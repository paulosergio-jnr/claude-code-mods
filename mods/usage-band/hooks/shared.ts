export const PANE = 'usage-band'

// Soft tones, none near the yellow and red of the indicators.
export const COLORS = {
  context: '#6fc3d6',
  tools: '#b8bcc8',
  skills: '#82c796',
  mcp: '#c58fd9',
  cache: '#e0c46c',
  session: '#7488e0',
  week: '#8c9eff',
} as const

// 1234 as `1.2k`, 160000 as `160k`.
export const compact = (n: number): string => {
  const f = (v: number, u: string) => `${v.toFixed(1).replace(/\.0$/, '')}${u}`
  return n >= 1e6 ? f(n / 1e6, 'M') : n >= 1e3 ? f(n / 1e3, 'k') : String(n)
}

export const pct = (tokens: number, window: number): string =>
  window > 0 ? `${((tokens / window) * 100).toFixed(1)}%` : '–'
