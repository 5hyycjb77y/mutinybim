import { BatteryCharging, Box, Cable, CircleDot, ClipboardCheck, Factory, Gauge, LayoutGrid, Library, Lightbulb, Network, Plug, PlugZap, Power, Repeat, Scale, Server, SquareStack, Table2, TableProperties, ToggleLeft, Unplug, Waypoints, X, Zap } from 'lucide-react'
import type { RibbonCommand, RibbonGroup, RibbonTab } from '../ribbon/types'
import { tradeTab } from '../ribbon/trade-tab'
import type { ScheduleChoice } from './schedules/schedule-plan'
import type { ScheduleAction } from './schedules/use-schedule-workflow'
import type { DockDeclaration } from '../contributions/types'
import { dockChildren } from '../schedule-tab/dock'

/** The starter types the Electrical tab places (packages/bim-kernel/src/library). */
export const ELECTRICAL_PLACE_TYPES = {
  receptacle: 'builtin:duplex-receptacle@1',
  light: 'builtin:troffer-2x4-led@1',
  switch: 'builtin:switch-single-pole@1',
  junction_box: 'builtin:junction-box-4sq@1',
  equipment_1p: 'builtin:equipment-connection-1p@1',
  equipment_2p: 'builtin:equipment-connection-2p@1',
  equipment_3p: 'builtin:equipment-connection-3p@1',
  panel_208: 'builtin:panelboard-225@1',
  panel_480: 'builtin:panelboard-225-480@1',
  switchboard: 'builtin:switchboard-800-480@1',
  transformer: 'builtin:transformer-75kva@1',
  receptacle_quad: 'builtin:quad-receptacle@1',
  receptacle_gfci: 'builtin:gfci-receptacle@1',
  receptacle_counter: 'builtin:countertop-receptacle@1',
  receptacle_floor: 'builtin:floor-receptacle@1',
  receptacle_ceiling: 'builtin:ceiling-receptacle@1',
  downlight: 'builtin:downlight-6-led@1',
  light_emergency: 'builtin:troffer-2x4-led-em@1',
  exit_sign: 'builtin:exit-sign-led@1',
  panel_208_mcb: 'builtin:panelboard-225-mcb@1',
  panel_480_mcb: 'builtin:panelboard-225-480-mcb@1',
  panel_unit: 'builtin:panelboard-125-208-1ph@1',
  switchboard_sections: 'builtin:switchboard-sections-1600-480@1',
  transformer_45: 'builtin:transformer-45kva@1',
  transformer_112: 'builtin:transformer-112_5kva@1',
  generator: 'builtin:generator-150kw-480@1',
  ats: 'builtin:ats-400-480@1',
  meter: 'builtin:ct-cabinet-meter-800-480@1',
  tap_box: 'builtin:tap-box-1200-480@1',
  disconnect_nf_30: 'builtin:disconnect-nf-30-480@1',
  disconnect_nf_60: 'builtin:disconnect-nf-60-480@1',
  disconnect_fused_60: 'builtin:disconnect-fused-60-480@1',
  disconnect_fused_100: 'builtin:disconnect-fused-100-480@1',
} as const

export type ElectricalPlaceKind = keyof typeof ELECTRICAL_PLACE_TYPES

/** What is selected, as the Circuit tab cares: loads that can go on a circuit, and distribution equipment. */
export interface ElectricalSelection {
  readonly label: string
  /** Devices and equipment with a power connector (not panels). */
  readonly loads: number
  /** Loads already on a circuit. */
  readonly circuited: number
  /** Panelboards, switchboards and transformers. */
  readonly panels: number
  /** Equipment selected that needs a field filled in before it can be circuited or fed. */
  readonly unready?: number
}

export interface ElectricalAction {
  readonly run: () => void
  readonly blocked: string | null
}

