import { expect, test } from 'claude-code/testing'
import type { SessionContextBreakdown } from 'claude-code'
import { line, showOf, toolSetOf } from './register'

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

test('line shows context, tools, skills and mcp with one decimal', () => {
  expect(plain(line(42, breakdown))).toBe(
    'context 42.0% · tools 7.5% · skills 25 (1.0%) · mcp 2/3 (5.0%)',
  )
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

test('tools, skills and mcp carry no indicator', () => {
  const segs = line(10, breakdown)
  expect(segs.slice(1).every(s => s.level === undefined)).toBe(true)
})

test('only the windows the account reports show', () => {
  const text = plain(line(42, breakdown, [{ kind: 'seven_day', percentUsed: 5 }]))
  expect(text.endsWith(' · week 5.0%')).toBe(true)
})

test('context comes from the breakdown before any API response, as /context shows it', () => {
  expect(plain(line(undefined, breakdown)).startsWith('context 42.0% · ')).toBe(true)
})

test('counted schema tokens replace the estimate in tools, mcp and context', () => {
  // The estimate holds 15k tools and 10k mcp; counted, they are 5k and 1k: 19k fewer.
  expect(plain(line(undefined, breakdown, [], undefined, { tools: 5_000, mcp: 1_000 }))).toBe(
    'context 32.5% · tools 2.5% · skills 25 (1.0%) · mcp 2/3 (0.5%)',
  )
})

test('after a response the total is the API count and the counted tokens leave it be', () => {
  const answered = { ...breakdown, apiUsage: {} } as SessionContextBreakdown
  expect(plain(line(undefined, answered, [], undefined, { tools: 5_000, mcp: 1_000 })).startsWith('context 42.0% · tools 2.5% · ')).toBe(true)
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

test('options choose which entries show, and context stays', () => {
  const show = showOf({ showTools: false, showMcp: false, showWeek: false })
  const text = plain(
    line(42, breakdown, [
      { kind: 'five_hour', percentUsed: 30 },
      { kind: 'seven_day', percentUsed: 5 },
    ], show),
  )
  expect(text).toBe('context 42.0% · skills 25 (1.0%) · session 30.0%')
  const off = showOf({ showTools: false, showSkills: false, showMcp: false, showSession: false, showWeek: false })
  expect(plain(line(42, breakdown, [{ kind: 'five_hour', percentUsed: 30 }], off))).toBe('context 42.0%')
  expect(showOf({})).toEqual({ tools: true, skills: true, mcp: true, session: true, week: true })
})
