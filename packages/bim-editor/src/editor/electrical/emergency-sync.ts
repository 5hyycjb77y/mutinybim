import type { ParamValue, PartInstance, PartTypeDefinition } from '@permitzip/bim-kernel'

const EM_POWER_KEY = 'electrical.emergency_mode'
const EGRESS_FIXTURE_KEY = 'electrical.egress_fixture'

function declaredInstanceNames(type: PartTypeDefinition | null): ReadonlySet<string> {
  if (!type) return new Set()
  return new Set(type.instanceParams.map((p) => p.name))
}

function existingPackPower(part: PartInstance, type: PartTypeDefinition | null): string | undefined {
  const v = part.values[EM_POWER_KEY] ?? type?.typeValues[EM_POWER_KEY]
  return typeof v === 'string' ? v : undefined
}

function existingCtrlMode(part: PartInstance, type: PartTypeDefinition | null): string | undefined {
  const v = part.values.emergency_mode ?? type?.typeValues.emergency_mode
  return typeof v === 'string' ? v : undefined
}

/**
 * Keep luminaire control-wiring emergency params (`emergency`, `emergency_mode`)
 * and photometric pack params (`electrical.emergency_mode`, `electrical.egress_fixture`)
 * bidirectionally synchronized on any Inspector save so toggling any emergency
 * control immediately updates 3D blackout lighting, egress heatmaps, plan half-fill
 * graphics, and NFPA 101 / IBC compliance schedules.
 */
export function syncLuminaireEmergencyEdits(
  part: PartInstance,
  type: PartTypeDefinition | null,
  partValues: Readonly<Record<string, ParamValue | null>>,
  packValues: Readonly<Record<string, ParamValue | null>>,
): {
  readonly partValues: Record<string, ParamValue | null>
  readonly packValues: Record<string, ParamValue | null>
} {
  const nextPart: Record<string, ParamValue | null> = { ...partValues }
  const nextPack: Record<string, ParamValue | null> = { ...packValues }
  const declared = declaredInstanceNames(type)

  const touchedPartFlag = Object.prototype.hasOwnProperty.call(partValues, 'emergency')
  const touchedPartMode = Object.prototype.hasOwnProperty.call(partValues, 'emergency_mode')
  const touchedPackPower = Object.prototype.hasOwnProperty.call(packValues, EM_POWER_KEY)
  const touchedPackEgress = Object.prototype.hasOwnProperty.call(packValues, EGRESS_FIXTURE_KEY)

  if (!touchedPartFlag && !touchedPartMode && !touchedPackPower && !touchedPackEgress) {
    return { partValues: nextPart, packValues: nextPack }
  }

  // Determine the user's intended emergency state (ON vs OFF) from whichever control(s) they edited.
  let intendedOn: boolean | null = null
  if (touchedPackPower) {
    const p = packValues[EM_POWER_KEY]
    intendedOn = p === 'battery_pack' || p === 'generator_circuit' || p === 'inverter'
  } else if (touchedPartMode) {
    const m = partValues.emergency_mode
    intendedOn = m === 'unswitched' || m === 'switched'
  } else if (touchedPartFlag) {
    intendedOn = partValues.emergency === true
  } else if (touchedPackEgress) {
    intendedOn = packValues[EGRESS_FIXTURE_KEY] === true
  }

  if (intendedOn === null) return { partValues: nextPart, packValues: nextPack }

  if (intendedOn) {
    // Sync control-wiring params when declared on this part type
    if (declared.has('emergency') && !touchedPartFlag) nextPart.emergency = true
    if (declared.has('emergency_mode') && !touchedPartMode) {
      const cur = existingCtrlMode(part, type)
      nextPart.emergency_mode = cur === 'switched' ? 'switched' : 'unswitched'
    }
    // Sync photometric pack params (for lighting fixtures that accept electrical.* pack params)
    if (type?.category === 'lighting_fixture' || touchedPackPower || touchedPackEgress || Object.prototype.hasOwnProperty.call(part.values, EM_POWER_KEY)) {
      if (!touchedPackPower) {
        const cur = existingPackPower(part, type)
        nextPack[EM_POWER_KEY] = cur === 'generator_circuit' || cur === 'inverter' ? cur : 'battery_pack'
      }
      if (!touchedPackEgress) nextPack[EGRESS_FIXTURE_KEY] = true
    }
  } else {
    // Turning emergency OFF: clear both control-wiring and photometric emergency fields cleanly
    if (declared.has('emergency')) nextPart.emergency = false
    if (declared.has('emergency_mode')) nextPart.emergency_mode = 'none'
    if (type?.category === 'lighting_fixture' || touchedPackPower || touchedPackEgress || Object.prototype.hasOwnProperty.call(part.values, EM_POWER_KEY)) {
      nextPack[EM_POWER_KEY] = 'none'
      nextPack[EGRESS_FIXTURE_KEY] = false
    }
  }

  return { partValues: nextPart, packValues: nextPack }
}
