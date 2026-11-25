import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import * as kernel from '@permitzip/bim-kernel'
import { asRevision, DEFAULT_SETTINGS, exampleRooftopUnit, executeCommand, type Command, type ModelState, type PartTypeDefinition } from '@permitzip/bim-kernel'
import type { EditorDataAnswer, EditorPartPublishRequest } from '@permitzip/bim-editor-host'
import { drawnPartItemId, newerLibraryVersions, partItemSizes, partUpdateCommand, partUpdateDiff, projectFamilyTable, projectPartTypesToSave, sizeHashes, type LibraryPartTypeEntry } from '../src/contracts/bim/firm-part-versions'
import { EditorHostProvider } from '../src/host'
import { createLocalEditorHost, jsonAnswer } from '../src/host/local'
import { PublishPartDialog } from '../src/editor/part-editor/PublishPartDialog'
import PartEditorWindow from '../src/editor/part-editor/PartEditorWindow'
import { blankDraft, draftDefinition, draftFromDefinition, setTypeValue } from '../src/editor/part-editor/draft'
import { ModelSession } from '../src/editor/model-session'
import { PartUpdateReview, type PartUpdateCommand } from '../src/editor/part-editor/PartUpdateReview'
import { publishPartTypeFrom } from '../src/editor/part-editor/part-type-library'
import { useFirmPartLibraryFrom } from '../src/editor/part-editor/use-firm-part-library'
import { TooltipProvider } from '../src/ui/tooltip'

// Editing and publishing work while the optional 3D engine is still loading.
jest.mock('../src/contracts/bim/part-geometry', () => ({ initPartGeometry: () => new Promise(() => {}) }))

const original = exampleRooftopUnit()
const revised = { ...original, description: 'Updated rooftop unit' }
const authorityUrl = 'ws://localhost/sync'

function entry(definition: PartTypeDefinition, revision: number): LibraryPartTypeEntry {
  const key = original.model!.id
  const first = { revision: 1, sizes: sizeHashes({ key, definition: original }) }
  return {
    key, id: drawnPartItemId(key), name: definition.familyName, definition, revision, scope: 'firm', provenance: null,
    revisions: revision === 1 ? [first] : [{ revision, sizes: sizeHashes({ key, definition }) }, first],
  }
}

function reviseRtu10(values: Record<string, number>): PartTypeDefinition {
  const model = original.model!
  const types = model.types.map(row => row.name === 'RTU-10' ? { ...row, values: { ...row.values, ...values } } : row)
  return { ...original, model: { ...model, types } }
}

function acknowledged(input: EditorPartPublishRequest, unchanged = false): EditorDataAnswer {
  const revision = input.baseRevision + (unchanged ? 0 : 1)
  const receipt = { requestId: input.requestId, baseRevision: input.baseRevision, familyId: drawnPartItemId(original.model!.id), revision }
  return jsonAnswer(unchanged ? { status: 'up_to_date', revision, receipt } : { status: 'saved', summary: { revision }, receipt })
}

function parts(entries: LibraryPartTypeEntry[] = []) {
  return {
    partTypes: jest.fn(async (): Promise<EditorDataAnswer> => jsonAnswer({ canPublish: true, partTypes: entries })),
    publishPartTypeAtRevision: jest.fn(async (input: EditorPartPublishRequest) => acknowledged(input)),
  }
}

function openPublish(firmParts: ReturnType<typeof parts>, onCatalogUpdate: (definition: PartTypeDefinition) => Promise<string | null> = async () => null, definition = revised) {
  const host = createLocalEditorHost({ authorityUrl, firmParts })
  const done = jest.fn()
  const view = render(
    <EditorHostProvider host={host}>
      <PublishPartDialog open definition={definition} partName="Rooftop unit" sizesText="3 sizes"
        onOpenChange={jest.fn()} onDone={done} alsoSaveForPlacePart={onCatalogUpdate} />
    </EditorHostProvider>,
  )
  return { done, view }
}

