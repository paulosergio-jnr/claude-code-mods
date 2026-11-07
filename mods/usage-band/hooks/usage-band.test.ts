import { expect, test } from 'claude-code/testing'
import type { SessionContextBreakdown } from 'claude-code'
import { line, modelName, showOf, toolSetOf } from './register'
import { detailOf, toolName } from './detail'
import { fit, groupLine, rowLine, startsShut } from './pane'

const breakdown = {
  rawMaxTokens: 200_000,
  apiUsage: null,
  totalTokens: 84_000,
  categories: [
    { name: 'System tools', tokens: 15_000, color: '', isDeferred: false, kind: 'used' },
    { name: 'System tools (deferred)', tokens: 20_000, color: '', isDeferred: true, kind: 'deferred' },
    { name: 'Free space', tokens: 100_000, color: '', isDeferred: false, kind: 'free' },
  ],
  mcpTools: [
    { name: 'a', serverName: 's', tokens: 4_000, isLoaded: true },
    { name: 'b', serverName: 's', tokens: 6_000, isLoaded: true },
    { name: 'c', serverName: 's', tokens: 9_000, isLoaded: false },
  ],
  skills: { totalSkills: 30, includedSkills: 25, tokens: 2_000, skillFrontmatter: [] },
} as unknown as SessionContextBreakdown

const plain = (segs: ReturnType<typeof line>): string =>
  segs.map(s => `${s.label} ${s.value}${s.note ? ` ${s.note}` : ''}`).join(' · ')

test('line shows the context with one decimal, and leaves tools, skills and mcp to the pane', () => {
  expect(plain(line(42, breakdown))).toBe('context 42.0%')
})

test('line ends with the session and week windows', () => {
  const soon = new Date()
  soon.setHours(14, 33, 0, 0)
  const later = new Date(2026, 9, 9, 9, 0) // a Friday
  const text = plain(
    line(42, breakdown, [
      { kind: 'seven_day', percentUsed: 11.2, resetsAt: later.toISOString() },
      { kind: 'five_hour', percentUsed: 31.6, resetsAt: soon.toISOString() },
    ]),
  )
  expect(text.endsWith(' · session 31.6% (resets at 14:33) · week 11.2% (resets at Fri 09:00)')).toBe(true)
})

test('indicators turn yellow from 75% and red from 90%', () => {
  const level = (p: number) => line(p, undefined)[0]?.level
  expect(level(74.9)).toBeUndefined()
  expect(level(75)).toBe('yellow')
  expect(level(89.9)).toBe('yellow')
  expect(level(90)).toBe('red')
  const [session, week] = line(10, undefined, [
    { kind: 'five_hour', percentUsed: 80 },
    { kind: 'seven_day', percentUsed: 95 },
  ]).slice(1)
  expect([session?.level, week?.level]).toEqual(['yellow', 'red'])
})


test('only the windows the account reports show', () => {
  const text = plain(line(42, breakdown, [{ kind: 'seven_day', percentUsed: 5 }]))
  expect(text.endsWith(' · week 5.0%')).toBe(true)
})

test('context comes from the breakdown before any API response, as /context shows it', () => {
  expect(plain(line(undefined, breakdown))).toBe('context 42.0%')
})

test('counted schema tokens replace the estimate in the context', () => {
  // The estimate holds 15k tools and 10k mcp; counted, they are 5k and 1k: 19k fewer.
  expect(plain(line(undefined, breakdown, [], undefined, { tools: 5_000, mcp: 1_000 }))).toBe('context 32.5%')
})

test('after a response the total is the API count and the counted tokens leave it be', () => {
  const answered = { ...breakdown, apiUsage: {} } as SessionContextBreakdown
  expect(plain(line(undefined, answered, [], undefined, { tools: 5_000, mcp: 1_000 }))).toBe('context 42.0%')
})

test('the tool set changes when a tool loads, not when messages grow', () => {
  const grown = { ...breakdown, totalTokens: 120_000 } as SessionContextBreakdown
  expect(toolSetOf(grown)).toBe(toolSetOf(breakdown))
  const loaded = { ...breakdown, mcpTools: breakdown.mcpTools.map(t => ({ ...t, isLoaded: true })) } as SessionContextBreakdown
  expect(toolSetOf(loaded)).not.toBe(toolSetOf(breakdown))
})

test('line before a breakdown exists', () => {
  expect(plain(line(undefined, undefined))).toBe('context 0.0%')
})

test('options choose which band entries show, and context stays', () => {
  const show = showOf({ showTools: false, showMcp: false, showWeek: false })
  const text = plain(
    line(42, breakdown, [
      { kind: 'five_hour', percentUsed: 30 },
      { kind: 'seven_day', percentUsed: 5 },
    ], show),
  )
  expect(text).toBe('context 42.0% · session 30.0%')
  const off = showOf({ showTools: false, showSkills: false, showMcp: false, showSession: false, showWeek: false })
  expect(plain(line(42, breakdown, [{ kind: 'five_hour', percentUsed: 30 }], off))).toBe('context 42.0%')
  expect(showOf({})).toEqual({ cache: true, tools: true, skills: true, mcp: true, session: true, week: true })
})

