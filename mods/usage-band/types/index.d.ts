export type Segment = {
  label: string
  value: string
  color: string
  /** Set from 75% (yellow) and 90% (red); the value is drawn in the default color otherwise. */
  level?: 'yellow' | 'red'
  /** Trailing text in the default color, such as when a window resets. */
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    'usage-band': {
      text: Segment[] | null
      /** The main loop's model, short, once a request has named it. */
      model: string | null
      /** The main loop's effort level, when the model takes one. */
      effort: string | null
      /** Whether the row of tools, skills and MCP under the band is shown. */
      open: boolean
    }
  }
}
