import type { ClientModule, RenderElement } from 'claude-code'

import type { AgentNode, AgentState, Flow } from '../types'

type Props = { agents: AgentNode[]; flows: Flow[]; now: number }
type State = { frame: number; selected?: string; cursor?: string }

const TICK_MS = 90
const TRAVEL_MS = 900 // how long a packet takes to cross between lanes
const SPAWN_MS = 700 // how long a new lane's name stays highlighted
const NARROW = 80
const METER = 12 // width of the time-split meter in the summary rows
const SPARK_SPAN_MS = 180_000 // how far back the sparkline reaches

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPARK = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

const COLORS: Record<AgentState, string> = { thinking: '#ff9e3d', acting: '#5aa9ff', waiting: '#82c796' }
const BRIGHT: Record<AgentState, string> = { thinking: '#ffc27d', acting: '#b4d7ff', waiting: '#c2e8cd' }
const GLYPH: Record<AgentState, string> = { thinking: '▓', acting: '█', waiting: '░' }
const FAILED = '#ff5f5f'

const KIND_COLOR = { task: 'yellow', result: 'cyan', message: 'magenta' } as const
const KIND_GLYPH = { task: '●', result: '◆', message: '✉' } as const

const PROMPT_LINES = 12
const ANSWER_LINES = 8

// What the latest drawing laid out, for the pointer and key listeners: the
// agent each drawn line belongs to, and the lanes in tree order.
const layout: { owners: (string | undefined)[]; order: string[] } = { owners: [], order: [] }

// The hooks module's clock, as an offset from this one. It times only the
// animations (packets, new-lane highlight); the axis itself is the run's time.
let clockOffset = 0
let anchoredAt = Number.NaN

type Cell = { ch: string; color?: string; dim?: boolean; bold?: boolean }
type Lane = { a: AgentNode; guides: string; isLast: boolean; depth: number }

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

const span = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return s % 60 === 0 ? `${s / 60}m` : `${Math.floor(s / 60)}m${s % 60}s`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

const duration = (a: AgentNode) => (a.startedAt === undefined || a.endedAt === undefined ? '' : span(a.endedAt - a.startedAt))