it('publishes a new part from revision zero and refreshes Place part from the same catalog', async () => {
  const firmParts = parts()
  const host = createLocalEditorHost({ authorityUrl, firmParts })
  const port = host.data.firmLibrary!
  const legacyWrite = jest.spyOn(port, 'importPartType')
  const catalog = renderHook(() => useFirmPartLibraryFrom(port, true))
  await waitFor(() => expect(catalog.result.current.status.state).toBe('ready'))
  expect(catalog.result.current.entries).toHaveLength(0)
  firmParts.publishPartTypeAtRevision.mockImplementationOnce(async (input) => {
    firmParts.partTypes.mockResolvedValue(jsonAnswer({ canPublish: true, partTypes: [entry(revised, 1)] }))
    return acknowledged(input)
  })
  const afterPublish = (definition: PartTypeDefinition) => catalog.result.current.afterPublish(definition)
  const { done } = openPublish(firmParts, afterPublish)
  fireEvent.click(await screen.findByRole('button', { name: 'Publish revision 1' }))
  await waitFor(() => expect(done).toHaveBeenCalledWith({ ok: true, revision: 1, text: expect.stringContaining('revision 1') }))
  expect(firmParts.publishPartTypeAtRevision).toHaveBeenCalledWith({ definition: revised, baseRevision: 0, requestId: expect.any(String) })
  expect(legacyWrite).not.toHaveBeenCalled()
  expect(catalog.result.current.entries.map(e => e.definition.typeName)).toEqual(['RTU-5', 'RTU-10', 'RTU-15'])
})

it('submits the revision shown and keeps a conflicting edit out of the catalog', async () => {
  const firmParts = parts([entry(original, 2)])
  const refresh = jest.fn(async () => null)
  const { done } = openPublish(firmParts, refresh)
  const publish = await screen.findByRole('button', { name: 'Publish revision 3' })
  const otherEdit = { ...original, description: 'Changed in the second window' }
  const other = openPublish(firmParts, undefined, otherEdit)
  const otherPublish = await screen.findByRole('button', { name: 'Publish revision 3' })
  firmParts.publishPartTypeAtRevision.mockImplementationOnce(async (input) => {
    firmParts.partTypes.mockResolvedValue(jsonAnswer({ canPublish: true, partTypes: [entry(otherEdit, 3)] }))
    return acknowledged(input)
  })
  fireEvent.click(otherPublish)
  await waitFor(() => expect(other.done).toHaveBeenCalledWith({ ok: true, revision: 3, text: expect.stringContaining('revision 3') }))
  other.view.unmount()
  firmParts.publishPartTypeAtRevision.mockResolvedValue(jsonAnswer({ currentRevision: 3 }, 409))
  fireEvent.click(publish)
  await screen.findByText(/now at revision 3/i)
  expect(firmParts.publishPartTypeAtRevision.mock.calls).toEqual([
    [{ definition: otherEdit, baseRevision: 2, requestId: expect.any(String) }],
    [{ definition: revised, baseRevision: 2, requestId: expect.any(String) }],
  ])
  expect(firmParts.publishPartTypeAtRevision.mock.calls[0]![0].requestId).not.toBe(firmParts.publishPartTypeAtRevision.mock.calls[1]![0].requestId)
  expect(screen.getByTestId('pe-publish-confirm')).toBeDisabled()
  expect(refresh).not.toHaveBeenCalled()
  expect(done).not.toHaveBeenCalled()
  const reopened = createLocalEditorHost({ authorityUrl, firmParts })
  const catalog = renderHook(() => useFirmPartLibraryFrom(reopened.data.firmLibrary, true))
  await waitFor(() => expect(catalog.result.current.status.state).toBe('ready'))
  expect(catalog.result.current.entries.map(e => e.definition.description)).toEqual(Array(3).fill(otherEdit.description))
})

it.each([
  ['a read-only catalog', jsonAnswer({ canPublish: false, partTypes: [] })],
  ['a failed revision lookup', jsonAnswer({ error: 'Library unavailable' }, 503)],
] as const)('keeps Publish disabled for %s', async (_name, response) => {
  const firmParts = parts()
  firmParts.partTypes.mockResolvedValue(response)
  openPublish(firmParts)
  await screen.findByRole('alert')
  expect(screen.getByTestId('pe-publish-confirm')).toBeDisabled()
  expect(firmParts.publishPartTypeAtRevision).not.toHaveBeenCalled()
})

