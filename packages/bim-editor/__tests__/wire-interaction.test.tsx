import { fireEvent, render, screen } from '@testing-library/react'
import {
  buildViewScene,
  modelToPaperPoint,
  viewLevelElements,
  viewOnPaper,
  viewportOnPaper,
  type Command,
  type PartInstance,
  type ViewElement,
  type Viewport,
} from '@permitzip/bim-kernel'
import { installFirstPartyAddOns } from '@permitzip/bim-first-party'
import { circuitHomeRunsOnPaper, circuitJoinsOnPaper, type CircuitGraphicsProps } from '@permitzip/bim-pack-electrical'
import { InMemoryCommitStore, SERVER_FEATURES, Sequencer, SyncClient, SyncHub, type CommitOutcome } from '@permitzip/bim-sync'
import { createElectricalDemoModel } from '@permitzip/bim-devserver/src/electrical-demo'
import { ModelDrawingLayer } from '../src/editor/view-input/ModelDrawingLayer'
import { EditControlsDialog } from '../src/editor/electrical/EditControlsDialog'
import type { ModelEditBridge } from '../src/editor/view-input/bridge'

installFirstPartyAddOns()

// jsdom omits PointerEvent, causing fireEvent.pointer* to drop clientX/clientY/button.
if (typeof globalThis.PointerEvent === 'undefined') {
  ;(globalThis as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = MouseEvent
}

function setupDemoLayer(viewId: 'v-e101' | 'v-e102' | 'v-e103' = 'v-e102') {
  const model = createElectricalDemoModel()
  const viewEl = model.elements[viewId]
  if (viewEl?.kind !== 'view') throw new Error(`missing view ${viewId}`)
  const { frame } = buildViewScene(model, viewId)
  const vop = viewOnPaper(model, viewEl, frame, null)
  const shown = new Map<string, PartInstance>()
  for (const el of viewLevelElements(model, viewEl)) if (el.kind === 'part') shown.set(el.id, el)
  const toPaper = (q: { x: number; y: number }) => modelToPaperPoint(vop, { x: q.x, y: q.y, z: 0 })
  const joins = circuitJoinsOnPaper(model, viewEl, shown, vop.frame.scale, toPaper)
  const homeRuns = circuitHomeRunsOnPaper(model, viewEl, shown, vop.frame.scale, toPaper)

  const submitted: Array<{ readonly command: Command; readonly label: string }> = []
  const selected: string[] = []
  const hints: Array<string | null> = []

  const bridge: ModelEditBridge = {
    selectedIds: [],
    canEdit: true,
    blockedReason: '',
    tool: 'select',
    serverFeatures: SERVER_FEATURES,
    hover: () => null,
    highlighted: () => null,
    tab: () => null,
    select: (id) => {
      if (id) selected.push(id)
    },
    selectBox: () => '',
    moveBy: () => null,
    submit: (command, label) => {
      submitted.push({ command, label })
      return null
    },
    hint: (message) => {
      hints.push(message)
    },
    runDrag: {
      begin: () => null,
      preview: () => null,
      previewModel: () => null,
      toLength: () => null,
      end: () => null,
    },
    tools: {
      previewSplit: () => '',
      split: () => '',
      previewRoute: () => null,
      clickRoute: () => null,
      finishRoute: () => null,
      cancelRoute: () => false,
      routeLastPoint: () => null,
      routePreviewModel: () => null,
    },
  }

  // Pass paper coords straight through clientX/clientY in jsdom.
  const paperOf = (e: { readonly clientX: number; readonly clientY: number }) => ({ x: e.clientX, y: e.clientY })
  const view = render(
    <svg>
      <ModelDrawingLayer model={model} view={vop} bridge={bridge} paperOf={paperOf} paperMmPerPx={0.3} />
    </svg>,
  )
  const hit = screen.getByTestId('model-drawing-hit')
  // jsdom lacks setPointerCapture on SVG elements.
  Object.defineProperty(hit, 'setPointerCapture', { value: () => {}, configurable: true })
  return { ...view, hit, model, vop, joins, homeRuns, submitted, selected, hints }
}

describe('ModelDrawingLayer electrical wire and home-run interactions inside rooms', () => {
  it('hovers and drags a circuit wire inside a room without rooms blocking it', () => {
    const { hit, joins, submitted } = setupDemoLayer('v-e102')
    const wire = joins.find((j) => j.linkId === 'ckt-hp-1' && j.a === 'lt-t1' && j.b === 'lt-t2')
    expect(wire).toBeDefined()
    const mid = wire!.points[Math.floor(wire!.points.length / 2)]!

    fireEvent.pointerMove(hit, { clientX: mid.x, clientY: mid.y })
    expect(screen.getByTestId('model-wire-hover')).toBeTruthy()

    fireEvent.pointerDown(hit, { button: 0, pointerId: 1, clientX: mid.x, clientY: mid.y })
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: mid.x, clientY: mid.y + 14 })
    expect(screen.getByTestId('model-bend-preview')).toBeTruthy()

    fireEvent.pointerUp(hit, { button: 0, pointerId: 1, clientX: mid.x, clientY: mid.y + 14 })
    expect(submitted).toHaveLength(1)
    expect(submitted[0]?.command.type).toBe('set_view_properties')
    if (submitted[0]?.command.type === 'set_view_properties') {
      const cg = submitted[0].command.props.circuitGraphics as CircuitGraphicsProps | undefined
      const hint = cg?.hints?.['ckt-hp-1']
      const keys = Object.keys(hint?.waypoints ?? {})
      expect(keys).toHaveLength(1)
      expect(hint?.waypoints?.[keys[0]!]).toHaveLength(1)
    }
  })

  it('right-clicks a wire inside a room and inserts a spline vertex', () => {
    const { hit, joins, submitted } = setupDemoLayer('v-e102')
    const wire = joins.find((j) => j.linkId === 'ckt-hp-1' && j.a === 'lt-t1' && j.b === 'lt-t2')!
    const mid = wire.points[Math.floor(wire.points.length / 2)]!

    fireEvent.contextMenu(hit, { clientX: mid.x, clientY: mid.y })
    const menu = screen.getByTestId('wire-context-menu')
    expect(menu).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Insert spline vertex here' }))
    expect(submitted).toHaveLength(1)
    expect(submitted[0]?.label).toBe('insert spline vertex on wire')
  })

  it('drags a home-run arrow tip and label inside a room', () => {
    const { hit, homeRuns, submitted } = setupDemoLayer('v-e102')
    const hr = homeRuns.find((h) => h.linkId === 'ckt-hp-1')
    expect(hr).toBeDefined()

    // Drag tip
    fireEvent.pointerDown(hit, { button: 0, pointerId: 2, clientX: hr!.tipPaper.x, clientY: hr!.tipPaper.y })
    fireEvent.pointerMove(hit, { pointerId: 2, clientX: hr!.tipPaper.x - 10, clientY: hr!.tipPaper.y - 6 })
    expect(screen.getByTestId('model-homerun-preview')).toBeTruthy()
    fireEvent.pointerUp(hit, { button: 0, pointerId: 2, clientX: hr!.tipPaper.x - 10, clientY: hr!.tipPaper.y - 6 })
    expect(submitted).toHaveLength(1)
    expect(submitted[0]?.label).toBe('move home run arrow')

    // Drag label center
    const lbl = {
      x: (hr!.labelBoxPaper.min.x + hr!.labelBoxPaper.max.x) / 2,
      y: (hr!.labelBoxPaper.min.y + hr!.labelBoxPaper.max.y) / 2,
    }
    fireEvent.pointerDown(hit, { button: 0, pointerId: 3, clientX: lbl.x, clientY: lbl.y })
    fireEvent.pointerMove(hit, { pointerId: 3, clientX: lbl.x, clientY: lbl.y - 8 })
    fireEvent.pointerUp(hit, { button: 0, pointerId: 3, clientX: lbl.x, clientY: lbl.y - 8 })
    expect(submitted).toHaveLength(2)
    expect(submitted[1]?.label).toBe('move home run label')
  })

  it('still selects a foreground device when clicking directly on its symbol', () => {
    const { hit, model, vop, selected, submitted } = setupDemoLayer('v-e103')
    const troffer = model.elements['lt-t1']
    if (troffer?.kind !== 'part') throw new Error('missing lt-t1')
    const p = modelToPaperPoint(vop, { x: troffer.position.x, y: troffer.position.y, z: 0 })

    fireEvent.pointerDown(hit, { button: 0, pointerId: 4, clientX: p.x, clientY: p.y })
    fireEvent.pointerUp(hit, { button: 0, pointerId: 4, clientX: p.x, clientY: p.y })
    expect(selected).toContain('lt-t1')
    expect(submitted).toHaveLength(0)
  })

  it('creates a new control zone, toggles protocol & emergency mode, and saves via EditControlsDialog', () => {
    const model = createElectricalDemoModel()
    const submitted: Array<{ readonly command: Command; readonly label: string }> = []
    let closed = false
    render(
      <EditControlsDialog
        model={model}
        selectedIds={['lt-d1']}
        submit={(command, label) => {
          submitted.push({ command, label: label ?? '' })
          return null
        }}
        onSelect={() => {}}
        onClose={() => {
          closed = true
        }}
      />,
    )
    fireEvent.click(screen.getByTestId('controls-new-zone-btn'))
    fireEvent.change(screen.getByTestId('controls-new-zone-input'), { target: { value: 'z' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    fireEvent.click(screen.getByRole('radio', { name: 'DALI' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Switched EM (UL 924)' }))
    fireEvent.click(screen.getByTestId('edit-controls-apply'))

    expect(closed).toBe(true)
    expect(submitted).toHaveLength(1)
    expect(submitted[0]?.command).toEqual({
      type: 'set_parameters',
      id: 'lt-d1',
      scope: 'instance',
      values: { switch_leg: 'z', control_type: 'dali', emergency: true, emergency_mode: 'switched' },
    })
  })

  it('drags Circuit LP-1-3 on Sheet E101 in-place editing and commits cleanly through SyncHub + SyncClient', async () => {
    const model = createElectricalDemoModel('electrical-plan-demo')
    const hub = new SyncHub(await Sequencer.start(new InMemoryCommitStore(model)))
    const outcomes: CommitOutcome[] = []
    let client!: SyncClient
    const conn = { id: 'c1', send: (raw: string) => client.receive(raw) }
    client = new SyncClient(
      {
        send: (raw) => {
          void hub.handle(conn, raw)
        },
        close: () => {},
      },
      { id: 'dev', name: 'Dev', kind: 'human' },
      { onOutcome: (_req, out) => outcomes.push(out) },
      0,
      { modelId: 'electrical-plan-demo', clientSessionId: 'c1' },
    )
    hub.join(conn)
    client.opened()
    await new Promise((r) => setTimeout(r, 25))

    const live = client.view()
    expect(live).not.toBeNull()
    const vp = live!.elements['vp-e101-pwr'] as Viewport
    const viewEl = live!.elements['v-e101'] as ViewElement
    const vop = viewportOnPaper(live!, vp, viewEl)
    const shown = new Map<string, PartInstance>()
    for (const el of viewLevelElements(live!, viewEl)) if (el.kind === 'part' && el.planned === undefined) shown.set(el.id, el)
    const toPaper = (q: { x: number; y: number }) => modelToPaperPoint(vop, { x: q.x, y: q.y, z: 0 })
    const joins = circuitJoinsOnPaper(live!, viewEl, shown, vop.frame.scale, toPaper)
    const wire = joins.find((j) => j.linkId === 'ckt-lp-3')
    expect(wire).toBeDefined()

    const bridge: ModelEditBridge = {
      selectedIds: [],
      canEdit: true,
      blockedReason: '',
      tool: 'select',
      serverFeatures: client.serverProtocolOf()?.features ?? SERVER_FEATURES,
      hover: () => null,
      highlighted: () => null,
      tab: () => null,
      select: () => {},
      selectBox: () => '',
      moveBy: () => null,
      submit: (command) => {
        const res = client.submit(command)
        return res.ok ? null : res.error.message
      },
      hint: () => {},
      runDrag: { begin: () => null, preview: () => null, previewModel: () => null, toLength: () => null, end: () => null },
      tools: {
        previewSplit: () => '',
        split: () => '',
        previewRoute: () => null,
        clickRoute: () => null,
        finishRoute: () => null,
        cancelRoute: () => false,
        routeLastPoint: () => null,
        routePreviewModel: () => null,
      },
    }
    render(
      <svg>
        <ModelDrawingLayer model={live!} view={vop} bridge={bridge} paperOf={(e) => ({ x: e.clientX, y: e.clientY })} paperMmPerPx={0.3} />
      </svg>,
    )
    const hit = screen.getByTestId('model-drawing-hit')
    Object.defineProperty(hit, 'setPointerCapture', { value: () => {}, configurable: true })
    const mid = wire!.points[Math.floor(wire!.points.length / 2)]!
    fireEvent.pointerDown(hit, { button: 0, pointerId: 9, clientX: mid.x, clientY: mid.y })
    fireEvent.pointerMove(hit, { pointerId: 9, clientX: mid.x + 10, clientY: mid.y + 10 })
    fireEvent.pointerUp(hit, { button: 0, pointerId: 9, clientX: mid.x + 10, clientY: mid.y + 10 })
    await new Promise((r) => setTimeout(r, 25))

    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]?.status).toBe('committed')

    // With a stale peer lacking graphics:link_routing connected to the same hub,
    // the server rejects with the plain-English reload message (not a cryptic code).
    const staleConn = { id: 'stale', send: () => {} }
    hub.join(staleConn)
    await hub.handle(
      staleConn,
      JSON.stringify({
        type: 'hello',
        modelId: 'electrical-plan-demo',
        actor: { id: 'dev', name: 'Dev', kind: 'human' },
        clientSessionId: 'stale-tab',
        lastRevision: 0,
        protocol: { version: 1, features: ['views:hash_marks'] },
      }),
    )
    fireEvent.pointerDown(hit, { button: 0, pointerId: 10, clientX: mid.x, clientY: mid.y })
    fireEvent.pointerMove(hit, { pointerId: 10, clientX: mid.x + 16, clientY: mid.y + 16 })
    fireEvent.pointerUp(hit, { button: 0, pointerId: 10, clientX: mid.x + 16, clientY: mid.y + 16 })
    await new Promise((r) => setTimeout(r, 25))

    expect(outcomes).toHaveLength(2)
    expect(outcomes[1]?.status).toBe('rejected')
    if (outcomes[1]?.status === 'rejected') {
      expect(outcomes[1].error.message).toMatch(/older version|reload any older tabs/i)
    }
    client.dispose()
  })
})
