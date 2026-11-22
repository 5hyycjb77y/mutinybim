import { openWholeModel } from '../src/editor/open-whole-model'
import type { PlanCameraState } from '@permitzip/bim-viewer-3d'

const KEPT: PlanCameraState = { targetX: 1, targetZ: 2, halfHeight: 10, zoom: 2 }

/** A viewer that records the order it is asked to do things. */
function recordingViewer() {
  const calls: string[] = []
  const viewer = {
    setAuthoredLevels: () => { calls.push('authoredLevels') },
    setVerticalSection: async () => { calls.push('verticalSection') },
    setMode: (mode: string) => { calls.push(`setMode:${mode}`) },
    setPlanCrop: () => { calls.push('planCrop') },
    resetPlanCut: () => { calls.push('resetPlanCut') },
    isolateLevel: async (level: string | null) => { calls.push(`isolateLevel:${level ?? 'all'}`) },
    frame: async () => { calls.push('frame') },
    setPlanCamera: async () => { calls.push('planCamera') },
  }
  return { viewer, calls }
}

describe('opening the whole model', () => {
  it('enters the Top-down plan already at the kept camera, so no default framing shows first', async () => {
    const { viewer, calls } = recordingViewer()
    await openWholeModel(viewer, 'plan', 'all', { planCamera: KEPT })
    // The camera is placed before the level isolation takes its frames, and setPlanCamera
    // enters plan mode itself: nothing frames a default plan for a moment to snap away from.
    expect(calls.indexOf('planCamera')).toBeLessThan(calls.findIndex((c) => c.startsWith('isolateLevel')))
    expect(calls).not.toContain('setMode:plan')
    expect(calls).not.toContain('frame')
    // A saved plan's crop and cut still do not leak into "All levels".
    expect(calls).toContain('planCrop')
    expect(calls).toContain('resetPlanCut')
  })

  it('without a kept camera the plan frames everything once, as it opens', async () => {
    const { viewer, calls } = recordingViewer()
    await openWholeModel(viewer, 'plan', 'all', {})
    expect(calls).toContain('setMode:plan')
    expect(calls.indexOf('frame')).toBeGreaterThan(calls.findIndex((c) => c.startsWith('isolateLevel')))
  })

  it('the 3D model is untouched: mode switch, no plan camera, no frame', async () => {
    const { viewer, calls } = recordingViewer()
    await openWholeModel(viewer, '3d', 'all', { planCamera: KEPT })
    expect(calls).toContain('setMode:3d')
    expect(calls).not.toContain('planCamera')
    expect(calls).not.toContain('frame')
  })
})