/** The Electrical tab's state and actions (built by useElectricalWorkflow). Each `…Blocked` is null when it runs, else why not. */
export interface ElectricalRibbon {
  readonly place: (kind: ElectricalPlaceKind) => void
  readonly placeBlocked: string | null
  readonly addToCircuit: () => void
  readonly addBlocked: string | null
  readonly editCircuit: () => void
  readonly editBlocked: string | null
  readonly removeFromCircuit: () => void
  readonly removeBlocked: string | null
  readonly feedPanel: () => void
  readonly feedBlocked: string | null
  readonly openPanelView: () => void
  readonly panelViewBlocked: string | null
  /** Findings, phase balancing and room templates: shown once wired (each `run` + why it can't). */
  readonly check?: ElectricalAction
  readonly balance?: ElectricalAction
  readonly templates?: ElectricalAction
  /** Schedules group: make a live schedule of this kind (`blockedFor` null when it can be made, else why not). */
  readonly schedules?: ScheduleAction
  /** Open (or make) the live diagram of a kind: drawn from the model, kept up to date (diagrams/). */
  readonly diagram?: { readonly open: (kind: 'one_line' | 'electrical_riser') => void; readonly blocked: string | null }
  /** Connection types, feeder types and room templates (the project's electrical catalog). */
  readonly types?: ElectricalAction
  /** One entry per docked record (the add-on's `docks` declaration), each opened beside the plan. */
  readonly docked?: { readonly addon: string; readonly dock: DockDeclaration; readonly list: readonly { readonly id: string; readonly name: string }[]; readonly open: (id: string) => void }
  /** Continue circuit: every device placed while it is on joins the picked circuit (Esc or Stop ends it). */
  readonly continueCircuit?: ElectricalAction
  /** Propose receptacles in rooms the person picks (NEC 210.52 or a density preset); preview, then accept all or some. */
  readonly propose?: ElectricalAction
  /** Early service size from a pasted equipment list (NEC 220); changes nothing in the model. */
  readonly serviceSize?: ElectricalAction
  /** Place a starter service (meter, main, distribution, panels) from a service size; the one-line then draws it. */
  readonly serviceLayout?: ElectricalAction
  readonly selection: ElectricalSelection | null
}

function scheduleCommand(s: ScheduleAction, kind: ScheduleChoice, label: string, icon: RibbonCommand['icon'], description: string, testId: string, keywords: string[] = []): RibbonCommand {
  return { id: `schedule-${kind}`, label, icon, description, keywords, disabledReason: s.blockedFor(kind), run: () => s.run(kind), testId }
}

function schedulesGroup(s: ScheduleAction): RibbonGroup {
  return {
    id: 'electrical-schedules',
    label: 'Schedules',
    commands: [
      scheduleCommand(s, 'panel', 'Panel schedule', Table2, 'A live panel schedule of the selected panel (or the panel of the selected device), placed on a sheet', 'ribbon-electrical-panel-schedule', ['panel schedule', 'switchboard schedule', 'load schedule', 'circuits']),
      scheduleCommand(s, 'feeder', 'Feeder schedule', Table2, 'Every feeder type in the model with its conductors and conduit, placed on a sheet', 'ribbon-electrical-feeder-schedule', ['feeders', 'conductors', 'wire']),
      {
        id: 'more-schedules',
        label: 'More schedules',
        icon: TableProperties,
        description: 'Connection types, equipment connections, and mechanical equipment with its circuit',
        keywords: ['schedule'],
        children: [
          scheduleCommand(s, 'connection_types', 'Connection types', Table2, 'Devices grouped by type and load', 'ribbon-electrical-connection-types-schedule', ['devices', 'receptacles']),
          scheduleCommand(s, 'equipment_connections', 'Equipment connections', Table2, 'Hardwired equipment with MCA, MOCP and its live circuit', 'ribbon-electrical-equipment-connections-schedule', ['mca', 'mocp', 'disconnect']),
          scheduleCommand(s, 'mechanical_equipment', 'Mechanical equipment (with electrical)', Table2, 'The mechanical equipment list with volts, MCA, MOCP and the circuit it is on', 'ribbon-electrical-mechanical-schedule', ['rtu', 'hvac', 'cross trade']),
        ],
        testId: 'ribbon-electrical-more-schedules',
      },
    ],
  }
}

function placeCommand(e: ElectricalRibbon, kind: ElectricalPlaceKind, label: string, icon: RibbonCommand['icon'], description: string, keywords: string[] = []): RibbonCommand {
  return { id: `place-${kind}`, label, icon, description, keywords, disabledReason: e.placeBlocked, run: () => e.place(kind), testId: `ribbon-electrical-place-${kind.replace(/_/g, '-')}` }
}

