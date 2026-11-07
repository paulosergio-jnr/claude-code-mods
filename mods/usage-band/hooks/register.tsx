import { atom, update, read } from 'claude-code'
import type { Segment } from '../types'
import type { ContextSkills, EngineInterface, Register, SessionContextBreakdown, SessionRateLimit } from 'claude-code'
import { detailOf, toolTokensOf } from './detail'
import type { Counted } from './detail'
import { renderPane } from './pane'
import { COLORS, PANE } from './shared'

const text = atom({ plugin: 'usage-band', key: 'text' } as const, null)
const model = atom({ plugin: 'usage-band', key: 'model' } as const, null)
const effort = atom({ plugin: 'usage-band', key: 'effort' } as const, null)
/** Mirrors the pane being open, so the band redraws when the toggle is pressed. */
const open = atom({ plugin: 'usage-band', key: 'open' } as const, false)
const detail = atom({ plugin: 'usage-band', key: 'detail' } as const, null)
/** Ids of the pane sections and groups the person flipped from how they start. */
const flipped = atom({ plugin: 'usage-band', key: 'flipped' } as const, [] as string[])

export type { Counted }

/** `claude-sonnet-5-5` or a dated id as a short name: `sonnet-5-5`. */
export const modelName = (id: string): string => id.replace(/^claude-/, '').replace(/-\d{8}$/, '')

const ORANGE = '#f0a050'

// Yellow from 75% and red from 90%, so the label colors keep clear of both.
const levelOf = (percent: number): 'yellow' | 'red' | undefined => (percent >= 90 ? 'red' : percent >= 75 ? 'yellow' : undefined)

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
  const p = max > 0 ? (total / max) * 100 : (percent ?? 0)

  const parts: Segment[] = [{ label: 'context', value: `${p.toFixed(1)}%`, level: levelOf(p), color: COLORS.context }]
  // The last response's prompt reuse: the share of its input read from the cache.
  const u = b.apiUsage
  const input = u ? u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0
  const cache = show.cache && u && input > 0 ? u : undefined
  if (cache) parts.push({ label: 'cache', value: `${((cache.cache_read_input_tokens / input) * 100).toFixed(0)}%`, color: COLORS.cache })
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

// What the full breakdown settled, and the tool set and skill count it was
// asked for. A module variable: a reload asks once more.
let cache: { set: string; skillKey: string; counted: Counted; skills?: ContextSkills } | undefined

async function draw($: EngineInterface, show: Show): Promise<void> {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const b = usage.context.breakdown
  if (b) {
    const set = toolSetOf(b)
    const skillKey = `${b.skills?.totalSkills ?? 0}|${b.skills?.includedSkills ?? 0}`
    // The summary may list no skill by name; the full one does.
    const unnamed = (b.skills?.includedSkills ?? 0) > 0 && (b.skills?.skillFrontmatter.length ?? 0) === 0
    // The summary estimates tool schemas well above what /context counts; count
    // them as /context does (one request per tool) only when the set changed.
    if (cache?.set !== set || (unnamed && cache.skillKey !== skillKey)) {
      const full = (await $.session.usage({ breakdown: 'full' })).context.breakdown
      if (full) cache = { set, skillKey, counted: toolTokensOf(full), skills: full.skills }
    }
  }
  const skills = b?.skills && b.skills.skillFrontmatter.length === 0 ? (cache?.skills ?? b.skills) : b?.skills
  await update($, text, () => line(usage.context.percent, b, usage.rateLimits, show, cache?.counted))
  await update($, detail, () => (b ? detailOf(b, cache?.counted, skills) : null))
}

const isOpen = async ($: EngineInterface): Promise<boolean> => (await $.ui.panes()).some(p => p.id === PANE)

// The `context` button: opens the pane, or closes it.
async function toggle($: EngineInterface): Promise<void> {
  if (await isOpen($)) await $.ui.close({ id: PANE })
  else await $.ui.open({ id: PANE, title: 'Usage', focus: true })
  await update($, open, v => !v)
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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const toggleFold = (id: string) => update($, flipped, f => (f.includes(id) ? f.filter(x => x !== id) : [...f, id]))
    return renderPane($, e, show, await read($, detail), await read($, flipped), toggleFold)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const line = await read($, text)
    if (e.props.hasSurvey || line === null) return next(e)
    const name = await read($, model)
    const level = await read($, effort)
    await read($, open)
    const shown = await isOpen($)
    const [first, ...rest] = line

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
          {first ? seg(first) : null}
          {first ? <Text>{' '}</Text> : null}
          {first ? (
            <Button key="pane" plain onPress={() => toggle($)}>
              <Text color={COLORS.mcp} bold={shown}>{'[?]'}</Text>
            </Button>
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
      </Box>
    )
  })
}