test('modelName drops the claude- prefix and a date suffix', () => {
  expect(modelName('claude-sonnet-5-5')).toBe('sonnet-5-5')
  expect(modelName('claude-haiku-4-5-20251001')).toBe('haiku-4-5')
})

test('cache shows the hit rate on the band, and the token counts in the pane detail', () => {
  const withUsage = {
    ...breakdown,
    apiUsage: { input_tokens: 1_000, cache_read_input_tokens: 94_000, cache_creation_input_tokens: 5_000, output_tokens: 10 },
  } as unknown as SessionContextBreakdown
  expect(line(42, withUsage).map(s => `${s.label} ${s.value}`)).toEqual([
    'context 42.0%', 'cache 94%',
  ])
  expect(detailOf(withUsage).cache).toEqual({ hit: 0.94, read: 94_000, write: 5_000 })
  expect(line(42, withUsage, [], { ...showOf({}), cache: false }).some(s => s.label.startsWith('cache'))).toBe(false)
  expect(line(42, breakdown).some(s => s.label.startsWith('cache'))).toBe(false)
  expect(detailOf(breakdown).cache).toBeUndefined()
})

const withSkills = {
  ...breakdown,
  skills: {
    totalSkills: 30,
    includedSkills: 3,
    tokens: 600,
    skillFrontmatter: [
      { name: 'a', source: 'userSettings', tokens: 100 },
      { name: 'b', source: 'plugin', pluginName: 'p', tokens: 300 },
      { name: 'c', source: 'plugin', pluginName: 'p', tokens: 200 },
    ],
  },
} as unknown as SessionContextBreakdown

test('detail groups skills by source and plugin, largest first', () => {
  const { skills } = detailOf(withSkills)
  expect(skills.included).toBe(3)
  expect(skills.total).toBe(30)
  expect(skills.groups.map(g => `${g.name} ${g.tokens}`)).toEqual(['plugin: p 500', 'userSettings 100'])
  expect(skills.groups[0]?.rows.map(r => r.name)).toEqual(['b', 'c'])
})

test('detail takes skills named by a full breakdown when the summary names none', () => {
  const bare = { ...breakdown, skills: { ...breakdown.skills, skillFrontmatter: [] } } as unknown as SessionContextBreakdown
  expect(detailOf(bare).skills.groups).toEqual([])
  expect(detailOf(bare, undefined, withSkills.skills).skills.groups).toHaveLength(2)
})

test('detail groups MCP tools by server, and unloaded ones do not count', () => {
  const { mcp } = detailOf(breakdown)
  expect(mcp).toMatchObject({ loaded: 2, total: 3, tokens: 10_000 })
  const [s] = mcp.groups
  expect(s).toMatchObject({ name: 's', tokens: 10_000, note: '2/3' })
  expect(s?.rows.map(r => `${r.name} ${r.tokens}${r.dim ? ' dim' : ''}`)).toEqual(['c 9000 dim', 'b 6000', 'a 4000'])
})

test('counted tokens set the tools total and scale the MCP tools to match it', () => {
  const d = detailOf(breakdown, { tools: 5_000, mcp: 5_000 })
  expect(d.tools.tokens).toBe(5_000)
  expect(d.tools.rows.map(r => `${r.name} ${r.tokens}`)).toEqual(['built-in 5000', 'deferred 20000'])
  expect(d.mcp.tokens).toBe(5_000)
  expect(d.mcp.groups[0]?.tokens).toBe(5_000)
  // 84k estimated, minus 15k + 10k estimated, plus 5k + 5k counted.
  expect(d.total).toBe(69_000)
})

test('detail context lists the used categories and the free space', () => {
  const d = detailOf(breakdown)
  expect(d.context.map(r => `${r.name} ${r.tokens}${r.dim ? ' dim' : ''}`)).toEqual(['System tools 15000', 'Free space 100000 dim'])
})

test('toolName drops the mcp__server__ prefix', () => {
  expect(toolName('mcp__linear__create_issue')).toBe('create_issue')
  expect(toolName('plain')).toBe('plain')
})

test('fit puts the right text flush and clips the left one', () => {
  expect(fit('ab', '1k', 8)).toBe('ab    1k')
  expect(fit('abcdefghij', '1k', 8)).toBe('abcd… 1k')
  expect(rowLine({ name: 'x', tokens: 1_500, note: 'n' }, 2, 14)).toBe('  x (n)   1.5k')
  expect(groupLine({ name: 's', tokens: 10_000, note: '2/3', rows: [] }, 14)).toBe('  s (2/3)  10k')
})

test('pane sections and their groups start shut, except context', () => {
  expect(['context', 'cache', 'tools', 'skills', 'mcp'].map(startsShut)).toEqual([false, true, true, true, true])
  expect(startsShut('skills:plugin: p')).toBe(true)
  expect(startsShut('mcp:s')).toBe(true)
})