function placeGroup(e: ElectricalRibbon): RibbonGroup {
  return {
    id: 'electrical-place',
    label: 'Place',
    commands: [
      {
        id: 'place-device',
        label: 'Device',
        icon: Plug,
        description: 'Place a receptacle, light, switch, junction box or hardwired equipment connection, then click in a plan or the 3D model',
        keywords: ['receptacle', 'outlet', 'light', 'fixture', 'switch', 'junction box', 'equipment connection', 'disconnect', 'power'],
        disabledReason: e.placeBlocked,
        children: [
          placeCommand(e, 'receptacle', 'Receptacle', Plug, 'A 20 A duplex receptacle, 120 V, 180 VA', ['outlet', 'duplex', 'plug']),
          placeCommand(e, 'receptacle_quad', 'Receptacle, quad', Plug, 'Two duplexes in one box, 360 VA', ['fourplex', 'double duplex']),
          placeCommand(e, 'receptacle_gfci', 'Receptacle, GFCI', Plug, 'A GFCI duplex receptacle', ['ground fault', 'gfi', 'wet']),
          placeCommand(e, 'receptacle_counter', 'Receptacle, countertop', Plug, 'A GFCI receptacle 42" up, above a counter', ['kitchen', 'counter', 'break room']),
          placeCommand(e, 'receptacle_floor', 'Receptacle, floor box', Plug, 'A duplex in a floor box', ['floor', 'poke-thru']),
          placeCommand(e, 'receptacle_ceiling', 'Receptacle, ceiling', Plug, 'A ceiling-mounted duplex', ['ceiling', 'projector']),
          placeCommand(e, 'light', 'Light', Lightbulb, 'A 2x4 LED troffer, 277 V', ['fixture', 'luminaire', 'troffer', 'lighting']),
          placeCommand(e, 'downlight', 'Downlight', Lightbulb, 'A 6" LED downlight, 277 V', ['can', 'recessed']),
          placeCommand(e, 'light_emergency', 'Light, emergency battery', BatteryCharging, 'A 2x4 troffer with an emergency battery', ['emergency', 'egress', 'em']),
          placeCommand(e, 'exit_sign', 'Exit sign', BatteryCharging, 'An LED exit sign with battery', ['exit', 'egress']),
          placeCommand(e, 'switch', 'Switch', ToggleLeft, 'A single-pole switch', ['light switch', 'toggle']),
          placeCommand(e, 'junction_box', 'Junction box', Box, 'A 4" square junction box', ['j-box', 'jbox']),
          placeCommand(e, 'equipment_1p', 'Equipment connection, 120 V', PlugZap, 'A hardwired connection, 1 pole: set its load and breaker to the nameplate', ['hardwired', 'disconnect', 'equipment']),
          placeCommand(e, 'equipment_2p', 'Equipment connection, 208 V 2-pole', PlugZap, 'A hardwired connection, 2 poles', ['hardwired', 'water heater', 'equipment']),
          placeCommand(e, 'equipment_3p', 'Equipment connection, 3-phase', PlugZap, 'A hardwired connection, 3 poles: set its voltage to 208 or 480', ['hardwired', 'motor', 'equipment']),
        ],
        testId: 'ribbon-electrical-device',
      },
      {
        id: 'place-panel',
        label: 'Panel',
        icon: Server,
        description: 'Place a panelboard or switchboard; name it (L1, H1, MDP) in its properties so circuits read L1-3',
        keywords: ['panelboard', 'switchboard', 'mdp', 'distribution', 'load center'],
        disabledReason: e.placeBlocked,
        children: [
          placeCommand(e, 'panel_208', 'Panelboard 120/208 V', Server, '225 A, 42 circuits, main lugs', ['208', 'lighting panel', 'receptacle panel']),
          placeCommand(e, 'panel_480', 'Panelboard 277/480 V', Server, '225 A, 42 circuits, main lugs', ['480', 'h panel']),
          placeCommand(e, 'panel_208_mcb', 'Panelboard 120/208 V, main breaker', Server, '225 A main breaker, 42 circuits', ['mcb', 'main breaker']),
          placeCommand(e, 'panel_480_mcb', 'Panelboard 277/480 V, main breaker', Server, '225 A main breaker, 42 circuits', ['mcb', 'main breaker']),
          placeCommand(e, 'panel_unit', 'Unit panel 120/208 V 1-phase', Server, '125 A main breaker, 30 circuits: a dwelling unit', ['apartment', 'unit', 'load center', 'residential']),
          placeCommand(e, 'switchboard', 'Switchboard 277/480 V', SquareStack, '800 A main breaker, 30 positions', ['mdp', 'main distribution', 'service']),
          placeCommand(e, 'switchboard_sections', 'Switchboard, sections', SquareStack, '1600 A, 3 sections (set the count in its properties)', ['msb', 'main switchboard', 'sections']),
        ],
        testId: 'ribbon-electrical-panel',
      },
      placeCommand(e, 'transformer', 'Transformer', Zap, 'A 75 kVA dry-type transformer, 480 V to 208Y/120 V: feed it from a 480 V breaker, then feed a 208 V panel from it', ['step down', 'xfmr', 'kva']),
      {
        id: 'place-equipment',
        label: 'Equipment',
        icon: Factory,
        description: 'Place a generator, transfer switch, meter and CT cabinet, tap box, disconnect or another transformer size',
        keywords: ['generator', 'ats', 'transfer switch', 'meter', 'ct cabinet', 'tap box', 'disconnect', 'safety switch'],
        disabledReason: e.placeBlocked,
        children: [
          placeCommand(e, 'generator', 'Generator', Power, '150 kW diesel, 480Y/277 V: feed a transfer switch’s emergency side from it', ['genset', 'standby', 'emergency']),
          placeCommand(e, 'ats', 'Transfer switch', Repeat, '400 A, 4-pole: fed on its normal side by a breaker and on its emergency side by a generator', ['ats', 'automatic transfer']),
          placeCommand(e, 'meter', 'Meter and CT cabinet', Gauge, '800 A, 480Y/277 V: between the utility and the main switchboard', ['ct', 'utility meter', 'service']),
          placeCommand(e, 'tap_box', 'Tap box', Gauge, '1200 A, 480Y/277 V, no breakers: feeders tap off the service here', ['tap can', 'wireway', 'gutter', 'service', 'fire pump']),
          placeCommand(e, 'disconnect_nf_30', 'Disconnect, non-fused 30 A', Unplug, 'NEMA 3R, for rooftop equipment', ['safety switch', 'nf', 'rooftop']),
          placeCommand(e, 'disconnect_nf_60', 'Disconnect, non-fused 60 A', Unplug, 'NEMA 1', ['safety switch', 'nf']),
          placeCommand(e, 'disconnect_fused_60', 'Disconnect, fused 60 A', Unplug, '40 A fuses, NEMA 1', ['safety switch', 'fused']),
          placeCommand(e, 'disconnect_fused_100', 'Disconnect, fused 100 A', Unplug, '80 A fuses, NEMA 3R', ['safety switch', 'fused']),
          placeCommand(e, 'transformer_45', 'Transformer 45 kVA', Zap, '480 V to 208Y/120 V', ['xfmr']),
          placeCommand(e, 'transformer_112', 'Transformer 112.5 kVA', Zap, '480 V to 208Y/120 V', ['xfmr']),
        ],
        testId: 'ribbon-electrical-equipment',
      },
    ],
  }
}

