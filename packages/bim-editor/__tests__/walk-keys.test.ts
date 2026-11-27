import { walkKeyAction, WALKING_HINT } from '../src/editor/walk-keys'

function press(code: string, key = '', modifiers: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) {
  return { code, key, metaKey: false, ctrlKey: false, altKey: false, ...modifiers }
}

const WALK_LETTERS: [string, string][] = [
  ['KeyW', 'w'],
  ['KeyA', 'a'],
  ['KeyS', 's'],
  ['KeyD', 'd'],
  ['KeyE', 'e'],
  ['KeyQ', 'q'],
]

describe('the walk keys on the Building Model surface', () => {
  it('not walking: W starts a walk; the other letters stay the tool shortcuts (D routes, S splits)', () => {
    expect(walkKeyAction(press('KeyW', 'w'), false)).toBe('start')
    for (const [code, key] of WALK_LETTERS.slice(1)) expect(walkKeyAction(press(code, key), false)).toBeNull()
    expect(walkKeyAction(press('Escape', 'Escape'), false)).toBeNull()
  })

  it('walking: W A S D, E and Q all go to the camera', () => {
    for (const [code, key] of WALK_LETTERS) expect(walkKeyAction(press(code, key), true)).toBe('move')
    // Caps Lock or Shift change the character, not the key.
    expect(walkKeyAction(press('KeyW', 'W'), true)).toBe('move')
  })

  it('walking: Esc leaves the walk; every other key carries on to the tools (F fits, 5 switches projection, Del deletes)', () => {
    expect(walkKeyAction(press('Escape', 'Escape'), true)).toBe('stop')
    const others: [string, string][] = [['KeyP', 'p'], ['KeyF', 'f'], ['Digit5', '5'], ['Delete', 'Delete'], ['Space', ' '], ['KeyR', 'r'], ['ShiftLeft', 'Shift']]
    for (const [code, key] of others) expect(walkKeyAction(press(code, key), true)).toBeNull()
  })

  it('with Ctrl, Cmd or Alt held, a walk key is never for the camera (Ctrl+S saves, Ctrl+W closes the tab, Alt+Esc belongs to the system)', () => {
    for (const walking of [true, false]) {
      for (const [code, key] of WALK_LETTERS) {
        expect(walkKeyAction(press(code, key, { ctrlKey: true }), walking)).toBeNull()
        expect(walkKeyAction(press(code, key, { metaKey: true }), walking)).toBeNull()
        expect(walkKeyAction(press(code, key, { altKey: true }), walking)).toBeNull()
      }
      expect(walkKeyAction(press('Escape', 'Escape', { altKey: true }), walking)).toBeNull()
    }
  })

  it('the hint names the keys, the speed wheel and the way out', () => {
    expect(WALKING_HINT).toContain('W A S D')
    expect(WALKING_HINT).toContain('E and Q')
    expect(WALKING_HINT).toContain('right-button + scroll')
    expect(WALKING_HINT).toContain('Esc stops')
  })
})