it('pins the revision when editing starts, even if the catalog refreshes before Publish opens', async () => {
  const firmParts = parts([entry(original, 3)])
  const host = createLocalEditorHost({ authorityUrl, firmParts })
  const editor = (revision?: number) => (
    <EditorHostProvider host={host}><TooltipProvider>
      <PartEditorWindow initial={original} canEdit onClose={jest.fn()} onSave={() => null}
        firmLibrary={revision === undefined ? undefined : { canWrite: true, itemsById: new Map([[drawnPartItemId(original.model!.id), entry(original, revision)]]), save: async () => null }} />
    </TooltipProvider></EditorHostProvider>
  )
  const view = render(editor())
  view.rerender(editor(2))
  fireEvent.change(screen.getByLabelText('Part name'), { target: { value: 'My rooftop edit' } })
  view.rerender(editor(3))
  fireEvent.click(screen.getByTestId('pe-save-firm'))
  await screen.findByText(/opened this part at revision 2.*library is now at revision 3/i)
  expect(screen.getByTestId('pe-publish-confirm')).toBeDisabled()
  expect(firmParts.publishPartTypeAtRevision).not.toHaveBeenCalled()
  fireEvent.click(within(screen.getByTestId('pe-publish-dialog')).getByRole('button', { name: 'Cancel' }))
  expect(screen.getByLabelText('Part name')).toHaveValue('My rooftop edit')
})

it('keeps an older project copy from publishing over a revision saved before its editor opened', async () => {
  const old = entry(original, 1)
  const placed = partItemSizes(old).find(size => size.definition.typeName === 'RTU-10')!
  const firmParts = parts([entry(revised, 2)])
  const host = createLocalEditorHost({ authorityUrl, firmParts })
  const catalog = renderHook(() => useFirmPartLibraryFrom(host.data.firmLibrary, true))
  await waitFor(() => expect(catalog.result.current.status.state).toBe('ready'))
  render(<EditorHostProvider host={host}><TooltipProvider>
    <PartEditorWindow initial={placed.definition} canEdit onClose={jest.fn()} onSave={() => null}
      firmLibrary={{ ...catalog.result.current, save: catalog.result.current.afterPublish }} />
  </TooltipProvider></EditorHostProvider>)
  fireEvent.click(screen.getByTestId('pe-save-firm'))
  await waitFor(() => expect(screen.getByTestId('pe-publish-dialog')).not.toHaveTextContent('Checking the firm library'))
  expect(screen.getByTestId('pe-publish-confirm')).toBeDisabled()
  expect(screen.getByTestId('pe-publish-dialog')).toHaveTextContent(/opened this part at revision 1.*library is now at revision 2/i)
  expect(firmParts.publishPartTypeAtRevision).not.toHaveBeenCalled()
})

it('gives two newly drawn families separate identities and keeps an existing family’s ID on rename', () => {
  const first = blankDraft()
  const second = blankDraft()
  expect(first.definition.model!.id).not.toEqual(second.definition.model!.id)
  const reopened = draftFromDefinition(original)
  expect(draftDefinition({ ...reopened, groupName: 'New display name' }).model!.id).toBe(original.model!.id)
})

it('retries the original edit and ID after a lost reply, even when a newer revision exists', async () => {
  const firmParts = parts()
  firmParts.publishPartTypeAtRevision.mockRejectedValueOnce(new Error('Connection closed'))
  const refresh = jest.fn(async () => null)
  const { done } = openPublish(firmParts, refresh)
  fireEvent.click(await screen.findByRole('button', { name: 'Publish revision 1' }))
  await screen.findByText(/did not confirm the save/i)
  expect(firmParts.publishPartTypeAtRevision).toHaveBeenCalledTimes(1)
  expect(refresh).not.toHaveBeenCalled()
  expect(done).not.toHaveBeenCalled()
  firmParts.partTypes.mockResolvedValue(jsonAnswer({ canPublish: true, partTypes: [entry(original, 2)] }))
  fireEvent.click(screen.getByRole('button', { name: 'Retry publish' }))
  await waitFor(() => expect(done).toHaveBeenCalledWith({ ok: true, revision: 1, text: expect.stringContaining('revision 1') }))
  const calls = firmParts.publishPartTypeAtRevision.mock.calls
  expect(calls).toHaveLength(2)
  expect(calls[1]).toEqual(calls[0])
  expect(firmParts.partTypes).toHaveBeenCalledTimes(1)
})

