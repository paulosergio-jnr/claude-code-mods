import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const SPAWN = {
  tool_use_id: 'tu-1',
  prompt: 'Find the auth code',
  description: 'find auth',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'test',
  background: false,
  fork: false,
} as const

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const

// Stands in for the engine beneath the mod and counts the panes it opens.
function engine(on: On) {
  const opened: string[] = []
  mock.clock(on)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('agent.spawn', async () => ({ model: 'test', agentId: 'sub-1' }))
  on('ui.panes', async () => ({ value: [] }) as never)
  on('ui.open', async (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  return opened
}

const cases = [
  { autoOpen: 'never', onStart: 0, onSpawn: 0 },
  { autoOpen: 'on-subagent', onStart: 0, onSpawn: 1 },
  { autoOpen: 'always', onStart: 1, onSpawn: 2 },
] as const

for (const { autoOpen, onStart, onSpawn } of cases) {
  test(`autoOpen ${autoOpen}`, { options: { autoOpen } }, async ($, on) => {
    const opened = engine(on)

    await $.session.start(START)
    expect(opened.length).toBe(onStart)

    await $.agent.spawn(SPAWN)
    expect(opened.length).toBe(onSpawn)
  })
}

test('autoOpen defaults to on-subagent', async ($, on) => {
  const opened = engine(on)

  await $.session.start(START)
  expect(opened.length).toBe(0)

  await $.agent.spawn(SPAWN)
  expect(opened).toEqual(['agent-flow'])
})
