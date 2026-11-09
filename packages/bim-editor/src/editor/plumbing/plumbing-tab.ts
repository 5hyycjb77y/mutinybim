import { ArrowDownToLine, ArrowUpFromLine, Check, ChartSpline, CircleDot, CirclePlus, Droplet, Droplets, Flame, Gauge, Layers, Library, Link2, ListTree, MapPin, Network, PackagePlus, Palette, Route, Square, Wand2 } from 'lucide-react'
import { type PipeSizingMode } from '@permitzip/bim-kernel'
import { BUILDING_TYPE_LABEL, CLEANOUT_PROPOSAL_WORDS, DEMAND_CURVE_LABEL, FIXTURE_CONNECT_TARGETS, FIXTURE_CONNECT_WORDS, type FixtureConnectTarget, OUTFALL_CONNECTION_WORDS, PLUMBING_DEMAND_CURVES, type PlumbingBuildingType, type PlumbingDemandCurve } from '@permitzip/bim-pack-plumbing'
import { tradeTab } from '../ribbon/trade-tab'
import type { RibbonCommand, RibbonGroup, RibbonTab } from '../ribbon/types'

export interface PlumbingAction {
  readonly run: () => void
  /** Null when it runs; otherwise why not, in the operator's words. */
  readonly blocked: string | null
}

/** The project's auto-sizing and demand curve, as the Sizing group shows and changes them. */
export interface PlumbingSizingRibbon {
  readonly mode: PipeSizingMode
  /** Systems that set their own mode, which the project's switch doesn't change. */
  readonly systemsOwnMode: number
  readonly toggle: () => void
  readonly curve: PlumbingDemandCurve | null
  readonly buildingType: PlumbingBuildingType | null
  readonly setCurve: (curve: PlumbingDemandCurve | null) => void
  readonly blocked: string | null
  /** Open the Hunter curve chart with each water system's design point. */
  readonly chart?: PlumbingAction
}

/** The Plumbing tab's state and actions (built by usePlumbingWorkflow). Optional entries show once their feature is wired. */
export interface PlumbingRibbon {
  readonly routePipe: PlumbingAction
  readonly placeFixture: PlumbingAction
  /** On a selected open pipe end: put a load (a fixture's or a lump) there without a fixture. */
  readonly placeLoadPoint?: PlumbingAction
  /** Split a lump load point across new points, totals kept. */
  readonly breakOut?: PlumbingAction
  readonly systems: PlumbingAction
  readonly sizing: PlumbingSizingRibbon
  readonly pipeTypes: PlumbingAction
  /** Connection types for plumbing, gas and air (P01, K07, the air taps). */
  readonly connectionTypes?: PlumbingAction
  readonly riser?: PlumbingAction
  /** Plumbing › Stacks: number the drawn stacks, their tags, the base-of-stack check. */
  readonly stacks?: PlumbingAction
  /** Systems › the selected building drain to a manhole, then the fall and backwater check. */
  readonly outfallConnection?: PlumbingAction
  /** Systems › cleanouts proposed as ghosts on the selected drain; Approve puts them in the pipe. */
  readonly proposeCleanouts?: PlumbingAction
  /** Connect › To drain / vent / cold / hot water on the selected fixtures (round 15). */
  readonly connectFixtures?: Readonly<Record<FixtureConnectTarget, PlumbingAction>>
}

const CONNECT_ICON: Readonly<Record<FixtureConnectTarget, RibbonCommand['icon']>> = { drain: ArrowDownToLine, vent: ArrowUpFromLine, cold_water: Droplet, hot_water: Flame }

/** Connect: one command, its four targets underneath (the group keeps five commands at most). */
function connectCommand(actions: Readonly<Record<FixtureConnectTarget, PlumbingAction>>): RibbonCommand {
  const W = FIXTURE_CONNECT_WORDS
  const open = FIXTURE_CONNECT_TARGETS.some((t) => actions[t].blocked === null)
  return {
    id: 'connect-fixtures',
    label: W.label,
    icon: Link2,
    description: W.description,
    keywords: [...W.keywords],
    disabledReason: open ? null : (actions.drain.blocked ?? W.selectFirst),
    children: FIXTURE_CONNECT_TARGETS.map((t) => cmd(`connect-${t.replace('_', '-')}`, W.target[t].label, CONNECT_ICON[t], W.target[t].description, actions[t], [...W.keywords, W.target[t].label.toLowerCase()])),
    testId: 'ribbon-plumbing-connect-fixtures',
  }
}

