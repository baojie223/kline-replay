import argparse
import csv
import gzip
import hashlib
import io
import json
import re
import time
from bisect import bisect_right
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import gettempdir
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
REVISION = "1a402721d639432875504a343e2b9ffe9508cd36"
SOURCE = f"https://raw.githubusercontent.com/Freddy-Hexas/china-futures-5min-2015-2025/{REVISION}/5min/CZCE/MA/"
CZCE = "https://www.czce.com.cn/cn/DFSStaticFiles/Future"
WARMUP = "2019-12-02"
START = "2020-01-02"
END = "2025-06-30"
# CZCE's daily file shows MA501 still led on this date. Its source bars undercounted volume.
VOLUME_LEADER_FIXES = {"2024-12-11": "MA2501"}
CONTRACTS = ["MA1912"] + [
    f"MA{year:02}{month:02}"
    for year in range(20, 27)
    for month in range(1, (6 if year == 26 else 12) + 1)
]


def slots(start, end):
    return [f"{minute // 60:02}:{minute % 60:02}" for minute in range(start + 5, end + 1, 5)]


DAY = slots(540, 615) + slots(630, 690) + slots(810, 900)
NIGHT = slots(1260, 1380)
NIGHT_LATE = slots(1260, 1410)
OPEN_LABELS = {"09:00", "10:30", "13:30", "21:00"}
CLOSE_LABELS = {"10:15", "11:30", "15:00"}


def download(url, path):
    if path.exists():
        return path.read_bytes()
    for attempt in range(3):
        try:
            request = Request(url, headers={"User-Agent": "MA-5m-research/1.0"})
            with urlopen(request, timeout=20) as response:
                content = response.read()
            path.write_bytes(content)
            return content
        except HTTPError as error:
            if error.code < 500 and error.code != 429:
                raise
            if attempt == 2:
                raise
        except (TimeoutError, URLError):
            if attempt == 2:
                raise
        time.sleep(0.5 * (attempt + 1))


def load_contract(contract, cache, fetch):
    path = cache / (contract + ".csv")
    content = download(SOURCE + path.name, path) if fetch else path.read_bytes()
    return contract, path, hashlib.sha256(content).hexdigest()


def rows(path):
    with path.open(encoding="utf-8-sig", newline="") as file:
        reader = csv.reader(file)
        header = next(reader)
        if header[:6] != ["datetime", "open", "high", "low", "close", "volume"]:
            raise ValueError(f"Unexpected header in {path.name}: {header}")
        for row in reader:
            when = row[0][:16]
            if when < "2019-11-30" or when > END + " 15:00":
                continue
            volume = float(row[5])
            if not volume.is_integer() or volume < 0:
                raise ValueError(f"Invalid volume in {path.name} at {when}: {row[5]}")
            if volume > 0:
                yield when, row[1:5], int(volume)


def aggregate(paths):
    day_volume = defaultdict(Counter)
    night_volume = defaultdict(Counter)
    for contract, path, _ in paths:
        for when, _, volume in rows(path):
            calendar_day, slot = when.split(" ")
            book = night_volume if slot >= "21:00" else day_volume
            book[calendar_day][contract] += volume

    dates = sorted(day_volume)
    night_to_day = {}
    for night, volumes in night_volume.items():
        after = bisect_right(dates, night)
        if after < len(dates):
            trade_day = dates[after]
            night_to_day[night] = trade_day
            day_volume[trade_day].update(volumes)
    return dates, night_to_day, day_volume


def read_main(paths, main, night_to_day):
    quotes = defaultdict(list)
    contracts = set(main.values())
    for contract, path, _ in paths:
        if contract not in contracts:
            continue
        for when, prices, volume in rows(path):
            calendar_day, slot = when.split(" ")
            trade_day = night_to_day.get(calendar_day) if slot >= "21:00" else calendar_day
            if main.get(trade_day) != contract:
                continue
            if any(not float(price).is_integer() for price in prices):
                raise ValueError(f"Non-integer price in {contract} at {when}")
            opening, high, low, close = map(lambda price: int(float(price)), prices)
            if not 0 < low <= min(opening, close) <= max(opening, close) <= high:
                raise ValueError(f"Invalid OHLC in {contract} at {when}")
            quotes[trade_day].append((when, trade_day, "MA" + contract[3:], opening, high, low, close, volume))
    return quotes


def to_close_times(bars):
    times = {row[0][11:] for row in bars}
    if not times.intersection(OPEN_LABELS):
        return bars, False
    if times.intersection(CLOSE_LABELS):
        raise ValueError(f"Mixed start/end timestamps on {bars[0][1]} for {bars[0][2]}")

    def close_time(row):
        timestamp = row[0]
        total = int(timestamp[11:13]) * 60 + int(timestamp[14:]) + 5
        return (f"{timestamp[:11]}{total // 60:02}:{total % 60:02}", *row[1:])

    return [close_time(row) for row in bars], True