it('reports an acknowledged revision even when refreshing Place part fails', async () => {
  const firmParts = parts([entry(original, 2)])
  firmParts.publishPartTypeAtRevision.mockImplementationOnce(async (input) => acknowledged(input, true))
  const { done } = openPublish(firmParts, async () => 'Library unavailable')
  fireEvent.click(await screen.findByRole('button', { name: 'Publish revision 3' }))
  await waitFor(() => expect(done).toHaveBeenCalledWith({ ok: false, revision: 2, text: expect.stringMatching(/already revision 2.*could not refresh/i) }))
})

it('keeps the refreshed Place part catalog when an earlier read finishes late', async () => {
  const firmParts = parts([entry(revised, 2)])
  let finishEarlier!: (response: EditorDataAnswer) => void
  firmParts.partTypes.mockImplementationOnce(() => new Promise(resolve => { finishEarlier = resolve }))
  const port = createLocalEditorHost({ authorityUrl, firmParts }).data.firmLibrary
  const catalog = renderHook(() => useFirmPartLibraryFrom(port, true))
  await act(async () => { await catalog.result.current.afterPublish(revised) })
  await act(async () => { finishEarlier(jsonAnswer({ canPublish: true, partTypes: [] })) })
  expect(catalog.result.current.entries).toHaveLength(3)
})

it('preserves the separate publish and Place part writes of a legacy host', async () => {
  const port = createLocalEditorHost({ authorityUrl }).data.firmLibrary!
  const publish = jest.spyOn(port, 'publishPartType').mockResolvedValue(jsonAnswer({ status: 'saved', summary: { revision: 2 } }))
  const mirror = jest.spyOn(port, 'importPartType').mockResolvedValue(jsonAnswer({}))
  jest.spyOn(port, 'firmParts').mockResolvedValue(jsonAnswer({ canWrite: true, parts: [{ definition: revised }] }))
  const catalog = renderHook(() => useFirmPartLibraryFrom(port, true))
  await waitFor(() => expect(catalog.result.current.canWrite).toBe(true))
  await expect(publishPartTypeFrom(port, revised, 1)).resolves.toEqual({ ok: true, revision: 2, upToDate: false })
  await act(async () => { expect(await catalog.result.current.afterPublish(revised)).toBeNull() })
  expect(publish).toHaveBeenCalledWith({ definition: revised })
  expect(mirror).toHaveBeenCalledWith({ definition: revised })
  expect(catalog.result.current.entries).toHaveLength(3)
})

function run(model: ModelState, command: Command): ModelState {
  const answer = executeCommand(model, command)
  if (!answer.ok) throw new Error(answer.error.message)
  return answer.model
}

it('offers only RTU-10 for an airflow edit and applies the full family definition for that size', async () => {
  const placed = partItemSizes(entry(original, 1))
  const latest = entry(reviseRtu10({ airflow: 4500 }), 2)
  const onApply = jest.fn(async (_command: PartUpdateCommand) => null)
  const host = createLocalEditorHost({ authorityUrl })
  render(<EditorHostProvider host={host}><PartUpdateReview library={[latest]} modelTypes={placed} canEdit
    placedCopies={Object.fromEntries(placed.map(p => [p.typeId, 1]))} onApply={onApply} /></EditorHostProvider>)

  fireEvent.click(screen.getByRole('button', { name: 'Review update' }))
  const dialog = screen.getByTestId('part-update-dialog')
  const review = within(dialog)
  expect(review.getByText(/Airflow: 4000 → 4500/)).toBeInTheDocument()
  expect(dialog).not.toHaveTextContent(/Shape changed|RTU-5|RTU-15/)
  await act(async () => { fireEvent.click(review.getByRole('button', { name: 'Update 1 placed copy' })) })
  expect(onApply).toHaveBeenCalledTimes(1)
  expect(onApply.mock.calls[0]?.[0].types).toEqual([{
    typeId: 'rtu.rtu-10',
    definition: expect.objectContaining({ typeName: 'RTU-10', typeValues: expect.objectContaining({ airflow: 4500 }), model: latest.definition.model }),
  }])
})

