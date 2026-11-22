import { fireEvent, render, screen, within } from '@testing-library/react'
import { OrientationControls } from '../src/editor/orientation/OrientationControls'
import { TooltipProvider } from '../src/ui/tooltip'

// jsdom omits PointerEvent, causing fireEvent.pointer* to drop button state.
if (typeof globalThis.PointerEvent === 'undefined') {
  ;(globalThis as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = MouseEvent
}
// Radix menus and sliders capture the pointer and watch sizes; jsdom has neither.
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

/** The viewer surface OrientationControls reads: the camera's lens angle, and where it points. */
function viewerWith(fovDeg: number) {
  return {
    orientation: () => ({ azimuth: 0.6, polar: 1.05 }),
    onCameraChange: () => () => {},
    orientTo: async () => {},
    orbitBy: async () => {},
    frame: async () => {},
    camera3dState: () => ({ eye: { x: 12000, y: 9000, z: 12000 }, target: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 }, fovDeg, orthoHeightMm: 5000 }),
    setFovDeg: jest.fn(),
  }
}

function renderControls(fovDeg: number, projection: 'perspective' | 'orthographic' = 'perspective') {
  const viewer = viewerWith(fovDeg)
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
      projection={projection}
      onProjectionChange={() => {}}
      />
    </TooltipProvider>,
  )
  return viewer
}

function openMenu() {
  const trigger = screen.getByRole('button', { name: 'Orientation options' })
  fireEvent.pointerDown(trigger, { button: 0 })
  fireEvent.click(trigger)
}

/** The slider thumb carries role="slider" and its accessible name directly. */
function fovSlider() {
  return screen.getByRole('slider', { name: 'Field of view in degrees' })
}

describe('orientation menu: field of view', () => {
  it("shows the camera's lens angle under Projection, in the slider's 5..120 range", async () => {
    renderControls(40)
    openMenu()
    const row = await screen.findByTestId('orientation-fov')
    expect(row.textContent).toContain('Field of view')
    expect(row.textContent).toContain('40°')
    const slider = fovSlider()
    expect(slider.getAttribute('aria-valuemin')).toBe('5')
    expect(slider.getAttribute('aria-valuemax')).toBe('120')
    expect(slider.getAttribute('aria-valuenow')).toBe('40')
  })

  it('the arrow keys step the angle and settle camera memory, without closing the menu or bubbling to window nudge shortcuts', async () => {
    const viewer = renderControls(40)
    const windowKeys: string[] = []
    const onWindowKey = (e: KeyboardEvent) => windowKeys.push(e.key)
    window.addEventListener('keydown', onWindowKey)
    try {
      openMenu()
      await screen.findByTestId('orientation-fov')
      const slider = fovSlider()
      fireEvent.keyDown(slider, { key: 'ArrowRight' })
      fireEvent.keyDown(slider, { key: 'ArrowRight' })
      fireEvent.keyDown(slider, { key: 'PageUp' })
      expect(viewer.setFovDeg).toHaveBeenCalledWith(41, { settle: false })
      expect(viewer.setFovDeg).toHaveBeenCalledWith(41, { settle: true })
      expect(viewer.setFovDeg).toHaveBeenCalledWith(42, { settle: false })
      expect(viewer.setFovDeg).toHaveBeenCalledWith(42, { settle: true })
      // Slider adjustment keys must never reach the global window handler that nudges selected geometry.
      expect(windowKeys).toEqual([])
      // Dragging or stepping the slider must not close the menu behind the person's hand.
      expect(screen.getByTestId('orientation-fov')).toBeDefined()
      // Escape still bubbles to dismiss the menu cleanly.
      fireEvent.keyDown(slider, { key: 'Escape' })
      expect(windowKeys).toContain('Escape')
    } finally {
      window.removeEventListener('keydown', onWindowKey)
    }
  })

  it('grays the slider out in orthographic, where the lens angle does nothing', async () => {
    const viewer = renderControls(40, 'orthographic')
    openMenu()
    const row = await screen.findByTestId('orientation-fov')
    const slider = within(row).getByRole('slider', { name: 'Field of view in degrees' })
    expect(row.querySelector('[data-slot="slider"]')?.hasAttribute('data-disabled')).toBe(true)
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(viewer.setFovDeg).not.toHaveBeenCalled()
  })
})
