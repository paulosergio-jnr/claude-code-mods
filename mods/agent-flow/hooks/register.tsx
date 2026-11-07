import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentNode, AgentState, Flow, FlowKind } from '../types'

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

const MAX_SEGMENTS = 150
const KEEP_MS = 31 * 60_000 // a little more than the widest timeline window
const MAX_TOKEN_LOG = 80

// Closes the open stretch and opens `state` (or none) at `now`; the same state keeps going.
function moveTo(a: AgentNode, state: AgentState | undefined, now: number): AgentNode {
  const segments = a.segments ?? []
  const last = segments[segments.length - 1]
  if (last && last.to === undefined && last.state === state) return a
  const closed = segments.map(s => (s.to === undefined ? { ...s, to: now } : s))
  const next = state ? [...closed, { state, from: now }] : closed
  return { ...a, segments: next.filter(s => (s.to ?? now) > now - KEEP_MS).slice(-MAX_SEGMENTS) }
}

// Waiting while a subagent works for it; thinking otherwise.
const resting = (list: AgentNode[], id: string): AgentState =>
  list.some(c => c.parentId === id && c.status === 'working') ? 'waiting' : 'thinking'

function patch($: EngineInterface, id: string, fn: (a: AgentNode) => AgentNode) {
  return update($, agents, list => list.map(a => (a.id === id ? fn(a) : a)))
}

async function flow($: EngineInterface, from: string, to: string, kind: FlowKind, text: string) {
  const now = await $.clock.now()
  const one: Flow = { id: `${now}-${flowSeq++}`, from, to, kind, text: clip(text), at: now }
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
    const now = await $.clock.now()
    await patch($, MAIN, a => ({
      ...moveTo(a, 'thinking', now),
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
      segments: [{ state: 'thinking', from: now }],
    }
    await update($, agents, list => [...list.filter(a => a.id !== node.id), node])
    await patch($, parent, a => (a.status === 'working' ? moveTo(a, 'waiting', now) : a))
    await flow($, parent, node.id, 'task', e.prompt)

    if (autoOpen !== 'never' && !(await $.ui.panes()).some(p => p.id === PANE)) void openPane($).catch(() => undefined)
    return started
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId ?? MAIN
    if (!(await known($, id))) return next(e)

    const skill = e.tool === 'Skill' ? e.skill : undefined
    const began = await $.clock.now()
    await patch($, id, a => ({
      ...moveTo(a, 'acting', began),
      status: 'working',
      tool: e.tool,
      tools: a.tools + 1,
      toolCounts: { ...a.toolCounts, [e.tool]: (a.toolCounts?.[e.tool] ?? 0) + 1 },
      skills: skill && !a.skills?.includes(skill) ? [...(a.skills ?? []), skill] : a.skills,
    }))
    const ran = await next(e)
    const ended = await $.clock.now()
    const list = await read($, agents)
    await patch($, id, a => (a.tool === e.tool ? { ...moveTo(a, resting(list, id), ended), tool: undefined } : a))
    return ran
  })

  on('turn.step', async function* ($, e, next) {
    const id = e.agentId ?? MAIN
    if (!(await known($, id))) return yield* next(e)

    await patch($, id, a => ({ ...a, model: e.model, effort: e.effort }))
    const answered = yield* next(e)
    const usage = answered.usage
    if (usage) {
      const at = await $.clock.now()
      const input = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
      await patch($, id, a => ({
        ...a,
        model: usage.model,
        tokensIn: (a.tokensIn ?? 0) + input,
        tokensOut: (a.tokensOut ?? 0) + usage.output_tokens,
        cacheRead: (a.cacheRead ?? 0) + usage.cache_read_input_tokens,
        tokenLog: [...(a.tokenLog ?? []), { t: at, out: usage.output_tokens }]
          .filter(x => x.t > at - KEEP_MS)
          .slice(-MAX_TOKEN_LOG),
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

    const now = await $.clock.now()
    if (id === MAIN) {
      await patch($, MAIN, a => ({
        ...moveTo(a, 'waiting', now),
        status: 'idle',
        tool: undefined,
        answer: keep(e.answer, ANSWER_MAX),
      }))
    } else {
      const isOk = e.reason === 'answer'
      await patch($, id, a => ({
        ...moveTo(a, undefined, now),
        status: isOk ? 'done' : 'failed',
        tool: undefined,
        endedAt: now,
        answer: keep(e.answer || e.reason, ANSWER_MAX),
      }))
      await flow($, id, node.parentId ?? MAIN, 'result', e.answer || e.reason)

      // The parent stops waiting once its last working subagent is done.
      const parent = node.parentId ?? MAIN
      const after = await read($, agents)
      await patch($, parent, a => {
        const last = a.segments?.[(a.segments?.length ?? 1) - 1]
        const isWaiting = a.status === 'working' && last?.to === undefined && last?.state === 'waiting'
        return isWaiting && resting(after, parent) === 'thinking' ? moveTo(a, 'thinking', now) : a
      })
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, agents)
    const recent = await read($, flows)
    const now = await $.clock.now()

    if (e.surface === 'terminal' || e.surface === 'desktop') {
      const { Box, Client, Button } = $.ui.resolve(e)
      return (
        <Box flexDirection="column" flexGrow={1}>
          <Client key="graph" module="./graph.tsx" props={{ agents: list, flows: recent, now }} flexGrow={1} />
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
