import { createLocalDataHost, jsonAnswer } from '../src/host/local-data'
import { EditorServiceUnavailableError, isEditorServiceUnavailable, unavailableWords } from '../src/host/unavailable'

describe("the standalone app's data host", () => {
  it('serves only what one computer can: the built-in library, title blocks and preferences kept for this visit', () => {
    const host = createLocalDataHost()
    expect(Object.keys(host).sort()).toEqual(['firmLibrary', 'layoutPrefs', 'routeDefaults', 'schedulePrefs', 'titleBlocks', 'viewPrefs'])
    for (const absent of ['linkedModels', 'codeStudy', 'drawingSets', 'sheetImages', 'coordination', 'costSource', 'ifcExport'] as const) expect(host[absent]).toBeUndefined()
  })

  it('answers like a server: ok, status and the same body as JSON or text', async () => {
    const answer = jsonAnswer({ a: 1 }, 201)
    expect(answer.ok).toBe(true)
    expect(answer.status).toBe(201)
    await expect(answer.json()).resolves.toEqual({ a: 1 })
    await expect(answer.text()).resolves.toBe('{"a":1}')
    expect(jsonAnswer({}, 403).ok).toBe(false)
  })

  it('lists no firm title blocks and refuses to make one the default, in words', async () => {
    const { titleBlocks } = createLocalDataHost()
    await expect((await titleBlocks?.list())?.json()).resolves.toEqual({ choices: [], defaultId: null, canWrite: false })
    const refused = await titleBlocks?.makeDefault({ id: 'x' })
    expect(refused?.status).toBe(403)
    await expect(refused?.json()).resolves.toMatchObject({ error: expect.stringContaining('no firm library') })
  })

  it('has an empty firm scope, the built-in catalog to browse, and says why nothing can be published', async () => {
    const { firmLibrary } = createLocalDataHost()
    await expect((await firmLibrary?.listOfType({ scope: 'firm', type: 'class' }))?.json()).resolves.toEqual({ items: [] })
    const scopes = (await (await firmLibrary?.scopes())?.json()) as { scopes: { id: string }[]; capabilities: { scope: string; publish: boolean; reason: string }[] }
    expect(scopes.scopes.map((s) => s.id)).toEqual(['builtin'])
    expect(scopes.capabilities[0]).toMatchObject({ scope: 'builtin', read: true, publish: false, reason: expect.stringContaining('no firm library') })
    const builtin = (await (await firmLibrary?.search({ scope: 'builtin', type: 'class' }))?.json()) as { items: { key: string }[] }
    expect(builtin.items.map((i) => i.key)).toContain('mep.water_heater')
    const publish = await firmLibrary?.publish({ scope: 'firm', item: {}, baseRevision: 0 })
    expect(publish?.status).toBe(403)
    await expect(publish?.json()).resolves.toMatchObject({ ok: false, code: 'read_only' })
    await expect((await firmLibrary?.scheduleTemplates())?.json()).resolves.toEqual({ canWrite: false, firm: [] })
  })

  it('keeps layout, schedule widths and Route defaults for this visit', async () => {
    const { layoutPrefs, schedulePrefs, routeDefaults } = createLocalDataHost()
    await layoutPrefs?.save({ surface: 'rail', collapsed: { levels: true }, widthPx: 300 }, { keepalive: false })
    await expect((await layoutPrefs?.read({}))?.json()).resolves.toEqual({ surfaces: [{ surface: 'rail', collapsed: { levels: true }, widthPx: 300 }] })

    await schedulePrefs?.opened({ projectId: 'demo', viewId: 'v1' }, {})
    await schedulePrefs?.saveColumnWidths({ projectId: 'demo', viewId: 'v1', columnWidths: { mark: 80 } })
    await expect((await schedulePrefs?.read({ projectId: 'demo', viewId: 'v1' }, {}))?.json()).resolves.toEqual({ viewId: 'v1', columnWidths: { mark: 80 }, frozenColumns: null, expandedRows: [], lastOpenedViewId: 'v1' })

    await routeDefaults?.save({ projectId: 'demo', domain: 'duct', scope: 'all', settings: { shape: 'round' } })
    const saved = (await (await routeDefaults?.save({ projectId: 'demo', domain: 'duct', scope: 'project', settings: { size: 12 } }))?.json()) as { defaults: { domain: string; effective: unknown }[] }
    expect(saved.defaults.find((d) => d.domain === 'duct')?.effective).toEqual({ shape: 'round', size: 12 })
    await routeDefaults?.save({ projectId: 'demo', domain: 'duct', scope: 'project', settings: null })
    const read = (await (await routeDefaults?.read({ projectId: 'demo' }))?.json()) as { defaults: { domain: string; thisProject: unknown }[] }
    expect(read.defaults.find((d) => d.domain === 'duct')?.thisProject).toBeNull()
  })
})

describe('"not available here"', () => {
  it('says what is missing, where, and what to do', () => {
    expect(unavailableWords('Linked models', { hostName: 'this computer', connectHint: null })).toBe("Linked models: not available here, because this computer doesn't provide it. Open this model in an app that has it set up.")
    expect(unavailableWords('Linked models', { hostName: 'Acme', connectHint: 'Settings › Integrations' })).toContain('Connect it in Settings › Integrations')
    const err = new EditorServiceUnavailableError('The code study')
    expect(isEditorServiceUnavailable(err)).toBe(true)
    expect(err.message).toBe("The code study: not available here, because this app doesn't provide it. Open this model in an app that has it set up.")
  })
})
