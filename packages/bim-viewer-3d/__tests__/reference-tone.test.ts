/**
 * @jest-environment node
 *
 * Linked model tone in the 3D canvas: the view's display becomes one
 * Fragments material override, it survives selecting a linked element, and
 * our own elements win picks over a receded linked model.
 */
import * as THREE from "three";
import { referencePresetDisplay, resolveReferenceDisplay } from "@permitzip/bim-kernel";
import { NORMAL_REFERENCE_TONE, PICK_HIGHLIGHT_ID, referenceMayWinPick, referenceTone, sameReferenceTone, toneMaterial } from "../src/reference-tone";
import { ModelViewer3D } from "../src/viewer";

const tone3d = (preset: Parameters<typeof referencePresetDisplay>[0], discipline: "architecture" | "mep" = "architecture") => referenceTone(resolveReferenceDisplay(referencePresetDisplay(preset), "3d", discipline));

describe("reference tone from the view's display", () => {
  it("halftone architecture is grey and 30% see-through, still writing depth", () => {
    expect(tone3d("halftone").base).toEqual({ halftone: true, opacity: expect.closeTo(0.7), depthWrite: true });
    expect(tone3d("halftone").receded).toBe(true);
  });

  it("normal leaves the file's materials alone and does not recede", () => {
    expect(tone3d("normal")).toEqual(NORMAL_REFERENCE_TONE);
  });

  it("an underlay never writes depth, so it cannot hide our ducts", () => {
    const base = tone3d("underlay").base;
    expect(base?.depthWrite).toBe(false);
    expect(base?.opacity).toBeLessThanOrEqual(0.35);
  });

  it("a see-through MEP model that is not halftone keeps its colours", () => {
    const t = referenceTone(resolveReferenceDisplay({ visible: true, halftone: false, transparencyPct: 50 }, "3d", "mep"));
    expect(t.base).toEqual({ halftone: false, opacity: expect.closeTo(0.5), depthWrite: true });
    expect(t.receded).toBe(true);
  });

  it("category exceptions: hidden doors, walls back in their own opaque colours over a toned model", () => {
    const t = referenceTone(resolveReferenceDisplay({ visible: true, halftone: true, categories: { IFCDOOR: { visible: false }, IFCWALL: { halftone: false } } }, "3d", "architecture"));
    expect(t.overrides).toEqual([
      { category: "IFCDOOR", visible: false, overlay: "halftone" },
      { category: "IFCWALL", visible: true, overlay: "original" },
    ]);
  });

  it("toning a material greys and fades it; clearing puts the file's look back exactly", () => {
    const m = new THREE.MeshLambertMaterial({ color: 0x8b2500 });
    toneMaterial(m, { halftone: true, opacity: 0.4, depthWrite: false });
    expect(m.opacity).toBeCloseTo(0.4);
    expect(m.transparent).toBe(true);
    expect(m.depthWrite).toBe(false);
    expect(m.color.getHex()).not.toBe(0x8b2500);
    toneMaterial(m, { halftone: true, opacity: 0.4, depthWrite: false });
    expect(m.opacity).toBeCloseTo(0.4);
    toneMaterial(m, null);
    expect({ hex: m.color.getHex(), opacity: m.opacity, transparent: m.transparent, depthWrite: m.depthWrite }).toEqual({ hex: 0x8b2500, opacity: 1, transparent: false, depthWrite: true });
  });

  it("the selection highlight is never faded", () => {
    const pick = new THREE.MeshLambertMaterial({ color: 0xff0000 });
    pick.userData.customId = PICK_HIGHLIGHT_ID;
    toneMaterial(pick, { halftone: true, opacity: 0.3, depthWrite: true });
    expect(pick.opacity).toBe(1);
  });

  it("our element wins a pick over a receded linked model, never over a normal one", () => {
    expect(referenceMayWinPick(tone3d("halftone"), true)).toBe(false);
    expect(referenceMayWinPick(tone3d("halftone"), false)).toBe(true);
    expect(referenceMayWinPick(NORMAL_REFERENCE_TONE, true)).toBe(true);
    expect(sameReferenceTone(tone3d("halftone"), tone3d("halftone"))).toBe(true);
    expect(sameReferenceTone(tone3d("halftone"), tone3d("transparent"))).toBe(false);
  });
});

type Call = readonly [string, ...unknown[]];

