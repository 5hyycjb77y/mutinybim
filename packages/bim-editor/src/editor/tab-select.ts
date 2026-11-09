import type { SelectionScope, SelectionScopeKind } from '@permitzip/bim-kernel'

/**
 * "Tab to select more": hovering pre-highlights the piece under the pointer;
 * each Tab widens the highlight (piece, stretch, run, branch, system, back to
 * the piece); Shift+Tab narrows it; a click selects what is highlighted. Moving
 * along the highlighted scope keeps it, so the highlight doesn't flicker as
 * the pointer slides down a duct.
 */
export interface PreHighlight {
  readonly anchorId: string
  readonly scopes: readonly SelectionScope[]
  readonly level: number
}

export function hoverTo(state: PreHighlight | null, id: string | null, scopesFor: (id: string) => readonly SelectionScope[]): PreHighlight | null {
  if (id === null) return null
  if (state && (state.anchorId === id || (state.level > 0 && (state.scopes[state.level]?.ids.some((x) => x === id) ?? false)))) return state
  const scopes = scopesFor(id)
  return scopes.length > 0 ? { anchorId: id, scopes, level: 0 } : null
}

export function cycle(state: PreHighlight | null, direction: 1 | -1): PreHighlight | null {
  if (!state || state.scopes.length < 2) return state
  const n = state.scopes.length
  return { ...state, level: (state.level + direction + n) % n }
}

export function currentScope(state: PreHighlight | null): SelectionScope | null {
  return state ? (state.scopes[state.level] ?? null) : null
}

const WORD: Readonly<Record<SelectionScopeKind, string>> = { element: 'this piece', stretch: 'stretch', run: 'run', branch: 'branch', system: 'system' }

function count(n: number): string {
  return `${n} element${n === 1 ? '' : 's'}`
}

export function scopeWord(kind: SelectionScopeKind): string {
  return WORD[kind]
}

/** The status line: what a click selects now and what Tab would select next. */
export function tabHint(state: PreHighlight | null): string | null {
  const now = currentScope(state)
  if (!state || !now) return null
  const click = now.kind === 'element' ? 'Click to select it' : `Click to select the ${WORD[now.kind]} (${count(now.ids.length)})`
  if (state.scopes.length < 2) return `${click}.`
  const next = state.scopes[(state.level + 1) % state.scopes.length]
  if (!next) return `${click}.`
  const tab = next.kind === 'element' ? 'Tab: back to this piece' : `Tab: select ${WORD[next.kind]} (${count(next.ids.length)})`
  return `${tab} · ${click}${state.level > 0 ? ' · Shift+Tab: back' : ''}.`
}
