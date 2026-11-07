import type { ContextCategory, ContextSkills, SessionContextBreakdown } from 'claude-code'
import type { Detail, Group, Row } from '../types'

/** Schema tokens of the built-in tools and the loaded MCP tools. */
export type Counted = { tools: number; mcp: number }

export const isSystemTools = (c: ContextCategory): boolean => /^system tools/i.test(c.name)

// Tool and MCP schema tokens as a breakdown carries them.
export const toolTokensOf = (b: SessionContextBreakdown): Counted => ({
  tools: b.categories.filter(c => c.kind === 'used' && isSystemTools(c)).reduce((s, c) => s + c.tokens, 0),
  mcp: b.mcpTools.filter(t => t.isLoaded).reduce((s, t) => s + t.tokens, 0),
})

const byTokens = (a: { tokens: number }, b: { tokens: number }): number => b.tokens - a.tokens

const groupsOf = (rows: Map<string, Row[]>, note: (rows: Row[]) => string | undefined): Group[] =>
  [...rows]
    .map(([name, list]) => ({
      name,
      tokens: list.filter(r => !r.dim).reduce((s, r) => s + r.tokens, 0),
      note: note(list),
      rows: [...list].sort(byTokens),
    }))
    .sort(byTokens)

const push = (map: Map<string, Row[]>, key: string, row: Row): void => {
  map.set(key, [...(map.get(key) ?? []), row])
}

/** `mcp__server__tool` as `tool`. */
export const toolName = (wire: string): string => wire.replace(/^mcp__.*?__/, '')

/**
 * What the pane draws, from the same breakdown as the band. `counted`
 * replaces the estimated schema tokens, and each MCP tool is scaled by the
 * same factor so the groups add up to the section's total. `skills` stands in
 * for the breakdown's own when the summary lists none by name.
 */
export function detailOf(b: SessionContextBreakdown, counted?: Counted, skills: ContextSkills | undefined = b.skills): Detail {
  const estimated = toolTokensOf(b)
  const c = counted ?? estimated
  const scale = estimated.mcp > 0 ? c.mcp / estimated.mcp : 1
  const u = b.apiUsage
  const input = u ? u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0

  const context: Row[] = b.categories
    .filter(cat => cat.kind === 'used' && !isSystemTools(cat) && cat.tokens > 0)
    .map(cat => ({ name: cat.name, tokens: cat.tokens }))
  context.push({ name: 'System tools', tokens: c.tools })
  context.sort(byTokens)
  const free = b.categories.filter(cat => cat.kind === 'free').reduce((s, cat) => s + cat.tokens, 0)
  if (free > 0) context.push({ name: 'Free space', tokens: free, dim: true })

  const deferred = b.categories.filter(cat => cat.kind !== 'used' && isSystemTools(cat)).reduce((s, cat) => s + cat.tokens, 0)
  const toolRows: Row[] = [{ name: 'built-in', tokens: c.tools }]
  if (deferred > 0) toolRows.push({ name: 'deferred', tokens: deferred, dim: true, note: 'not loaded' })

  const servers = new Map<string, Row[]>()
  for (const t of b.mcpTools) {
    push(servers, t.serverName, {
      name: toolName(t.name),
      tokens: Math.round(t.tokens * scale),
      ...(t.isLoaded ? {} : { dim: true, note: 'not loaded' }),
    })
  }

  const sources = new Map<string, Row[]>()
  for (const s of skills?.skillFrontmatter ?? []) {
    push(sources, s.pluginName ? `plugin: ${s.pluginName}` : s.source, { name: s.name, tokens: s.tokens })
  }

  return {
    max: b.rawMaxTokens,
    total: b.apiUsage
      ? b.totalTokens
      : b.totalTokens - estimated.tools - estimated.mcp + c.tools + c.mcp,
    context,
    cache: u && input > 0 ? { hit: u.cache_read_input_tokens / input, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens } : undefined,
    tools: { tokens: c.tools, rows: toolRows },
    skills: {
      included: skills?.includedSkills ?? 0,
      total: skills?.totalSkills ?? 0,
      tokens: skills?.tokens ?? 0,
      groups: groupsOf(sources, rows => `${rows.length}`),
    },
    mcp: {
      loaded: b.mcpTools.filter(t => t.isLoaded).length,
      total: b.mcpTools.length,
      tokens: c.mcp,
      groups: groupsOf(servers, rows => `${rows.filter(r => !r.dim).length}/${rows.length}`),
    },
  }
}
