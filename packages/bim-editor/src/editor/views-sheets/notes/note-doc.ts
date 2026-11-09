import type { JSONContent } from '@tiptap/core'
import { LINE_BREAK, normalizeParagraphs, type NoteAlign, type NoteParagraph, type NoteRun } from '@permitzip/bim-kernel'

/**
 * The in-place editor speaks Tiptap; the model stores structured paragraphs.
 * These two functions convert between them. Lists are nested in Tiptap
 * (bulletList > listItem > paragraph, deeper lists inside the item) and flat
 * in the model (each paragraph carries its list kind and level).
 */

/** The textStyle attribute holding a run's cap height in paper mm. */
export const NOTE_SIZE_ATTR = 'capMm'

type Mark = NonNullable<JSONContent['marks']>[number]

function marksOf(run: NoteRun): Mark[] {
  const marks: Mark[] = []
  if (run.bold) marks.push({ type: 'bold' })
  if (run.italic) marks.push({ type: 'italic' })
  if (run.underline) marks.push({ type: 'underline' })
  if (run.size !== undefined || run.color) marks.push({ type: 'textStyle', attrs: { [NOTE_SIZE_ATTR]: run.size ?? null, color: run.color ?? null } })
  return marks
}

function inlineOf(runs: readonly NoteRun[]): JSONContent[] {
  const out: JSONContent[] = []
  for (const run of runs) {
    const marks = marksOf(run)
    run.text.split(LINE_BREAK).forEach((part, i) => {
      if (i > 0) out.push({ type: 'hardBreak' })
      if (part.length > 0) out.push(marks.length ? { type: 'text', text: part, marks } : { type: 'text', text: part })
    })
  }
  return out
}

function paragraphNode(p: NoteParagraph): JSONContent {
  const content = inlineOf(p.runs)
  return { type: 'paragraph', attrs: { textAlign: p.align ?? 'left' }, ...(content.length ? { content } : {}) }
}

/** Model paragraphs as a Tiptap document. */
export function paragraphsToDoc(paragraphs: readonly NoteParagraph[]): JSONContent {
  const root: JSONContent[] = []
  // Open lists by level: each entry is the list node and its items.
  const stack: Array<{ list: JSONContent; items: JSONContent[]; kind: 'bullet' | 'numbered' }> = []
  for (const p of paragraphs) {
    if (!p.list) {
      stack.length = 0
      root.push(paragraphNode(p))
      continue
    }
    const level = Math.min(p.list.level, stack.length)
    while (stack.length > level + 1) stack.pop()
    const top = stack[level]
    const restart = p.list.kind === 'numbered' && p.list.start !== undefined
    if (!top || top.kind !== p.list.kind || restart) {
      if (top) stack.length = level
      const items: JSONContent[] = []
      const list: JSONContent = p.list.kind === 'bullet' ? { type: 'bulletList', content: items } : { type: 'orderedList', attrs: { start: p.list.start ?? 1 }, content: items }
      const parentItems = stack[level - 1]?.items
      const parentItem = parentItems?.[parentItems.length - 1]
      if (level > 0 && parentItem) parentItem.content = [...(parentItem.content ?? []), list]
      else root.push(list)
      stack[level] = { list, items, kind: p.list.kind }
    }
    stack[level]?.items.push({ type: 'listItem', content: [paragraphNode(p)] })
  }
  return { type: 'doc', content: root.length ? root : [{ type: 'paragraph' }] }
}

function runsOf(node: JSONContent): NoteRun[] {
  const runs: NoteRun[] = []
  for (const child of node.content ?? []) {
    if (child.type === 'hardBreak') {
      runs.push({ text: LINE_BREAK })
      continue
    }
    if (child.type !== 'text' || !child.text) continue
    const run: { -readonly [K in keyof NoteRun]: NoteRun[K] } = { text: child.text }
    for (const mark of child.marks ?? []) {
      if (mark.type === 'bold') run.bold = true
      else if (mark.type === 'italic') run.italic = true
      else if (mark.type === 'underline') run.underline = true
      else if (mark.type === 'textStyle') {
        const size = mark.attrs?.[NOTE_SIZE_ATTR]
        const color = mark.attrs?.color
        if (typeof size === 'number' && Number.isFinite(size)) run.size = size
        if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) run.color = color
      }
    }
    runs.push(run)
  }
  // A hard break takes the style of the run before it, so it merges into that run.
  const merged: NoteRun[] = []
  for (const r of runs) {
    const last = merged[merged.length - 1]
    if (r.text === LINE_BREAK && last) merged[merged.length - 1] = { ...last, text: last.text + LINE_BREAK }
    else merged.push(r)
  }
  return merged
}

function alignOf(node: JSONContent): NoteAlign | undefined {
  const a = node.attrs?.textAlign
  return a === 'center' || a === 'right' || a === 'justify' ? a : undefined
}

/** A Tiptap document as model paragraphs (normalized). */
export function docToParagraphs(doc: JSONContent): NoteParagraph[] {
  const out: NoteParagraph[] = []
  const walk = (nodes: readonly JSONContent[], list: { kind: 'bullet' | 'numbered'; level: number } | null) => {
    for (const node of nodes) {
      if (node.type === 'paragraph') {
        const align = alignOf(node)
        out.push({ runs: runsOf(node), ...(align ? { align } : {}), ...(list ? { list: { kind: list.kind, level: list.level } } : {}) })
      } else if (node.type === 'bulletList' || node.type === 'orderedList') {
        const kind = node.type === 'bulletList' ? 'bullet' : 'numbered'
        const level = list ? list.level + 1 : 0
        const start = typeof node.attrs?.start === 'number' ? node.attrs.start : 1
        const firstIndex = out.length
        for (const item of node.content ?? []) walk(item.content ?? [], { kind, level })
        const first = out[firstIndex]
        // A numbered list that doesn't start at 1, or that follows another list at its level, restarts its count.
        if (kind === 'numbered' && first?.list && (start !== 1 || out[firstIndex - 1]?.list?.level === level)) out[firstIndex] = { ...first, list: { ...first.list, start } }
      }
    }
  }
  walk(doc.content ?? [], null)
  return normalizeParagraphs(out.length ? out : [{ runs: [] }])
}