it('preserves the accepted RTU-10 airflow when a designer saves an RTU-5 edit from an older family table', () => {
  const sizes = partItemSizes(entry(original, 1))
  const latest = entry(reviseRtu10({ airflow: 4500 }), 2)
  const empty: ModelState = { modelId: 'project-b', revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS }
  let project = run(empty, { type: 'create_level', levelId: 'roof', name: 'Roof', elevationMm: 0 })
  for (const size of sizes.slice(0, 2)) {
    project = run(project, { type: 'place_part', partId: `placed-${size.name}`, typeId: size.typeId, partType: size.definition, levelId: 'roof', position: { x: 0, y: 0 } })
  }
  const projectType = (id: string) => {
    const el = project.elements[id]
    if (el?.kind !== 'part_type') throw new Error(`Missing project type ${id}`)
    return el.definition
  }
  const before = projectType('rtu.rtu-5')
  const updates = newerLibraryVersions([sizes[1]!], [latest])
  project = run(project, partUpdateCommand(updates, 1))
  const accepted = projectType('rtu.rtu-10')
  expect(accepted.typeValues.airflow).toBe(4500)
  const session: ModelSession = Object.assign(Object.create(ModelSession.prototype), {
    kernel, view: project, submitCommand(command: Command) { project = run(project, command); return null },
  })
  expect(session.partFamilyForEditing(before).model!.types.find(row => row.name === 'RTU-10')?.values.airflow).toBe(4500)
  const edited = draftDefinition(setTypeValue(draftFromDefinition(before), 'RTU-5', 'airflow', 2200))
  expect(session.savePartDefinition(edited, before)).toBeNull()
  expect(projectType('rtu.rtu-5').typeValues.airflow).toBe(2200)
  expect(projectType('rtu.rtu-10')).toEqual(accepted)
  expect(projectType('rtu.rtu-5').model!.types.find(row => row.name === 'RTU-10')?.values.airflow).toBe(4500)
  expect(project.elements['placed-RTU-10']).toMatchObject({ typeId: 'rtu.rtu-10' })
})

it('opens a partially accepted family with the kept project value and detects competing edits to the same size', () => {
  const oldSizes = partItemSizes(entry(original, 1))
  const changeBoth = setTypeValue(draftFromDefinition(reviseRtu10({ airflow: 4500 })), 'RTU-5', 'airflow', 2500)
  const latest = entry(draftDefinition(changeBoth), 2)
  const empty: ModelState = { modelId: 'project-b', revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS }
  const placed = run(empty, { type: 'save_part_types', label: 'Save rooftop units', types: oldSizes })
  const selected = newerLibraryVersions([oldSizes[1]!], [latest])
  const project = run(placed, partUpdateCommand(selected, 1))
  const accepted = selected[0]!.after
  const initial = projectFamilyTable(accepted, project.elements)
  expect(initial.model!.types[0]?.values.airflow).toBe(2000)
  const edit = (base: PartTypeDefinition, name: string, airflow: number) =>
    draftDefinition(setTypeValue(draftFromDefinition(base), name, 'airflow', airflow))
  const pending = projectPartTypesToSave(edit(initial, 'RTU-5', 2200), initial, project.elements)
  expect(pending.map(size => size.typeId)).toEqual(['rtu.rtu-5'])
  expect(() => projectPartTypesToSave(edit(original, 'RTU-10', 4800), original, project.elements)).toThrow(/RTU-10 changed in the project/)
})

