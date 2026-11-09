'use client'

import { useState } from 'react'
import { BookOpen, Crosshair, Link2, PenLine, ShieldCheck, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { asElementId, type Command, type ModelState, type Requirement } from '@permitzip/bim-kernel'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../../ui/empty'
import { Field, FieldGroup, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemHeader, ItemTitle } from '../../ui/item'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Textarea } from '../../ui/textarea'
import type { EditorDataHost } from '@permitzip/bim-editor-host'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { createBrowserCodeStudyWriteBackFrom, createRequirementLinkFrom, PERMITZIP_CODE_STUDY_SOURCE_ID, VERIFY_NEEDS_RIGHTS, type RequirementLinkInput } from '../code-study/code-study-client'
import { checklistGroups, fulfilmentLabel, statusLabel, valueLabel, visibleRows, type ChecklistGroup, type ChecklistRow } from './checklist-model'

/**
 * Checklist › Needs: what the requirements graph says each place still
 * needs, grouped by cause, ranked, five per group then "and N more". Each row
 * names the requirement, its citation, its source, its status and how the
 * model meets it, with: Show, Record decision (spaces and zones), Override
 * (a reason is required), Verify (code-study editors only; agents never
 * verify), Open in Code Map and Link to Code Map (PermitZIP code studies).
 */

export interface ChecklistNeedsProps {
  readonly projectId: string
  readonly modelId: string
  readonly model: ModelState
  readonly requirements: readonly Requirement[]
  /** Null while it is being checked, else whether the person may verify. */
  readonly canVerify: boolean | null
  readonly canEdit: boolean
  /** Why edits are refused, shown on disabled actions. */
  readonly blockedReason: string
  /** Who the person is, as records name them. */
  readonly actorName: string
  readonly submit: (command: Command, undoLabel: string) => string | null
  readonly onSelect: (ids: readonly string[]) => void
  /** Why the graph couldn't be read, with Retry. */
  readonly problem?: string | null
  readonly onRetry?: () => void
}

const CODE_MAP_HREF = (projectId: string) => `/projects/${encodeURIComponent(projectId)}?node=codemap:code_study`

function isPermitZip(r: Requirement): boolean {
  return r.provider === PERMITZIP_CODE_STUDY_SOURCE_ID && r.sourceRef !== undefined
}

/** A requirement's anchor as one of the four places a link or a decision can name. */
function placeKind(r: Requirement): 'space' | 'zone' | 'element' | 'model' {
  switch (r.anchor.kind) {
    case 'space':
      return 'space'
    case 'zone':
      return 'zone'
    case 'element':
      return 'element'
    default:
      return 'model'
  }
}

function linkOf(r: Requirement, modelId: string, linkKind: RequirementLinkInput['linkKind']): RequirementLinkInput | null {
  if (!r.sourceRef) return null
  return { requirementId: r.sourceRef.ref, modelId, targetKind: placeKind(r), targetId: r.anchor.id ?? modelId, linkKind }
}

/** Write the requirement ↔ model link after a person acted on a PermitZIP requirement; a refusal is shown, never swallowed. */
async function linkAfter(port: EditorDataHost['codeStudy'], projectId: string, r: Requirement, modelId: string): Promise<void> {
  const link = linkOf(r, modelId, 'anchor')
  if (!link || !isPermitZip(r)) return
  const result = await createRequirementLinkFrom(port, projectId, link)
  if (!result.ok) toast.error(`Saved in the model, but the Code Map link wasn't written: ${result.reason}`)
}

function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