/** A Fragments model that records what the viewer asks of it. */
function fakeModel(categoryIds: Record<string, number[]> = {}) {
  const calls: Call[] = [];
  const object = new THREE.Group();
  const base = new THREE.MeshLambertMaterial({ color: 0x8b2500 });
  object.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [base, base]));
  const model = {
    object,
    resetHighlight: async (ids?: number[]) => void calls.push(["resetHighlight", ids]),
    highlight: async (ids: number[] | undefined, m: { opacity: number; color: THREE.Color; customId?: string }) => void calls.push(["highlight", ids, { opacity: m.opacity, color: m.color.getHex(), customId: m.customId }]),
    setOpacity: async (ids: number[] | undefined, o: number) => void calls.push(["setOpacity", ids, o]),
    setVisible: async (ids: number[] | undefined, v: boolean) => void calls.push(["setVisible", ids, v]),
    resetVisible: async () => void calls.push(["resetVisible"]),
    getItemsOfCategories: async (res: RegExp[]) => {
      const out: Record<string, number[]> = {};
      for (const [cat, ids] of Object.entries(categoryIds)) if (res.some((r) => r.test(cat))) out[cat] = ids;
      return out;
    },
    raycast: async () => ({ localId: 7, distance: 1, point: new THREE.Vector3() }),
  };
  return { model, calls, base };
}

interface ViewerInternals {
  setReferenceTone: ModelViewer3D["setReferenceTone"];
  select: ModelViewer3D["select"];
  pick: ModelViewer3D["pick"];
}

/** The real viewer methods over fake Fragments models (the WebGL renderer is not needed for tone, selection or pick order). */
function viewerWith(entries: Record<string, ReturnType<typeof fakeModel>["model"]>): ViewerInternals {
  const viewer: object = Object.create(ModelViewer3D.prototype);
  const references = new Map(Object.entries(entries).map(([id, model]) => [id, { model, info: { id, label: id, discipline: "architecture", loadMs: 0, levels: [] }, hiddenIds: [], toneHiddenIds: [], categoryIds: new Map() }]));
  Object.assign(viewer, {
    references,
    referenceTones: new Map(),
    sessionHiddenReferences: new Set(),
    markers: new Map(),
    markerMaterials: null,
    nativeEntries: [],
    selected: null,
    isolatedLevel: null,
    mode: "3d",
    referencesBoxCache: null,
    fragments: { update: async () => undefined },
    palette: { pickHighlight: new THREE.Color(0xff0000) },
    refreshOrbitFallback: async () => undefined,
    camera: () => new THREE.PerspectiveCamera(),
    renderer: { domElement: {} },
    pickNative: () => ({ source: "native", elementId: "duct-1", point: new THREE.Vector3(), distance: 5 }),
    pickMarker: () => null,
  });
  return viewer as ViewerInternals;
}

describe("the viewer applies the tone to the linked model", () => {
  it("halftone greys and fades the model's own materials; normal puts them back", async () => {
    const { model, base } = fakeModel();
    const viewer = viewerWith({ arch: model });
    await viewer.setReferenceTone("arch", tone3d("halftone"));
    expect(base.opacity).toBeCloseTo(0.7);
    expect(base.transparent).toBe(true);
    expect(base.color.getHex()).not.toBe(0x8b2500);
    await viewer.setReferenceTone("arch", NORMAL_REFERENCE_TONE);
    expect({ hex: base.color.getHex(), opacity: base.opacity, transparent: base.transparent }).toEqual({ hex: 0x8b2500, opacity: 1, transparent: false });
  });

  it("selecting a linked element highlights it opaque on top, and the rest stays halftone", async () => {
    const { model, calls, base } = fakeModel();
    const viewer = viewerWith({ arch: model });
    await viewer.setReferenceTone("arch", tone3d("halftone"));
    calls.length = 0;
    await viewer.select({ source: "reference", referenceId: "arch", localId: 7, point: new THREE.Vector3() });
    expect(calls).toEqual([["resetHighlight", undefined], ["highlight", [7], { opacity: 1, color: 0xff0000, customId: PICK_HIGHLIGHT_ID }]]);
    expect(base.opacity).toBeCloseTo(0.7);
  });

  it("a hidden category is switched off and stays off", async () => {
    const { model, calls } = fakeModel({ IFCDOOR: [3, 4] });
    const viewer = viewerWith({ arch: model });
    await viewer.setReferenceTone("arch", referenceTone(resolveReferenceDisplay({ visible: true, halftone: true, categories: { IFCDOOR: { visible: false } } }, "3d", "architecture")));
    expect(calls).toContainEqual(["setVisible", [3, 4], false]);
  });

  it("hidden hides the model object", async () => {
    const { model } = fakeModel();
    const viewer = viewerWith({ arch: model });
    await viewer.setReferenceTone("arch", tone3d("hidden"));
    expect(model.object.visible).toBe(false);
    await viewer.setReferenceTone("arch", tone3d("halftone"));
    expect(model.object.visible).toBe(true);
  });

  it("our duct behind a halftone wall is the pick; in normal display the nearer wall wins", async () => {
    const { model } = fakeModel();
    const viewer = viewerWith({ arch: model });
    await viewer.setReferenceTone("arch", tone3d("halftone"));
    expect(await viewer.pick(10, 10)).toMatchObject({ source: "native", elementId: "duct-1" });
    await viewer.setReferenceTone("arch", NORMAL_REFERENCE_TONE);
    expect(await viewer.pick(10, 10)).toMatchObject({ source: "reference", referenceId: "arch", localId: 7 });
  });
});
