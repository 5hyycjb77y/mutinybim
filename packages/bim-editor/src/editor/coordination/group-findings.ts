import type { ModelState } from '@permitzip/bim-kernel'
import { elementName, type Finding, type Severity } from '@permitzip/bim-lint'

/**
 * Manage › Coordination's list, grouped so a long check reads at a glance:
 * by rule, then within a rule by the element the findings are about (RTU-1
 * passing into four linked walls is one group of four, not four cards).
 */

export interface ElementCluster {
  /** Our element the findings are about, or the finding id when it names none. */
  readonly key: string
  readonly label: string
  readonly findings: readonly Finding[]
  /** Every element the findings name, ours, for Select all. */
  readonly elementIds: readonly string[]
  readonly worst: Severity
}

export interface RuleGroup {
  readonly rule: string
  readonly findings: readonly Finding[]
  readonly clusters: readonly ElementCluster[]
  readonly worst: Severity
}

const RANK: Readonly<Record<Severity, number>> = { error: 0, warning: 1, info: 2 }

function worstOf(findings: readonly Finding[]): Severity {
  return findings.reduce<Severity>((w, f) => (RANK[f.severity] < RANK[w] ? f.severity : w), 'info')
}

function labelOf(model: ModelState | null, id: string): string {
  const el = model?.elements[id]
  return el && model ? elementName(model.elements, el) : id
}

/**
 * The element a finding is worded from. Its ids are sorted, so with two of
 * ours the first isn't necessarily the subject: the one whose name opens the
 * message is (rules write "RTU-1 passes 2 in. into …").
 */
function subjectOf(model: ModelState | null, f: Finding): { key: string; label: string } {
  if (f.elementIds.length === 0) return { key: f.id, label: f.message }
  for (const id of f.elementIds) {
    const label = labelOf(model, id)
    if (f.message.startsWith(label)) return { key: id, label }
  }
  const first = f.elementIds[0] as string
  return { key: first, label: labelOf(model, first) }
}

export function groupFindings(findings: readonly Finding[], model: ModelState | null): RuleGroup[] {
  const byRule = new Map<string, Finding[]>()
  for (const f of findings) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f])
  const groups: RuleGroup[] = []
  for (const [rule, list] of byRule) {
    const byElement = new Map<string, { label: string; findings: Finding[] }>()
    for (const f of list) {
      const s = subjectOf(model, f)
      const known = byElement.get(s.key)
      if (known) known.findings.push(f)
      else byElement.set(s.key, { label: s.label, findings: [f] })
    }
    const clusters = [...byElement.entries()]
      .map(([key, c]): ElementCluster => ({ key, label: c.label, findings: c.findings, elementIds: [...new Set(c.findings.flatMap((f) => f.elementIds))], worst: worstOf(c.findings) }))
      .sort((a, b) => RANK[a.worst] - RANK[b.worst] || b.findings.length - a.findings.length || a.label.localeCompare(b.label))
    groups.push({ rule, findings: list, clusters, worst: worstOf(list) })
  }
  return groups.sort((a, b) => RANK[a.worst] - RANK[b.worst] || a.rule.localeCompare(b.rule))
}
