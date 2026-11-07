import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Form, Kind, PaneUi, Scope, Suggestion, ThreadStore } from '../types'
import {
  DONE_DELAY_MS,
  KINDS,
  KIND_COLOR,
  MAX_PER_TURN,
  addSuggestions,
  addThread,
  change,
  clip,
  colorOf,
  emptyStore,
  find,
  glyphOf,
  hasPending,
  isExpired,
  parseStore,
  parseSuggestions,
  remove,
  scopeOf,
  sweep,
  toggleDone,
} from './model'
import { mutateProject, projectStamp, readProject } from './storage'

const PANE = 'threads'
const KEPT_DAYS = 30
const DAY_MS = 86_400_000
const SUGGEST_TOOL = 'mcp__threads__suggest_threads'

const session = atom({ plugin: 'threads', key: 'session' } as const, emptyStore(), { shape: 'store-1' })
const project = atom({ plugin: 'threads', key: 'project' } as const, emptyStore(), { shape: 'store-1' })
const suggestions = atom({ plugin: 'threads', key: 'suggestions' } as const, [] as Suggestion[], {
  shape: 'suggestions-1',
})
const INITIAL_UI: PaneUi = { selected: null, showDone: false, form: null }
const ui = atom({ plugin: 'threads', key: 'ui' } as const, INITIAL_UI, { shape: 'ui-1' })
const tick = atom({ plugin: 'threads', key: 'tick' } as const, 0, { shape: 'tick-1' })

type Settings = {
  isSuggesting: boolean
  visibility: 'at-start' | 'at-suggestion' | 'manual'
  retention: 'keep' | 'delete'
}

const GUIDANCE = [
  'The user keeps a list of open threads in a side pane: unresolved questions, doubts, deferred items and undecided choices.',
  'When your reply leaves one of these open (a question you asked that is still unanswered, something you set aside as "later" or out of scope, a doubt of the user that is not settled, a decision left open), call suggest_threads once, at the end of the turn, with up to 5 short titles.',
  'Be selective: skip what you resolved in this turn, plain to-dos, and anything already listed. Never mention the call in your reply.',
].join(' ')

// Drafts of the open form live outside the state: each keystroke would redraw the pane.
let draft: { title: string; note: string } | null = null
// Suggestions taken in the turn that runs, against the limit per turn.
let perTurn = 0
let isAutoOpened = false
// Each form gets Inputs of their own: the surface keeps what was typed in an Input until its key changes.
let formSeq = 0
let lastStamp = -1
let ticks = 0

const KIND_LABEL: Record<Kind, string> = {
  question: 'question',
  doubt: 'doubt',
  explore: 'explore',
  decision: 'decision',
}

const openPane = ($: EngineInterface, isFocused = false) =>
  $.ui.open(isFocused ? { id: PANE, title: 'Threads', focus: true } : { id: PANE, title: 'Threads' })

const isOpen = async ($: EngineInterface) => (await $.ui.panes()).some(p => p.id === PANE)

const fail = ($: EngineInterface, error: unknown) =>
  $.ui.toast(`threads: ${error instanceof Error ? error.message : String(error)}`)

// Session threads outlive the process in the plugin's store, so `--resume` brings them back.
const sessionKey = async ($: EngineInterface) => `session:${await $.session.id()}`

async function saveSession($: EngineInterface) {
  const store = await read($, session)
  const key = await sessionKey($)
  if (store.nextId === 1) await $.store.delete(key)
  else await $.store.set(key, { store, savedAt: await $.clock.now() })
}

async function restoreSession($: EngineInterface) {
  if ((await read($, session)).nextId !== 1) return
  const kept = (await $.store.get(await sessionKey($))) as { store?: unknown } | undefined
  const store = kept?.store ? parseStore(JSON.stringify(kept.store)) : undefined
  if (store) await update($, session, () => store)
}

// Entries of sessions nobody came back to are dropped.
async function pruneSessions($: EngineInterface) {
  const now = await $.clock.now()
  for (const key of await $.store.keys()) {
    if (!key.startsWith('session:')) continue
    const kept = (await $.store.get(key)) as { savedAt?: unknown } | undefined
    if (typeof kept?.savedAt !== 'number' || now - kept.savedAt > KEPT_DAYS * DAY_MS) await $.store.delete(key)
  }
}