it('reports a change to the RTU-10 cabinet length as a shape change for that size', () => {
  const placed = partItemSizes(entry(original, 1))
  const latest = entry(reviseRtu10({ length: 2540 }), 2)
  const updates = newerLibraryVersions(placed, [latest])
  expect(updates.map(u => u.typeId)).toEqual(['rtu.rtu-10'])
  const { before, after } = updates[0]!
  expect(partUpdateDiff(before, after)).toMatchObject({ parameters: ['Length: 2286 → 2540'], other: ['Shape changed'] })
})

it('offers a shared family edit to every matching size and preserves a locally edited family table', () => {
  const placed = partItemSizes(entry(original, 1))
  const latest = entry(revised, 2)
  expect(newerLibraryVersions(placed, [latest]).map(u => u.typeId)).toEqual(placed.map(p => p.typeId))
  const locallyEdited = partItemSizes(entry(reviseRtu10({ airflow: 4200 }), 1))
  expect(newerLibraryVersions(locallyEdited, [latest])).toEqual([])
})

it('reviews a scripted family as the single library item its script published', () => {
  const source = { kind: 'script' } as const
  const first = { ...entry(original, 1), key: 'script-rtu', definition: { ...original, source } }
  const latest = { ...first, definition: { ...reviseRtu10({ airflow: 4500 }), source }, revision: 2 }
  const revisions = [latest, first].map(item => ({ revision: item.revision, sizes: sizeHashes(item) }))
  const updates = newerLibraryVersions(partItemSizes(first), [{ ...latest, revisions }])
  expect(updates.map(u => u.typeId)).toEqual(['script-rtu'])
})

it('places RTU-10 in another project and changes its copy only after Update is applied', async () => {
  const firmParts = parts([entry(original, 1)])
  const placingHost = createLocalEditorHost({ authorityUrl, firmParts })
  const catalog = renderHook(() => useFirmPartLibraryFrom(placingHost.data.firmLibrary, true))
  await waitFor(() => expect(catalog.result.current.status.state).toBe('ready'))
  const size = catalog.result.current.entries.find(e => e.definition.typeName === 'RTU-10')!
  const empty: ModelState = { modelId: 'project-b', revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS }
  const level = run(empty, { type: 'create_level', levelId: 'roof', name: 'Roof', elevationMm: 0 })
  let project = run(level, { type: 'place_part', partId: 'ahu-1', typeId: size.typeId, partType: size.definition, levelId: 'roof', position: { x: 0, y: 0 } })
  const placed = project.elements[size.typeId]
  if (placed?.kind !== 'part_type') throw new Error('Expected the placed part type')
  expect(project.elements['ahu-1']).toMatchObject({ typeId: size.typeId })
  catalog.unmount()

  const latest = entry(revised, 3)
  // Revision 2 had the same definition for this size as revision 1.
  const history = [{ revision: 3, sizes: sizeHashes(latest) }, ...entry(original, 2).revisions]
  firmParts.partTypes.mockResolvedValue(jsonAnswer({ canPublish: true, partTypes: [{ ...latest, revisions: history }] }))
  const reopened = createLocalEditorHost({ authorityUrl, firmParts })
  const onApply = jest.fn(async (command: PartUpdateCommand) => {
    project = run(project, command)
    return null
  })
  render(<EditorHostProvider host={reopened}><PartUpdateReview modelTypes={[{ typeId: size.typeId, definition: placed.definition }]}
    canEdit placedCopies={{ [size.typeId]: 1 }} onApply={onApply} /></EditorHostProvider>)
  await screen.findByText(/matches revision 2.*library has revision 3/i)
  fireEvent.click(screen.getByRole('button', { name: 'Review update' }))
  expect(screen.getByText(/description changed to.*Updated rooftop unit/i)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('radio', { name: 'Keep' }))
  expect(screen.getByTestId('part-update-apply')).toBeDisabled()
  expect(onApply).not.toHaveBeenCalled()
  expect(project.elements[size.typeId]).toBe(placed)
  fireEvent.click(screen.getByRole('radio', { name: 'Update' }))
  await act(async () => { fireEvent.click(screen.getByTestId('part-update-apply')) })
  expect(onApply).toHaveBeenCalledTimes(1)
  expect(project.elements[size.typeId]).toMatchObject({ definition: { typeName: 'RTU-10', description: revised.description } })
})
