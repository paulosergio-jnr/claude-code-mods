export type Kind = 'question' | 'doubt' | 'explore' | 'decision'

export type Scope = 'project' | 'session'

/** One open (or finished) line of the pane. `id` is `p<n>` in the project file, `s<n>` in the session. */
export type Thread = {
  id: string
  title: string
  note?: string
  kind?: Kind
  status: 'open' | 'done'
  /** Set only while a finished thread waits to be deleted (`doneRetention: delete`). */
  expiresAt?: number
}

/** A scope's threads and the counter its ids come from; an id is never reused. */
export type ThreadStore = { nextId: number; threads: Thread[] }

/** What Claude proposed; it becomes a session thread when accepted. */
export type Suggestion = { title: string; kind?: Kind }

/** The add/edit form: the pane shows it in place of the lists. */
export type Form = { mode: 'add' | 'edit'; scope: Scope; id?: string; title: string; note: string; kind: Kind | null }

export type PaneUi = { selected: string | null; showDone: boolean; form: Form | null }

declare module 'claude-code' {
  interface PluginState {
    threads: {
      session: Shaped<ThreadStore>
      project: Shaped<ThreadStore>
      suggestions: Shaped<Suggestion[]>
      ui: Shaped<PaneUi>
      /** Bumped once a second while a deletion is pending, so the Undo countdown redraws. */
      tick: Shaped<number>
    }
  }
}