function circuitCommands(e: ElectricalRibbon): RibbonCommand[] {
  const onCircuit = (e.selection?.circuited ?? 0) > 0
  return [
    {
      id: 'add-to-circuit',
      label: onCircuit && e.selection?.loads === e.selection?.circuited ? 'Change circuit' : 'Add to circuit',
      icon: Cable,
      description: 'Put what you selected on a circuit: pick the panel, and the free slots that best balance its phases are chosen for you',
      keywords: ['circuit', 'home run', 'branch circuit', 'assign', 'panel'],
      disabledReason: e.addBlocked,
      run: e.addToCircuit,
      testId: 'ribbon-electrical-add-to-circuit',
    },
    {
      id: 'edit-circuit',
      label: 'Edit circuit',
      icon: Waypoints,
      description: 'Change the selected device’s circuit: its slots, breaker, wire and what is on it',
      keywords: ['breaker', 'wire', 'slot', 'move circuit', 'remove device'],
      disabledReason: e.editBlocked,
      run: e.editCircuit,
      testId: 'ribbon-electrical-edit-circuit',
    },
    {
      id: 'feed-panel',
      label: 'Feed panel',
      icon: Unplug,
      description: 'Feed the selected panel or transformer from a breaker in another panel or switchboard',
      keywords: ['feeder', 'supply from', 'fed from', 'sub-feed', 'transformer'],
      disabledReason: e.feedBlocked,
      run: e.feedPanel,
      testId: 'ribbon-electrical-feed-panel',
    },
  ]
}

