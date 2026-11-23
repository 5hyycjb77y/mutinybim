/**
 * @jest-environment node
 *
 * Verifies that PartInspector exposes pack parameter sets (`PARAMETER_SET_POINT`:
 * Photometrics & Emergency Egress) on lighting fixtures and keeps control-wiring
 * emergency fields (`emergency`, `emergency_mode`) and photometric pack fields
 * (`electrical.emergency_mode`, `electrical.egress_fixture`) bidirectionally synced
 * so clicking Save changes updates 3D blackout emitters and egress calcs immediately.
 */
import { installFirstPartyAddOns } from '@permitzip/bim-first-party'
import { createShowcaseDemoModel } from '@permitzip/bim-first-party/seed'
import { executeCommand, withUpgradePolicy, type Command, type ModelState, type PartInstance, type PartTypeElement } from '@permitzip/bim-kernel'
import { displayText, inspectorSections, planParameterEdit, storedValue } from '../src/editor/inspector/parameter-model'
import { syncLuminaireEmergencyEdits } from '../src/editor/electrical/emergency-sync'
import { buildSceneLightEmitters } from '../src/editor/electrical/photometrics-heatmap'

beforeAll(() => {
  installFirstPartyAddOns()
})

function run(model: ModelState, cmd: Command): ModelState {
  const res = withUpgradePolicy(
    () => true,
    () => executeCommand(model, cmd, { actor: { id: 'test', name: 'Test', kind: 'human' } }),
  )
  if (!res.ok) throw new Error(`${cmd.type} failed: ${res.error.message}`)
  return res.model
}

describe('PartInspector pack parameters & unified emergency fixture sync', () => {
  it('renders Photometrics and Emergency Egress pack parameters on F2-18 (lt-214) and syncs toggles immediately to 3D blackout emitters', () => {
    let model = createShowcaseDemoModel()
    const part = model.elements['lt-214'] as PartInstance
    const pt = model.elements[part.typeId] as PartTypeElement

    const sections = inspectorSections(pt.definition, [], { part, elements: model.elements })
    const allInst = sections.flatMap((s) => s.parameters.filter((p) => p.scope === 'instance'))
    const byName = new Map(allInst.map((p) => [p.name, p]))

    // Pack parameters are surfaced directly in the Inspector (excluding huge inline IES text blobs)
    expect(byName.get('electrical.photometric_profile')?.source).toBe('pack')
    expect(byName.get('electrical.emergency_mode')?.label).toBe('Emergency power source')
    expect(byName.get('electrical.emergency_lumens')?.source).toBe('pack')
    expect(byName.get('electrical.egress_fixture')?.source).toBe('pack')
    expect(byName.get('electrical.lld')?.source).toBe('pack')
    expect(byName.has('electrical.ies_file')).toBe(false)

    // Starts normal (non-emergency)
    expect(buildSceneLightEmitters(model).find((e) => e.id === 'lt-214')?.activeInBlackout).toBe(false)

    // 1. User checks Emergency battery + sets Emergency mode = switched in PartInspector
    const textsOn: Record<string, string> = {}
    for (const p of allInst) textsOn[p.name] = displayText(p, storedValue(pt.definition, part, p))
    textsOn.emergency = 'true'
    textsOn.emergency_mode = 'switched'

    const planOn = planParameterEdit(pt.definition, part, allInst, textsOn, 'instance')
    expect('problem' in planOn).toBe(false)
    if ('problem' in planOn) return
    const syncedOn = syncLuminaireEmergencyEdits(part, pt.definition, planOn.values, planOn.packValues)
    expect(syncedOn.partValues).toEqual({ emergency: true, emergency_mode: 'switched' })
    expect(syncedOn.packValues).toEqual({ 'electrical.emergency_mode': 'battery_pack', 'electrical.egress_fixture': true })

    model = run(model, { type: 'set_parameters', id: part.id, scope: 'instance', values: syncedOn.partValues })
    model = run(model, { type: 'set_element_values', elementIds: [part.id], values: syncedOn.packValues })

    const emitterOn = buildSceneLightEmitters(model).find((e) => e.id === 'lt-214')!
    expect(emitterOn.activeInBlackout).toBe(true)
    expect(emitterOn.blackoutScale).toBeGreaterThan(0)

    // 2. User switches Emergency power source to generator_circuit
    const pGen = model.elements['lt-214'] as PartInstance
    const textsGen: Record<string, string> = {}
    for (const p of allInst) textsGen[p.name] = displayText(p, storedValue(pt.definition, pGen, p))
    textsGen['electrical.emergency_mode'] = 'generator_circuit'

    const planGen = planParameterEdit(pt.definition, pGen, allInst, textsGen, 'instance')
    expect('problem' in planGen).toBe(false)
    if ('problem' in planGen) return
    const syncedGen = syncLuminaireEmergencyEdits(pGen, pt.definition, planGen.values, planGen.packValues)
    expect(syncedGen.packValues['electrical.emergency_mode']).toBe('generator_circuit')

    model = run(model, { type: 'set_element_values', elementIds: [part.id], values: syncedGen.packValues })
    const emitterGen = buildSceneLightEmitters(model).find((e) => e.id === 'lt-214')!
    expect(emitterGen.activeInBlackout).toBe(true)
    // Generator circuit runs at full maintained output (higher blackoutScale than battery pack)
    expect(emitterGen.blackoutScale ?? 0).toBeGreaterThan(emitterOn.blackoutScale ?? 0)

    // 3. User toggles OFF via Emergency power source = none -> clears both pack & control fields
    const pOff = model.elements['lt-214'] as PartInstance
    const textsOff: Record<string, string> = {}
    for (const p of allInst) textsOff[p.name] = displayText(p, storedValue(pt.definition, pOff, p))
    textsOff['electrical.emergency_mode'] = 'none'

    const planOff = planParameterEdit(pt.definition, pOff, allInst, textsOff, 'instance')
    expect('problem' in planOff).toBe(false)
    if ('problem' in planOff) return
    const syncedOff = syncLuminaireEmergencyEdits(pOff, pt.definition, planOff.values, planOff.packValues)
    expect(syncedOff.partValues).toEqual({ emergency: false, emergency_mode: 'none' })
    expect(syncedOff.packValues).toEqual({ 'electrical.emergency_mode': 'none', 'electrical.egress_fixture': false })

    model = run(model, { type: 'set_parameters', id: part.id, scope: 'instance', values: syncedOff.partValues })
    model = run(model, { type: 'set_element_values', elementIds: [part.id], values: syncedOff.packValues })
    expect(buildSceneLightEmitters(model).find((e) => e.id === 'lt-214')?.activeInBlackout).toBe(false)
  })
})
