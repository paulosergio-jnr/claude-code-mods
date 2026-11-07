import type { EngineInterface } from 'claude-code'

import type { ThreadStore } from '../types'
import { emptyStore, parseStore } from './model'

export const FILE = '.claude/threads.local.json'
const TEMP = '.claude/threads.local.json.tmp'
const LOCK = '.claude/threads.local.lock'

const STALE_MS = 5000
const TRIES = 60
const WAIT_MS = 50

/** The project's threads; an empty store when the file is not there yet. Rejects when it is not a thread file. */
export async function readProject($: EngineInterface): Promise<ThreadStore> {
  if (!(await $.fs.exists(FILE))) return emptyStore()
  const store = parseStore(await $.fs.read(FILE))
  if (!store) throw new Error(`${FILE} is not a threads file; fix or remove it`)
  return store
}

/** When the file last changed, or 0 when it is missing. */
export async function projectStamp($: EngineInterface): Promise<number> {
  if (!(await $.fs.exists(FILE))) return 0
  return (await $.fs.stat(FILE)).mtimeMs
}

// `mkdir` is atomic: one session makes the folder, the others see it fail and wait.
async function lock($: EngineInterface) {
  await $.process.run(['mkdir', '-p', '.claude'])
  for (let tries = 0; tries < TRIES; tries++) {
    if ((await $.process.run(['mkdir', LOCK])).exitCode === 0) return
    try {
      const held = await $.fs.stat(LOCK)
      if ((await $.clock.now()) - held.mtimeMs > STALE_MS) await $.process.run(['rmdir', LOCK])
    } catch {
      // gone already: try again
    }
    await $.clock.sleep(WAIT_MS)
  }
  throw new Error('the threads file is locked by another session')
}

/** Reads the file under its lock, applies `change`, and writes the result back whole. */
export async function mutateProject(
  $: EngineInterface,
  change: (store: ThreadStore) => ThreadStore,
): Promise<ThreadStore> {
  await lock($)
  try {
    const next = change(await readProject($))
    await $.fs.write(TEMP, JSON.stringify(next, null, 2) + '\n')
    await $.process.run(['mv', TEMP, FILE])
    return next
  } finally {
    await $.process.run(['rmdir', LOCK])
  }
}
