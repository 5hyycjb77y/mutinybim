import { fireEvent, render, screen } from '@testing-library/react'
import { asElementId, asRevision, DEFAULT_SETTINGS, type BimElement, type Level, type ModelState, type Opening, type RunFitting, type RunSegment, type Wall } from '@permitzip/bim-kernel'
import CameraTools from '../src/editor/orientation/CameraTools'
import { advanceWalker, walkFloor, walkingPose } from '../src/editor/orientation/floor-walk'
import { defaultFlight, flightPose, pointAlong, traceCameraRoute, validFlight } from '../src/editor/orientation/camera-paths'

const record = (id: string) => ({ id: asElementId(id), version: 1, authoredRev: {} })
const floor: Level = { ...record('L2'), kind: 'level', name: 'Level 2', elevationMm: 3200, partition: { level: '*', zone: '*', discipline: 'architecture' } }
const modelWith = (...records: BimElement[]): ModelState => ({
  modelId: 'camera-test', elements: Object.fromEntries([floor, ...records].map(r => [r.id, r])), connections: [], revision: asRevision(1), settings: DEFAULT_SETTINGS,
})
const camera = { eye: { x: 5000, y: -4000, z: 6500 }, target: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 }, fovDeg: 45, orthoHeightMm: 10000 }
const size = { shape: 'round', diameter: 150 } as const
const systemId = asElementId('sa')
const riser: RunSegment = {
  ...record('riser'), kind: 'run_segment', systemId, levelId: floor.id, domain: 'duct', size, flow: 0, branches: [],
  start: { x: 0, y: 0, z: 0 }, end: { x: 0, y: 0, z: 2000 }, links: { end: { elementId: asElementId('elbow'), port: 'a' } },
}
const trunk: RunSegment = { ...riser, ...record('trunk'), start: riser.end, end: { x: 3000, y: 0, z: 2000 }, branches: [asElementId('tee')], links: { start: { elementId: asElementId('elbow'), port: 'b' } } }
const elbow: RunFitting = { ...record('elbow'), kind: 'run_fitting', fittingType: 'elbow', label: 'Elbow', domain: 'duct', systemId, levelId: floor.id, position: riser.end,
  ports: [{ id: 'a', position: riser.end, direction: { x: 0, y: 0, z: -1 }, size, link: { elementId: riser.id, port: 'end' } },
    { id: 'b', position: trunk.start, direction: { x: 1, y: 0, z: 0 }, size, link: { elementId: trunk.id, port: 'start' } }] }
const tee: RunFitting = { ...elbow, ...record('tee'), fittingType: 'tee', label: 'Tee', position: { x: 1100, y: 0, z: 2000 }, host: { segmentId: trunk.id, s: 1100, side: 1 }, ports: [] }

it('keeps a walker on the chosen floor and sweeps through a door, stopping at a sill or a solid wall', () => {
  const wall: Wall = { ...record('wall'), kind: 'wall', start: { x: 0, y: 0 }, end: { x: 8000, y: 0 }, height: 2700, thickness: 120, wallType: 'Wall',
    partition: { level: floor.name, zone: 'Z1', discipline: 'architecture' } }
  const door: Opening = { ...record('door'), kind: 'opening', openingType: 'door', mark: '201A', hostId: wall.id, offset: 1500, width: 1000, height: 2100, position: { x: 1500, y: 0 } }
  const window: Opening = { ...door, ...record('window'), openingType: 'window', height: 1200, offset: 4500, position: { x: 4500, y: 0 } }
  const walk = walkFloor(modelWith(wall, door, window), floor)
  const cross = (x: number) => advanceWalker({ x, y: -1200, pitch: 0, yaw: 0 }, 0, 2400, walk.clear).y
  expect(cross(1500)).toBe(1200)
  expect(cross(1900)).toBeLessThan(0) // shoulder clips the jamb
  expect(cross(4500)).toBeLessThan(0)
  expect(cross(6500)).toBeLessThan(0)
  const spawn = walk.spawn(camera)!
  expect(walk.clear(spawn)).toBe(true)
  expect(walkingPose(spawn, floor).eye.z).toBe(4800)
})

