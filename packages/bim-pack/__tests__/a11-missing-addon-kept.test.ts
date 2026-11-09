/**
 * @jest-environment node
 *
 * Round 11 A11 (D5; tolerant readers, round 6): a model that pins an outside
 * add-on this host doesn't have opens with every record untouched and says
 * "This model needs add-on X v1.2". The stored pin keeps its digest, tier and
 * any newer field when read and written back. Fails on round 10's code: the
 * settings reader dropped everything but id and version, and the missing pin
 * had no words.
 */
import { canonicalJson, type ModelState } from "@permitzip/bim-kernel";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { readStoredPackPin, readStoredPackPins, writePackPin } from "@permitzip/bim-kernel/packs";
import { openWithOutsidePacks } from "../src/install";

const digest = `sha256:${"a".repeat(64)}` as const;

describe("a11 missing add-on kept", () => {
  it("opens without it, records untouched, with the words", () => {
    const m = createFullBimModel({ ...FULL_BIM_TIERS.XS, modelId: "a11-missing" });
    const pinned: ModelState = { ...m, settings: { ...m.settings, packs: [{ id: "acme", version: "1.2.0", digest, tier: "data" }] } };
    const before = canonicalJson(pinned.elements);
    const opened = openWithOutsidePacks(pinned, [], []);
    expect(opened.set.packs).toEqual([]);
    expect(opened.needs).toEqual(["This model needs add-on acme 1.2.0, which isn't installed here. Its records on this model are kept unchanged."]);
    expect(canonicalJson(pinned.elements)).toBe(before);
    expect(pinned.settings.packs).toEqual([{ id: "acme", version: "1.2.0", digest, tier: "data" }]);
  });

  it("a stored pin keeps its digest, tier and newer fields through a read and a write", () => {
    const stored = { id: "acme", version: "1.2.0", digest, tier: "data", catalogue: "https://packages.example.com" };
    const read = readStoredPackPin(stored);
    if (!read.ok) throw new Error(read.reason);
    expect(read.pin).toEqual({ id: "acme", version: "1.2.0", digest, tier: "data", extensions: { catalogue: "https://packages.example.com" } });
    expect(writePackPin(read.pin)).toEqual(stored);
  });

  it("a pin from before digests, an unknown tier and a foreign digest read without loss", () => {
    expect(readStoredPackPins([{ id: "struct", version: "0.1.0" }])).toEqual([{ id: "struct", version: "0.1.0" }]);
    const odd = readStoredPackPin({ id: "acme", version: "2.0.0", digest: "blake3:abcdef0123456789", tier: "isolate" });
    if (!odd.ok) throw new Error(odd.reason);
    expect(odd.pin).toEqual({ id: "acme", version: "2.0.0", tier: "isolate", extensions: { digest: "blake3:abcdef0123456789" } });
    expect(odd.notes.length).toBe(2);
    expect(readStoredPackPins([{ id: "" }, { id: "ok", version: "1.0.0" }])).toEqual([{ id: "ok", version: "1.0.0" }]);
  });
});
