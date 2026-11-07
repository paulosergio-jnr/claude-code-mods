import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const
const SUGGEST = 'mcp__threads__suggest_threads'
const FILE = '.claude/threads.local.json'

const PANE = {
  plugin: 'threads',
  component: 'Pane',
  requestId: 'threads',
  props: { title: 'Threads', isFocused: false, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

// The engine hands fs hooks absolute paths; the disk below keys files by their path from `.claude`.
const rel = (path: string) => path.replace(/^.*?(\.claude\/)/, '$1')

// Stands in for the engine beneath the mod: an in-memory disk, `mkdir`/`mv`/`rmdir`, and the panes.
function engine(on: On) {
  const files = new Map<string, string>()
  const opened: string[] = []
  const dirs = new Set<string>()
  let stamp = 1

  mock.clock(on)
  const kept = new Map<string, unknown>()
  on('store.get', async (_$, e) => ({ value: kept.get(e.key) }) as never)
  on('store.set', async (_$, e) => {
    kept.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined } as never
  })
  on('store.delete', async (_$, e) => {
    kept.delete(e.key)
    return { value: undefined } as never
  })
  on('store.keys', async () => ({ value: [...kept.keys()] }) as never)
  on('session.id', async () => ({ value: 'sess-1' }) as never)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }) as never)
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('tool.register', async () => ({ value: { tool: SUGGEST } }) as never)
  on('ui.panes', async () => ({ value: [] }) as never)
  on('ui.open', async (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('fs.exists', async (_$, e) => ({ value: files.has(rel(e.path)) }) as never)
  on('fs.stat', async () => ({ value: { mtimeMs: stamp } }) as never)
  on('fs.read', async (_$, e) => ({ value: files.get(rel(e.path)) ?? '' }) as never)
  on('fs.write', async (_$, e) => {
    files.set(rel(e.path), e.text)
    stamp++
    return { value: undefined } as never
  })
  on('process.run', async (_$, e) => {
    const [cmd, a, b] = e.argv
    let exitCode = 0
    if (cmd === 'mkdir' && a !== '-p') {
      exitCode = dirs.has(a as string) ? 1 : 0
      dirs.add(a as string)
    }
    if (cmd === 'rmdir') dirs.delete(a as string)
    if (cmd === 'mv') {
      files.set(b as string, files.get(a as string) ?? '')
      files.delete(a as string)
    }
    return { value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  return { files, opened, kept }
}

test('/thread adds to the session, and --project writes the project file', async ($, on) => {
  const { files } = engine(on)
  await $.session.start(START)

  const mine = await $.command.run({ ...TYPED, command: 'thread', args: 'Why does the stop hook fire twice?' })
  expect(mine.text).toBe('Added s1: Why does the stop hook fire twice?')
  expect(files.has(FILE)).toBe(false)

  const shared = await $.command.run({ ...TYPED, command: 'thread', args: '--project Compare zod vs valibot' })
  expect(shared.text).toBe('Added p1: Compare zod vs valibot')
  expect(JSON.parse(files.get(FILE) ?? '{}')).toEqual({
    nextId: 2,
    threads: [{ id: 'p1', title: 'Compare zod vs valibot', status: 'open' }],
  })

  expect((await $.command.run({ ...TYPED, command: 'thread', args: '' })).text).toMatch(/^Usage/)
})

test('the pane lists threads and a suggestion that can be accepted', async ($, on) => {
  engine(on)
  await $.session.start(START)
  await $.command.run({ ...TYPED, command: 'thread', args: 'First' })
  await $.command.run({ ...TYPED, command: 'thread', args: '--project Shared' })

  const queued = await $.tool.call({
    tool: SUGGEST,
    threads: [{ title: 'Decide lock timeout', kind: 'decision' }, { title: 'first' }],
  } as never)
  expect(JSON.stringify(queued)).toContain('Queued 1 suggested thread')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Shared/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /First/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Decide lock timeout/ })).toBeDefined()
    await ui.press({ key: 'sg-add-0' })
    expect(await ui.find({ type: 'Text', text: /Decide lock timeout/ })).toBeDefined()
    expect(await ui.find({ key: 'sg-add-0' })).toBeUndefined()
    await ui.unmount()
    break
  }
})

test('no more than five suggestions are taken in a turn', async ($, on) => {
  engine(on)
  await $.session.start(START)

  const many = Array.from({ length: 8 }, (_, i) => ({ title: `Idea ${i}` }))
  const first = await $.tool.call({ tool: SUGGEST, threads: many } as never)
  expect(JSON.stringify(first)).toContain('Queued 5 suggested threads')
  expect(JSON.stringify(first)).toContain('3 not queued')

  const second = await $.tool.call({ tool: SUGGEST, threads: [{ title: 'One more' }] } as never)
  expect(JSON.stringify(second)).toContain('Queued 0')
})

test('a /clear takes the session threads and suggestions with it', async ($, on) => {
  engine(on)
  await $.session.start(START)
  await $.command.run({ ...TYPED, command: 'thread', args: 'Gone soon' })
  await $.tool.call({ tool: SUGGEST, threads: [{ title: 'Also gone' }] } as never)

  await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Gone soon/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Also gone/ })).toBeUndefined()
  await ui.unmount()
})

