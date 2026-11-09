/**
 * @jest-environment jsdom
 */
import * as THREE from "three";
import CameraControls from "camera-controls";
import { PAN_RELEASE_GRACE_MS, PanButtonGuard, panButtonOf } from "../src/pan-buttons";
import { makeCameraControls, type PointZoomControls } from "../src/navigation";

function mouse(type: string, init: { button?: number; buttons?: number; clientX?: number; clientY?: number; pointerType?: string } = {}): MouseEvent {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, button: init.button ?? 0, buttons: init.buttons ?? 0, clientX: init.clientX ?? 0, clientY: init.clientY ?? 0 });
  Object.defineProperty(e, "pointerId", { value: 1 });
  Object.defineProperty(e, "pointerType", { value: init.pointerType ?? "mouse" });
  return e;
}

describe("panButtonOf: the same pan buttons in every view", () => {
  it("the middle press pans", () => {
    expect(panButtonOf({ button: 1, buttons: 4, pointerType: "mouse" })).toBe("middle");
  });

  it("left + right held together (buttons 3) pans, whichever came first", () => {
    expect(panButtonOf({ button: 2, buttons: 3, pointerType: "mouse" })).toBe("chord");
    expect(panButtonOf({ button: 0, buttons: 3, pointerType: "mouse" })).toBe("chord");
    expect(panButtonOf({ button: -1, buttons: 3, pointerType: "mouse" })).toBe("chord");
  });

  it("a plain right-click and a plain left press are left to the surface (menu, select, move)", () => {
    expect(panButtonOf({ button: 2, buttons: 2, pointerType: "mouse" })).toBeNull();
    expect(panButtonOf({ button: 0, buttons: 1, pointerType: "mouse" })).toBeNull();
    expect(panButtonOf({ button: -1, buttons: 1, pointerType: "mouse" })).toBeNull();
  });

  it("a pen tip + barrel button or a touch never chords", () => {
    expect(panButtonOf({ button: 2, buttons: 3, pointerType: "pen" })).toBeNull();
    expect(panButtonOf({ button: 0, buttons: 3, pointerType: "touch" })).toBeNull();
  });
});

describe("PanButtonGuard", () => {
  function setup() {
    const el = document.createElement("div");
    document.body.appendChild(el);
    let now = 1000;
    const guard = new PanButtonGuard(el, () => now);
    return {
      el,
      guard,
      advance: (ms: number) => {
        now += ms;
      },
      dispose: () => {
        guard.dispose();
        el.remove();
      },
    };
  }

  it("a plain right-click still opens the menu", () => {
    const { el, dispose } = setup();
    const menu = mouse("contextmenu", { button: 2, buttons: 2 });
    el.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(false);
    dispose();
  });

  it("the right press of a chord whose left came first opens no menu (Mac opens it on the press)", () => {
    const { el, dispose } = setup();
    const menu = mouse("contextmenu", { button: 2, buttons: 3 });
    el.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    dispose();
  });

  it("during a pan and just after it, the menu and the release's click are swallowed; then they work again", () => {
    const { el, guard, advance, dispose } = setup();
    guard.panStarted();
    const during = mouse("contextmenu", { button: 2, buttons: 2 });
    el.dispatchEvent(during);
    expect(during.defaultPrevented).toBe(true);
    window.dispatchEvent(mouse("pointerup", { button: 2, buttons: 0 }));
    // Windows sends the menu after the release.
    const after = mouse("contextmenu", { button: 2 });
    el.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(true);
    const click = mouse("click");
    const onClick = jest.fn();
    el.addEventListener("click", onClick);
    el.dispatchEvent(click);
    expect(onClick).not.toHaveBeenCalled();
    advance(PAN_RELEASE_GRACE_MS + 1);
    const later = mouse("contextmenu", { button: 2, buttons: 2 });
    el.dispatchEvent(later);
    expect(later.defaultPrevented).toBe(false);
    dispose();
  });

  it("a fresh plain press right after a pan gets its own click", () => {
    const { el, guard, dispose } = setup();
    guard.panStarted();
    window.dispatchEvent(mouse("pointerup", { buttons: 0 }));
    el.dispatchEvent(mouse("pointerdown", { button: 0, buttons: 1 }));
    const onClick = jest.fn();
    el.addEventListener("click", onClick);
    el.dispatchEvent(mouse("click"));
    expect(onClick).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("a middle click never pastes, opens a tab or autoscrolls", () => {
    const { el, dispose } = setup();
    const aux = mouse("auxclick", { button: 1 });
    const down = mouse("mousedown", { button: 1, buttons: 4 });
    el.dispatchEvent(down);
    el.dispatchEvent(aux);
    expect(down.defaultPrevented).toBe(true);
    expect(aux.defaultPrevented).toBe(true);
    dispose();
  });
});

describe("3D and plan cameras: the chord is a pure pan", () => {
  function rig() {
    const el = document.createElement("div");
    el.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, toJSON: () => ({}) });
    document.body.appendChild(el);
    const camera = new THREE.PerspectiveCamera(45, 4 / 3, 0.1, 5000);
    const controls = makeCameraControls(camera, el);
    void controls.setLookAt(40, 30, 40, 0, 0, 0, false);
    settle(controls, camera);
    return { el, camera, controls };
  }

  function settle(controls: PointZoomControls, camera: THREE.Camera) {
    for (let i = 0; i < 300; i++) controls.update(1 / 60);
    camera.updateMatrixWorld();
  }

  it("left pressed, then right joins: the view pans and does not turn; left orbits again afterwards", () => {
    const { el, camera, controls } = rig();
    const turn = camera.quaternion.clone();
    const target = controls.getTarget(new THREE.Vector3());
    el.dispatchEvent(mouse("pointerdown", { button: 0, buttons: 1, clientX: 400, clientY: 300 }));
    el.dispatchEvent(mouse("pointermove", { button: 2, buttons: 3, clientX: 400, clientY: 300 }));
    expect(controls.chordPanning).toBe(true);
    for (let i = 1; i <= 10; i++) {
      controls.update(1 / 60);
      el.dispatchEvent(mouse("pointermove", { button: -1, buttons: 3, clientX: 400 + i * 20, clientY: 300 }));
    }
    el.dispatchEvent(mouse("pointerup", { button: 0, buttons: 0, clientX: 600, clientY: 300 }));
    settle(controls, camera);
    expect(camera.quaternion.angleTo(turn)).toBeLessThan(1e-6);
    expect(controls.getTarget(new THREE.Vector3()).distanceTo(target)).toBeGreaterThan(0.5);
    expect(controls.chordPanning).toBe(false);
    expect(controls.mouseButtons.left).toBe(CameraControls.ACTION.ROTATE);
    el.remove();
  });
});
