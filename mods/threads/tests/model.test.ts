import { expect, test } from 'claude-code/testing'

import {
  addSuggestions,
  addThread,
  emptyStore,
  parseStore,
  parseSuggestions,
  remove,
  sweep,
  toggleDone,
} from '../hooks/model'

test('ids carry the scope and are never reused', async () => {
  const one = addThread(emptyStore(), 'project', { title: ' First ' })
  const two = addThread(one.store, 'project', { title: 'Second', kind: 'doubt' })
  expect(one.thread).toEqual({ id: 'p1', title: 'First', status: 'open' })
  expect(two.thread.id).toBe('p2')

  const gone = remove(two.store, 'p2')
  expect(addThread(gone, 'project', { title: 'Third' }).thread.id).toBe('p3')
  expect(addThread(emptyStore(), 'session', { title: 'x' }).thread.id).toBe('s1')
})

test('finishing sets an expiry only when a delay is given, and reopening clears it', async () => {
  const { store } = addThread(emptyStore(), 'session', { title: 'x' })

  const kept = toggleDone(store, 's1', 1000, undefined)
  expect(kept.threads[0]?.status).toBe('done')
  expect(kept.threads[0]?.expiresAt).toBeUndefined()

  const pending = toggleDone(store, 's1', 1000, 30_000)
  expect(pending.threads[0]?.expiresAt).toBe(31_000)
  expect(sweep(pending, 30_999).threads.length).toBe(1)
  expect(sweep(pending, 31_000).threads.length).toBe(0)

  const reopened = toggleDone(pending, 's1', 2000, 30_000)
  expect(reopened.threads[0]).toEqual({ id: 's1', title: 'x', status: 'open' })
})

test('a project file is read back, and anything else is refused', async () => {
  const text = JSON.stringify({
    nextId: 4,
    threads: [
      { id: 'p3', title: 'a', status: 'done', kind: 'explore', note: 'n' },
      { id: 'p2', title: 'b', kind: 'nonsense' },
      { nope: true },
    ],
  })
  expect(parseStore(text)).toEqual({
    nextId: 4,
    threads: [
      { id: 'p3', title: 'a', status: 'done', kind: 'explore', note: 'n' },
      { id: 'p2', title: 'b', status: 'open' },
    ],
  })
  expect(parseStore('not json')).toBeUndefined()
  expect(parseStore('{"threads": []}')).toBeUndefined()
})

test('suggestions skip repeats, known titles and the room left, and keep the newest ten', async () => {
  const incoming = parseSuggestions([
    { title: 'Decide lock timeout', kind: 'decision' },
    { title: '  decide   LOCK timeout ' },
    { title: 'Already a thread' },
    { title: '' },
    { title: 'Pane width', kind: 'bogus' },
    'junk',
  ])
  expect(incoming).toEqual([
    { title: 'Decide lock timeout', kind: 'decision' },
    { title: 'decide   LOCK timeout' },
    { title: 'Already a thread' },
    { title: 'Pane width' },
  ])

  const first = addSuggestions([], incoming, ['already a thread'], 5)
  expect(first.list.map(s => s.title)).toEqual(['Decide lock timeout', 'Pane width'])
  expect(first.taken).toBe(2)

  expect(addSuggestions([], incoming, [], 1).taken).toBe(1)
  expect(addSuggestions([], incoming, [], 0).list).toEqual([])

  const many = Array.from({ length: 12 }, (_, i) => ({ title: `t${i}` }))
  const capped = addSuggestions([], many, [], 12)
  expect(capped.list.length).toBe(10)
  expect(capped.list[0]?.title).toBe('t2')
})
