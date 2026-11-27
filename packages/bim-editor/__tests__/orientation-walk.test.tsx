import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { OrientationControls } from '../src/editor/orientation/OrientationControls'
import { TooltipProvider } from '../src/ui/tooltip'

// jsdom omits PointerEvent, causing fireEvent.pointer* to drop button state.
if (typeof globalThis.PointerEvent === 'undefined') {
  ;(globalThis as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = MouseEvent
}
// Radix captures the pointer and watches sizes; jsdom has neither.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.hasPointerCapture = () => false
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

/** The viewer surface OrientationControls reads, with the walk as its own little state that tells its listeners. */
function viewerWith() {
  const listeners = new Set<(walking: boolean) => void>()
  let walking = false
  const tell = () => {
    for (const listener of listeners) listener(walking)
  }
  const speedListeners = new Set<(scale: number) => void>()
  let speedScale = 1
  const tellSpeed = () => {
    for (const listener of speedListeners) listener(speedScale)
  }
  return {
    orientation: () => ({ azimuth: 0.6, polar: 1.05 }),
    onCameraChange: () => () => {},
    orientTo: async () => {},
    orbitBy: () => {},
    frame: async () => {},
    camera3dState: () => ({ eye: { x: 12000, y: 9000, z: 12000 }, target: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 }, fovDeg: 45, orthoHeightMm: 5000 }),
    setFovDeg: jest.fn(),
    walking: jest.fn(() => walking),
    setWalk: jest.fn((on: boolean) => {
      if (on === walking) return
      walking = on
      tell()
    }),
    onWalkChange: (listener: (walking: boolean) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    walkSpeed: jest.fn(() => speedScale),
    setWalkSpeed: jest.fn((scale: number) => {
      if (scale === speedScale) return
      speedScale = scale
      tellSpeed()
    }),
    onWalkSpeedChange: (listener: (scale: number) => void) => {
      speedListeners.add(listener)
      return () => speedListeners.delete(listener)
    },
  }
}

function renderWith(viewer: ReturnType<typeof viewerWith>) {
  render(
    <TooltipProvider>
      <OrientationControls
        viewer={viewer as unknown as Parameters<typeof OrientationControls>[0]['viewer']}
        rightInset={0}
        canCreateViews
        blockedReason=""
        onCreatePlan={() => {}}
        onCreateElevation={() => {}}
        trueNorthDeg={0}
        projection="perspective"
        onProjectionChange={() => {}}
      />
    </TooltipProvider>,
  )
  return viewer
}

function renderControls() {
  return renderWith(viewerWith())
}

const walkButton = () => screen.getByRole('button', { name: 'Walk the model' })

describe('the Walk switch on the view toolbar', () => {
  it('is there beside Home, not pressed', () => {
    renderControls()
    expect(walkButton()).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('orientation-walk')).toBe(walkButton())
    expect(screen.getByTestId('orientation-controls')).toHaveAttribute('data-walking', 'false')
    // Home comes first, then Walk: the same order on screen.
    const home = screen.getByTestId('orientation-home')
    expect(home.compareDocumentPosition(walkButton()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('clicking it starts the walk, and the button shows it is on', () => {
    const viewer = renderControls()
    fireEvent.click(walkButton())
    expect(viewer.setWalk).toHaveBeenCalledTimes(1)
    expect(viewer.setWalk).toHaveBeenCalledWith(true)
    expect(walkButton()).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('orientation-controls')).toHaveAttribute('data-walking', 'true')
  })

  it('clicking it again stops the walk', () => {
    const viewer = renderControls()
    fireEvent.click(walkButton())
    fireEvent.click(walkButton())
    expect(viewer.setWalk).toHaveBeenLastCalledWith(false)
    expect(walkButton()).toHaveAttribute('aria-pressed', 'false')
  })

  it('follows a walk started and stopped elsewhere (W starts it, Esc stops it)', () => {
    const viewer = renderControls()
    act(() => viewer.setWalk(true))
    expect(walkButton()).toHaveAttribute('aria-pressed', 'true')
    act(() => viewer.setWalk(false))
    expect(walkButton()).toHaveAttribute('aria-pressed', 'false')
  })

  it('is pressed from the first frame when the view opens mid-walk', () => {
    const viewer = viewerWith()
    viewer.setWalk(true)
    render(
      <TooltipProvider>
        <OrientationControls
          viewer={viewer as unknown as Parameters<typeof OrientationControls>[0]['viewer']}
          rightInset={0}
          canCreateViews
          blockedReason=""
          onCreatePlan={() => {}}
          onCreateElevation={() => {}}
          trueNorthDeg={0}
          projection="perspective"
          onProjectionChange={() => {}}
        />
      </TooltipProvider>,
    )
    expect(walkButton()).toHaveAttribute('aria-pressed', 'true')
  })

  it('is disabled in orthographic projection', () => {
    const viewer = viewerWith()
    render(
      <TooltipProvider>
        <OrientationControls
          viewer={viewer as unknown as Parameters<typeof OrientationControls>[0]['viewer']}
          rightInset={0}
          canCreateViews
          blockedReason=""
          onCreatePlan={() => {}}
          onCreateElevation={() => {}}
          trueNorthDeg={0}
          projection="orthographic"
          onProjectionChange={() => {}}
        />
      </TooltipProvider>,
    )
    expect(walkButton()).toBeDisabled()
  })
})

describe('the walk speed slider under the Walk button', () => {
  const speedPanel = () => screen.getByTestId('orientation-walk-speed')
  const speedThumb = () => within(speedPanel()).getByRole('slider')

  it('shows only while walking, reading the pace the viewer holds (100% by default)', () => {
    renderControls()
    expect(screen.queryByTestId('orientation-walk-speed')).toBeNull()
    const preset = viewerWith()
    act(() => preset.setWalk(true))
    act(() => preset.setWalkSpeed(2.5))
    renderWith(preset)
    expect(speedPanel()).toHaveTextContent('Walk speed')
    expect(speedPanel()).toHaveTextContent('250%')
  })

  it('appears when the walk starts and goes when it stops', () => {
    const viewer = renderControls()
    expect(screen.queryByTestId('orientation-walk-speed')).toBeNull()
    act(() => viewer.setWalk(true))
    expect(speedPanel()).toHaveTextContent('100%')
    act(() => viewer.setWalk(false))
    expect(screen.queryByTestId('orientation-walk-speed')).toBeNull()
  })

  it('the arrow keys step the pace and tell the viewer (each step about 12%) without bubbling to window shortcuts', () => {
    const viewer = renderControls()
    act(() => viewer.setWalk(true))
    const windowKeys: string[] = []
    const onWindowKey = (e: KeyboardEvent) => windowKeys.push(e.key)
    window.addEventListener('keydown', onWindowKey)
    try {
      speedThumb().focus()
      fireEvent.keyDown(speedThumb(), { key: 'ArrowRight' })
      expect(viewer.setWalkSpeed).toHaveBeenLastCalledWith(Math.pow(10, 0.05))
      // The stub tells its listeners, so the readout followed.
      expect(speedPanel()).toHaveTextContent('112%')
      fireEvent.keyDown(speedThumb(), { key: 'ArrowLeft' })
      expect(viewer.setWalkSpeed).toHaveBeenLastCalledWith(1)
      expect(speedPanel()).toHaveTextContent('100%')
      expect(windowKeys).toEqual([])
    } finally {
      window.removeEventListener('keydown', onWindowKey)
    }
  })

  it('follows the wheel turning the pace elsewhere (right-button + scroll on the canvas)', () => {
    const viewer = renderControls()
    act(() => viewer.setWalk(true))
    act(() => viewer.setWalkSpeed(Math.pow(10, -0.2)))
    expect(speedPanel()).toHaveTextContent('63%')
  })
})
