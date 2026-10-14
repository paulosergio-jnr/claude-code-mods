import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane' as const,
  requestId: 'agent-flow',
  props: { title: 'Agent flow', isFocused: false, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} },
}

test('a subagent shows as working, then done, with its task and result', async ($, on) => {
  const clock = mock.clock(on)
  on('agent.spawn', async () => ({ model: 'test', agentId: 'sub-1' }))
  on('tool.call', async () => ({ text: 'ok' }) as never)
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: {
        model: 'claude-haiku-4-5-20251001',
        input_tokens: 1000,
        output_tokens: 250,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 0,
      },
    }
  })
  on('ui.panes', async () => ({ value: [] }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'agent-flow', surface, ...PANE })
    expect(await ui.find({ in: 'graph', text: /orchestrator/ })).toBeDefined()
    await ui.unmount()
  }

  await $.agent.spawn({
    tool_use_id: 'tu-1',
    prompt: 'Find the auth code',
    description: 'find auth',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'test',
    background: false,
    fork: false,
  })

  const ui = await $.ui.mount({ plugin: 'agent-flow', surface: 'terminal', ...PANE })
  expect(await ui.find({ in: 'graph', text: /1 working/ })).toBeDefined()
  expect(await ui.find({ in: 'graph', text: /task/ })).toBeDefined()

  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-4-5-20251001', effort: 'high', messageCount: 1, agentId: 'sub-1' })
  for await (const _ of step) void _
  await step.result
  expect(await ui.find({ in: 'graph', text: /haiku-4-5 · ↑1\.5k ↓250/ })).toBeDefined()

  await clock.advance(1200)
  await $.turn.complete({
    answer: 'auth lives in src/auth.ts',
    durationMs: 1200,
    isAborted: false,
    turnId: 't1',
    agentId: 'sub-1',
    reason: 'answer',
  })
  await ui.advance(500)
  expect(await ui.find({ in: 'graph', text: /1 finished/ })).toBeDefined()
  expect(await ui.find({ in: 'graph', text: /src\/auth\.ts/ })).toBeDefined()

  // Row 0 is the header, 1 the hint, 2 the orchestrator, 3 the subagent.
  expect(await ui.find({ in: 'graph', text: /cache read 500/ })).toBeUndefined()
  await ui.pointer({ type: 'down', button: 'left', x: 8, y: 3, in: 'graph' })
  expect(await ui.find({ in: 'graph', text: /cache read 500/ })).toBeDefined()
  expect(await ui.find({ in: 'graph', text: /effort\s+high/ })).toBeDefined()
  expect(await ui.find({ in: 'graph', text: /cache read 500/ })).toBeDefined()
  await ui.pointer({ type: 'down', button: 'left', x: 8, y: 3, in: 'graph' })
  expect(await ui.find({ in: 'graph', text: /cache read 500/ })).toBeUndefined()

  await ui.key({ key: 'down', in: 'graph' })
  await ui.key({ key: 'down', in: 'graph' })
  await ui.key({ key: 'return', in: 'graph' })
  expect(await ui.find({ in: 'graph', text: /cache read 500/ })).toBeDefined()

  await ui.press({ key: 'clear' })
  expect(await ui.find({ in: 'graph', text: /0 subagents/ })).toBeDefined()
})