it('measures vertical travel in world coordinates, rounds the elbow and stops at the first branch in either direction', () => {
  const model = modelWith(riser, elbow, trunk, tee)
  const route = traceCameraRoute(model, riser, 'start')
  expect(route).toMatchObject({ length: 3100, end: 'First tee' })
  expect(pointAlong(route, 1000)).toEqual({ x: 0, y: 0, z: 4200 })
  expect(pointAlong(route, route.length)).toEqual({ x: 1100, y: 0, z: 5200 })
  expect(traceCameraRoute(model, trunk, 'end')).toMatchObject({ length: 1900, end: 'First tee' })
  expect(traceCameraRoute(model, riser, 'end')).toMatchObject({ length: 2000, end: 'Open end' })
})

it('stops on a broken, disjoint or cross-system continuation and measures a flex by its curve', () => {
  for (const other of [{ ...trunk, links: {} }, { ...trunk, start: { ...trunk.start, x: 300 } }, { ...trunk, systemId: asElementId('ra') }]) {
    expect(traceCameraRoute(modelWith(riser, elbow, other), riser, 'start')).toMatchObject({ length: 2000, end: 'End of connected run' })
  }
  const bent: RunSegment = { ...trunk, links: {}, branches: [], flex: { path: [{ x: 1500, y: 2000, z: 2000 }] } }
  const route = traceCameraRoute(modelWith(bent), bent, 'start')
  expect(route.length).toBe(5000)
  expect(pointAlong(route, 2500)).toEqual({ x: 1500, y: 2000, z: 5200 })
})

it('honours waypoint times, captured aim and end positions', () => {
  const shots = defaultFlight(camera)
  const final = { ...shots[2]!, target: { x: 1250, y: 600, z: 400 }, seconds: 12 }
  const edited = [shots[0]!, shots[1]!, final]
  expect(validFlight(edited)).toBe(true)
  expect(validFlight([edited[0]!, { ...final, seconds: 0 }])).toBe(false)
  expect(flightPose(edited, 4)).toMatchObject({ eye: shots[1]!.eye, target: shots[1]!.target })
  expect(flightPose(edited, 8).target).toEqual({ x: 625, y: 300, z: 200 })
  expect(flightPose(edited, 99)).toMatchObject(final)
})

it('releases the camera on Escape and on unmount, and reopens edited waypoint times in this tab', () => {
  const release = jest.fn()
  const viewer = { camera3dState: () => camera, beginCameraMotion: () => ({ look: () => true, release }), setCamera3d: async () => {} }
  const canvas = document.createElement('div')
  canvas.tabIndex = -1
  document.body.appendChild(canvas)
  const props = { viewer, model: modelWith(), initialLevel: floor.id, selectedId: null, rightInset: 0, canvasRef: { current: canvas }, onClose: jest.fn() }
  const first = render(<CameraTools {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Start floor walk' }))
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(release).toHaveBeenCalledTimes(1)
  expect(canvas).toHaveFocus()
  canvas.remove()
  fireEvent.change(screen.getByLabelText('Camera mode'), { target: { value: 'flight' } })
  fireEvent.change(screen.getByLabelText('Waypoint'), { target: { value: '2' } })
  fireEvent.change(screen.getByLabelText('Seconds'), { target: { value: '6' } })
  fireEvent.click(screen.getByRole('button', { name: 'Play flyover' }))
  first.unmount()
  expect(release).toHaveBeenCalledTimes(2)
  render(<CameraTools {...props} />)
  fireEvent.change(screen.getByLabelText('Camera mode'), { target: { value: 'flight' } })
  expect(screen.getByRole('option', { name: 'Shot 3 · 6 s' })).toBeInTheDocument()
})