const cmd = (id: string, label: string, icon: RibbonCommand['icon'], description: string, a: PlumbingAction, keywords: string[]): RibbonCommand => ({ id, label, icon, description, keywords, disabledReason: a.blocked, run: a.run, testId: `ribbon-plumbing-${id}` })

function createGroup(p: PlumbingRibbon): RibbonGroup {
  return {
    id: 'plumbing-create',
    label: 'Create',
    commands: [
      cmd('route-pipe', 'Route pipe', Route, 'Draw pipe: water, sanitary, vent, storm, gas. The fittings are placed as you turn and branch', p.routePipe, ['pipe', 'route', 'draw', 'sanitary', 'water', 'gas', 'vent']),
      ...(p.placeLoadPoint ? [cmd('place-load-point', 'Load point', MapPin, 'Put a load on the selected open pipe end (a fixture’s WSFU, DFU, gas input) without placing the fixture', p.placeLoadPoint, ['load point', 'nub', 'connection point', 'stub out', 'fixture units', 'dfu', 'wsfu'])] : []),
      cmd('place-fixture', 'Fixture', PackagePlus, 'Place a plumbing fixture or piece of equipment from the parts catalog', p.placeFixture, ['fixture', 'water closet', 'lavatory', 'sink', 'water heater', 'equipment']),
      ...(p.breakOut ? [cmd('break-out', 'Break out', ListTree, 'Split the selected lump load point (a whole kitchen) across new load points; the totals stay the same', p.breakOut, ['split', 'lump', 'break out load'])] : []),
    ],
  }
}

function sizingGroup(s: PlumbingSizingRibbon): RibbonGroup {
  const on = s.mode === 'auto'
  const others = s.systemsOwnMode > 0 ? ` (${s.systemsOwnMode} system${s.systemsOwnMode === 1 ? '' : 's'} set their own)` : ''
  const curveNow = s.curve ? DEMAND_CURVE_LABEL[s.curve] : s.buildingType ? `from the building type (${BUILDING_TYPE_LABEL[s.buildingType]})` : 'not chosen yet'
  return {
    id: 'plumbing-sizing',
    label: 'Sizing',
    commands: [
      {
        id: 'auto-size',
        label: 'Auto-size',
        icon: Wand2,
        description: on ? `On: suggested pipe sizes are applied as you model${others}. Press to go back to checking only` : `Off: every pipe is checked and sizes are suggested; nothing changes until you accept${others}. Press to let sizes apply as you model`,
        keywords: ['auto size', 'automatic sizing', 'sizing', 'check', 'audit', 'lint'],
        pressed: on,
        disabledReason: s.blocked,
        run: s.toggle,
        testId: 'ribbon-plumbing-auto-size',
      },
      {
        id: 'demand-curve',
        label: 'Demand curve',
        icon: Gauge,
        description: `Fixture units to gpm for water sizing: ${curveNow}`,
        keywords: ['hunter curve', 'ashrae', 'curve a', 'wsfu', 'demand', 'appendix e', 'gpm'],
        disabledReason: s.blocked,
        children: [
          ...PLUMBING_DEMAND_CURVES.filter((c) => c !== 'legacy_fit').map((c) => ({
            id: `demand-curve-${c}`,
            label: DEMAND_CURVE_LABEL[c],
            icon: s.curve === c ? Check : Square,
            description: `Size water pipes on ${DEMAND_CURVE_LABEL[c]}`,
            pressed: s.curve === c,
            disabledReason: s.blocked,
            run: () => s.setCurve(c),
            testId: `ribbon-plumbing-demand-curve-${c}`,
          })),
          { id: 'demand-curve-building', label: 'From the building type', icon: s.curve === null ? Check : Square, description: 'Use the curve the building type calls for (set it in Systems › Project)', pressed: s.curve === null, disabledReason: s.blocked, run: () => s.setCurve(null), testId: 'ribbon-plumbing-demand-curve-building' },
        ],
        testId: 'ribbon-plumbing-demand-curve',
      },
      ...(s.chart ? [cmd('hunter-curve', 'Hunter curve', ChartSpline, "The demand curves and where each water system's fixture units fall on its curve", s.chart, ['hunter curve', 'chart', 'graph', 'demand', 'gpm', 'wsfu', 'operating point', 'design point'])] : []),
    ],
  }
}

