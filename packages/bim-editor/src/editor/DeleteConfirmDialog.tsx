'use client'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog'
import type { DeletePlan } from './model-session'

export type DeletePolicy = 'refuse' | 'disconnect' | 'cascade'

/** Building Model › Delete: what else goes with it, before anything is deleted. */
export function DeleteConfirmDialog({ pending, onClose, onConfirm }: { readonly pending: { readonly title: string; readonly plan: DeletePlan } | null; readonly onClose: () => void; readonly onConfirm: (policy: DeletePolicy) => void }) {
  return (
    <AlertDialog open={pending !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent data-testid="delete-confirmation">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {pending?.title}?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2">
              {pending?.plan.kind === 'clear' && <p>Nothing else depends on it. You can undo this.</p>}
              {pending?.plan.kind === 'refused' && <p>{pending.plan.message}</p>}
              {pending?.plan.kind === 'dependents' && (
                <>
                  <p>
                    {pending.plan.dependents.length > 0
                      ? 'These depend on it and would be deleted too:'
                      : `It has ${pending.plan.connections} connection${pending.plan.connections === 1 ? '' : 's'} that would be cut.`}
                  </p>
                  {pending.plan.dependents.length > 0 && (
                    <ul className="list-disc pl-5" data-testid="delete-dependents">
                      {pending.plan.dependents.slice(0, 8).map((d) => (
                        <li key={d.id}>{d.label}</li>
                      ))}
                      {pending.plan.dependents.length > 8 && <li>and {pending.plan.dependents.length - 8} more</li>}
                    </ul>
                  )}
                  <p>You can undo this.</p>
                </>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          {pending?.plan.kind === 'clear' && (
            <AlertDialogAction variant="destructive" onClick={() => onConfirm('refuse')}>
              Delete
            </AlertDialogAction>
          )}
          {pending?.plan.kind === 'dependents' && (
            <AlertDialogAction variant="destructive" onClick={() => onConfirm(pending.plan.kind === 'dependents' && pending.plan.dependents.length > 0 ? 'cascade' : 'disconnect')}>
              {pending.plan.dependents.length > 0 ? 'Delete all of these' : 'Delete and cut connections'}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
