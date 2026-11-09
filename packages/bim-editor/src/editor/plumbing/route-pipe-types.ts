'use client'

import { useMemo } from 'react'
import { defaultPipeSpec, elementsOfKind, pipeFamilyOf, type BimElement, type ModelState, type PipeMaterial, type SystemKind } from '@permitzip/bim-kernel'
import type { PipeTypeEntry, PipeTypeRecord } from '@permitzip/bim-pack-plumbing'
import type * as PlumbingHost from '@permitzip/bim-pack-plumbing/host'
import { requireAddOns } from '../../contracts/building-model/add-ons'
import { MM_PER_IN } from '../placement'
import type { RouteChoices, RoutePipeTypes } from '../RoutePanel'

/**
 * The Route panel's pipe choices follow the system (round 16: the product owner picked
 * Sanitary and drew 1" copper with sweat elbows). Choosing a system loads the
 * pipe type this add-on picks for it: the project's saved type for that
 * system, else the firm's; an existing system keeps its pipe's material.
 * Which type, which start size and which fittings is the add-on's rule
 * (`system-pipe-type.ts` in the package); this writes it into the panel.
 */

/** The size the system's existing pipe is, when it has some (so a new run keeps its material). */
export interface SystemPipe {
  readonly material: PipeMaterial
  readonly nominalIn: number
}

type Host = Pick<typeof PlumbingHost, 'pipeTypeAllowsSize' | 'pipeTypeBendAngles' | 'pipeTypeForSystem' | 'pipeTypeRouteFittings' | 'pipeTypesForSystem' | 'startSizeFor'>

const inches = (v: number) => String(Math.round(v * 1000) / 1000)

function withPipeType(c: RouteChoices, type: PipeTypeEntry, nominalIn: number): RouteChoices {
  const spec = type.spec && type.spec !== defaultPipeSpec(type.material) ? type.spec : ''
  return { ...c, pipeType: type.name, material: type.material, pipeSpec: spec, nominalIn: inches(nominalIn) }
}

function chosenPipeType(c: RouteChoices, records: readonly PipeTypeRecord[]): PipeTypeEntry | null {
  if (c.kind !== 'pipe' || !c.pipeType) return null
  const name = c.pipeType.toUpperCase()
  return records.find((r) => r.entry.name.toUpperCase() === name)?.entry ?? null
}

/**
 * The Route panel's pipe types from `records` (the project's saved types, then
 * the firm's). `systemPipe`: an existing system's pipe, whose material a new
 * run on it keeps. `host`: this add-on's loaded entry.
 */
export function routePipeTypes(records: readonly PipeTypeRecord[], systemPipe: (systemId: string) => SystemPipe | null = () => null, host: Host = requireAddOns().plumbing): RoutePipeTypes {
  const sizeFor = (type: PipeTypeEntry, kind: SystemKind, nominalIn: number) => (Number.isFinite(nominalIn) && nominalIn > 0 && host.pipeTypeAllowsSize(type, nominalIn) ? nominalIn : host.startSizeFor(type, kind))
  return {
    home: 'Plumbing › Pipe types',
    // The size stays when the service didn't change and the type takes it; otherwise the add-on's start size.
    forSystem(next, prevKind, kind) {
      if (next.kind !== 'pipe' || !kind) return next
      const type = host.pipeTypeForSystem(records, kind, systemPipe(next.system) ?? undefined)
      if (!type) return { ...next, pipeType: '' }
      const sameService = prevKind !== null && pipeFamilyOf(prevKind) === pipeFamilyOf(kind)
      return withPipeType(next, type, sameService ? sizeFor(type, kind, Number(next.nominalIn)) : host.startSizeFor(type, kind))
    },
    typesFor: (kind) => host.pipeTypesForSystem(records, kind),
    chosen: (c) => chosenPipeType(c, records),
    withType(c, name, kind) {
      const type = host.pipeTypesForSystem(records, kind).find((t) => t.name === name)
      if (!type) return null
      const now = Number(c.nominalIn)
      return withPipeType(c, type, Number.isFinite(now) && host.pipeTypeAllowsSize(type, now) ? now : host.startSizeFor(type, kind))
    },
    bendAngles(c, kind) {
      const type = chosenPipeType(c, records)
      return type ? host.pipeTypeBendAngles(type, kind) : []
    },
    // Fittings the chosen type picks over its material's (the engineer's picks on Plumbing › Pipe types).
    fittings(c) {
      const type = chosenPipeType(c, records)
      return type ? host.pipeTypeRouteFittings(type) : {}
    },
  }
}

/** An existing system's pipe (its first straight piece), read when that system is picked. */
function systemPipeOf(model: ModelState | null, systemId: string): SystemPipe | null {
  if (!model) return null
  for (const el of elementsOfKind(model.elements, 'run_segment')) {
    if (el.systemId === systemId && el.size.shape === 'pipe') return { material: el.size.material, nominalIn: Math.round((el.size.nominalMm / MM_PER_IN) * 1000) / 1000 }
  }
  return null
}

/** The Route panel's pipe types while the Route tool is on, read from the catalog records alone (never a whole-model scan per edit). */
export function useRoutePipeTypes(active: boolean, catalog: readonly BimElement[], currentModel: () => ModelState | null): RoutePipeTypes | null {
  return useMemo(() => {
    if (!active) return null
    const host = requireAddOns().plumbing
    const records = host.projectPipeTypes({ elements: Object.fromEntries(catalog.map((el) => [el.id, el])) })
    return routePipeTypes(records, (systemId) => systemPipeOf(currentModel(), systemId), host)
  }, [active, catalog, currentModel])
}