/** Plumbing: on every project's Building Model, like Electrical, in the same tab pattern. */
export function plumbingTab(p: PlumbingRibbon, select: RibbonGroup): RibbonTab {
  return tradeTab({
    id: 'plumbing',
    label: 'Plumbing',
    select,
    create: [createGroup(p)],
    connect: {
      id: 'plumbing-systems',
      label: 'Systems',
      commands: [
        ...(p.connectFixtures ? [connectCommand(p.connectFixtures)] : []),
        cmd('systems', 'Systems', Palette, 'Name each pipe system, its colour and line pattern (vents dashed in print), and whether it sizes itself', p.systems, ['system', 'rename', 'colour', 'color', 'line style', 'dashed', 'line weight', 'graphics', 'visibility']),
        ...(p.outfallConnection ? [cmd('outfall-connection', OUTFALL_CONNECTION_WORDS.label, CircleDot, OUTFALL_CONNECTION_WORDS.description, p.outfallConnection, [...OUTFALL_CONNECTION_WORDS.keywords])] : []),
        ...(p.proposeCleanouts ? [cmd('propose-cleanouts', CLEANOUT_PROPOSAL_WORDS.label, CirclePlus, CLEANOUT_PROPOSAL_WORDS.description, p.proposeCleanouts, [...CLEANOUT_PROPOSAL_WORDS.keywords])] : []),
        ...(p.stacks ? [cmd('stacks', 'Stacks', Layers, 'Every sanitary, vent and storm stack: number them, see each floor’s size, DFU and offsets, and the tag they print (4"//S/K/L//19)', p.stacks, ['stack', 'stacks', 'riser', 'stack number', 'stack tag', 'offset', 'base of stack', '3 diameter', 'waste stack', 'vent stack'])] : []),
      ],
    },
    analyze: sizingGroup(p.sizing),
    design: {
      id: 'plumbing-types',
      label: 'Types',
      commands: [
        cmd('pipe-types', 'Pipe types', Library, 'DW-PEX, SAN-PVC, GAS-SCH40…: material, sizes and joints, and the fittings each material takes', p.pipeTypes, ['pipe type', 'material', 'pex', 'pvc', 'cast iron', 'copper', 'fittings', 'piping specifications']),
        ...(p.connectionTypes ? [cmd('connection-types', 'Connection types', Droplets, 'P01, K07…: what a fixture or appliance connects with (WSFU, DFU, gas input, CFM), used by load points and fixtures', p.connectionTypes, ['connection type', 'fixture type', 'wsfu', 'dfu', 'mbh', 'cfm', 'designator'])] : []),
      ],
    },
    documents: [p.riser ? { id: 'plumbing-diagrams', label: 'Diagrams', commands: [cmd('riser', 'Riser diagram', Network, 'The live plumbing riser drawn from the model, redrawn as it changes; place it on a sheet like any view', p.riser, ['riser', 'isometric', 'schematic', 'diagram'])] } : null],
  })
}

const NOTHING = (): void => undefined

/** The Plumbing tab while the plumbing tools load (or failed): every command off, saying why. */
export function waitingRibbon(reason: string): PlumbingRibbon {
  const off = { run: NOTHING, blocked: reason }
  return {
    routePipe: off,
    placeFixture: off,
    systems: off,
    sizing: { mode: 'check', systemsOwnMode: 0, toggle: NOTHING, curve: null, buildingType: null, setCurve: NOTHING, blocked: reason },
    pipeTypes: off,
  }
}

/** This add-on's tabs by the ids in its `ADDON_UI` (`tabsFrom`). */
export const TABS = { plumbing: plumbingTab }
