/**
 * @jest-environment node
 *
 * Verifies `electrical.insertDisconnect` in `@permitzip/bim-script`:
 * - Places a local disconnect switch within sight of remote HVAC equipment (NEC 440.14)
 * - Re-routes power inline (`HP-1 -> SD-RTU-1 -> RTU-1`) while preserving original breaker positions
 * - Discoverable through `searchReference("disconnect")`
 */
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { SERVER_FEATURES } from "@permitzip/bim-sync";
import {
  DEFAULT_SETTINGS,
  asRevision,
  elementsOfKind,
  executeCommand,
  withUpgradePolicy,
  type ModelState,
} from "@permitzip/bim-kernel";
import {
  defineScript,
  electrical,
  equipment,
  runScript,
  searchReference,
  sliceModel,
  units,
} from "@permitzip/bim-script";

installFirstPartyAddOns();

const features = new Set<string>(SERVER_FEATURES);
const runWithFeatures = <T>(fn: () => T): T => withUpgradePolicy((f) => features.has(f), fn);

function emptyModel(id: string): ModelState {
  return { modelId: id, revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS };
}

describe("electrical.insertDisconnect", () => {
  it("is discoverable via bim_script_reference and re-routes panel -> disconnect -> equipment preserving breaker positions", async () => {
    const hits = searchReference("disconnect");
    expect(hits.some((h) => h.kind === "function" && h.name === "electrical.insertDisconnect")).toBe(true);

    let model = emptyModel("insert-disc-test");
    const r0 = runWithFeatures(() => executeCommand(model, { type: "create_level", levelId: "l1", name: "Level 1", elevationMm: 0 }));
    if (!r0.ok) throw new Error(r0.error.message);
    model = r0.model;
    const r1 = runWithFeatures(() => executeCommand(model, { type: "create_level", levelId: "roof", name: "Roof", elevationMm: 4000 }));
    if (!r1.ok) throw new Error(r1.error.message);
    model = r1.model;

    const script = defineScript({
      kind: "layout",
      reads: { levels: true, kinds: ["part", "part_type", "service_link"] },
      parameters: {},
      run(ctx) {
        const hp = equipment.place(ctx, {
          level: "Level 1",
          type: "builtin:panelboard-225-480@1",
          at: { x: units.ft(2), y: units.ft(2) },
          mark: "HP-1",
        });
        const rtu = equipment.place(ctx, {
          level: "Roof",
          type: "builtin:rtu-5-ton@1",
          at: { x: units.ft(40), y: units.ft(10) },
          mark: "RTU-1",
        });
        ctx.edit({
          type: "create_service_link",
          linkId: "ckt-hp-rtu",
          sourceId: hp.id,
          positions: [1, 3, 5],
          members: [{ elementId: rtu.id }],
          description: "RTU-1",
          electrical: { ratingA: 40 },
        });
        const inserted = electrical.insertDisconnect(ctx, rtu, { mark: "SD-RTU-1" });
        ctx.label(`Inserted ${inserted.mark}`);
      },
    });

    const out = await runWithFeatures(() =>
      runScript(script, {
        slice: sliceModel(model, script.manifest.reads, [], SERVER_FEATURES),
        values: {},
        scriptHash: "sha256:insert-disconnect-test",
      }),
    );
    expect(out.kind).toBe("edits");
    if (out.kind !== "edits") return;

    for (const batch of out.batches) {
      for (const cmd of batch.commands) {
        const res = runWithFeatures(() => executeCommand(model, cmd));
        if (!res.ok) throw new Error(`Command ${cmd.type} failed: ${res.error.message}`);
        model = res.model;
      }
    }

    const parts = elementsOfKind(model.elements, "part");
    const disc = parts.find((p) => p.mark === "SD-RTU-1");
    const rtu = parts.find((p) => p.mark === "RTU-1");
    const hp = parts.find((p) => p.mark === "HP-1");
    expect(disc).toBeDefined();
    expect(rtu).toBeDefined();
    expect(hp).toBeDefined();
    expect(disc!.levelId).toBe("roof");

    const links = elementsOfKind(model.elements, "service_link");
    const upstream = links.find((l) => l.id === "ckt-hp-rtu");
    expect(upstream?.source.elementId).toBe(hp!.id);
    expect(upstream?.source.positions).toEqual([1, 3, 5]);
    expect(upstream?.members.map((m) => m.elementId)).toEqual([disc!.id]);

    const downstream = links.find((l) => l.source.elementId === disc!.id);
    expect(downstream).toBeDefined();
    expect(downstream?.members.map((m) => m.elementId)).toEqual([rtu!.id]);
    expect(downstream?.source.positions).toEqual([]);
  });
});
