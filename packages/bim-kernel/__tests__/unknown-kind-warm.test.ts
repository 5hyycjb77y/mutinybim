/**
 * @jest-environment node
 *
 * Rolling deploys: a newer browser or agent can write an element kind that the
 * running model server's kernel does not know yet (Oct 27: `space`, `zone` and
 * `drawing_underlay` crashed an older server in `NetworkIndex` while it warmed
 * the model, so the whole model would not open). A kind this build doesn't know
 * has no connectors as far as this build is concerned; the model still opens and
 * the network over the elements it does know is unchanged.
 */
import { DEFAULT_SETTINGS, executeCommand, warmModel, type BimElement, type Command, type ModelState } from "../src";
import { networkOf } from "../src/network";

function build(commands: readonly Command[]): ModelState {
  let m: ModelState = { modelId: "uk", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  for (const command of commands) {
    const r = executeCommand(m, command);
    if (!r.ok) throw new Error(`${command.type}: ${r.error.message}`);
    m = r.model;
  }
  return m;
}

/** An element written by a later build: a kind this kernel has never heard of. */
function fromLaterBuild(id: string): BimElement {
  const foreign: unknown = { id, kind: "kind_from_a_later_build", version: 1, authoredRev: {}, partition: { discipline: "mechanical", level: "project", zone: "documents" } };
  return foreign as BimElement;
}

describe("a model holding a kind this build doesn't know", () => {
  const base = build([{ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 }]);
  const withForeign: ModelState = { ...base, elements: { ...base.elements, later1: fromLaterBuild("later1") } };

  it("still warms (opens) instead of throwing", () => {
    expect(() => warmModel(withForeign)).not.toThrow();
  });

  it("treats the unknown element as having no connectors", () => {
    const net = networkOf(withForeign);
    expect(net.children("later1")).toEqual([]);
    expect(net.connectionsOf("later1")).toEqual([]);
  });
});
