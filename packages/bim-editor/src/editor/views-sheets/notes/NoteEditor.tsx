'use client'

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { Extension } from '@tiptap/core'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import TextAlign from '@tiptap/extension-text-align'
import { TextStyle } from '@tiptap/extension-text-style'
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, Check, Italic, List, ListOrdered, Underline, Undo2 } from 'lucide-react'
import { NOTE_LINE_HEIGHT, NOTE_LIST_INDENT_EM, NOTE_SIZE_CHOICES, NOTE_SVG_FONT_FAMILY, emForCapHeight, type NoteParagraph, type Vec2 } from '@permitzip/bim-kernel'
import { Button } from '../../../ui/button'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select'
import { Separator } from '../../../ui/separator'
import { ToggleGroup, ToggleGroupItem } from '../../../ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../ui/tooltip'
import { NOTE_SIZE_ATTR, docToParagraphs, paragraphsToDoc } from './note-doc'

/**
 * Edit a note in place. The visible text while you type is the layout
 * engine's (the canvas draws the draft the same way it prints); this editor
 * sits exactly on top with transparent glyphs, the same font file, size, line
 * height, indents and wrapping width, so the caret and selection land on the
 * printed characters. Cmd+B / I / U, Cmd+Shift+7 / 8 for lists, Shift+Enter
 * for a line break. Esc or clicking outside saves; Discard throws the draft away.
 */

const NoteSize = Extension.create({
  name: 'noteSize',
  addGlobalAttributes() {
    return [
      {
        types: ['textStyle'],
        attributes: {
          [NOTE_SIZE_ATTR]: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const v = Number(el.dataset.capMm)
              return Number.isFinite(v) && v > 0 ? v : null
            },
            renderHTML: (attrs: Record<string, unknown>) => {
              const cap = attrs[NOTE_SIZE_ATTR]
              if (typeof cap !== 'number') return {}
              return { 'data-cap-mm': String(cap), style: `font-size: calc(var(--note-px-mm) * ${emForCapHeight(cap)})` }
            },
          },
        },
      },
    ]
  },
})

export interface NoteEditorProps {
  /** Box top-left on paper, mm. */
  readonly origin: Vec2
  readonly rotation: number
  readonly width: number
  readonly height: number | null
  readonly paper: Vec2
  /** Screen pixels per paper mm at the current zoom. */
  readonly pxPerMm: number
  /** The note's default cap height, paper mm. */
  readonly size: number
  readonly lineSpacing: number
  readonly initial: readonly NoteParagraph[]
  /** True while text overflows a fixed-height box (it won't print). */
  readonly overflow: boolean
  readonly onDraft: (paragraphs: NoteParagraph[]) => void
  readonly onCommit: (paragraphs: NoteParagraph[]) => void
  readonly onDiscard: () => void
}

const SIZE_LABEL = (mm: number) => NOTE_SIZE_CHOICES.find((c) => Math.abs(c.mm - mm) < 0.01)?.label ?? `${mm.toFixed(2)} mm`

