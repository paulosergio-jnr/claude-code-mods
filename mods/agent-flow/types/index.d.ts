export type AgentStatus = 'working' | 'idle' | 'done' | 'failed'

/** What a working agent is doing: orange, blue or green on the timeline. */
export type AgentState = 'thinking' | 'acting' | 'waiting'

/** A stretch of time an agent spent in one state; `to` is absent while it lasts. */
export type Segment = { state: AgentState; from: number; to?: number }

export type AgentNode = {
  id: string
  parentId?: string
  label: string
  type: string
  name?: string
  status: AgentStatus
  tool?: string
  tools: number
  model?: string
  effort?: string | number
  tokensIn?: number
  tokensOut?: number
  cacheRead?: number
  prompt?: string
  answer?: string
  toolCounts?: Record<string, number>
  skills?: string[]
  background?: boolean
  startedAt?: number
  endedAt?: number
  segments?: Segment[]
  tokenLog?: { t: number; out: number }[]
}

export type FlowKind = 'task' | 'result' | 'message'

export type Flow = {
  id: string
  from: string
  to: string
  kind: FlowKind
  text: string
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-flow': { agents: AgentNode[]; flows: Flow[] }
  }
}