// Applies `fn` to a scope's store: the session's in the state, the project's in its file under a lock.
async function edit($: EngineInterface, scope: Scope, fn: (store: ThreadStore) => ThreadStore) {
  try {
    if (scope === 'session') {
      await update($, session, fn)
      await saveSession($)
      return
    }
    const next = await mutateProject($, fn)
    lastStamp = await projectStamp($)
    await update($, project, () => next)
  } catch (error) {
    fail($, error)
  }
}

async function reloadProject($: EngineInterface, force = false) {
  try {
    const stamp = await projectStamp($)
    if (!force && stamp === lastStamp) return
    lastStamp = stamp
    const next = await readProject($)
    await update($, project, () => next)
  } catch (error) {
    fail($, error)
  }
}

async function mutateUi($: EngineInterface, fn: (state: PaneUi) => PaneUi) {
  await update($, ui, fn)
}

async function addToScope($: EngineInterface, scope: Scope, input: { title: string; note?: string; kind?: Kind }) {
  let id = ''
  await edit($, scope, store => {
    const added = addThread(store, scope, input)
    id = added.thread.id
    return added.store
  })
  return id
}

async function finish($: EngineInterface, settings: Settings, id: string) {
  const now = await $.clock.now()
  const delay = settings.retention === 'delete' ? DONE_DELAY_MS : undefined
  await edit($, scopeOf(id), store => toggleDone(store, id, now, delay))
}

async function destroy($: EngineInterface, id: string) {
  await edit($, scopeOf(id), store => remove(store, id))
  await mutateUi($, s => (s.selected === id ? { ...s, selected: null } : s))
}

// Moves a thread to the other scope. It lands first, so a failure never loses it.
async function move($: EngineInterface, id: string) {
  const from = scopeOf(id)
  const to: Scope = from === 'project' ? 'session' : 'project'
  const store = from === 'project' ? await read($, project) : await read($, session)
  const thread = find(store, id)
  if (!thread) return
  const copy = { title: thread.title, note: thread.note, kind: thread.kind, status: thread.status }
  const landed = await addToScope($, to, copy)
  if (!landed) return
  await edit($, from, store => remove(store, id))
  await mutateUi($, s => ({ ...s, selected: landed }))
}

async function acceptSuggestion($: EngineInterface, title: string) {
  const list = await read($, suggestions)
  const found = list.find(s => s.title === title)
  if (!found) return
  await update($, suggestions, all => all.filter(s => s.title !== title))
  await addToScope($, 'session', found.kind ? { title, kind: found.kind } : { title })
}

const dismissSuggestion = ($: EngineInterface, title: string) =>
  update($, suggestions, all => all.filter(s => s.title !== title))

async function openForm($: EngineInterface, form: Form) {
  formSeq++
  draft = { title: form.title, note: form.note }
  await mutateUi($, s => ({ ...s, form }))
}

async function closeForm($: EngineInterface) {
  draft = null
  await mutateUi($, s => ({ ...s, form: null }))
}

async function saveForm($: EngineInterface) {
  const { form } = await read($, ui)
  const text = draft
  if (!form || !text) return
  const title = text.title.trim()
  if (!title) return
  const note = text.note.trim()
  const kind = form.kind ?? undefined

  if (form.mode === 'add') {
    const id = await addToScope($, form.scope, { title, note, kind })
    await mutateUi($, s => ({ ...s, selected: id || s.selected }))
  } else if (form.id) {
    await edit($, form.scope, store =>
      change(store, form.id as string, { title, note: note || undefined, kind }),
    )
  }
  await closeForm($)
}

// What a tick does once a second while the session lives.
async function onTick($: EngineInterface) {
  ticks++
  const now = await $.clock.now()
  const mine = await read($, session)
  const shared = await read($, project)

  if (isExpired(mine, now)) await edit($, 'session', store => sweep(store, now))
  if (isExpired(shared, now)) await edit($, 'project', store => sweep(store, now))
  if (hasPending(mine) || hasPending(shared)) await update($, tick, n => n + 1)

  // Another session may have changed the file.
  if (ticks % 2 === 0) await reloadProject($)
}

