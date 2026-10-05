import type { ClientModule, RenderElement } from 'claude-code'

import type { AgentNode, Flow } from '../types'

type Props = { agents: AgentNode[]; flows: Flow[] }
type State = { frame: number; expanded: string[]; cursor?: string }

const TICK_MS = 90
const TRAVEL = 10 // frames a packet takes to cross a connector
const FLASH = 40 // frames a new interaction stays highlighted in the log
const WIRE = 4 // connector width in cells
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const PULSE = ['cyan', 'cyanBright', 'whiteBright', 'cyanBright']
const KIND_COLOR = { task: 'yellow', result: 'green', message: 'magenta' } as const
const KIND_GLYPH = { task: '●', result: '◆', message: '✉' } as const

// First frame each flow was seen on, so a packet animates once from when it
// arrives. Flows present at mount count as already delivered.
const seenAt = new Map<string, number>()
let mounted = false

// What the latest drawing laid out, for the pointer and key listeners: the
// agent each drawn line belongs to, and the agents in tree order.
const layout: { owners: (string | undefined)[]; order: string[] } = { owners: [], order: [] }

const PROMPT_LINES = 12
const ANSWER_LINES = 8

// Breaks text into lines of at most `width` cells, on spaces where it can.
const wrapText = (text: string, width: number) => {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let rest = word
      while (rest.length > width) {
        if (line) out.push(line)
        out.push(rest.slice(0, width))
        rest = rest.slice(width)
        line = ''
      }
      if (!line) line = rest
      else if (line.length + 1 + rest.length <= width) line += ' ' + rest
      else {
        out.push(line)
        line = rest
      }
    }
    out.push(line)
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out
}

const duration = (a: AgentNode) => {
  if (a.startedAt === undefined || a.endedAt === undefined) return ''
  const s = Math.round((a.endedAt - a.startedAt) / 1000)
  return s < 60 ? ` ${s}s` : ` ${Math.floor(s / 60)}m${s % 60}s`
}

const shortModel = (model: string) => model.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[1m\]$/, '')

