import { atom, update, read } from 'claude-code'
import type { Segment } from '../types'
import type { EngineInterface, Register, SessionContextBreakdown, SessionRateLimit } from 'claude-code'

const text = atom({ plugin: 'usage-band', key: 'text' } as const, null)

// Soft tones, none near the yellow and red of the indicators.
const COLORS = {
  context: '#6fc3d6',
  tools: '#b8bcc8',
  skills: '#82c796',
  mcp: '#c58fd9',
  session: '#7488e0',
  week: '#8c9eff',
} as const

// Yellow from 75% and red from 90%, so the label colors keep clear of both.
const levelOf = (percent: number): 'yellow' | 'red' | undefined => (percent >= 90 ? 'red' : percent >= 75 ? 'yellow' : undefined)

const pct = (tokens: number, window: number): string =>
  window > 0 ? `${((tokens / window) * 100).toFixed(1)}%` : '–'

type Counts = { tools: number; mcpTools: number }

export type Show = { tools: boolean; skills: boolean; mcp: boolean; session: boolean; week: boolean }

const ALL: Show = { tools: true, skills: true, mcp: true, session: true, week: true }

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// The reset time in local time, led by the weekday when it is not today.
const clock = (iso: string): string => {
  const d = new Date(iso)
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return d.toDateString() === new Date().toDateString() ? time : `${DAYS[d.getDay()]} ${time}`
}

// A rate-limit window as `label 32% (resets at 14:33)`; absent off a subscription.
function window(limits: readonly SessionRateLimit[], kind: string): Omit<Segment, 'label' | 'color'> | undefined {
  const w = limits.find(l => l.kind === kind)
  if (!w) return undefined
  return {
    value: `${w.percentUsed.toFixed(1)}%`,
    level: levelOf(w.percentUsed),
    note: w.resetsAt ? `(resets at ${clock(w.resetsAt)})` : undefined,
  }
}

const windows = (limits: readonly SessionRateLimit[], show: Show): Segment[] => {
  const out: Segment[] = []
  const session = show.session ? window(limits, 'five_hour') : undefined
  const week = show.week ? window(limits, 'seven_day') : undefined
  if (session) out.push({ label: 'session', ...session, color: COLORS.session })
  if (week) out.push({ label: 'week', ...week, color: COLORS.week })
  return out
}

// Every figure but the tool count comes from the breakdown. The built-in tools
// are told apart by the row's name, the one place the engine's labels are read.
export function line(
  percent: number | undefined,
  b: SessionContextBreakdown | undefined,
  n: Counts,
  limits: readonly SessionRateLimit[] = [],
  show: Show = ALL,
): Segment[] {
  const parts: Segment[] = [{ label: 'context', value: `${(percent ?? 0).toFixed(1)}%`, level: levelOf(percent ?? 0), color: COLORS.context }]
  const tail = windows(limits, show)
  if (!b) return [...parts, ...tail]

  const max = b.rawMaxTokens
  const toolTokens = b.categories.filter(c => c.kind === 'used' && /^system tools/i.test(c.name)).reduce((s, c) => s + c.tokens, 0)
  const mcpTokens = b.mcpTools.filter(t => t.isLoaded).reduce((s, t) => s + t.tokens, 0)

  if (show.tools) parts.push({ label: 'tools', value: pct(toolTokens, max), color: COLORS.tools })
  if (show.skills) parts.push({ label: 'skills', value: `${b.skills?.includedSkills ?? 0} (${pct(b.skills?.tokens ?? 0, max)})`, color: COLORS.skills })
  if (show.mcp) parts.push({ label: 'mcp', value: `${n.mcpTools} (${pct(mcpTokens, max)})`, color: COLORS.mcp })
  parts.push(...tail)
  return parts
}

async function draw($: EngineInterface, show: Show): Promise<void> {
  const [usage, tools] = await Promise.all([$.session.usage({ breakdown: 'summary' }), $.tool.list()])
  const mcpTools = tools.filter(t => t.mcp).length
  await update($, text, () => line(usage.context.percent, usage.context.breakdown, { tools: tools.length - mcpTools, mcpTools }, usage.rateLimits, show))
}

// An option left unset, or stored as anything but false, stays on.
export const showOf = (options: Readonly<Record<string, unknown>>): Show => ({
  tools: options.showTools !== false,
  skills: options.showSkills !== false,
  mcp: options.showMcp !== false,
  session: options.showSession !== false,
  week: options.showWeek !== false,
})

export const register: Register = (on, options) => {
  const show = showOf(options)

  on('session.start', async ($, e, next) => {
    await draw($, show)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await draw($, show)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const line = await read($, text)
    if (e.props.hasSurvey || line === null) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate">
          {'─'.repeat(500)}
        </Text>
        <Text wrap="truncate">
          {line.map((seg, i) => (
            <Text key={seg.label}>
              {i > 0 ? <Text dimColor>{' · '}</Text> : null}
              <Text color={seg.color}>{seg.label}</Text>
              {' '}
              <Text color={seg.level}>{seg.value}</Text>
              {seg.note ? ` ${seg.note}` : null}
            </Text>
          ))}
        </Text>
      </Box>
    )
  })
}
