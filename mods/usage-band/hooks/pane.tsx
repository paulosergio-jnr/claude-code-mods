import type { EngineInterface } from 'claude-code'
import type { RenderChildren, RenderInput } from 'claude-code'
import type { Detail, Group, Row } from '../types'
import { COLORS, compact, pct } from './shared'

export type PaneShow = { cache: boolean; tools: boolean; skills: boolean; mcp: boolean }

const clip = (s: string, width: number): string => (s.length > width ? `${s.slice(0, Math.max(1, width - 1))}…` : s)

/** `left` and `right` on one line of `width`, the right one flush. */
export const fit = (left: string, right: string, width: number): string => {
  const l = clip(left, Math.max(1, width - right.length - 1))
  return `${l}${' '.repeat(Math.max(1, width - l.length - right.length))}${right}`
}

export const rowLine = (r: Row, indent: number, width: number): string =>
  fit(`${' '.repeat(indent)}${r.name}${r.note ? ` (${r.note})` : ''}`, compact(r.tokens), width)

export const groupLine = (g: Group, width: number): string =>
  fit(`  ${g.name}${g.note ? ` (${g.note})` : ''}`, compact(g.tokens), width)

/** Everything starts folded shut except `context`: the sections, and the groups inside them. */
export const startsShut = (id: string): boolean => id !== 'context'

/** `d` and `flipped` are the pane's state, read by the caller; `toggle` flips an id from how it starts. */
export function renderPane(
  $: EngineInterface,
  e: RenderInput<'Pane'>,
  show: PaneShow,
  d: Detail | null,
  flipped: readonly string[],
  toggle: (id: string) => unknown,
) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const width = Math.max(24, (e.props.bodyColumns ?? 40) - 2)

  const titleBar = (
    <Box key="title-bar" justifyContent="center" marginBottom={1}>
      <Text bold color="claude">Usage</Text>
      <Text color="subtle">{d ? ` · ${pct(d.total, d.max)} of ${compact(d.max)}` : ''}</Text>
    </Box>
  )
  if (!d) return <Box flexDirection="column">{titleBar}<Text dimColor>No measurement yet.</Text></Box>

  // A section: a header button that folds it, and its lines when open.
  const section = (id: string, title: string, color: string, summary: string, lines: () => RenderChildren) => {
    const shut = startsShut(id) !== flipped.includes(id)
    return (
      <Box key={id} flexDirection="column" marginBottom={1}>
        <Button key={`head-${id}`} plain onPress={() => toggle(id)}>
          <Text color={color} bold>{`${shut ? '▸' : '▾'} ${title}`}</Text>
          <Text>{`  ${summary}`}</Text>
        </Button>
        {shut ? null : lines()}
      </Box>
    )
  }

  const rows = (list: readonly Row[], indent = 2, prefix = '') =>
    list.map(r => (
      <Text key={`${prefix}${r.name}`} dimColor={r.dim} wrap="truncate">
        {rowLine(r, indent, width)}
      </Text>
    ))

  const groups = (id: string, list: readonly Group[]) =>
    list.map(g => {
      const key = `${id}:${g.name}`
      const shut = startsShut(key) !== flipped.includes(key)
      return (
        <Box key={key} flexDirection="column">
          <Button key={`head-${key}`} plain onPress={() => toggle(key)}>
            <Text wrap="truncate">{`${shut ? '▸' : '▾'}${groupLine(g, width - 1)}`}</Text>
          </Button>
          {shut ? null : rows(g.rows, 4, key)}
        </Box>
      )
    })

  const out: RenderChildren[] = [
    section('context', 'Context', COLORS.context, `${compact(d.total)} / ${compact(d.max)}`, () => rows(d.context)),
  ]
  if (show.cache && d.cache) {
    const c = d.cache
    out.push(
      section('cache', 'Cache', COLORS.cache, `${(c.hit * 100).toFixed(0)}% hit`, () => [
        <Text key="read">{fit('  read', compact(c.read), width)}</Text>,
        <Text key="write">{fit('  write', compact(c.write), width)}</Text>,
      ]),
    )
  }
  if (show.tools) {
    out.push(section('tools', 'Tools', COLORS.tools, `${compact(d.tools.tokens)} (${pct(d.tools.tokens, d.max)})`, () => rows(d.tools.rows)))
  }
  if (show.skills) {
    const s = d.skills
    out.push(
      section('skills', 'Skills', COLORS.skills, `${s.included}/${s.total} listed · ${compact(s.tokens)} (${pct(s.tokens, d.max)})`, () => [
        ...groups('skills', s.groups),
        s.total > s.included ? <Text key="over" dimColor>{`  ${s.total - s.included} not listed (over the budget)`}</Text> : null,
      ]),
    )
  }
  if (show.mcp) {
    const m = d.mcp
    out.push(
      section('mcp', 'MCP', COLORS.mcp, `${m.loaded}/${m.total} loaded · ${compact(m.tokens)} (${pct(m.tokens, d.max)})`, () =>
        m.total === 0 ? [<Text key="none" dimColor>{'  no MCP tools'}</Text>] : groups('mcp', m.groups),
      ),
    )
  }

  return (
    <Box flexDirection="column">
      {titleBar}
      {out}
    </Box>
  )
}
