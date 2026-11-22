import { CameraPlacement } from '../src/editor/views-sheets/view-camera-memory'

describe('camera placement gate', () => {
  it('a settle while a placement is still running is skipped, so a view does not remember where the camera was before it opened', () => {
    const placing = new CameraPlacement()
    placing.start()
    expect(placing.inFlight).toBe(true)
  })

  it('once the placement is done, settles are remembered again (including manual FOV slider commits)', () => {
    const placing = new CameraPlacement()
    const token = placing.start()
    placing.finish(token)
    expect(placing.inFlight).toBe(false)
  })

  it('a finish from a placement a newer one replaced does not unblock (a quick click from one view to the next, or an overlapping re-run for the same view)', () => {
    const placing = new CameraPlacement()
    const first = placing.start()
    const second = placing.start()
    placing.finish(first)
    // The first placement is still settling its way out; only the current one may clear the flag.
    expect(placing.inFlight).toBe(true)
    placing.finish(second)
    expect(placing.inFlight).toBe(false)
  })

  it('a newer placement finishing before an older one still keeps the gate closed until both finish', () => {
    const placing = new CameraPlacement()
    const first = placing.start()
    const second = placing.start()
    placing.finish(second)
    expect(placing.inFlight).toBe(true)
    placing.finish(first)
    expect(placing.inFlight).toBe(false)
  })

  it('finishing an unknown token changes nothing', () => {
    const placing = new CameraPlacement()
    placing.start()
    placing.finish(999)
    expect(placing.inFlight).toBe(true)
  })
})
