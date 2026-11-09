'use client'

import { useState } from 'react'
import { PackageOpen } from 'lucide-react'
import { modelSetupOf, type ModelState } from '@permitzip/bim-kernel'
import type { Pack } from '@permitzip/bim-kernel/packs'
import { Alert, AlertDescription } from '../../ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../ui/alert-dialog'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../../ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../ui/item'
import { Switch } from '../../ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { PREVIEW_PACK_IDS, installedPacks } from '../../contracts/building-model/installed-packs'
import type { SubmitCommand } from '../views-sheets/types'
import { PREVIEW_NOTE } from './AddonsPreviewNote'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { DisciplinesSectionFrom, type DisciplineRows } from '../library/DisciplinesSection'


interface Props {
  readonly model: ModelState
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly submit: SubmitCommand
  readonly onClose: () => void
  /** The add-ons this server has; the host's list by default. */
  readonly packs?: readonly Pack[]
  readonly previewIds?: ReadonlySet<string>
  /** The firm's disciplines to offer for pinning; the library by default. */
  readonly loadDisciplineRows?: () => Promise<DisciplineRows>
}

/**
 * Building Model › Manage › Model settings › Add-ons: switch an installed
 * add-on on or off for this model. Off by default. A switch is an ordinary
 * edit (undoable, attributed; an agent's switch gets an Approve card).
 * Switching off asks first: its rows are hidden, nothing is deleted.
 */
export function AddonsPreview({ model, canEdit, blockedReason, submit, onClose, packs = installedPacks(), previewIds = PREVIEW_PACK_IDS, loadDisciplineRows }: Props) {
  const firmLibrary = useEditorHost().data.firmLibrary
  const [error, setError] = useState<string | null>(null)
  const [confirmOff, setConfirmOff] = useState<Pack | null>(null)
  const pins = modelSetupOf(model).pins
  const isOn = (pack: Pack) => pins.some((p) => p.id === pack.manifest.id && p.version === pack.manifest.version)

  const flip = (pack: Pack, on: boolean) => {
    const verb = on ? 'switch on' : 'switch off'
    const refusal = submit({ type: 'set_model_addon', packId: pack.manifest.id, version: pack.manifest.version, on }, `${verb} ${pack.manifest.name}`)
    if (refusal) console.error('[AddonsPreview] the add-on switch was refused', { packId: pack.manifest.id, on, refusal })
    setError(refusal)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl" data-testid="addons-preview-dialog">
        <DialogHeader>
          <DialogTitle>Add-ons</DialogTitle>
          <DialogDescription>Add-ons this server has, beyond the built-in trades. Each is off until you switch it on for this model; a switch is an edit you can undo.</DialogDescription>
        </DialogHeader>
        {!canEdit && (
          <Alert>
            <AlertDescription>{blockedReason}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive" data-testid="addons-preview-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {packs.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PackageOpen />
              </EmptyMedia>
              <EmptyTitle>No add-ons on this server</EmptyTitle>
              <EmptyDescription>Only the built-in trades are installed. Settings › MutinyBIM library › Add-ons lists what a server has.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup>
            {packs.map((pack) => {
              const on = isOn(pack)
              const preview = previewIds.has(pack.manifest.id)
              const label = `${pack.manifest.name}${preview ? ' (Preview)' : ''}`
              const toggle = (
                <Switch
                  checked={on}
                  disabled={!canEdit}
                  aria-label={`${label}: ${on ? 'on' : 'off'} for this model`}
                  data-testid={`addon-switch-${pack.manifest.id}`}
                  onCheckedChange={(next) => (next ? flip(pack, true) : setConfirmOff(pack))}
                />
              )
              return (
                <Item key={pack.manifest.id} variant="outline" data-testid={`addon-row-${pack.manifest.id}`}>
                  <ItemContent>
                    <ItemTitle>
                      {pack.manifest.name}
                      {preview && <Badge variant="outline">Preview</Badge>}
                      <span className="text-muted-foreground text-xs tabular-nums">{pack.manifest.version}</span>
                    </ItemTitle>
                    {pack.manifest.description && <ItemDescription>{pack.manifest.description}</ItemDescription>}
                    {preview && <ItemDescription className="text-warning-700">{PREVIEW_NOTE}</ItemDescription>}
                  </ItemContent>
                  <ItemActions>
                    {canEdit ? (
                      toggle
                    ) : (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>{toggle}</span>
                        </TooltipTrigger>
                        <TooltipContent>{blockedReason}</TooltipContent>
                      </Tooltip>
                    )}
                  </ItemActions>
                </Item>
              )
            })}
          </ItemGroup>
        )}
        <DisciplinesSectionFrom port={firmLibrary} pinTo={{ model, canEdit, blockedReason, submit }} {...(loadDisciplineRows ? { loadRows: loadDisciplineRows } : {})} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
      <AlertDialog open={confirmOff !== null} onOpenChange={(open) => !open && setConfirmOff(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch {confirmOff?.manifest.name} off for this model?</AlertDialogTitle>
            <AlertDialogDescription>Its rows are hidden; nothing is deleted. Switch it back on, or undo, to see them again.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it on</AlertDialogCancel>
            <AlertDialogAction
              data-testid="addon-switch-off-confirm"
              onClick={() => {
                if (confirmOff) flip(confirmOff, false)
                setConfirmOff(null)
              }}
            >
              Switch off
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}
