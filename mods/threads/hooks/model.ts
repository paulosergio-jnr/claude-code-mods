import type { Kind, Scope, Suggestion, Thread, ThreadStore } from '../types'

export const KINDS: readonly Kind[] = ['question', 'doubt', 'explore', 'decision']

export const GLYPH: Record<Kind | 'none', string> = {
  question: '?',
  doubt: '!',
  explore: '◇',
  decision: '◆',
  none: '·',
}

export const DONE_DELAY_MS = 30_000
export const MAX_SUGGESTIONS = 10
export const MAX_PER_TURN = 5

export const emptyStore = (): ThreadStore => ({ nextId: 1, threads: [] })

export const scopeOf = (id: string): Scope => (id.startsWith('p') ? 'project' : 'session')

const isKind = (value: unknown): value is Kind => KINDS.some(k => k === value)

export const glyphOf = (kind: Kind | undefined) => GLYPH[kind ?? 'none']

/** Titles compare ignoring case and spacing. */
export const normalize = (title: string) => title.toLowerCase().replace(/\s+/g, ' ').trim()

export function clip(text: string, max: number) {
  const line = text.replace(/\s+/g, ' ').trim()
  return max > 1 && line.length > max ? line.slice(0, max - 1) + '…' : line
}

export type NewThread = { title: string; note?: string; kind?: Kind; status?: Thread['status'] }

export function addThread(store: ThreadStore, scope: Scope, input: NewThread) {
  const thread: Thread = {
    id: `${scope === 'project' ? 'p' : 's'}${store.nextId}`,
    title: input.title.trim(),
    status: input.status ?? 'open',
  }
  if (input.note?.trim()) thread.note = input.note.trim()
  if (input.kind) thread.kind = input.kind
  return { thread, store: { nextId: store.nextId + 1, threads: [...store.threads, thread] } }
}

export const find = (store: ThreadStore, id: string) => store.threads.find(t => t.id === id)

export const remove = (store: ThreadStore, id: string): ThreadStore => ({
  ...store,
  threads: store.threads.filter(t => t.id !== id),
})

export const change = (store: ThreadStore, id: string, patch: Partial<Thread>): ThreadStore => ({
  ...store,
  threads: store.threads.map(t => (t.id === id ? { ...t, ...patch } : t)),
})

/** Finishes an open thread, or reopens a finished one. With `delay`, a finished thread is set to expire. */
export function toggleDone(store: ThreadStore, id: string, now: number, delay: number | undefined): ThreadStore {
  const thread = find(store, id)
  if (!thread) return store
  if (thread.status === 'done') {
    const { expiresAt: _expiresAt, ...rest } = thread
    return { ...store, threads: store.threads.map(t => (t.id === id ? { ...rest, status: 'open' } : t)) }
  }
  return change(store, id, { status: 'done', expiresAt: delay === undefined ? undefined : now + delay })
}

export const hasPending = (store: ThreadStore) => store.threads.some(t => t.expiresAt !== undefined)

export const isExpired = (store: ThreadStore, now: number) =>
  store.threads.some(t => t.expiresAt !== undefined && t.expiresAt <= now)

export const sweep = (store: ThreadStore, now: number): ThreadStore => ({
  ...store,
  threads: store.threads.filter(t => t.expiresAt === undefined || t.expiresAt > now),
})

/** Reads a project file; undefined when the text is not a thread store. */
export function parseStore(text: string): ThreadStore | undefined {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof data !== 'object' || data === null) return undefined
  const { nextId, threads } = data as { nextId?: unknown; threads?: unknown }
  if (typeof nextId !== 'number' || !Array.isArray(threads)) return undefined

  const kept: Thread[] = []
  for (const raw of threads as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue
    const t = raw as Record<string, unknown>
    if (typeof t.id !== 'string' || typeof t.title !== 'string') continue
    const thread: Thread = { id: t.id, title: t.title, status: t.status === 'done' ? 'done' : 'open' }
    if (typeof t.note === 'string') thread.note = t.note
    if (isKind(t.kind)) thread.kind = t.kind
    if (typeof t.expiresAt === 'number') thread.expiresAt = t.expiresAt
    kept.push(thread)
  }
  return { nextId, threads: kept }
}

/** What the model sent to `suggest_threads`, cleaned: titles only, a known kind or none. */
export function parseSuggestions(input: unknown): Suggestion[] {
  if (!Array.isArray(input)) return []
  const out: Suggestion[] = []
  for (const raw of input as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue
    const { title, kind } = raw as { title?: unknown; kind?: unknown }
    if (typeof title !== 'string' || !title.trim()) continue
    out.push(isKind(kind) ? { title: title.trim(), kind } : { title: title.trim() })
  }
  return out
}

/**
 * Adds what is new to the list of suggestions: not already a thread, not already suggested, not a repeat
 * inside `incoming`. At most `room` are taken; the list keeps its newest `MAX_SUGGESTIONS`.
 */
export function addSuggestions(list: Suggestion[], incoming: Suggestion[], known: string[], room: number) {
  const seen = new Set([...known, ...list.map(s => s.title)].map(normalize))
  const fresh: Suggestion[] = []
  for (const s of incoming) {
    if (fresh.length >= room) break
    const key = normalize(s.title)
    if (seen.has(key)) continue
    seen.add(key)
    fresh.push(s)
  }
  return { list: [...list, ...fresh].slice(-MAX_SUGGESTIONS), taken: fresh.length }
}