function OverrideForm({ r, onCancel, onSave }: { r: Requirement; onCancel: () => void; onSave: (value: number | string, reason: string) => void }) {
  const [value, setValue] = useState(r.value === null ? '' : String(r.value))
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const save = () => {
    if (reason.trim().length < 3) {
      setError('Say why you are overriding it; the reason travels with the model and is offered to its code study.')
      return
    }
    if (!value.trim()) {
      setError('Enter the value that should apply here.')
      return
    }
    const n = Number(value)
    onSave(typeof r.value === 'number' && Number.isFinite(n) ? n : value.trim(), reason.trim())
  }
  return (
    <FieldGroup className="gap-2" data-testid="checklist-override-form">
      <Field>
        <FieldLabel htmlFor={`ov-v-${r.id}`}>Value{r.unit && r.unit !== '1' ? ` (${r.unit})` : ''}</FieldLabel>
        <Input id={`ov-v-${r.id}`} value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
      <Field>
        <FieldLabel htmlFor={`ov-r-${r.id}`}>Reason (required)</FieldLabel>
        <Textarea id={`ov-r-${r.id}`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      {error && (
        <p className="text-xs text-danger-600" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" onClick={save} data-testid="checklist-override-save">
          Override
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </FieldGroup>
  )
}

export function DecisionForm({ anchorLabel, onCancel, onSave }: { anchorLabel: string; onCancel: () => void; onSave: (d: { key: string; value: string; reasoning: string; confidence: 'high' | 'medium' | 'low' }) => void }) {
  const [key, setKey] = useState('occupancy')
  const [value, setValue] = useState('')
  const [reasoning, setReasoning] = useState('')
  const [confidence, setConfidence] = useState<'high' | 'medium' | 'low'>('medium')
  const [error, setError] = useState<string | null>(null)
  const save = () => {
    if (!key.trim() || !value.trim()) {
      setError('Say what you decided (for example occupancy) and the answer (for example A-3).')
      return
    }
    if (reasoning.trim().length < 3) {
      setError('Write the reasoning in your own words; it is what "why is this here?" shows.')
      return
    }
    onSave({ key: key.trim(), value: value.trim(), reasoning: reasoning.trim(), confidence })
  }
  return (
    <FieldGroup className="gap-2" data-testid="checklist-decision-form">
      <p className="text-xs text-muted-foreground">A decision for {anchorLabel}</p>
      <div className="grid grid-cols-2 gap-2">
        <Field>
          <FieldLabel htmlFor="dec-key">What you decided</FieldLabel>
          <Input id="dec-key" value={key} onChange={(e) => setKey(e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="dec-value">Answer</FieldLabel>
          <Input id="dec-value" value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="dec-reason">Reasoning</FieldLabel>
        <Textarea id="dec-reason" rows={2} value={reasoning} onChange={(e) => setReasoning(e.target.value)} />
      </Field>
      <Field>
        <FieldLabel htmlFor="dec-confidence">Confidence</FieldLabel>
        <Select value={confidence} onValueChange={(v) => setConfidence(v === 'high' || v === 'low' ? v : 'medium')}>
          <SelectTrigger id="dec-confidence" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      {error && (
        <p className="text-xs text-danger-600" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" onClick={save} data-testid="checklist-decision-save">
          Record decision
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </FieldGroup>
  )
}

function anchorLabelOf(model: ModelState, r: Requirement): string {
  if (!r.anchor.id) return 'the whole model'
  const el = model.elements[r.anchor.id]
  if (el && 'name' in el && typeof el.name === 'string' && el.name) return el.name
  return r.anchor.id
}

function Row({ row, props }: { row: ChecklistRow; props: ChecklistNeedsProps }) {
  const { requirement: r, conflicts } = row
  const { projectId, modelId, model, canEdit, canVerify, blockedReason, actorName, submit, onSelect } = props
  const codeStudy = useEditorHost().data.codeStudy
  const [open, setOpen] = useState<'override' | 'decision' | null>(null)
  const ours = isPermitZip(r)
  const writeBack = ours ? createBrowserCodeStudyWriteBackFrom(codeStudy, projectId) : null
  const showIds = [...(r.anchor.id ? [r.anchor.id] : []), ...r.fulfilment.elementIds]
  const verifyReason = !canEdit ? blockedReason : canVerify === false ? VERIFY_NEEDS_RIGHTS : canVerify === null ? 'Checking your code-study rights…' : null
  const value = valueLabel(r)

  const verify = async () => {
    const refused = submit({ type: 'set_requirement_state', requirementId: r.id, status: 'verified', reason: 'Verified in the Building Model checklist', by: actorName }, `verify ${r.title}`)
    if (refused) {
      toast.error(refused)
      return
    }
    if (writeBack && r.sourceRef) {
      const result = await writeBack.verifyRule({ ruleId: r.ruleId, sourceRef: r.sourceRef, status: 'verified', reason: 'Verified in the Building Model checklist' })
      if (!result.ok) toast.error(`Saved in the model; PermitZIP code study didn't accept it: ${result.reason}`)
    }
    await linkAfter(codeStudy, projectId, r, modelId)
  }

  const override = async (next: number | string, reason: string) => {
    const unit = r.unit && r.unit !== '1' ? r.unit : undefined
    const refused = submit({ type: 'set_requirement_state', requirementId: r.id, status: 'overridden', value: next, ...(unit ? { unit } : {}), reason, by: actorName }, `override ${r.title}`)
    if (refused) {
      toast.error(refused)
      return
    }
    setOpen(null)
    if (writeBack) {
      const result = await writeBack.overrideRequirement({ modelId, modelRevision: model.revision, requirementId: r.id, ...(r.sourceRef ? { sourceRef: r.sourceRef } : {}), anchorId: r.anchor.id, value: next, ...(unit ? { unit } : {}), reason })
      if (result.ok) toast.success('Overridden in the model and offered to the Code Map')
      else toast.error(`Saved in the model; PermitZIP code study didn't accept it: ${result.reason}`)
    }
    await linkAfter(codeStudy, projectId, r, modelId)
  }

  const decide = async (d: { key: string; value: string; reasoning: string; confidence: 'high' | 'medium' | 'low' }) => {
    if (!r.anchor.id) return
    const determinationId = newId('det')
    const subject = { kind: placeKind(r), id: r.anchor.id }
    const decidedAt = new Date().toISOString()
    const refused = submit({ type: 'record_determination', determinationId, subject, key: d.key, value: d.value, reasoning: d.reasoning, decidedBy: actorName, decidedAt, confidence: d.confidence }, `record ${d.key} for ${anchorLabelOf(model, r)}`)
    if (refused) {
      toast.error(refused)
      return
    }
    setOpen(null)
    if (writeBack) {
      const result = await writeBack.recordDetermination({
        modelId,
        modelRevision: model.revision,
        record: { id: asElementId(determinationId), kind: 'determination', version: 1, authoredRev: {}, determination: { subject, key: d.key, value: d.value, inputs: [], reasoning: d.reasoning, decidedBy: actorName, decidedAt, confidence: d.confidence, status: 'recorded' } },
      })
      if (!result.ok) toast.error(`Saved in the model; PermitZIP code study didn't accept it: ${result.reason}`)
    }
    await linkAfter(codeStudy, projectId, r, modelId)
  }

  const linkNow = async () => {
    const link = linkOf(r, modelId, 'anchor')
    if (!link) return
    const result = await createRequirementLinkFrom(codeStudy, projectId, link)
    if (result.ok) toast.success('Linked: Code Map › Show in model now opens it here')
    else toast.error(result.reason)
  }

  return (
    <Item variant="outline" size="sm" data-testid="checklist-row" data-requirement={r.id}>
      <ItemHeader className="min-w-0 flex-wrap gap-1">
        <ItemTitle className="min-w-0 text-sm">{r.title}</ItemTitle>
        <Badge variant={r.status === 'overridden' || r.status === 'withdrawn' ? 'secondary' : 'outline'} data-testid="checklist-status">
          {statusLabel(r)}
        </Badge>
      </ItemHeader>
      <ItemContent className="gap-1">
        <ItemDescription className="text-xs">
          {r.citation.instrument} {r.citation.section}
          {value ? ` · ${value}` : ''} · {anchorLabelOf(model, r)}
        </ItemDescription>
        <ItemDescription className="text-xs" data-testid="checklist-fulfilment">
          {fulfilmentLabel(r)}
          {r.problem ? ` (${r.problem})` : ''}
        </ItemDescription>
        {r.accepted && <ItemDescription className="text-xs">Accepted in its code study: {r.accepted.reason}</ItemDescription>}
        {(r.chips ?? []).length > 0 && (
          <div className="flex flex-wrap gap-1">
            {(r.chips ?? []).map((chip) => (
              <Badge key={chip} variant="outline" className="text-[10px]">
                {chip}
              </Badge>
            ))}
          </div>
        )}
        {conflicts.map((c) => (
          <ItemDescription key={c.id} className="text-xs text-warning-700" data-testid="checklist-conflict">
            Also from {c.provider}: {valueLabel(c) ?? 'no model check'} ({c.citation.instrument} {c.citation.section})
          </ItemDescription>
        ))}
        {open === 'override' && <OverrideForm r={r} onCancel={() => setOpen(null)} onSave={(v, reason) => void override(v, reason)} />}
        {open === 'decision' && <DecisionForm anchorLabel={anchorLabelOf(model, r)} onCancel={() => setOpen(null)} onSave={(d) => void decide(d)} />}
        {verifyReason && canVerify === false && <p className="text-xs text-muted-foreground">{VERIFY_NEEDS_RIGHTS}</p>}
      </ItemContent>
      <ItemActions className="flex-wrap">
        <Button size="sm" variant="ghost" disabled={showIds.length === 0} onClick={() => onSelect(showIds)} title="Select it and what meets it">
          <Crosshair data-icon="inline-start" />
          Show
        </Button>
        {(r.anchor.kind === 'space' || r.anchor.kind === 'zone') && (
          <Button size="sm" variant="ghost" disabled={!canEdit} title={canEdit ? 'Record a decision for this place' : blockedReason} onClick={() => setOpen('decision')} data-testid="checklist-record-decision">
            <PenLine data-icon="inline-start" />
            Record decision
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={!canEdit} title={canEdit ? 'Replace the value here, with a reason' : blockedReason} onClick={() => setOpen('override')} data-testid="checklist-override">
          Override…
        </Button>
        <Button size="sm" variant="ghost" disabled={verifyReason !== null || r.status === 'verified'} title={verifyReason ?? 'Verify it as a person with code-study edit rights'} onClick={() => void verify()} data-testid="checklist-verify">
          <ShieldCheck data-icon="inline-start" />
          Verify
        </Button>
        {ours && (
          <>
            <Button size="sm" variant="ghost" asChild>
              <a href={CODE_MAP_HREF(projectId)} target="_blank" rel="noreferrer" data-testid="checklist-open-code-map">
                <BookOpen data-icon="inline-start" />
                Open in Code Map
              </a>
            </Button>
            <Button size="sm" variant="ghost" disabled={!canEdit} title={canEdit ? 'Link it so the Code Map can show it in the model' : blockedReason} onClick={() => void linkNow()} data-testid="checklist-link">
              <Link2 data-icon="inline-start" />
              Link to Code Map
            </Button>
          </>
        )}
      </ItemActions>
    </Item>
  )
}

function Group({ group, props }: { group: ChecklistGroup; props: ChecklistNeedsProps }) {
  const [expanded, setExpanded] = useState(false)
  const { rows, more } = visibleRows(group, expanded)
  return (
    <section className="flex min-w-0 flex-col gap-2" data-testid="checklist-group" data-cause={group.cause}>
      <h3 className="flex items-start gap-2 text-sm font-medium">
        <span className="min-w-0 flex-1">{group.cause}</span>
        <Badge variant="outline" className="shrink-0">
          {group.open} open
        </Badge>
      </h3>
      <ItemGroup className="gap-2">
        {rows.map((row) => (
          <Row key={row.requirement.id} row={row} props={props} />
        ))}
      </ItemGroup>
      {more > 0 && (
        <Button size="sm" variant="link" className="self-start" onClick={() => setExpanded(true)} data-testid="checklist-more">
          and {more} more
        </Button>
      )}
    </section>
  )
}

/** Causes drawn before "Show N more causes": keeps a frame cheap on a model with thousands of requirements. */
export const CAUSES_PER_PAGE = 40

export function ChecklistNeeds(props: ChecklistNeedsProps) {
  const [pages, setPages] = useState(1)
  if (props.problem) {
    return (
      <Alert variant="destructive" data-testid="checklist-error">
        <TriangleAlert />
        <AlertTitle>The checklist couldn&apos;t read the code studies</AlertTitle>
        <AlertDescription>
          {props.problem}
          {props.onRetry && (
            <Button variant="outline" size="sm" className="mt-2" onClick={props.onRetry}>
              Retry
            </Button>
          )}
        </AlertDescription>
      </Alert>
    )
  }
  const groups = checklistGroups(props.requirements)
  if (groups.length === 0 || groups.every((g) => g.open === 0)) {
    return (
      <Empty className="border" data-testid="checklist-empty">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldCheck />
          </EmptyMedia>
          <EmptyTitle>Nothing left to check</EmptyTitle>
          <EmptyDescription>
            {groups.length === 0 ? 'No code study on this model produces a requirement yet. Pin one, or add a local rule.' : 'Every requirement the code studies produce here is met or decided.'}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto" data-testid="checklist-needs">
      {groups.slice(0, pages * CAUSES_PER_PAGE).map((g) => (
        <Group key={g.cause} group={g} props={props} />
      ))}
      {groups.length > pages * CAUSES_PER_PAGE && (
        <Button size="sm" variant="outline" className="self-start" onClick={() => setPages((n) => n + 1)} data-testid="checklist-more-causes">
          Show {Math.min(CAUSES_PER_PAGE, groups.length - pages * CAUSES_PER_PAGE)} more causes ({groups.length - pages * CAUSES_PER_PAGE} left)
        </Button>
      )}
    </div>
  )
}