function continueCircuitCommand(a: ElectricalAction): RibbonCommand {
  return {
    id: 'continue-circuit',
    label: 'Continue circuit',
    icon: Repeat,
    description: 'Pick a panel and a circuit (or a new one), then every device you place joins it; Esc or Stop ends it',
    keywords: ['keep adding', 'circuit while placing', 'daisy chain', 'home run', 'place on circuit'],
    disabledReason: a.blocked,
    run: a.run,
    testId: 'ribbon-electrical-continue-circuit',
  }
}

function diagramsGroup(d: NonNullable<ElectricalRibbon['diagram']>): RibbonGroup {
  return {
    id: 'electrical-diagrams',
    label: 'Diagrams',
    commands: [
      { id: 'one-line-diagram', label: 'One-line diagram', icon: Network, description: 'The live one-line, drawn from your panels and feeders and redrawn whenever they change; place it on a sheet like any view', keywords: ['single line', 'sld', 'one line', 'riser', 'distribution', 'feeder'], disabledReason: d.blocked, run: () => d.open('one_line'), testId: 'ribbon-electrical-one-line' },
      { id: 'electrical-riser', label: 'Riser diagram', icon: Network, description: 'The live electrical riser: the same equipment and feeders drawn floor by floor', keywords: ['riser', 'vertical', 'floors'], disabledReason: d.blocked, run: () => d.open('electrical_riser'), testId: 'ribbon-electrical-riser' },
    ],
  }
}

/** Electrical: on every project's Building Model, whether or not anything electrical is in it yet. Same pattern as every trade's tab (ribbon/trade-tab.ts). */
export function electricalTab(e: ElectricalRibbon, select: RibbonGroup): RibbonTab {
  return tradeTab({
    id: 'electrical',
    label: 'Electrical',
    select,
    create: [placeGroup(e)],
    connect: { id: 'electrical-circuit', label: 'Circuits', commands: [...circuitCommands(e), ...(e.continueCircuit ? [continueCircuitCommand(e.continueCircuit)] : [])] },
    analyze: {
      id: 'electrical-panels',
      label: 'Panels',
      commands: [
        {
          id: 'panel-view',
          label: 'Panel view',
          icon: CircleDot,
          description: 'The live panel schedule: every slot, its circuit, breaker and load by phase',
          keywords: ['panel schedule', 'slots', 'breakers', 'loads'],
          disabledReason: e.panelViewBlocked,
          run: e.openPanelView,
          testId: 'ribbon-electrical-panel-view',
          // One entry per docked record opens its schedule beside the plan.
          ...(e.docked && e.docked.list.length > 0 ? { split: true, children: dockChildren(e.docked.addon, e.docked.dock, CircleDot, e.docked.list, e.docked.open) } : {}),
        },
        ...(e.check ? [{ id: 'electrical-check', label: 'Check', icon: ClipboardCheck, description: 'What needs attention: devices on no circuit, voltage mismatches, overloaded or unbalanced panels', keywords: ['findings', 'errors', 'uncircuited', 'overloaded', 'unbalanced', 'audit'], disabledReason: e.check.blocked, run: e.check.run, testId: 'ribbon-electrical-check' }] : []),
        ...(e.balance ? [{ id: 'electrical-balance', label: 'Balance phases', icon: Scale, description: 'Suggest slot moves that even out the load on A, B and C; you choose which to apply', keywords: ['rebalance', 'phase balance', 'load balance'], disabledReason: e.balance.blocked, run: e.balance.run, testId: 'ribbon-electrical-balance' }] : []),
      ],
    },
    design: {
      id: 'electrical-design',
      label: 'Design',
      commands: [
        ...(e.types ? [{ id: 'electrical-types', label: 'Electrical types', icon: Library, description: 'Connection types (E.05: load, voltage, poles, class), feeder types (F225: breaker, conductors, conduit) and room templates', keywords: ['connection type', 'feeder type', 'feeder schedule', 'designator', 'catalog', 'f225'], disabledReason: e.types.blocked, run: e.types.run, testId: 'ribbon-electrical-types' }] : []),
        ...(e.propose ? [{ id: 'electrical-propose', label: 'Propose receptacles', icon: LayoutGrid, description: 'Pick rooms and a receptacle type: see where NEC 210.52 spacing (or a light, medium or heavy density) puts them, then accept all or some. Nothing is circuited', keywords: ['receptacle layout', '210.52', 'outlet spacing', 'suggest receptacles', 'density', 'dwelling'], disabledReason: e.propose.blocked, run: e.propose.run, testId: 'ribbon-electrical-propose' }] : []),
        ...(e.serviceSize ? [{ id: 'electrical-service-size', label: 'Service size', icon: Gauge, description: 'Paste the kitchen and mechanical equipment lists: confirm each load class and get the NEC Article 220 service size with its trail, before any layout', keywords: ['service', 'load calc', 'equipment list', 'kitchen schedule', 'article 220', 'utility'], disabledReason: e.serviceSize.blocked, run: e.serviceSize.run, testId: 'ribbon-electrical-service-size' }] : []),
        ...(e.serviceLayout ? [{ id: 'electrical-service-layout', label: 'Service layout', icon: Network, description: 'From a service size (400 A 120/208 V): place the meter, main, main distribution and the panels you list, each fed from what you pick, as one edit; the one-line then shows it', keywords: ['one-line skeleton', 'service entrance', 'mdp', 'main distribution', 'starter layout', 'riser', 'single line'], disabledReason: e.serviceLayout.blocked, run: e.serviceLayout.run, testId: 'ribbon-electrical-service-layout' }] : []),
        ...(e.templates ? [{ id: 'electrical-templates', label: 'Room templates', icon: SquareStack, description: 'Your firm’s circuit conventions (bedroom on circuit 1, living room on 2…), applied to the units you pick', keywords: ['template', 'dwelling', 'unit', 'convention', 'multifamily'], disabledReason: e.templates.blocked, run: e.templates.run, testId: 'ribbon-electrical-templates' }] : []),
      ],
    },
    documents: [e.schedules ? schedulesGroup(e.schedules) : null, e.diagram ? diagramsGroup(e.diagram) : null],
  })
}

