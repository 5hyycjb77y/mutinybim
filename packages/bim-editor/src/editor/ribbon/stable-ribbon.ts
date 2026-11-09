'use client'

import { memo, useRef } from 'react'
import { useContributionsVersion } from '../contributions/AddonComponent'
import { Ribbon } from './Ribbon'
import type { RibbonCommand, RibbonGroup, RibbonTab } from './types'

/**
 * The ribbon is rebuilt on every surface render (its input is closures over
 * the surface's state). These keep what it shows referentially stable while
 * nothing it shows changed, so a memoised `Ribbon` skips the render when a
 * duct moves: the built tabs are compared as data (labels, counts in labels,
 * disabled reasons, pressed states, icons by identity), and every handler in
 * the returned tree is a trampoline to the same handler in the latest build,
 * so a click never runs a stale closure. Anything a builder computes from the
 * model must be in that data (the Not placed yet count is in the label), never
 * read by a handler at build time.
 */

type Path = readonly number[]

function sameStrings(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

function sameCommand(a: RibbonCommand, b: RibbonCommand): boolean {
  return (
    a.id === b.id &&
    a.label === b.label &&
    a.ariaLabel === b.ariaLabel &&
    a.icon === b.icon &&
    a.description === b.description &&
    a.shortcut === b.shortcut &&
    (a.disabledReason ?? null) === (b.disabledReason ?? null) &&
    a.pressed === b.pressed &&
    (a.run === undefined) === (b.run === undefined) &&
    a.split === b.split &&
    a.testId === b.testId &&
    sameStrings(a.keywords, b.keywords) &&
    sameCommands(a.children, b.children)
  )
}

function sameCommands(a: readonly RibbonCommand[] | undefined, b: readonly RibbonCommand[] | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  return a.every((c, i) => {
    const d = b[i]
    return d !== undefined && sameCommand(c, d)
  })
}

function sameGroup(a: RibbonGroup, b: RibbonGroup): boolean {
  const toolsSame = a.tool === b.tool || (a.tool !== undefined && b.tool !== undefined && a.tool.value === b.tool.value && a.tool.ariaLabel === b.tool.ariaLabel)
  return a.id === b.id && a.label === b.label && a.shared === b.shared && toolsSame && sameCommands(a.commands, b.commands)
}

/** True when two built ribbons show the same thing (handlers aside). */
export function sameTabs(a: readonly RibbonTab[], b: readonly RibbonTab[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((t, i) => {
    const u = b[i]
    if (!u || t.id !== u.id || t.label !== u.label || t.contextual !== u.contextual || t.groups.length !== u.groups.length) return false
    return t.groups.every((g, j) => {
      const h = u.groups[j]
      return h !== undefined && sameGroup(g, h)
    })
  })
}

function commandAt(tabs: readonly RibbonTab[], path: Path): RibbonCommand | undefined {
  const [ti, gi, ...rest] = path
  let list: readonly RibbonCommand[] | undefined = tabs[ti ?? -1]?.groups[gi ?? -1]?.commands
  let found: RibbonCommand | undefined
  for (const i of rest) {
    found = list?.[i]
    list = found?.children
  }
  return found
}

/**
 * `tabs` as a stable value: the previous result while it shows the same
 * thing, else a copy whose handlers call the latest build's. Call once per
 * render with the freshly built tabs.
 */
export function useStableRibbonTabs(tabs: readonly RibbonTab[]): readonly RibbonTab[] {
  // The caller rebuilds `tabs` when an add-on tab's code arrives (or fails), replacing its loading state.
  useContributionsVersion()
  const latest = useRef(tabs)
  latest.current = tabs
  const shown = useRef<readonly RibbonTab[] | null>(null)
  if (shown.current && sameTabs(shown.current, tabs)) return shown.current
  const run = (path: Path) => () => {
    const command = commandAt(latest.current, path)
    if (!command?.run) {
      console.error('[ribbon] a command vanished between the build it was shown from and the click', { path })
      return
    }
    command.run()
  }
  const wrap = (c: RibbonCommand, path: Path): RibbonCommand => ({
    ...c,
    ...(c.run ? { run: run(path) } : {}),
    ...(c.children ? { children: c.children.map((child, i) => wrap(child, [...path, i])) } : {}),
  })
  const next = tabs.map((t, ti) => ({
    ...t,
    groups: t.groups.map((g, gi) => ({
      ...g,
      ...(g.tool
        ? {
            tool: {
              ...g.tool,
              onValueChange: (id: string) => {
                const tool = latest.current[ti]?.groups[gi]?.tool
                if (!tool) {
                  console.error('[ribbon] a tool group vanished between the build it was shown from and the change', { ti, gi })
                  return
                }
                tool.onValueChange(id)
              },
            },
          }
        : {}),
      commands: g.commands.map((c, ci) => wrap(c, [ti, gi, ci])),
    })),
  }))
  shown.current = next
  return next
}

/** The quick commands (Undo, Redo) as a stable value, the same way. */
export function useStableCommands(commands: readonly RibbonCommand[]): readonly RibbonCommand[] {
  const asTab: readonly RibbonTab[] = [{ id: 'quick', label: 'Quick', groups: [{ id: 'quick', label: 'Quick', commands }] }]
  return useStableRibbonTabs(asTab)[0]?.groups[0]?.commands ?? commands
}

/** `Ribbon`, skipping renders whose props are unchanged (pair with the stable values above and a stable `onValueChange`). */
export const MemoRibbon = memo(Ribbon)