const count = (n: number) => (n < 1000 ? `${n}` : n < 1e6 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1e6).toFixed(2)}M`)

// A level as is; a number is a thinking budget in tokens.
const effort = (a: AgentNode) =>
  a.effort === undefined ? 'n/a' : typeof a.effort === 'number' ? `budget ${count(a.effort)}` : a.effort

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, Math.max(0, max - 1)) + '…' : text)

// The state an agent is in right now, if it is in one.
const stateOf = (a: AgentNode): AgentState | undefined => {
  const last = a.segments?.[a.segments.length - 1]
  return last && last.to === undefined ? last.state : undefined
}

// Output tokens over the last few minutes, one bar per cell.
const sparkline = (a: AgentNode, now: number, cells: number) => {
  const per = SPARK_SPAN_MS / cells
  const buckets = new Array<number>(cells).fill(0)
  for (const { t, out } of a.tokenLog ?? []) {
    const back = Math.floor((now - t) / per)
    if (back >= 0 && back < cells) buckets[cells - 1 - back] = (buckets[cells - 1 - back] ?? 0) + out
  }
  const top = Math.max(...buckets)
  return buckets.map(v => SPARK[top === 0 ? 0 : Math.ceil((v / top) * (SPARK.length - 1))]).join('')
}

const sameStyle = (a: Cell, b: Cell) => a.color === b.color && a.dim === b.dim && a.bold === b.bold

const GraphView: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const { agents, flows } = props
  const runEnd = props.now // the run's time: where the last event left it

  if (props.now !== anchoredAt) {
    anchoredAt = props.now
    clockOffset = props.now - Date.now()
  }
  const live = Date.now() + clockOffset

  const state: State = surface.state ?? { frame: 0 }
  const set = (change: Partial<State>) => surface.setState({ ...(surface.state ?? state), ...change })
  const select = (id: string) => set({ cursor: id, selected: surface.state?.selected === id ? undefined : id })

  if (surface.state === undefined) {
    surface.every(TICK_MS, () => set({ frame: (surface.state?.frame ?? 0) + 1 }))
    surface.onPointer(e => {
      if (e.type !== 'down' || e.button !== 'left') return
      const id = layout.owners[e.y]
      if (id) select(id)
    })
    surface.onKey(e => {
      const order = layout.order
      if (order.length === 0) return
      const at = order.indexOf(surface.state?.cursor ?? '')
      if (e.key === 'down' || e.key === 'j') set({ cursor: order[Math.min(order.length - 1, at + 1)] })
      else if (e.key === 'up' || e.key === 'k') set({ cursor: order[Math.max(0, at - 1)] })
      else if ((e.key === 'return' || e.key === ' ') && at >= 0) select(order[at] as string)
    })
    surface.setState(state)
  }
  const { frame, selected, cursor } = state
  const width = surface.columns > 0 ? surface.columns : 80
  const isNarrow = width < NARROW

  const byId = new Map(agents.map(a => [a.id, a]))
  const children = (id: string) => agents.filter(a => a.parentId === id)
  
  // --- lanes: as many as fit, the oldest finished ones dropped first

  const everyLane: Lane[] = []
  const walk = (a: AgentNode, guides: string, isLast: boolean, depth: number) => {
    everyLane.push({ a, guides, isLast, depth })
    const kids = children(a.id)
    const nextGuides = depth === 0 ? '' : guides + (isLast ? '  ' : '│ ')
    kids.forEach((k, i) => walk(k, nextGuides, i === kids.length - 1, depth + 1))
  }
  const root = byId.get('main')
  if (root) walk(root, '', true, 0)

  const lanes = everyLane

  // --- the run's time: from its first activity to its last event, fitted to the width

  const stamps = lanes.flatMap(l => (l.a.segments ?? []).flatMap(s => [s.from, s.to ?? runEnd]))
  const t0 = stamps.length > 0 ? Math.min(...stamps) : runEnd
  const t1 = stamps.length > 0 ? Math.max(...stamps) : runEnd
  const total = Math.max(1000, t1 - t0)

  // --- geometry: name | bars | tool or state

  const prefixOf = (l: Lane) => (l.depth > 0 ? ' ' + l.guides + (l.isLast ? '└ ' : '├ ') : '')
  const detailOf = (a: AgentNode) => {
    if (a.status === 'done' || a.status === 'failed') return `${a.status === 'failed' ? 'failed ' : ''}${duration(a)} · ${a.tools} tools`
    const s = stateOf(a)
    if (s === 'acting') return a.tool ?? 'acting'
    if (s === 'thinking') return 'thinking'
    return a.status === 'idle' ? 'idle' : 'waiting'
  }

  const longestName = Math.max(10, ...lanes.map(l => prefixOf(l).length + l.a.label.length + 1))
  const longestDetail = Math.max(8, ...lanes.map(l => detailOf(l.a).length + 2))
  const nameW = Math.min(longestName, Math.floor(width * (isNarrow ? 0.34 : 0.3)))
  const toolW = Math.min(longestDetail, Math.floor(width * (isNarrow ? 0.3 : 0.26)))
  const barW = Math.max(12, width - nameW - toolW - 2)
  const inner = barW - 2 // columns 0 and barW-1 are for connectors
  const xStart = (t: number) => 1 + Math.max(0, Math.min(inner - 1, Math.floor(((t - t0) / total) * inner)))
  const xEnd = (t: number) => 1 + Math.max(0, Math.min(inner - 1, Math.ceil(((t - t0) / total) * inner) - 1))

  // --- bars: a line per agent, coloured by the state it was in

  const barFor = (a: AgentNode): Cell[] => {
    const cells: Cell[] = Array.from({ length: barW }, () => ({ ch: ' ' }))
    const weight = new Array<number>(barW).fill(0)
    const segs = a.segments ?? []
    segs.forEach((s, i) => {
      const to = s.to ?? runEnd
      const c0 = xStart(s.from)
      const c1 = Math.max(c0, xEnd(to))
      const color = a.status === 'failed' && i === segs.length - 1 ? FAILED : COLORS[s.state]
      for (let c = c0; c <= c1; c++) {
        const lo = t0 + ((c - 1) / inner) * total
        const hi = t0 + (c / inner) * total
        const w = Math.max(1, Math.min(to, hi) - Math.max(s.from, lo))
        if (w > (weight[c] ?? 0)) {
          weight[c] = w
          cells[c] = { ch: '━', color, bold: a.id === 'main' }
        }
      }
    })

    // A running agent's open end shimmers: a bright cell sweeps along acting, thinking pulses.
    const open = stateOf(a)
    if (open && a.status === 'working') {
      const end = xEnd(runEnd)
      if (open === 'acting') {
        const at = end - ((frame * 2) % 12)
        const cell = cells[at]
        if (cell && cell.color === COLORS.acting) cells[at] = { ...cell, color: BRIGHT.acting }
      } else if (open === 'thinking' && frame % 16 < 8) {
        for (let c = Math.max(1, end - 2); c <= end; c++) {
          const cell = cells[c]
          if (cell && cell.color === COLORS.thinking) cells[c] = { ...cell, color: BRIGHT.thinking }
        }
      }
    }
    if (a.id === 'main' && open) cells[barW - 1] = { ch: '▶', color: COLORS[open], bold: true }
    return cells
  }

  const grid = lanes.map(l => barFor(l.a))
  const rowOf = new Map(lanes.map((l, i) => [l.a.id, i]))

  // --- interactions: a connector down to a child at its start, back up from it
  // at its end, and a packet travelling along it while the interaction is new.

  const wires: { col: number; src: number; dst: number; f: Flow }[] = []
  for (const f of flows) {
    const src = rowOf.get(f.from)
    const dst = rowOf.get(f.to)
    if (src === undefined || dst === undefined || src === dst) continue
    const child = byId.get(f.kind === 'result' ? f.from : f.to)
    const col =
      f.kind === 'task'
        ? xStart(child?.startedAt ?? f.at) - 1
        : f.kind === 'result'
          ? Math.min(barW - 1, xEnd(child?.endedAt ?? f.at) + 1)
          : xStart(f.at)
    wires.push({ col, src, dst, f })
  }

  for (const { col, src, dst, f } of wires) {
    const step = dst > src ? 1 : -1
    for (let r = src + step; r !== dst; r += step) {
      const cell = grid[r]![col]
      if (cell && cell.ch === ' ') grid[r]![col] = { ch: f.kind === 'message' ? '┆' : '│', color: KIND_COLOR[f.kind], dim: true }
    }
  }
  for (const { col, src, dst, f } of wires) {
    const color = KIND_COLOR[f.kind]
    if (f.kind === 'task') {
      grid[src]![col] = { ch: KIND_GLYPH.task, color, bold: true }
      grid[dst]![col] = { ch: '╰', color }
    } else if (f.kind === 'result') {
      grid[src]![col] = { ch: '╯', color }
      grid[dst]![col] = { ch: KIND_GLYPH.result, color, bold: true }
    } else {
      grid[dst]![col] = { ch: KIND_GLYPH.message, color, bold: true }
    }
  }
  for (const { col, src, dst, f } of wires) {
    const age = live - f.at
    if (age < 0 || age >= TRAVEL_MS) continue
    const at = src + Math.round((age / TRAVEL_MS) * (dst - src))
    grid[at]![col] = { ch: KIND_GLYPH[f.kind], color: KIND_COLOR[f.kind], bold: true }
  }

  const runs = (cells: Cell[], key: string) => {
    const out: RenderElement[] = []
    for (let i = 0; i < cells.length; ) {
      const first = cells[i] as Cell
      let text = ''
      let j = i
      while (j < cells.length && sameStyle(cells[j] as Cell, first)) text += (cells[j++] as Cell).ch
      out.push(
        <Text key={`${key}${i}`} color={first.color} dimColor={first.dim} bold={first.bold}>
          {text}
        </Text>,
      )
      i = j
    }
    return out
  }

  // --- rows

  const badge = (a: AgentNode) => {
    if (a.status === 'done') return <Text color={COLORS.waiting}>✓</Text>
    if (a.status === 'failed') return <Text color={FAILED}>✗</Text>
    const s = stateOf(a)
    if (s === 'thinking' || s === 'acting') {
      return (
        <Text color={frame % 6 < 3 ? COLORS[s] : BRIGHT[s]} bold>
          {SPINNER[frame % SPINNER.length]}
        </Text>
      )
    }
    if (s === 'waiting') return <Text color={COLORS.waiting} dimColor={frame % 28 >= 14}>●</Text>
    return <Text dimColor>○</Text>
  }

  const lines: RenderElement[] = []
  const owners: (string | undefined)[] = []
  const line = (el: RenderElement, owner?: string) => {
    lines.push(el)
    owners.push(owner)
  }

  const details = (a: AgentNode) => {
    const wrapAt = Math.max(20, width - 2)
    const field = (label: string, value: string) =>
      line(
        <Text wrap="truncate">
          <Text color="gray">{label.padEnd(7)}</Text>
          {value}
        </Text>,
        a.id,
      )
    const block = (label: string, text: string, max: number) => {
      const wrapped = wrapText(text, wrapAt)
      line(<Text color="gray">{label}</Text>, a.id)
      for (const one of wrapped.slice(0, max)) line(<Text wrap="truncate">  {one}</Text>, a.id)
      if (wrapped.length > max) line(<Text dimColor>  … {wrapped.length - max} more lines</Text>, a.id)
    }

    const tokens =
      a.tokensIn || a.tokensOut
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
    if (a.tokenLog?.length) field('rate', sparkline(a, runEnd, 24) + ' output tokens, last 3 minutes')
    if (a.endedAt !== undefined) field('time', duration(a))
    field('tools', tools || 'none')
    field('skills', a.skills?.join(' · ') || 'none')
    block(a.id === 'main' ? 'last prompt' : 'task', a.prompt || '(not recorded)', PROMPT_LINES)
    if (a.answer) block(a.id === 'main' ? 'last answer' : 'result', a.answer, ANSWER_LINES)
  }

  // --- header

  const subs = agents.length - 1
  const working = agents.filter(a => a.status === 'working').length
  const finished = agents.filter(a => a.status === 'done' || a.status === 'failed').length
  const totalIn = agents.reduce((n, a) => n + (a.tokensIn ?? 0), 0)
  const totalOut = agents.reduce((n, a) => n + (a.tokensOut ?? 0), 0)
  const inState = (s: AgentState) => agents.filter(a => stateOf(a) === s).length

  const all: RenderElement[] = []
  const allOwners: (string | undefined)[] = []
  const push = (el: RenderElement, owner?: string) => {
    all.push(el)
    allOwners.push(owner)
  }

  push(
    <Text wrap="truncate" dimColor>
      {subs} subagents · <Text color={COLORS.acting}>{working} working</Text> · {finished} finished · ↑{count(totalIn)} in ↓{count(totalOut)} out
      · run {span(total)}
    </Text>,
  )
  push(
    <Text wrap="truncate">
      {(['thinking', 'acting', 'waiting'] as const).map(s => (
        <Text key={s} color={COLORS[s]}>
          {GLYPH[s]} {s} {inState(s)}
          {'  '}
        </Text>
      ))}
    </Text>,
  )
  push(<Text dimColor wrap="truncate">click a lane (or ↑/↓ and enter) for details</Text>)

  // --- timeline

  const order: string[] = []
  lanes.forEach(({ a, guides, isLast, depth }, row) => {
    order.push(a.id)
    const s = stateOf(a)
    const isWorking = a.status === 'working' && s !== 'waiting'
    const isCursor = cursor === a.id
    const age = a.startedAt === undefined ? Infinity : live - a.startedAt
    const ended = a.status === 'done' || a.status === 'failed'
    const accent = a.status === 'failed' ? FAILED : s ? COLORS[s] : undefined
    const prefix = prefixOf({ a, guides, isLast, depth })
    const label = clip(a.label, Math.max(4, nameW - prefix.length - 1))
    const namePad = ' '.repeat(Math.max(1, nameW - prefix.length - label.length))

    line(
      <Text key={a.id} wrap="truncate">
        <Text dimColor>{prefix}</Text>
        <Text bold={isWorking || depth === 0} dimColor={ended && !isCursor} inverse={isCursor || age < SPAWN_MS}>
          {label}
        </Text>
        <Text>{namePad} </Text>
        {runs(grid[row] as Cell[], a.id)}
        <Text> </Text>
        {badge(a)}
        <Text color={accent} dimColor={!isWorking}>
          {' ' + clip(detailOf(a), toolW - 2)}
        </Text>
      </Text>,
      a.id,
    )
  })

  lines.forEach((el, i) => push(el, owners[i]))

  // --- the middle: the selected agent's details, only while one is selected

  const picked = selected ? byId.get(selected) : undefined
  const middle: RenderElement[] = []
  const middleOwners: (string | undefined)[] = []
  if (picked) {
    lines.length = 0
    owners.length = 0
    line(<Text> </Text>)
    line(
      <Text bold wrap="truncate">
        {picked.label}
        <Text dimColor> · {picked.type}</Text>
      </Text>,
      picked.id,
    )
    details(picked)
    lines.forEach((el, i) => {
      middle.push(el)
      middleOwners.push(owners[i])
    })
  }

  // --- the bottom: one row per agent: name, meter, tool or state, tokens, recent rate

  // How long the agent has run against the whole run, as a bar: the filled part is
  // coloured by how its time split between thinking, acting and waiting, the rest dotted.
  const meterOf = (a: AgentNode, cells: number) => {
    const spent: Record<AgentState, number> = { thinking: 0, acting: 0, waiting: 0 }
    for (const sg of a.segments ?? []) spent[sg.state] += Math.max(0, (sg.to ?? runEnd) - sg.from)
    const sum = spent.thinking + spent.acting + spent.waiting
    const filled = sum === 0 ? 0 : Math.max(1, Math.min(cells, Math.round((sum / total) * cells)))
    const out: Cell[] = []
    for (const st of ['thinking', 'acting', 'waiting'] as const) {
      const n = Math.round((spent[st] / (sum || 1)) * filled)
      for (let i = 0; i < n && out.length < filled; i++) out.push({ ch: GLYPH[st], color: COLORS[st] })
    }
    while (out.length < filled) out.push({ ...(out[out.length - 1] as Cell) })
    if (a.status === 'working' && filled > 0) {
      const at = frame % filled
      const cell = out[at] as Cell
      const st = (Object.keys(COLORS) as AgentState[]).find(k => COLORS[k] === cell.color)
      if (st) out[at] = { ...cell, color: BRIGHT[st] }
    }
    while (out.length < cells) out.push({ ch: '░', color: 'gray', dim: true })
    return out
  }

  const rowDetail = (a: AgentNode) =>
    a.status === 'done' ? `done ${duration(a)}` : a.status === 'failed' ? `failed ${duration(a)}` : detailOf(a)
  const nameW2 = Math.min(Math.max(8, ...lanes.map(l => l.a.label.length + 2)), 18)
  const toolW2 = Math.min(Math.max(10, ...lanes.map(l => rowDetail(l.a).length + 2)), 16)
  const inW = 10 // room for the input count, so the output count sits well apart from it
  const tokensW = inW + 8
  let meterW = 12
  const fixed = 2 + nameW2 + 2 + toolW2 + tokensW
  if (fixed + meterW > width) meterW = Math.max(6, width - fixed)

  const bottom: RenderElement[] = []
  const bottomOwners: (string | undefined)[] = []
  for (const { a } of lanes) {
    const s = stateOf(a)
    const isWorking = a.status === 'working' && s !== 'waiting'
    const accent = a.status === 'failed' ? FAILED : s ? COLORS[s] : undefined
    const tokensIn = `↑${count(a.tokensIn ?? 0)}`
    const tokensOut = `↓${count(a.tokensOut ?? 0)}`
    bottom.push(
      <Text key={`row-${a.id}`} wrap="truncate">
        {badge(a)}
        <Text> </Text>
        <Text inverse={cursor === a.id}>{clip(a.label, nameW2 - 1).padEnd(nameW2)}</Text>
        <Text dimColor>▕</Text>
        {runs(meterOf(a, meterW), `m-${a.id}`)}
        <Text dimColor>▏ </Text>
        <Text color={accent} dimColor={!isWorking}>
          {clip(rowDetail(a), toolW2 - 1).padEnd(toolW2)}
        </Text>
        <Text color="gray">{tokensIn.padEnd(inW)}</Text>
        <Text color="gray">{tokensOut}</Text>
      </Text>,
    )
    bottomOwners.push(a.id)
  }

  // The bottom rows sit at the foot of the pane: whatever room is left is empty.
  const filler = Math.max(1, surface.rows > 0 ? surface.rows - all.length - middle.length - bottom.length : 1)
  middle.forEach((el, i) => push(el, middleOwners[i]))
  for (let i = 0; i < filler; i++) push(<Text key={`gap-${i}`}> </Text>)
  bottom.forEach((el, i) => push(el, bottomOwners[i]))

  layout.owners = allOwners
  layout.order = order

  return <Box flexDirection="column">{all}</Box>
}

export default GraphView
