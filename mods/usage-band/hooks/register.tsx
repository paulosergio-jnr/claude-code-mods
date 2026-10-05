import { atom, update, read } from 'claude-code'
import type { Segment } from '../types'
import type { ContextCategory, EngineInterface, Register, SessionContextBreakdown, SessionRateLimit } from 'claude-code'

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

/** Schema tokens of the built-in tools and the loaded MCP tools. */
export type Counted = { tools: number; mcp: number }

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

const isSystemTools = (c: ContextCategory): boolean => c.kind === 'used' && /^system tools/i.test(c.name)

// Tool and MCP schema tokens as a breakdown carries them.
export const toolTokensOf = (b: SessionContextBreakdown): Counted => ({
  tools: b.categories.filter(isSystemTools).reduce((s, c) => s + c.tokens, 0),
  mcp: b.mcpTools.filter(t => t.isLoaded).reduce((s, t) => s + t.tokens, 0),
})

// Every figure comes from the breakdown. The built-in tools
// are told apart by the row's name, the one place the engine's labels are read.
// `counted` replaces the summary's estimated schema tokens with /context's
// counted ones. Before the first response the total is an estimate too and
// moves with them; after it the engine has reconciled the total to the API's.
export function line(
  percent: number | undefined,
  b: SessionContextBreakdown | undefined,
  limits: readonly SessionRateLimit[] = [],
  show: Show = ALL,
  counted?: Counted,
): Segment[] {
  const tail = windows(limits, show)
  if (!b) {
    const p = percent ?? 0
    return [{ label: 'context', value: `${p.toFixed(1)}%`, level: levelOf(p), color: COLORS.context }, ...tail]
  }

  const max = b.rawMaxTokens
  const estimated = toolTokensOf(b)
  const { tools: toolTokens, mcp: mcpTokens } = counted ?? estimated
  const total = b.apiUsage ? b.totalTokens : b.totalTokens - estimated.tools - estimated.mcp + toolTokens + mcpTokens
  const loaded = b.mcpTools.filter(t => t.isLoaded).length
  const p = max > 0 ? (total / max) * 100 : (percent ?? 0)

  const parts: Segment[] = [{ label: 'context', value: `${p.toFixed(1)}%`, level: levelOf(p), color: COLORS.context }]
  if (show.tools) parts.push({ label: 'tools', value: pct(toolTokens, max), color: COLORS.tools })
  if (show.skills) parts.push({ label: 'skills', value: `${b.skills?.includedSkills ?? 0} (${pct(b.skills?.tokens ?? 0, max)})`, color: COLORS.skills })
  if (show.mcp) parts.push({ label: 'mcp', value: `${loaded}/${b.mcpTools.length} (${pct(mcpTokens, max)})`, color: COLORS.mcp })
  parts.push(...tail)
  return parts
}

// What the tool schemas in the window are: changes when a deferred tool loads
// or a server connects, and only then is a counted breakdown worth asking for.
export const toolSetOf = (b: SessionContextBreakdown): string =>
  [
    ...b.categories.filter(c => /^system tools/i.test(c.name)).map(c => `${c.kind}:${c.tokens}`),
    ...b.mcpTools.filter(t => t.isLoaded).map(t => t.name),
  ].join('|')

// The last counted schema tokens and the tool set they were counted for. A
// module variable: a reload counts once more.
let cache: { set: string; counted: Counted } | undefined

async function draw($: EngineInterface, show: Show): Promise<void> {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const b = usage.context.breakdown
  // The summary estimates tool schemas well above what /context counts; count
  // them as /context does (one request per tool) only when the set changed.
  if (b && cache?.set !== toolSetOf(b)) {
    const full = (await $.session.usage({ breakdown: 'full' })).context.breakdown
    if (full) cache = { set: toolSetOf(b), counted: toolTokensOf(full) }
  }
  await update($, text, () => line(usage.context.percent, b, usage.rateLimits, show, cache?.counted))
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
