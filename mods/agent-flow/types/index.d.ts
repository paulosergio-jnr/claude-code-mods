export type AgentStatus = 'working' | 'idle' | 'done' | 'failed'

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
}

export type FlowKind = 'task' | 'result' | 'message'

export type Flow = {
  id: string
  from: string
  to: string
  kind: FlowKind
  text: string
}

declare module 'claude-code' {
  interface PluginState {
    'agent-flow': { agents: AgentNode[]; flows: Flow[] }
  }
}
