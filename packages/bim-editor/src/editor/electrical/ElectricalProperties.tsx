'use client'

import { Cable, CircleDot, Power, ToggleLeft, Unplug, Waypoints } from 'lucide-react'
import { faultCurrentAt, faultCurrentSummary, electricalConnections, hasPositions, isLocalDisconnectPart, panelSchedule, upstreamLinkOfPart } from '@permitzip/bim-pack-electrical'
import { builtinPartType, serviceLinkName, type Command, type ModelState } from '@permitzip/bim-kernel'
import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../ui/item'
import { Label } from '../../ui/label'
import { Separator } from '../../ui/separator'
import type { SubmitCommand } from '../views-sheets/types'
import { ConnectionTypePicker } from './ConnectionTypePicker'
import { DedicatedSpaceForm } from './DedicatedSpaceForm'
import type { ElectricalTarget } from './selection'

/**
 * The Electrical section of the properties panel: what a device is on (with
 * one click to put it on a circuit or change it), the circuits a panel has and
 * what feeds it, and for a box selection how many are circuited.
 */
export function ElectricalProperties({
  model,
  target,
  addBlocked,
  onAdd,
  onEdit,
  onEditControls,
  onPanelView,
  onFeed,
  submit,
  editBlocked,
  onManageTypes,
}: {
  readonly model: ModelState
  readonly target: ElectricalTarget
  readonly addBlocked: string | null
  readonly onAdd: () => void
  readonly onEdit: (linkId: string) => void
  readonly onEditControls?: () => void
  readonly onPanelView: (panelId: string) => void
  readonly onFeed: () => void
  readonly submit: SubmitCommand
  readonly editBlocked: string | null
  readonly onManageTypes: () => void
}) {
  const els = model.elements
  const body = (() => {
    if (target.panels.length === 1 && target.loads.length === 0) {
      const panelId = target.panels[0] ?? ''
      const s = panelSchedule(els, panelId)
      if (!s) return null
      const fault = faultCurrentAt(els, panelId)
      const panelPart = els[panelId]
      return (
        <>
          <ItemGroup className="gap-1">
            <Item size="sm">
              <ItemContent>
                <ItemDescription className="text-xs">System</ItemDescription>
                <ItemTitle className="text-xs font-normal">{s.system}</ItemTitle>
              </ItemContent>
            </Item>
            <Item size="sm">
              <ItemContent>
                <ItemDescription className="text-xs">Supply from</ItemDescription>
                <ItemTitle className="text-xs font-normal" data-testid="electrical-props-supply">
                  {s.fedBy ? `${s.fedBy.sourceName} (${s.fedBy.name})` : 'Not fed yet'}
                </ItemTitle>
              </ItemContent>
            </Item>
            <Item size="sm">
              <ItemContent>
                <ItemDescription className="text-xs">{hasPositions(s.kind) ? 'Circuits' : 'Feeds'}</ItemDescription>
                <ItemTitle className="text-xs font-normal" data-testid="electrical-props-circuits">
                  {s.circuits.length === 0 ? 'None yet' : s.circuits.slice(0, 8).map((c) => (c.role === 'feeder' ? `${c.name} (feeder)` : `${c.name} ${c.description}`.trim())).join(' · ')}
                  {s.circuits.length > 8 ? ` · and ${s.circuits.length - 8} more` : ''}
                </ItemTitle>
              </ItemContent>
            </Item>
            {fault && (
              <Item size="sm">
                <ItemContent>
                  <ItemDescription className="text-xs">Fault current</ItemDescription>
                  <ItemTitle className={`text-xs font-normal${fault.passes === false ? ' text-danger-600' : ''}`} data-testid="electrical-props-fault">
                    {faultCurrentSummary(fault)}
                  </ItemTitle>
                </ItemContent>
              </Item>
            )}
          </ItemGroup>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => onPanelView(panelId)} data-testid="electrical-props-panel-view">
              <CircleDot data-icon="inline-start" />
              Open panel schedule
            </Button>
            <Button variant="outline" size="sm" onClick={onFeed} data-testid="electrical-props-feed">
              <Unplug data-icon="inline-start" />
              {s.fedBy ? 'Change feeder' : `Feed ${s.name}`}
            </Button>
          </div>
          {panelPart?.kind === 'part' && <DedicatedSpaceForm key={panelId} model={model} part={panelPart} canEdit={editBlocked === null} editBlocked={editBlocked} submit={submit} />}
        </>
      )
    }
    if (target.loads.length === 1 && target.panels.length === 0) {
      const id = target.loads[0] ?? ''
      const part = els[id]
      const conn = electricalConnections(els, id)[0]
      const circuit = conn?.circuit ?? null
      const sourceEl = circuit ? els[circuit.sourceId] : undefined
      const localDisc = sourceEl?.kind === 'part' && isLocalDisconnectPart(model, sourceEl) ? sourceEl : null
      const upstreamLink = localDisc ? upstreamLinkOfPart(model, localDisc.id) : null
      const upstreamName = upstreamLink ? serviceLinkName(els, upstreamLink) : null
      const disconnectExempt =
        part?.kind === 'part' &&
        (part.values['electrical.disconnect_required'] === false ||
          part.values['electrical.local_disconnect'] === 'not_required' ||
          part.values.disconnect_required === false ||
          part.values.local_disconnect === 'not_required')
      const partType = part?.kind === 'part' ? els[part.typeId] : undefined
      const showDisconnectControls =
        Boolean(localDisc) ||
        (partType?.kind === 'part_type' &&
          (partType.definition.category === 'mechanical_equipment' || partType.definition.category === 'plumbing_fixture' || partType.definition.category === 'electrical_equipment'))

      type EditStep = Extract<Command, { type: 'batch_edits' }>['commands'][number]

      const nextLinkId = (base: string) => {
        let id = base
        let k = 2
        while (els[id]) id = `${base}-${k++}`
        return id
      }

      const handleToggleDisconnectExempt = (exempt: boolean) => {
        if (part?.kind !== 'part') return
        submit(
          {
            type: 'set_element_values',
            elementIds: [part.id],
            values: { 'electrical.disconnect_required': !exempt, 'electrical.local_disconnect': exempt ? 'not_required' : 'required' },
          },
          exempt ? 'mark local disconnect not required' : 'require local disconnect',
        )
      }

      const handleAddDisconnect = () => {
        if (part?.kind !== 'part') return
        const currentLink = circuit ? els[circuit.linkId] : undefined
        const ratingA = (currentLink?.kind === 'service_link' ? currentLink.electrical?.ratingA : undefined) ?? 30
        const typeId = ratingA > 30 ? 'builtin:disconnect-nf-60-480@1' : 'builtin:disconnect-nf-30-480@1'
        const def = els[typeId]?.kind === 'part_type' ? undefined : builtinPartType(typeId)?.definition
        const slug = (part.mark.trim() || part.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'eq'
        let discId = `disc-${slug}`
        let n = 2
        while (els[discId]) discId = `disc-${slug}-${n++}`
        const mark = `SD-${part.mark.trim() || part.id}`
        const cmds: EditStep[] = [
          {
            type: 'place_part',
            partId: discId,
            typeId,
            ...(def ? { partType: def } : {}),
            levelId: part.levelId,
            position: { x: Math.round(part.position.x - 900), y: Math.round(part.position.y) },
            offsetMm: Math.round(part.offsetMm || 1200),
            mark,
            values: { panel_name: mark, serves: part.mark.trim() || part.id },
          },
          { type: 'set_element_values', elementIds: [part.id], values: { 'electrical.disconnect_required': true, 'electrical.local_disconnect': 'required' } },
        ]
        if (currentLink?.kind === 'service_link') {
          if (currentLink.members.length === 1) {
            cmds.push({ type: 'delete_elements', ids: [currentLink.id], policy: 'cascade' })
            cmds.push({
              type: 'create_service_link',
              linkId: nextLinkId(`ckt-${currentLink.source.elementId}-to-${discId}`),
              sourceId: currentLink.source.elementId,
              ...(currentLink.source.positions.length > 0 ? { positions: [...currentLink.source.positions] } : {}),
              members: [{ elementId: discId }],
              ...(currentLink.description ? { description: currentLink.description } : {}),
              ...(currentLink.electrical ? { electrical: currentLink.electrical } : { electrical: { ratingA } }),
            })
          } else {
            cmds.push({ type: 'remove_link_members', linkId: currentLink.id, elementIds: [part.id] })
            cmds.push({
              type: 'create_service_link',
              linkId: nextLinkId(`ckt-${currentLink.source.elementId}-to-${discId}`),
              sourceId: currentLink.source.elementId,
              members: [{ elementId: discId }],
              description: `${part.mark || part.id} (via ${mark})`,
              electrical: { ratingA },
            })
          }
        }
        cmds.push({
          type: 'create_service_link',
          linkId: nextLinkId(`ckt-${discId}-to-${slug}`),
          sourceId: discId,
          members: [{ elementId: part.id }],
          description: `${part.mark || part.id} local feed`,
          electrical: { ratingA },
        })
        submit({ type: 'batch_edits', label: `Add local disconnect ${mark}`, commands: cmds }, `add local disconnect ${mark}`)
      }

      const handleRemoveDisconnect = () => {
        if (part?.kind !== 'part' || !localDisc || !circuit) return
        const cmds: EditStep[] = [
          {
            type: 'delete_elements',
            ids: [circuit.linkId, localDisc.id, ...(upstreamLink ? [upstreamLink.id] : [])],
            policy: 'cascade',
          },
        ]
        if (upstreamLink) {
          cmds.push({
            type: 'create_service_link',
            linkId: nextLinkId(`ckt-${upstreamLink.source.elementId}-to-${part.id}`),
            sourceId: upstreamLink.source.elementId,
            ...(upstreamLink.source.positions.length > 0 ? { positions: [...upstreamLink.source.positions] } : {}),
            members: [{ elementId: part.id }],
            ...(upstreamLink.description ? { description: upstreamLink.description } : {}),
            ...(upstreamLink.electrical ? { electrical: upstreamLink.electrical } : {}),
          })
        }
        submit({ type: 'batch_edits', label: `Remove local disconnect ${localDisc.mark || localDisc.id}`, commands: cmds }, 'remove local disconnect')
      }

      return (
        <>
          <ItemGroup className="gap-1">
            <Item size="sm">
              <ItemContent>
                <ItemDescription className="text-xs">Circuit</ItemDescription>
                <ItemTitle className="text-xs font-normal" data-testid="electrical-props-circuit">
                  {localDisc
                    ? upstreamName
                      ? `${upstreamName} (via ${localDisc.mark || localDisc.id})`
                      : `Via ${localDisc.mark || localDisc.id}`
                    : circuit
                      ? `${circuit.name} (panel ${circuit.sourceName})`
                      : 'Not on a circuit'}
                </ItemTitle>
              </ItemContent>
            </Item>
            <Item size="sm">
              <ItemContent>
                <ItemDescription className="text-xs">Needs</ItemDescription>
                <ItemTitle className="text-xs font-normal">
                  {conn?.voltage ? `${conn.voltage} V, ${conn.poles ?? 1} pole${(conn.poles ?? 1) === 1 ? '' : 's'}` : 'No voltage set: set it above before circuiting'}
                  {conn?.loadVa ? `, ${Math.round(conn.loadVa)} VA` : ''}
                </ItemTitle>
              </ItemContent>
            </Item>
            {showDisconnectControls && (
              <Item size="sm">
                <ItemContent>
                  <ItemDescription className="text-xs">Local disconnect</ItemDescription>
                  <ItemTitle className="text-xs font-normal" data-testid="electrical-props-disconnect">
                    {localDisc
                      ? `${localDisc.mark || localDisc.id}${upstreamName ? ` → ${upstreamName}` : ''}`
                      : disconnectExempt
                        ? 'Not required (exempt)'
                        : 'None (direct feed)'}
                  </ItemTitle>
                </ItemContent>
              </Item>
            )}
          </ItemGroup>
          {showDisconnectControls && (
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap gap-2">
                {localDisc ? (
                  <Button variant="outline" size="sm" onClick={handleRemoveDisconnect} disabled={editBlocked !== null} title={editBlocked ?? undefined} data-testid="electrical-props-remove-disconnect">
                    <Power data-icon="inline-start" />
                    Remove disconnect
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" onClick={handleAddDisconnect} disabled={editBlocked !== null} title={editBlocked ?? undefined} data-testid="electrical-props-add-disconnect">
                    <Power data-icon="inline-start" />
                    Add local disconnect
                  </Button>
                )}
              </div>
              {!localDisc && (
                <Label className="flex items-center gap-2 text-xs font-normal text-muted-foreground">
                  <Checkbox
                    checked={disconnectExempt}
                    disabled={editBlocked !== null}
                    onCheckedChange={(v) => handleToggleDisconnectExempt(v === true)}
                    data-testid="electrical-props-disconnect-exempt"
                  />
                  Disconnect not required (integral / lockable breaker)
                </Label>
              )}
            </div>
          )}
          <ConnectionTypePicker model={model} ids={[id]} submit={submit} editBlocked={editBlocked} onManage={onManageTypes} />
          <div className="flex flex-wrap gap-2">
            <Button variant={circuit ? 'outline' : 'default'} size="sm" onClick={onAdd} disabled={addBlocked !== null} title={addBlocked ?? undefined} data-testid="electrical-props-add">
              <Cable data-icon="inline-start" />
              {circuit ? 'Change circuit' : 'Add to circuit'}
            </Button>
            {circuit && (
              <>
                <Button variant="outline" size="sm" onClick={() => onEdit(circuit.linkId)}>
                  <Waypoints data-icon="inline-start" />
                  Edit circuit
                </Button>
                <Button variant="ghost" size="sm" onClick={() => onPanelView(circuit.sourceId)}>
                  <CircleDot data-icon="inline-start" />
                  {circuit.sourceName}
                </Button>
              </>
            )}
            {onEditControls && (
              <Button variant="outline" size="sm" onClick={onEditControls} disabled={editBlocked !== null} title={editBlocked ?? undefined} data-testid="electrical-props-edit-controls">
                <ToggleLeft data-icon="inline-start" />
                Edit controls
              </Button>
            )}
          </div>
          {addBlocked && <p className="text-xs text-muted-foreground">{addBlocked}</p>}
        </>
      )
    }
    if (target.loads.length === 0) return null
    const circuited = target.loads.filter((id) => electricalConnections(els, id).some((c) => c.circuit)).length
    return (
      <>
        <p className="text-xs" data-testid="electrical-props-group">
          {target.loads.length} device{target.loads.length === 1 ? '' : 's'} that take power: {circuited === 0 ? 'none on a circuit yet' : `${circuited} on a circuit`}.{target.panels.length > 0 ? ` ${target.panels.length} panel${target.panels.length === 1 ? '' : 's'} in the selection stay as they are.` : ''}
        </p>
        <ConnectionTypePicker model={model} ids={target.loads} submit={submit} editBlocked={editBlocked} onManage={onManageTypes} />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={onAdd} disabled={addBlocked !== null} title={addBlocked ?? undefined} data-testid="electrical-props-add">
            <Cable data-icon="inline-start" />
            {circuited === target.loads.length ? 'Change circuit' : 'Add to circuit'}
          </Button>
          {onEditControls && (
            <Button variant="outline" size="sm" onClick={onEditControls} disabled={editBlocked !== null} title={editBlocked ?? undefined} data-testid="electrical-props-edit-controls">
              <ToggleLeft data-icon="inline-start" />
              Edit controls
            </Button>
          )}
        </div>
        {addBlocked && <p className="text-xs text-muted-foreground">{addBlocked}</p>}
      </>
    )
  })()
  if (!body) return null
  return (
    <section className="flex flex-col gap-2" aria-label="Electrical" data-testid="electrical-properties">
      <Separator />
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Electrical</span>
      {body}
    </section>
  )
}