function parseThreadArgs(args: string) {
  const match = /^--project(?:\s+|$)/.exec(args.trim())
  return match
    ? { scope: 'project' as const, title: args.trim().slice(match[0].length).trim() }
    : { scope: 'session' as const, title: args.trim() }
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    isSuggesting: options.suggestions !== 'off',
    visibility:
      options.paneVisibility === 'at-start' || options.paneVisibility === 'at-suggestion'
        ? options.paneVisibility
        : 'manual',
    retention: options.doneRetention === 'delete' ? 'delete' : 'keep',
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'threads', description: 'Show or hide the Threads pane' })
    await $.command.register({
      name: 'thread',
      description: 'Add a thread: an open question, doubt or idea to come back to',
      argumentHint: '[--project] <text>',
    })
    if (settings.isSuggesting) {
      await $.tool.register({
        name: 'suggest_threads',
        description:
          'Propose threads for the user to keep: unresolved questions, deferred items and undecided choices that this reply leaves open. At most 5 per turn; they appear in the Threads pane for the user to accept or dismiss.',
        inputSchema: {
          type: 'object',
          properties: {
            threads: {
              type: 'array',
              maxItems: MAX_PER_TURN,
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: 'One short line' },
                  kind: { type: 'string', enum: [...KINDS] },
                },
                required: ['title'],
              },
            },
          },
          required: ['threads'],
        },
        isDeferred: false,
      })
    }

    await restoreSession($).catch(() => undefined)
    await pruneSessions($).catch(() => undefined)
    await reloadProject($, true)
    $.clock.every(1000, () => {
      void onTick($).catch(() => undefined)
    })
    if (settings.visibility === 'at-start') void openPane($).catch(() => undefined)
    return next(e)
  })

  // A /clear ends the session and starts none: what belongs to the session goes with it.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      draft = null
      await $.store.delete(await sessionKey($)).catch(() => undefined)
      await update($, session, () => emptyStore())
      await update($, suggestions, () => [])
      await update($, ui, () => INITIAL_UI)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    perTurn = 0
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!settings.isSuggesting) return composed
    return { sections: [...composed.sections, { id: 'threads:suggest', text: GUIDANCE, scope: 'session' as const }] }
  })

  on('tool.call', { tool: SUGGEST_TOOL }, async ($, e) => {
    if (!settings.isSuggesting) return { deny: 'Suggested threads are switched off.' }

    const incoming = parseSuggestions((e as unknown as { threads?: unknown }).threads)
    const known = [...(await read($, session)).threads, ...(await read($, project)).threads].map(t => t.title)
    const room = Math.max(0, MAX_PER_TURN - perTurn)
    let taken = 0
    await update($, suggestions, list => {
      const added = addSuggestions(list, incoming, known, room)
      taken = added.taken
      return added.list
    })
    perTurn += taken

    if (taken > 0 && settings.visibility === 'at-suggestion' && !isAutoOpened) {
      isAutoOpened = true
      if (!(await isOpen($))) void openPane($).catch(() => undefined)
    }

    const skipped = incoming.length - taken
    return {
      result:
        `Queued ${taken} suggested thread${taken === 1 ? '' : 's'} for the user.` +
        (skipped > 0 ? ` ${skipped} not queued (duplicates, or over the limit of ${MAX_PER_TURN} per turn).` : ''),
    }
  })

  on('command.run', { command: 'threads' }, async $ => {
    if (await isOpen($)) {
      await $.ui.close({ id: PANE })
      return { text: 'Threads pane closed.' }
    }
    await openPane($, true)
    return { text: 'Threads pane opened.' }
  })

  on('command.run', { command: 'thread' }, async ($, e) => {
    const { scope, title } = parseThreadArgs(e.args)
    if (!title) return { text: 'Usage: /thread [--project] <text>' }
    const id = await addToScope($, scope, { title })
    return { text: id ? `Added ${id}: ${clip(title, 80)}` : 'Could not add the thread.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const mine = await read($, session)
    const shared = await read($, project)
    const proposed = await read($, suggestions)
    const state = await read($, ui)
    await read($, tick)
    const now = await $.clock.now()
    const columns = Math.max(24, e.props.bodyColumns ?? 40)
    const room = columns - 16

    // The pane's own title shows only as a tab beside other panes, so the body names the mod.
    const open = [...shared.threads, ...mine.threads].filter(t => t.status === 'open').length
    const titleBar = (
      <Box key="title-bar" justifyContent="center" marginBottom={1}>
        <Text bold color="claude">Threads</Text>
        <Text color="subtle">{open > 0 ? ` · ${open} open` : ''}</Text>
      </Box>
    )

    // ---- the add / edit form replaces the lists
    if (state.form) {
      const form = state.form
      const text = draft ?? { title: form.title, note: form.note }
      return (
        <Box flexDirection="column">
          {titleBar}
          <Text bold>
            {form.mode === 'add' ? `New ${form.scope} thread` : `Edit ${form.id ?? 'thread'}`}
          </Text>
          <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
            {KINDS.map(kind => (
              <Button
                key={`kind-${kind}`}
                plain
                dimColor={form.kind !== kind}
                onPress={() => mutateUi($, s => (s.form ? { ...s, form: { ...s.form, kind: s.form.kind === kind ? null : kind } } : s))}
              >
                <Text color={KIND_COLOR[kind]} bold={form.kind === kind} dimColor={form.kind !== kind}>
                  {`${form.kind === kind ? '●' : '○'} ${glyphOf(kind)} ${KIND_LABEL[kind]}  `}
                </Text>
              </Button>
            ))}
          </Box>
          <Input
            key={`title-${formSeq}`}
            label="title "
            placeholder="what to come back to"
            value={text.title}
            autoFocus
            onInput={value => {
              draft = { title: value, note: draft?.note ?? form.note }
            }}
            onSubmit={value => {
              draft = { title: value, note: draft?.note ?? form.note }
              void saveForm($)
            }}
          />
          <Input
            key={`note-${formSeq}`}
            label="note  "
            placeholder="optional detail"
            rows={2}
            value={text.note}
            onInput={value => {
              draft = { title: draft?.title ?? form.title, note: value }
            }}
            onSubmit={value => {
              draft = { title: draft?.title ?? form.title, note: value }
              void saveForm($)
            }}
          />
          <Box marginTop={1}>
            <Button key="save" variant="primary" onPress={() => saveForm($)}>save</Button>
            <Button key="cancel" onPress={() => closeForm($)}>cancel</Button>
          </Box>
          <Text color="inactive">↵ save · Tab next field</Text>
        </Box>
      )
    }

    // ---- the lists
    const addForm = (scope: Scope) =>
      openForm($, { mode: 'add', scope, title: '', note: '', kind: null })

    const header = (label: string, count: number, scope?: Scope, color?: string) => (
      <Box key={`head-${label}`}>
        <Text bold color={color}>{label}</Text>
        <Text color="subtle">{` · ${count}`}</Text>
        <Box flexGrow={1} />
        {scope && (
          <Button key={`add-${scope}`} plain hotkey={scope === 'project' ? 'p' : 's'} onPress={() => addForm(scope)}>
            <Text color="success">[+]</Text>
          </Button>
        )}
      </Box>
    )

    const rule = (name: string) => (
      <Text key={`rule-${name}`} color="inactive">{'─'.repeat(Math.max(4, columns - 2))}</Text>
    )

    const row = (id: string) => {
      const store = scopeOf(id) === 'project' ? shared : mine
      const t = find(store, id)
      if (!t) return null
      const isSelected = state.selected === id
      const isDone = t.status === 'done'
      const left = Math.max(0, Math.ceil(((t.expiresAt ?? now) - now) / 1000))
      const label = clip(t.title, room)
      const arrow = scopeOf(id) === 'project' ? '[↓]' : '[↑]'

      return (
        <Box key={`thread-${id}`} flexDirection="column">
          <Box>
            <Button
              key={`row-${id}`}
              plain
              onPress={() => mutateUi($, s => ({ ...s, selected: s.selected === id ? null : id }))}
            >
              <Text bold color="claude">{isSelected ? '▌' : ' '}</Text>
              <Text color={isDone ? 'success' : colorOf(t.kind)}>{isDone ? '✓' : glyphOf(t.kind)}</Text>
              <Text color="subtle">{` ${id} `}</Text>
              <Text bold={isSelected} dimColor={isDone} strikethrough={isDone}>{label}</Text>
            </Button>
            <Box flexGrow={1} />
            {t.expiresAt !== undefined ? (
              <Button key={`undo-${id}`} plain onPress={() => finish($, settings, id)}>
                <Text color={left <= 5 ? 'error' : 'warning'}>{`[Undo ${left}s]`}</Text>
              </Button>
            ) : (
              <Button key={`move-${id}`} plain onPress={() => move($, id)}>
                <Text color="subtle">{arrow}</Text>
              </Button>
            )}
          </Box>
          {isSelected && (
            <Box flexDirection="column" paddingLeft={3}>
              {t.note && <Text color="subtle" wrap="wrap">{t.note}</Text>}
              <Box>
                <Button key="act-done" plain hotkey="d" onPress={() => finish($, settings, id)}>
                  {isDone ? 'reopen' : 'done'}
                </Button>
                <Text>{'  '}</Text>
                <Button
                  key="act-edit"
                  plain
                  hotkey="e"
                  onPress={() =>
                    openForm($, {
                      mode: 'edit',
                      scope: scopeOf(id),
                      id,
                      title: t.title,
                      note: t.note ?? '',
                      kind: t.kind ?? null,
                    })
                  }
                >
                  edit
                </Button>
                <Text>{'  '}</Text>
                <Button key="act-move" plain hotkey="m" onPress={() => move($, id)}>
                  {scopeOf(id) === 'project' ? 'to session' : 'to project'}
                </Button>
                <Text>{'  '}</Text>
                <Button key="act-delete" plain hotkey="x" onPress={() => destroy($, id)}>
                  <Text color="error">delete</Text>
                </Button>
              </Box>
            </Box>
          )}
        </Box>
      )
    }

    // Open threads, and finished ones waiting to be deleted; the other finished ones go under Done.
    const shown = (store: ThreadStore) =>
      store.threads.filter(t => t.status === 'open' || t.expiresAt !== undefined)
    const finished = [...shared.threads, ...mine.threads].filter(t => t.status === 'done' && t.expiresAt === undefined)

    const section = (label: string, scope: Scope, store: ThreadStore) => {
      const list = shown(store)
      return (
        <Box key={label} flexDirection="column">
          {header(label, list.filter(t => t.status === 'open').length, scope)}
          {list.length === 0 && <Text color="inactive">{'  nothing here'}</Text>}
          {list.map(t => row(t.id))}
          {rule(label)}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {titleBar}
        {section('PROJECT', 'project', shared)}
        {section('SESSION', 'session', mine)}

        {proposed.length > 0 && (
          <Box flexDirection="column">
            {header('SUGGESTED', proposed.length, undefined, 'suggestion')}
            {proposed.map((s, i) => (
              <Box key={`suggestion-${i}`}>
                <Text color={colorOf(s.kind)}>{` ${glyphOf(s.kind)} `}</Text>
                <Text italic>{clip(s.title, room)}</Text>
                <Box flexGrow={1} />
                <Button key={`sg-add-${i}`} plain onPress={() => acceptSuggestion($, s.title)}>
                  <Text color="success">[+]</Text>
                </Button>
                <Button key={`sg-del-${i}`} plain onPress={() => dismissSuggestion($, s.title)}>
                  <Text color="error">[-]</Text>
                </Button>
              </Box>
            ))}
            {rule('SUGGESTED')}
          </Box>
        )}

        {finished.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Button
              key="toggle-done"
              plain
              onPress={() => mutateUi($, s => ({ ...s, showDone: !s.showDone }))}
            >
              <Text color="subtle">{`${state.showDone ? '▾' : '▸'} Done · ${finished.length}`}</Text>
            </Button>
            {state.showDone && finished.map(t => row(t.id))}
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          <Text color="inactive">Tab/↑↓ walk · ↵ press · p/s add</Text>
          <Text color="inactive">d done · e edit · m move · x delete</Text>
        </Box>
      </Box>
    )
  })
}
