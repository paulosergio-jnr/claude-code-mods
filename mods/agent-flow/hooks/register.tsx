import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentNode, Flow, FlowKind } from '../types'

const PANE = 'agent-flow'
const MAIN = 'main'
const ORCHESTRATOR: AgentNode = { id: MAIN, label: 'orchestrator', type: 'main', status: 'idle', tools: 0 }

const agents = atom({ plugin: 'agent-flow', key: 'agents' } as const, [ORCHESTRATOR])
const flows = atom({ plugin: 'agent-flow', key: 'flows' } as const, [])

const clip = (text: string, max = 80) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

const PROMPT_MAX = 2000
const ANSWER_MAX = 1200

const keep = (text: string, max: number) => (text.length > max ? text.slice(0, max - 1) + '…' : text)

let flowSeq = 0

function patch($: EngineInterface, id: string, fn: (a: AgentNode) => AgentNode) {
  return update($, agents, list => list.map(a => (a.id === id ? fn(a) : a)))
}

async function flow($: EngineInterface, from: string, to: string, kind: FlowKind, text: string) {
  const now = await $.clock.now()
  const one: Flow = { id: `${now}-${flowSeq++}`, from, to, kind, text: clip(text) }
  await update($, flows, list => [...list, one].slice(-60))
}

async function known($: EngineInterface, id: string) {
  return (await read($, agents)).some(a => a.id === id)
}

function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: 'Agent flow' })
}

type AutoOpen = 'never' | 'on-subagent' | 'always'
const AUTO_OPEN: readonly AutoOpen[] = ['never', 'on-subagent', 'always']

export const register: Register = (on, options) => {
  const autoOpen = AUTO_OPEN.find(v => v === options.autoOpen) ?? 'on-subagent'

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'agent-flow', description: 'Show the orchestrator and its subagents in an animated pane' })
    if (autoOpen === 'always') void openPane($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'agent-flow' }, async $ => {
    await openPane($)
    return { text: 'Agent flow pane opened.' }
  })

  on('turn.start', async ($, e, next) => {
    await patch($, MAIN, a => ({
      ...a,
      status: 'working',
      tool: undefined,
      prompt: e.text ? keep(e.text, PROMPT_MAX) : a.prompt,
    }))
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined || started.agentId === undefined) return started

    const parent = e.parentAgentId ?? MAIN
    const now = await $.clock.now()
    const node: AgentNode = {
      id: started.agentId,
      parentId: parent,
      label: e.description || e.subagentType,
      type: e.subagentType,
      name: e.name,
      status: 'working',
      tools: 0,
      model: started.model,
      prompt: keep(e.prompt, PROMPT_MAX),
      background: e.background,
      startedAt: now,
    }
    await update($, agents, list => [...list.filter(a => a.id !== node.id), node])
    await flow($, parent, node.id, 'task', e.prompt)

    if (autoOpen !== 'never' && !(await $.ui.panes()).some(p => p.id === PANE)) void openPane($).catch(() => undefined)
    return started
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId ?? MAIN
    if (!(await known($, id))) return next(e)

    const skill = e.tool === 'Skill' ? e.skill : undefined
    await patch($, id, a => ({
      ...a,
      status: 'working',
      tool: e.tool,
      tools: a.tools + 1,
      toolCounts: { ...a.toolCounts, [e.tool]: (a.toolCounts?.[e.tool] ?? 0) + 1 },
      skills: skill && !a.skills?.includes(skill) ? [...(a.skills ?? []), skill] : a.skills,
    }))
    const ran = await next(e)
    await patch($, id, a => (a.tool === e.tool ? { ...a, tool: undefined } : a))
    return ran
  })

  on('turn.step', async function* ($, e, next) {
    const id = e.agentId ?? MAIN
    if (!(await known($, id))) return yield* next(e)

    await patch($, id, a => ({ ...a, model: e.model, effort: e.effort }))
    const answered = yield* next(e)
    const usage = answered.usage
    if (usage) {
      const input = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
      await patch($, id, a => ({
        ...a,
        model: usage.model,
        tokensIn: (a.tokensIn ?? 0) + input,
        tokensOut: (a.tokensOut ?? 0) + usage.output_tokens,
        cacheRead: (a.cacheRead ?? 0) + usage.cache_read_input_tokens,
      }))
    }
    return answered
  })

  on('session.send', async ($, e, next) => {
    const sent = await next(e)
    if (!sent.isDelivered) return sent

    const list = await read($, agents)
    const to = list.find(a => a.id === e.to || a.name === e.to)
    if (to) await flow($, e.agentId ?? MAIN, to.id, 'message', e.text)
    return sent
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId ?? MAIN
    const list = await read($, agents)
    const node = list.find(a => a.id === id)
    if (!node) return next(e)

    if (id === MAIN) {
      await patch($, MAIN, a => ({ ...a, status: 'idle', tool: undefined, answer: keep(e.answer, ANSWER_MAX) }))
    } else {
      const now = await $.clock.now()
      const isOk = e.reason === 'answer'
      await patch($, id, a => ({
        ...a,
        status: isOk ? 'done' : 'failed',
        tool: undefined,
        endedAt: now,
        answer: keep(e.answer || e.reason, ANSWER_MAX),
      }))
      await flow($, id, node.parentId ?? MAIN, 'result', e.answer || e.reason)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, agents)
    const recent = await read($, flows)

    if (e.surface === 'terminal' || e.surface === 'desktop') {
      const { Box, Client, Button } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Client key="graph" module="./graph.tsx" props={{ agents: list, flows: recent }} />
          <Box marginTop={1}>
            <Button key="clear" onPress={async () => {
              await update($, agents, all => all.filter(a => a.id === MAIN || a.status === 'working'))
              await update($, flows, () => [])
            }}>clear finished</Button>
          </Box>
        </Box>
      )
    }

    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {list.map(a => (
          <Text dimColor={a.status !== 'working'}>
            {a.id === MAIN ? '' : '  └ '}
            {a.label} · {a.status}
            {a.tool ? ` · ${a.tool}` : ''}
          </Text>
        ))}
      </Box>
    )
  })
}
