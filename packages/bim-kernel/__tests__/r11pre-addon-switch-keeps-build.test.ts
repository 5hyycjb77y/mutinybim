/**
 * @jest-environment node
 *
 * R11-pre item 3: switching an outside add-on on records which reviewed build
 * (digest) and trust tier the model uses, and switching it off and on again
 * keeps them. Fails on round 11 wave 2: `set_model_addon` took id and version
 * only, so the digest and tier were stripped from the command and the model's
 * pin fell back to id + version.
 */
import { DEFAULT_SETTINGS, commandSchema, installModelSetupHost, modelSetupOf, planCommit, withUpgradePolicy, type ModelState } from "../src";
import { PACKS_OUTSIDE_PINS_FEATURE, definePack, type Pack } from "../src/packs";

const VT: Pack = definePack({ id: "vt", name: "Vertical transportation (test)", version: "1.0.0", kernel: "^1.5.0" }, []);
const BUILD = `sha256:${"ab".repeat(32)}`;

type Policy = (feature: string) => boolean;
const ALL: Policy = () => true;
const OLDER_SERVER: Policy = (f) => f !== PACKS_OUTSIDE_PINS_FEATURE;

const actor = { id: "avery", name: "Avery", kind: "human" as const };
let seq = 0;
let uninstall: () => void = () => undefined;

beforeAll(() => {
  uninstall = installModelSetupHost(() => [VT]);
});
afterAll(() => uninstall());

function commit(head: ModelState, command: unknown, policy: Policy = ALL): ModelState {
  seq += 1;
  const parsed = commandSchema.parse(command);
  const d = withUpgradePolicy(policy, () => planCommit(head, [], { idempotencyKey: `r11pre-build-${seq}`, baseRevision: head.revision, actor, command: parsed }, () => "2026-11-03T00:00:00.000Z", []));
  if (!d.ok) throw new Error(d.error.message);
  return d.model;
}

function attempt(head: ModelState, command: unknown, policy: Policy = ALL): string | null {
  try {
    commit(head, command, policy);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function model(modelId: string): ModelState {
  const empty: ModelState = { modelId, revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  return commit(empty, { type: "create_level", levelId: "lvl-1", name: "L1", elevationMm: 0 });
}

describe("r11pre add-on switch keeps the build", () => {
  it("records the build and tier, and keeps them through off and on", () => {
    const on = commit(model("r11pre-build"), { type: "set_model_addon", packId: "vt", version: "1.0.0", on: true, digest: BUILD, tier: "data" });
    expect(modelSetupOf(on).pins).toEqual([{ id: "vt", version: "1.0.0", digest: BUILD, tier: "data" }]);

    const off = commit(on, { type: "set_model_addon", packId: "vt", version: "1.0.0", on: false });
    expect(modelSetupOf(off).pins).toEqual([]);

    const back = commit(off, { type: "set_model_addon", packId: "vt", version: "1.0.0", on: true });
    expect(modelSetupOf(back).pins).toEqual([{ id: "vt", version: "1.0.0", digest: BUILD, tier: "data" }]);
  });

  it("refuses a build without a tier, and a build an older model server can't store", () => {
    const start = model("r11pre-build-refused");
    expect(attempt(start, { type: "set_model_addon", packId: "vt", version: "1.0.0", on: true, digest: BUILD })).toBe("An outside add-on's switch names both the build it was reviewed as and its trust tier, or neither");
    expect(attempt(start, { type: "set_model_addon", packId: "vt", version: "1.0.0", on: true, digest: BUILD, tier: "data" }, OLDER_SERVER)).toMatch(/older version that doesn't store which build of an outside add-on/);
  });
});
