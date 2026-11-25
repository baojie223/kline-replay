export function ema20(bars: readonly { close: number; contract?: string }[]) {
  let count = 0
  let value = 0
  return bars.map(({ close, contract }, index) => {
    if (contract !== bars[index - 1]?.contract) count = value = 0
    count++
    if (count <= 20) {
      value += (close - value) / count
      return count === 20 ? value : undefined
    }
    value += (close - value) * (2 / 21)
    return value
  })
}