def audit_official(day, previous, main, previous_leader, bars, cache):
    compact = day.replace("-", "")
    url = f"{CZCE}/{day[:4]}/{compact}/FutureDataDaily.txt"
    try:
        raw = download(url, cache / ("czce-" + day + ".txt"))
    except (HTTPError, URLError, TimeoutError) as error:
        return {"day": day, "error": str(error), "url": url}
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("gb18030")
    if day not in text.splitlines()[0]:
        return {"day": day, "error": "Incorrect date in exchange response", "url": url}
    contracts = {}
    for line in text.splitlines()[2:]:
        cells = [cell.strip().replace(",", "") for cell in line.split("|")]
        if re.fullmatch(r"MA\d{3}", cells[0]) and len(cells) > 9 and cells[9].isdigit() and int(cells[9]) > 0:
            contracts[cells[0]] = [int(float(cells[i])) for i in (2, 3, 4, 5, 9)]
    main_code = "MA" + main[3:]
    expected = contracts.get(main_code)
    if expected is None:
        return {"day": day, "error": "Missing selected contract in exchange response", "url": url}
    actual = [bars[0][3], max(row[4] for row in bars), min(row[5] for row in bars), bars[-1][6], sum(row[7] for row in bars)]
    highest_volume = max(contracts, key=lambda contract: contracts[contract][4])
    return {
        "day": day,
        "previousDay": previous,
        "contract": main_code,
        "exchangeLead": highest_volume,
        "minuteLead": "MA" + previous_leader[3:],
        "difference": dict(zip(("open", "high", "low", "close", "volume"), (a - e for a, e in zip(actual, expected)))),
        "exchangeVolume": expected[4],
        "url": url,
    }


def prepare(cache, fetch, crosscheck):
    cache.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=8) as pool:
        paths = list(pool.map(lambda contract: load_contract(contract, cache, fetch), CONTRACTS))
    print(f"Read {len(paths)} pinned contract files", flush=True)
    dates, night_to_day, book = aggregate(paths)
    previous_day = dict(zip(dates[1:], dates))
    minute_leader = {day: max(sorted(volumes), key=volumes.get) for day, volumes in book.items()}
    leader = minute_leader | VOLUME_LEADER_FIXES
    main = {day: leader[previous_day[day]] for day in dates if WARMUP <= day <= END and day in previous_day}
    if not main or START not in main or END not in main:
        raise ValueError("Incomplete historical sample window")
    quotes = read_main(paths, main, night_to_day)
    rolls = []
    unexpected = []
    opening_label_days = Counter()
    schedules = Counter()
    day_counts = Counter()
    first_of_quarter = {}
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(["time", "trade_date", "contract", "open", "high", "low", "close", "volume"])
    last_contract = None
    for day, contract in main.items():
        bars, open_label = to_close_times(quotes[day])
        schedule = [row[0][11:] for row in bars]
        if schedule not in (NIGHT + DAY, NIGHT_LATE + DAY, DAY):
            unexpected.append({"day": day, "contract": contract, "slots": schedule})
        if not bars or schedule[-1] != "15:00":
            raise ValueError(f"Missing trade-day close: {day} {contract}")
        if last_contract != contract:
            rolls.append({"day": day, "from": last_contract, "to": contract})
            last_contract = contract
        writer.writerows(bars)
        if open_label:
            opening_label_days[day[:4]] += 1
        schedules[len(schedule)] += 1
        if day >= START:
            day_counts[day[:4]] += 1
            first_of_quarter.setdefault((day[:4], (int(day[5:7]) - 1) // 3), day)

    official = []
    if crosscheck:
        check_days = set(first_of_quarter.values()) | {END} | VOLUME_LEADER_FIXES.keys()
        for roll in rolls[1:]:
            check_days.update((roll["day"], previous_day[roll["day"]]))
        with ThreadPoolExecutor(max_workers=5) as pool:
            official = list(pool.map(lambda day: audit_official(
                day, previous_day[day], main[day], minute_leader[day], quotes[day], cache,
            ), sorted(check_days)))

    market = output.getvalue().encode("ascii")
    manifest = {
        "revision": REVISION, "marketSha256": hashlib.sha256(market).hexdigest(),
        "warmupFrom": next(iter(main)), "from": START, "through": END,
        "calendarDayCounts": dict(day_counts), "rolls": rolls, "unexpectedSchedules": unexpected,
        "openingLabelDaysByYear": dict(opening_label_days), "barsPerDayCountsIncludingWarmup": dict(schedules),
        "volumeLeaderFixes": VOLUME_LEADER_FIXES,
        "official": official, "rawSha256": {contract: sha for contract, _, sha in paths},
    }
    (ROOT / "history-5m.csv.gz").write_bytes(gzip.compress(market, mtime=0))
    (ROOT / "history-audit.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"{day_counts.total()} trading days, {sum(map(len, quotes.values()))} bars including warmup, "
          f"{len(unexpected)} unusual schedules, {len(official)} official checks")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build the MA research sample from pinned public contract files.")
    parser.add_argument("--cache", type=Path, default=Path(gettempdir()) / ("ma-5m-" + REVISION[:7]))
    parser.add_argument("--download", action="store_true", help="Fetch missing GitHub files into the cache.")
    parser.add_argument("--audit", action="store_true", help="Compare selected trading days with CZCE daily files.")
    args = parser.parse_args()
    prepare(args.cache, args.download, args.audit)
