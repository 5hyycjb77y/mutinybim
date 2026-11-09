'use client'

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { dependsOn, why, type Command, type DependsOnAnswer, type ModelState, type NodeRef, type RankedAnswer } from '@permitzip/bim-kernel'
import { Button } from '../../ui/button'
import { Separator } from '../../ui/separator'
import { DecisionForm } from '../checklist/ChecklistNeeds'

/**
 * Inspector › Why is this here? / What depends on this: the requirements
 * graph's two questions for the selected element, each five sentences with a
 * named cause, then "and N more". A space or zone also
 * gets Record a decision.
 */

export interface WhySectionProps {
  readonly model: ModelState
  readonly elementId: string
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly actorName: string
  readonly submit: (command: Command, undoLabel: string) => string | null
}

type Answers = { readonly why: RankedAnswer; readonly depends: DependsOnAnswer } | { readonly problem: string }

function nodeOf(model: ModelState, id: string): NodeRef {
  const kind = model.elements[id]?.kind
  return { kind: kind === 'space' || kind === 'zone' ? kind : 'element', id }
}

function AnswerList({ answer, testId }: { answer: RankedAnswer; testId: string }) {
  if (answer.items.length === 0) return <p className="text-xs text-muted-foreground" data-testid={`${testId}-empty`}>{answer.empty}</p>
  return (
    <ol className="flex flex-col gap-1 text-xs" data-testid={testId}>
      {answer.items.map((item) => (
        <li key={`${item.node.kind}:${item.node.id}:${item.label}`}>
          <span className="font-medium">{item.label}</span>
          <span className="text-muted-foreground">: {item.cause}</span>
        </li>
      ))}
      {answer.more > 0 && <li className="text-muted-foreground" data-testid={`${testId}-more`}>and {answer.more} more</li>}
    </ol>
  )
}

export function WhySection({ model, elementId, canEdit, blockedReason, actorName, submit }: WhySectionProps) {
  const [deciding, setDeciding] = useState(false)
  const answers = useMemo<Answers>(() => {
    try {
      const node = nodeOf(model, elementId)
      return { why: why(model, node), depends: dependsOn(model, node) }
    } catch (err) {
      console.error('[Inspector] the requirements graph could not answer', { elementId, err })
      return { problem: err instanceof Error ? err.message : String(err) }
    }
  }, [model, elementId])
  const el = model.elements[elementId]
  if (!el) return null
  const place = el.kind === 'space' || el.kind === 'zone'
  const name = 'name' in el && typeof el.name === 'string' && el.name ? el.name : elementId

  return (
    <section className="flex flex-col gap-2" data-testid="inspector-why" aria-label="Why is this here?">
      <Separator />
      {'problem' in answers ? (
        <p className="text-xs text-danger-600" role="alert">
          The code studies couldn&apos;t be read for this: {answers.problem}
        </p>
      ) : (
        <>
          <h4 className="text-xs font-medium">Why is this here?</h4>
          <AnswerList answer={answers.why} testId="inspector-why-list" />
          <h4 className="text-xs font-medium">What depends on this</h4>
          <AnswerList answer={answers.depends} testId="inspector-depends-list" />
          {answers.depends.quantityDeltas.length > 0 && (
            <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground" data-testid="inspector-depends-quantities">
              {answers.depends.quantityDeltas.map((q) => (
                <li key={`${q.measure}:${q.group}`}>{q.label}</li>
              ))}
            </ul>
          )}
        </>
      )}
      {place && !deciding && (
        <Button size="sm" variant="outline" className="self-start" disabled={!canEdit} title={canEdit ? `Record a decision for ${name}` : blockedReason} onClick={() => setDeciding(true)} data-testid="inspector-record-decision">
          Record a decision
        </Button>
      )}
      {place && deciding && (
        <DecisionForm
          anchorLabel={name}
          onCancel={() => setDeciding(false)}
          onSave={(d) => {
            const refused = submit(
              { type: 'record_determination', determinationId: `det-${Math.random().toString(36).slice(2, 10)}`, subject: { kind: el.kind, id: elementId }, key: d.key, value: d.value, reasoning: d.reasoning, decidedBy: actorName, decidedAt: new Date().toISOString(), confidence: d.confidence },
              `record ${d.key} for ${name}`,
            )
            if (refused) toast.error(refused)
            else setDeciding(false)
          }}
        />
      )}
    </section>
  )
}
