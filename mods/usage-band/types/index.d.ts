export type Segment = {
  label: string
  value: string
  color: string
  /** Set from 75% (yellow) and 90% (red); the value is drawn in the default color otherwise. */
  level?: 'yellow' | 'red'
  /** Trailing text in the default color, such as when a window resets. */
  note?: string
}

/** One line of the pane: a category, a tool, a skill. */
export type Row = {
  name: string
  tokens: number
  /** Drawn dim: free space, or a tool whose schema is not in the window. */
  dim?: boolean
  note?: string
}

/** Rows under one heading: a skill source or an MCP server. */
export type Group = { name: string; tokens: number; note?: string; rows: Row[] }

/** What the pane draws; the band's figures come from the same breakdown. */
export type Detail = {
  /** The context window, in tokens. */
  max: number
  /** Tokens in use. */
  total: number
  context: Row[]
  cache?: { hit: number; read: number; write: number }
  tools: { tokens: number; rows: Row[] }
  skills: { included: number; total: number; tokens: number; groups: Group[] }
  mcp: { loaded: number; total: number; tokens: number; groups: Group[] }
}

declare module 'claude-code' {
  interface PluginState {
    'usage-band': {
      text: Segment[] | null
      /** The main loop's model, short, once a request has named it. */
      model: string | null
      /** The main loop's effort level, when the model takes one. */
      effort: string | null
      /** Whether the pane is open; the band redraws when the toggle flips it. */
      open: boolean
      /** The pane's content, null before the first measurement. */
      detail: Detail | null
      /** Ids of the pane sections and groups the person flipped from how they start: everything starts shut but `context`. */
      flipped: string[]
    }
  }
}