test('a session thread moves up to the project, and a project thread back down', async ($, on) => {
  const { files } = engine(on)
  await $.session.start(START)
  await $.command.run({ ...TYPED, command: 'thread', args: 'Worth keeping' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'move-s1' })
  expect(JSON.parse(files.get(FILE) ?? '{}').threads[0]).toEqual({ id: 'p1', title: 'Worth keeping', status: 'open' })
  expect(await ui.find({ key: 'move-s1' })).toBeUndefined()

  await ui.press({ key: 'move-p1' })
  expect(JSON.parse(files.get(FILE) ?? '{}').threads).toEqual([])
  expect(await ui.find({ key: 'move-s2' })).toBeDefined()
  await ui.unmount()
})

test('finishing a thread: kept under Done, or deleted after a countdown that Undo stops', async ($, on) => {
  engine(on)
  await $.session.start(START)
  await $.command.run({ ...TYPED, command: 'thread', args: 'Settled' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'row-s1' })
  await ui.press({ key: 'act-done' })
  expect(await ui.find({ type: 'Button', text: /Done · 1/ })).toBeDefined()
  expect(await ui.find({ key: 'undo-s1' })).toBeUndefined()
  await ui.unmount()
})

test('with doneRetention delete, a finished thread waits for 30 seconds and Undo reopens it', { options: { doneRetention: 'delete' } }, async ($, on) => {
  engine(on)
  await $.session.start(START)
  await $.command.run({ ...TYPED, command: 'thread', args: 'Settled' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'row-s1' })
  await ui.press({ key: 'act-done' })
  expect((await ui.find({ key: 'undo-s1' }))?.text).toMatch(/Undo 30s/)

  await ui.press({ key: 'undo-s1' })
  expect(await ui.find({ key: 'undo-s1' })).toBeUndefined()
  expect(await ui.find({ key: 'move-s1' })).toBeDefined()
  await ui.unmount()
})

// The form's Inputs get new keys each time it opens; the first is the title, the second the note.
const field = async (ui: { findAll: (q: { type: string }) => Promise<{ key: string | undefined }[]> }, n: number) =>
  (await ui.findAll({ type: 'Input' }))[n]?.key as string

test('the add form saves a thread with a kind, and cancel leaves nothing behind', async ($, on) => {
  engine(on)
  await $.session.start(START)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'add-session' })
  await ui.press({ key: 'kind-doubt' })
  await ui.input({ key: await field(ui, 0), text: 'Is the lock stale-safe?', kind: 'change' })
  await ui.press({ key: 'save' })
  expect(await ui.find({ type: 'Text', text: /Is the lock stale-safe\?/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /!/ })).toBeDefined()

  // Enter in the title field saves too.
  await ui.press({ key: 'add-session' })
  await ui.input({ key: await field(ui, 0), text: 'Saved by Enter' })
  expect(await ui.find({ type: 'Text', text: /Saved by Enter/ })).toBeDefined()

  await ui.press({ key: 'add-project' })
  await ui.input({ key: await field(ui, 0), text: 'Never saved', kind: 'change' })
  await ui.press({ key: 'cancel' })
  expect(await ui.find({ type: 'Text', text: /Never saved/ })).toBeUndefined()
  await ui.unmount()
})

test('session threads are saved as they change, and come back when the session does', async ($, on) => {
  const { kept } = engine(on)
  await $.session.start(START)
  await $.command.run({ ...TYPED, command: 'thread', args: 'Survives a resume' })

  const saved = kept.get('session:sess-1') as { store: { threads: { title: string }[] } }
  expect(saved.store.threads.map(t => t.title)).toEqual(['Survives a resume'])
})

test('a resumed session finds its threads again, and the next id carries on', async ($, on) => {
  const { kept } = engine(on)
  kept.set('session:sess-1', {
    savedAt: 1,
    store: { nextId: 4, threads: [{ id: 's3', title: 'From before', status: 'open' }] },
  })
  kept.set('session:old', { savedAt: -40 * 86_400_000, store: { nextId: 2, threads: [] } })
  await $.session.start(START)
  expect(kept.has('session:old')).toBe(false) // unused for 30 days: pruned

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /From before/ })).toBeDefined()
  await ui.unmount()

  const next = await $.command.run({ ...TYPED, command: 'thread', args: 'After' })
  expect(next.text).toBe('Added s4: After')
})

test('a /clear forgets the saved session threads', async ($, on) => {
  const { kept } = engine(on)
  await $.session.start(START)
  await $.command.run({ ...TYPED, command: 'thread', args: 'Gone' })
  expect(kept.has('session:sess-1')).toBe(true)

  await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: {} } as never)
  expect(kept.has('session:sess-1')).toBe(false)
})

test('a form opens empty each time, with Inputs the surface has not typed into', async ($, on) => {
  engine(on)
  await $.session.start(START)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'add-session' })
  const first = [await field(ui, 0), await field(ui, 1)]
  await ui.input({ key: first[1] as string, text: 'a note', kind: 'change' })
  await ui.input({ key: first[0] as string, text: 'With a note' })

  await ui.press({ key: 'add-session' })
  const second = [await field(ui, 0), await field(ui, 1)]
  expect(second[0]).not.toBe(first[0])
  expect(second[1]).not.toBe(first[1])
  expect((await ui.find({ key: second[1] as string }))?.text ?? '').toBe('')
  await ui.unmount()
})