const count = (n: number) => (n < 1000 ? `${n}` : n < 1e6 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1e6).toFixed(2)}M`)

// A level as is; a number is a thinking budget in tokens.
const effort = (a: AgentNode) =>
  a.effort === undefined ? 'n/a' : typeof a.effort === 'number' ? `budget ${count(a.effort)}` : a.effort

const usage = (a: AgentNode) => {
  const model = a.model ? ` · ${shortModel(a.model)}` : ''
  const tokens = a.tokensIn || a.tokensOut ? ` · ↑${count(a.tokensIn ?? 0)} ↓${count(a.tokensOut ?? 0)}` : ''
  return model + tokens
}

const GraphView: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const { agents, flows } = props

  const state: State = surface.state ?? { frame: 0, expanded: [] }
  const set = (change: Partial<State>) => surface.setState({ ...(surface.state ?? state), ...change })
  const toggle = (id: string) => {
    const open = surface.state?.expanded ?? []
    set({ cursor: id, expanded: open.includes(id) ? open.filter(x => x !== id) : [...open, id] })
  }

  if (surface.state === undefined) {
    surface.every(TICK_MS, () => set({ frame: (surface.state?.frame ?? 0) + 1 }))
    surface.onPointer(e => {
      if (e.type !== 'down' || e.button !== 'left') return
      const id = layout.owners[e.y]
      if (id) toggle(id)
    })
    surface.onKey(e => {
      const order = layout.order
      if (order.length === 0) return
      const at = order.indexOf(surface.state?.cursor ?? '')
      if (e.key === 'down' || e.key === 'j') set({ cursor: order[Math.min(order.length - 1, at + 1)] })
      else if (e.key === 'up' || e.key === 'k') set({ cursor: order[Math.max(0, at - 1)] })
      else if ((e.key === 'return' || e.key === ' ') && at >= 0) toggle(order[at] as string)
    })
    surface.setState(state)
  }
  const { frame, expanded, cursor } = state
  const width = surface.columns > 0 ? surface.columns : 80

  if (!mounted) {
    for (const f of flows) seenAt.set(f.id, -1e6)
    mounted = true
  }
  for (const f of flows) if (!seenAt.has(f.id)) seenAt.set(f.id, frame)

  const byId = new Map(agents.map(a => [a.id, a]))
  const children = (id: string) => agents.filter(a => a.parentId === id)
  const name = (id: string) => byId.get(id)?.label ?? id

  // The packet in flight on the wire between `child` and its parent, if any.
  const inFlight = (child: AgentNode) => {
    for (let i = flows.length - 1; i >= 0; i--) {
      const f = flows[i]
      if (!f) continue
      const age = frame - (seenAt.get(f.id) ?? frame)
      if (age >= TRAVEL) continue
      const down = f.from === child.parentId && f.to === child.id
      const up = f.from === child.id && f.to === child.parentId
      if (down || up) return { flow: f, pos: down ? age / TRAVEL : 1 - age / TRAVEL }
    }
    return undefined
  }

  const wire = (child: AgentNode) => {
    const packet = inFlight(child)
    if (packet) {
      const at = Math.min(WIRE - 1, Math.floor(packet.pos * WIRE))
      const color = KIND_COLOR[packet.flow.kind]
      return (
        <Text>
          <Text color={color} dimColor>{'─'.repeat(at)}</Text>
          <Text color={color} bold>{KIND_GLYPH[packet.flow.kind]}</Text>
          <Text color={color} dimColor>{'─'.repeat(WIRE - 1 - at)}</Text>
        </Text>
      )
    }
    if (child.status === 'working') {
      // Marching dots toward the child while it works.
      const cells = Array.from({ length: WIRE }, (_, i) => ((i - frame) % 4 === 0 ? '•' : '─')).join('')
      return <Text color="cyan">{cells}</Text>
    }
    return <Text dimColor>{'─'.repeat(WIRE)}</Text>
  }

  const badge = (a: AgentNode) => {
    switch (a.status) {
      case 'working':
        return <Text color={PULSE[frame % PULSE.length]} bold>{SPINNER[frame % SPINNER.length]}</Text>
      case 'done':
        return <Text color="green">✓</Text>
      case 'failed':
        return <Text color="red">✗</Text>
      default:
        return <Text dimColor>○</Text>
    }
  }

  const detail = (a: AgentNode) => {
    if (a.status === 'working') return a.tool ? ` ${a.tool}` : ' thinking'
    if (a.status === 'idle') return ' idle'
    return `${duration(a)} · ${a.tools} tools`
  }

  const lines: RenderElement[] = []
  const owners: (string | undefined)[] = []
  const order: string[] = []
  const line = (el: RenderElement, owner?: string) => {
    lines.push(el)
    owners.push(owner)
  }

  const details = (a: AgentNode, indent: string) => {
    const room = Math.max(20, width - indent.length - 2)
    const field = (label: string, value: string) =>
      line(
        <Text wrap="truncate">
          <Text dimColor>{indent}</Text>
          <Text color="gray">{label.padEnd(7)}</Text>
          {value}
        </Text>,
        a.id,
      )
    const block = (label: string, text: string, max: number) => {
      const wrapped = wrapText(text, room)
      line(
        <Text>
          <Text dimColor>{indent}</Text>
          <Text color="gray">{label}</Text>
        </Text>,
        a.id,
      )
      for (const one of wrapped.slice(0, max)) line(<Text wrap="truncate"><Text dimColor>{indent}</Text>  {one}</Text>, a.id)
      if (wrapped.length > max)
        line(<Text dimColor>{indent}  … {wrapped.length - max} more lines</Text>, a.id)
    }

    const tokens = a.tokensIn || a.tokensOut
      ? `in ${count(a.tokensIn ?? 0)} (cache read ${count(a.cacheRead ?? 0)}) · out ${count(a.tokensOut ?? 0)}`
      : 'no requests yet'
    const tools = Object.entries(a.toolCounts ?? {})
      .sort((x, y) => y[1] - x[1])
      .map(([tool, n]) => `${tool}×${n}`)
      .join(' · ')

    field('type', `${a.type}${a.background ? ' · background' : ''}${a.name ? ` · @${a.name}` : ''}`)
    field('model', a.model ?? 'unknown')
    field('effort', effort(a))
    field('tokens', tokens)
    if (a.endedAt !== undefined) field('time', duration(a).trim())
    field('tools', tools || 'none')
    field('skills', a.skills?.join(' · ') || 'none')
    block(a.id === 'main' ? 'last prompt' : 'task', a.prompt || '(not recorded)', PROMPT_LINES)
    if (a.answer) block(a.id === 'main' ? 'last answer' : 'result', a.answer, ANSWER_LINES)
  }

  const walk = (a: AgentNode, guides: string, isLast: boolean, depth: number) => {
    const isWorking = a.status === 'working'
    const isOpen = expanded.includes(a.id)
    const isCursor = cursor === a.id
    order.push(a.id)
    line(
      <Text key={a.id} wrap="truncate">
        {depth > 0 && <Text dimColor>{guides + (isLast ? '└' : '├')}</Text>}
        {depth > 0 && wire(a)}
        {depth > 0 ? ' ' : ''}
        {badge(a)}
        <Text bold={isWorking || depth === 0} dimColor={!isWorking && depth > 0 && !isCursor} inverse={isCursor}>
          {' '}
          {a.label}
          {' '}
        </Text>
        <Text dimColor>{isOpen ? '▾' : '▸'}</Text>
        <Text dimColor>{depth > 0 && a.type !== a.label ? ` (${a.type})` : ''}</Text>
        <Text color={isWorking ? 'cyan' : undefined} dimColor={!isWorking}>{detail(a)}</Text>
        <Text color="gray">{usage(a)}</Text>
      </Text>,
      a.id,
    )
    const kids = children(a.id)
    const nextGuides = depth === 0 ? '' : guides + (isLast ? ' ' : '│') + ' '.repeat(WIRE + 1)
    if (isOpen) details(a, nextGuides + (kids.length > 0 ? '│ ' : '  ') + ' ')
    kids.forEach((k, i) => walk(k, nextGuides, i === kids.length - 1, depth + 1))
  }

  const root = byId.get('main')
  if (root) walk(root, '', true, 0)

  const totalIn = agents.reduce((n, a) => n + (a.tokensIn ?? 0), 0)
  const totalOut = agents.reduce((n, a) => n + (a.tokensOut ?? 0), 0)
  const working = agents.filter(a => a.status === 'working').length
  const finished = agents.filter(a => a.status === 'done' || a.status === 'failed').length

  // Every line is one row, so a pointer's `y` indexes `owners` directly.
  const all: RenderElement[] = []
  const allOwners: (string | undefined)[] = []
  const push = (el: RenderElement, owner?: string) => {
    all.push(el)
    allOwners.push(owner)
  }
  push(
    <Text wrap="truncate" dimColor>
      {agents.length - 1} subagents · <Text color="cyan">{working} working</Text> · {finished} finished · ↑{count(totalIn)} in ↓{count(totalOut)} out
    </Text>,
  )
  push(<Text dimColor wrap="truncate">click a row (or ↑/↓ and enter) for details</Text>)
  lines.forEach((el, i) => push(el, owners[i]))
  push(<Text> </Text>)
  push(<Text bold>Interactions</Text>)

  const logRoom = Math.max(3, surface.rows > 0 ? surface.rows - all.length : 8)
  const log = flows.slice(-logRoom)
  if (log.length === 0) push(<Text dimColor>None yet.</Text>)
  for (const f of log) {
    const isNew = frame - (seenAt.get(f.id) ?? frame) < FLASH
    const arrow = f.kind === 'result' ? '◀── result ──' : f.kind === 'task' ? '── task ──▶' : '── msg ──▶'
    const [left, right] = f.kind === 'result' ? [f.to, f.from] : [f.from, f.to]
    push(
      <Text key={f.id} wrap="truncate" dimColor={!isNew}>
        <Text bold={isNew}>{name(left)}</Text>
        <Text color={KIND_COLOR[f.kind]}> {arrow} </Text>
        <Text bold={isNew}>{name(right)}</Text>
        <Text dimColor> {f.text}</Text>
      </Text>,
    )
  }

  layout.owners = allOwners
  layout.order = order

  return <Box flexDirection="column">{all}</Box>
}

export default GraphView