export function NoteEditor({ origin, rotation, width, height, paper, pxPerMm, size, lineSpacing, initial, overflow, onDraft, onCommit, onDiscard }: NoteEditorProps) {
  const latest = useRef({ onDraft, onCommit, onDiscard })
  useLayoutEffect(() => {
    latest.current = { onDraft, onCommit, onDiscard }
  })
  const content = useMemo(() => paragraphsToDoc(initial), [initial])

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: false, blockquote: false, code: false, codeBlock: false, horizontalRule: false, strike: false, link: false, dropcursor: false, gapcursor: false, trailingNode: false }),
      TextStyle,
      NoteSize,
      TextAlign.configure({ types: ['paragraph'], alignments: ['left', 'center', 'right', 'justify'], defaultAlignment: 'left' }),
    ],
    content,
    autofocus: 'end',
    editorProps: {
      attributes: { 'aria-label': 'Note text', 'data-testid': 'note-editor', spellcheck: 'true' },
      handleKeyDown: (view, event) => {
        if (event.key !== 'Escape') return false
        event.preventDefault()
        event.stopPropagation()
        latest.current.onCommit(docToParagraphs(view.state.doc.toJSON()))
        return true
      },
    },
    onUpdate: ({ editor: ed }) => latest.current.onDraft(docToParagraphs(ed.getJSON())),
  })

  const state = useEditorState({
    editor,
    selector: ({ editor: ed }) => {
      if (!ed) return null
      const cap = ed.getAttributes('textStyle')[NOTE_SIZE_ATTR]
      return {
        bold: ed.isActive('bold'),
        italic: ed.isActive('italic'),
        underline: ed.isActive('underline'),
        bullet: ed.isActive('bulletList'),
        numbered: ed.isActive('orderedList'),
        align: (['center', 'right', 'justify'] as const).find((a) => ed.isActive('paragraph', { textAlign: a })) ?? 'left',
        size: typeof cap === 'number' ? cap : size,
        canUndo: ed.can().undo(),
      }
    },
  })

  // Keep the parent's draft in step from the first frame (the doc normalizes the initial content).
  useEffect(() => {
    if (editor) latest.current.onDraft(docToParagraphs(editor.getJSON()))
  }, [editor])

  const em = emForCapHeight(size)
  const style: React.CSSProperties & Record<'--note-px-mm' | '--note-indent', string> = {
    left: `${(origin.x / paper.x) * 100}%`,
    top: `${(origin.y / paper.y) * 100}%`,
    width: `${width * pxPerMm}px`,
    minHeight: height !== null ? `${height * pxPerMm}px` : undefined,
    transform: rotation ? `rotate(${rotation}deg)` : undefined,
    transformOrigin: '0 0',
    fontFamily: `'${NOTE_SVG_FONT_FAMILY}', 'Liberation Sans', Arimo, Arial, sans-serif`,
    fontSize: `${em * pxPerMm}px`,
    lineHeight: String(NOTE_LINE_HEIGHT * lineSpacing),
    fontKerning: 'none',
    fontVariantLigatures: 'none',
    fontFeatureSettings: "'kern' 0, 'liga' 0",
    letterSpacing: 0,
    wordSpacing: 0,
    textRendering: 'geometricPrecision',
    '--note-px-mm': `${pxPerMm}px`,
    '--note-indent': `${NOTE_LIST_INDENT_EM * em * pxPerMm}px`,
  }

  return (
    <>
      <div
        className="absolute z-20 text-transparent caret-primary [&_*::selection]:bg-primary/25! [&_.ProseMirror]:min-h-0! [&_.ProseMirror]:whitespace-pre-wrap! [&_.ProseMirror]:outline-none [&_.ProseMirror_p+p]:mt-0! [&_li]:m-0! [&_li]:p-0! [&_ol]:m-0! [&_ol]:list-none! [&_ol]:pl-[var(--note-indent)]! [&_p]:m-0! [&_ul]:m-0! [&_ul]:list-none! [&_ul]:pl-[var(--note-indent)]!"
        // The app's global .ProseMirror styles are unlayered, so the overrides above are !important.
        style={style}
        onPointerDown={(e) => e.stopPropagation()}
        data-testid="note-editor-box"
      >
        <EditorContent editor={editor} />
      </div>
      <div
        className="absolute z-30 flex -translate-y-full items-center gap-1 rounded-md border bg-background p-1 shadow-md"
        style={{ left: `${(origin.x / paper.x) * 100}%`, top: `calc(${(origin.y / paper.y) * 100}% - 6px)` }}
        onPointerDown={(e) => {
          // Clicking the bar keeps the caret in the note.
          e.stopPropagation()
          if (!(e.target instanceof HTMLElement && e.target.closest('[role="combobox"]'))) e.preventDefault()
        }}
        role="toolbar"
        aria-label="Note formatting"
        data-testid="note-format-bar"
      >
        <ToggleGroup type="multiple" size="sm" value={[state?.bold ? 'bold' : '', state?.italic ? 'italic' : '', state?.underline ? 'underline' : ''].filter(Boolean)} aria-label="Text style">
          <FormatButton value="bold" label="Bold" keys="⌘B" onClick={() => editor?.chain().focus().toggleBold().run()}>
            <Bold />
          </FormatButton>
          <FormatButton value="italic" label="Italic" keys="⌘I" onClick={() => editor?.chain().focus().toggleItalic().run()}>
            <Italic />
          </FormatButton>
          <FormatButton value="underline" label="Underline" keys="⌘U" onClick={() => editor?.chain().focus().toggleUnderline().run()}>
            <Underline />
          </FormatButton>
        </ToggleGroup>
        <Separator orientation="vertical" className="h-5" />
        <ToggleGroup type="single" size="sm" value={state?.bullet ? 'bullet' : state?.numbered ? 'numbered' : ''} aria-label="List">
          <FormatButton value="bullet" label="Bullets" keys="⌘⇧8" onClick={() => editor?.chain().focus().toggleBulletList().run()}>
            <List />
          </FormatButton>
          <FormatButton value="numbered" label="Numbered list" keys="⌘⇧7" onClick={() => editor?.chain().focus().toggleOrderedList().run()}>
            <ListOrdered />
          </FormatButton>
        </ToggleGroup>
        <Separator orientation="vertical" className="h-5" />
        <Select
          value={String(state?.size ?? size)}
          onValueChange={(v) => {
            const mm = Number(v)
            if (!editor) return
            if (Math.abs(mm - size) < 1e-6) editor.chain().focus().setMark('textStyle', { [NOTE_SIZE_ATTR]: null }).removeEmptyTextStyle().run()
            else editor.chain().focus().setMark('textStyle', { [NOTE_SIZE_ATTR]: mm }).run()
          }}
        >
          <SelectTrigger size="sm" className="w-[6.75rem]" aria-label="Text height" data-testid="note-size">
            <SelectValue placeholder={SIZE_LABEL(state?.size ?? size)} />
          </SelectTrigger>
          <SelectContent onPointerDown={(e) => e.stopPropagation()}>
            <SelectGroup>
              {NOTE_SIZE_CHOICES.map((c) => (
                <SelectItem key={c.mm} value={String(c.mm)}>
                  {c.label}
                  {Math.abs(c.mm - size) < 1e-6 ? ' (note)' : ''}
                </SelectItem>
              ))}
              {!NOTE_SIZE_CHOICES.some((c) => Math.abs(c.mm - (state?.size ?? size)) < 1e-6) && <SelectItem value={String(state?.size ?? size)}>{SIZE_LABEL(state?.size ?? size)}</SelectItem>}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Separator orientation="vertical" className="h-5" />
        <ToggleGroup type="single" size="sm" value={state?.align ?? 'left'} aria-label="Alignment">
          <FormatButton value="left" label="Align left" onClick={() => editor?.chain().focus().setTextAlign('left').run()}>
            <AlignLeft />
          </FormatButton>
          <FormatButton value="center" label="Center" onClick={() => editor?.chain().focus().setTextAlign('center').run()}>
            <AlignCenter />
          </FormatButton>
          <FormatButton value="right" label="Align right" onClick={() => editor?.chain().focus().setTextAlign('right').run()}>
            <AlignRight />
          </FormatButton>
          <FormatButton value="justify" label="Justify" onClick={() => editor?.chain().focus().setTextAlign('justify').run()}>
            <AlignJustify />
          </FormatButton>
        </ToggleGroup>
        <Separator orientation="vertical" className="h-5" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" onClick={() => latest.current.onDiscard()} data-testid="note-discard">
              <Undo2 data-icon="inline-start" />
              Discard
            </Button>
          </TooltipTrigger>
          <TooltipContent>Throw away what you typed since opening the note. Nothing is saved.</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" onClick={() => editor && latest.current.onCommit(docToParagraphs(editor.getJSON()))} data-testid="note-done">
              <Check data-icon="inline-start" />
              Done
            </Button>
          </TooltipTrigger>
          <TooltipContent>Save the note (Esc, or click outside it)</TooltipContent>
        </Tooltip>
      </div>
      {overflow && (
        <div
          className="absolute z-30 rounded-sm bg-danger-50 px-1.5 py-0.5 text-xs text-danger-700 ring-1 ring-danger-300"
          style={{ left: `${(origin.x / paper.x) * 100}%`, top: `calc(${((origin.y + (height ?? 0)) / paper.y) * 100}% + 4px)` }}
          role="status"
          data-testid="note-overflow"
        >
          Text runs past the box and won&apos;t print. Drag the bottom edge down, or set the height to fit.
        </div>
      )}
    </>
  )
}

function FormatButton({ value, label, keys, onClick, children }: { value: string; label: string; keys?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ToggleGroupItem value={value} aria-label={label} onClick={onClick} data-testid={`note-format-${value}`}>
          {children}
        </ToggleGroupItem>
      </TooltipTrigger>
      <TooltipContent>{keys ? `${label} (${keys})` : label}</TooltipContent>
    </Tooltip>
  )
}