/** Circuit: opens by itself when something electrical is selected. Null when nothing is. */
export function circuitTab(e: ElectricalRibbon, select: RibbonGroup): RibbonTab | null {
  const sel = e.selection
  if (!sel) return null
  return {
    id: 'circuit',
    label: 'Circuit',
    contextual: true,
    groups: [
      select,
      {
        id: 'circuit',
        label: sel.label,
        commands: [
          ...circuitCommands(e),
          { id: 'remove-from-circuit', label: 'Take off circuit', icon: X, description: 'Take the selected devices off their circuits; the circuit stays as a spare if nothing is left on it', keywords: ['remove', 'unassign', 'disconnect'], disabledReason: e.removeBlocked, run: e.removeFromCircuit, testId: 'ribbon-electrical-remove-from-circuit' },
          { id: 'circuit-panel-view', label: 'Panel view', icon: CircleDot, description: 'Open the panel schedule of the selected panel, or of the panel the selected device is on', disabledReason: e.panelViewBlocked, run: e.openPanelView, testId: 'ribbon-circuit-panel-view' },
        ],
      },
    ],
  }
}

const NOTHING = (): void => undefined

/** The Electrical and Circuit tabs while the electrical tools load (or failed): every command off, saying why. */
export function waitingRibbon(reason: string): ElectricalRibbon {
  return {
    place: NOTHING,
    placeBlocked: reason,
    addToCircuit: NOTHING,
    addBlocked: reason,
    editCircuit: NOTHING,
    editBlocked: reason,
    removeFromCircuit: NOTHING,
    removeBlocked: reason,
    feedPanel: NOTHING,
    feedBlocked: reason,
    openPanelView: NOTHING,
    panelViewBlocked: reason,
    selection: null,
  }
}

/** This add-on's tabs by the ids in its `ADDON_UI` (`tabsFrom`). */
export const TABS = { electrical: electricalTab, circuit: circuitTab }
