import { atom, update, read } from 'claude-code'
import type { Segment } from '../types'
import type { ContextCategory, EngineInterface, Register, SessionContextBreakdown, SessionRateLimit } from 'claude-code'

const text = atom({ plugin: 'usage-band', key: 'text' } as const, null)
const model = atom({ plugin: 'usage-band', key: 'model' } as const, null)
const effort = atom({ plugin: 'usage-band', key: 'effort' } as const, null)
const open = atom({ plugin: 'usage-band', key: 'open' } as const, false)

// What the toggle on `context` reveals; the band's own row keeps the rest.
const EXTRA: readonly string[] = ['tools', 'skills', 'mcp', 'cache read', 'cache write']

/** Splits the segments into the band's row and the expandable one. */
export const split = (segs: readonly Segment[]): { main: Segment[]; extra: Segment[] } => ({
  main: segs.filter(s => !EXTRA.includes(s.label)),
  extra: segs.filter(s => EXTRA.includes(s.label)),
})

/** `claude-sonnet-5-5` or a dated id as a short name: `sonnet-5-5`. */
export const modelName = (id: string): string => id.replace(/^claude-/, '').replace(/-\d{8}$/, '')

// Soft tones, none near the yellow and red of the indicators.
const COLORS = {
  context: '#6fc3d6',
  tools: '#b8bcc8',
  skills: '#82c796',
  mcp: '#c58fd9',
  cache: '#e0c46c',
  session: '#7488e0',
  week: '#8c9eff',
} as const

const ORANGE = '#f0a050'

// Yellow from 75% and red from 90%, so the label colors keep clear of both.
const levelOf = (percent: number): 'yellow' | 'red' | undefined => (percent >= 90 ? 'red' : percent >= 75 ? 'yellow' : undefined)

// 1234 as `1.2k`, 160000 as `160k`.
const compact = (n: number): string => {
  const f = (v: number, u: string) => `${v.toFixed(1).replace(/\.0$/, '')}${u}`
  return n >= 1e6 ? f(n / 1e6, 'M') : n >= 1e3 ? f(n / 1e3, 'k') : String(n)
}

const pct = (tokens: number, window: number): string =>
  window > 0 ? `${((tokens / window) * 100).toFixed(1)}%` : '–'

/** Schema tokens of the built-in tools and the loaded MCP tools. */
export type Counted = { tools: number; mcp: number }

export type Show = { cache: boolean; tools: boolean; skills: boolean; mcp: boolean; session: boolean; week: boolean }

const ALL: Show = { cache: true, tools: true, skills: true, mcp: true, session: true, week: true }

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
  // The last response's prompt reuse: the share of its input read from the cache.
  const u = b.apiUsage
  const input = u ? u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0
  const cache = show.cache && u && input > 0 ? u : undefined
  if (cache) parts.push({ label: 'cache', value: `${((cache.cache_read_input_tokens / input) * 100).toFixed(0)}%`, color: COLORS.cache })
  if (show.tools) parts.push({ label: 'tools', value: pct(toolTokens, max), color: COLORS.tools })
  if (show.skills) parts.push({ label: 'skills', value: `${b.skills?.includedSkills ?? 0} (${pct(b.skills?.tokens ?? 0, max)})`, color: COLORS.skills })
  if (show.mcp) parts.push({ label: 'mcp', value: `${loaded}/${b.mcpTools.length} (${pct(mcpTokens, max)})`, color: COLORS.mcp })
  if (cache) {
    parts.push({ label: 'cache read', value: compact(cache.cache_read_input_tokens), color: COLORS.cache })
    parts.push({ label: 'cache write', value: compact(cache.cache_creation_input_tokens), color: COLORS.cache })
  }
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
  cache: options.showCache !== false,
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

  // The main loop's model and effort, as each request names them.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const m = modelName(e.model)
      const f = e.effort === undefined ? null : String(e.effort)
      if ((await read($, model)) !== m) await update($, model, () => m)
      if ((await read($, effort)) !== f) await update($, effort, () => f)
    }
    return yield* next(e)
  })

  on('session.measure', async ($, e, next) => {
    await draw($, show)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const line = await read($, text)
    if (e.props.hasSurvey || line === null) return next(e)
    const name = await read($, model)
    const level = await read($, effort)
    const expanded = await read($, open)
    const { main, extra } = split(line)
    const [first, ...rest] = main

    const { Box, Text, Button } = $.ui.resolve(e)
    const sep = <Text dimColor>{' · '}</Text>
    const seg = (s: Segment) => (
      <Text>
        <Text color={s.color}>{s.label}</Text>
        {' '}
        <Text color={s.level}>{s.value}</Text>
        {s.note ? ` ${s.note}` : null}
      </Text>
    )
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate">
          {'─'.repeat(500)}
        </Text>
        <Box flexDirection="row">
          {name ? (
            <Text wrap="truncate">
              <Text color={ORANGE}>{name}</Text>
              {level ? <Text color="white">{` ${level}`}</Text> : null}
              {sep}
            </Text>
          ) : null}
          {first && extra.length > 0 ? (
            <Button key="context" plain onPress={() => update($, open, v => !v)}>
              <Text color={first.color}>{first.label}</Text>
              {' '}
              <Text color={first.level}>{first.value}</Text>
              <Text dimColor>{expanded ? ' [-]' : ' [+]'}</Text>
            </Button>
          ) : first ? (
            seg(first)
          ) : null}
          <Text wrap="truncate">
            {rest.map(s => (
              <Text key={s.label}>
                {sep}
                {seg(s)}
              </Text>
            ))}
          </Text>
        </Box>
        {expanded && extra.length > 0 ? (
          <Text wrap="truncate">
            {extra.map((s, i) => (
              <Text key={s.label}>
                {i > 0 ? sep : null}
                {seg(s)}
              </Text>
            ))}
          </Text>
        ) : null}
      </Box>
    )
  })
}
