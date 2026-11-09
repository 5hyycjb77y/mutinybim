/**
 * @jest-environment node
 *
 * The model server binds each served model to the add-ons it pins (5c), so
 * one firm's pack never reaches another firm's model in the same process.
 */
import { DEFAULT_SETTINGS } from "@permitzip/bim-kernel";
import { activePackSet, definePack, unbindModelPacks, withModelPacks } from "@permitzip/bim-kernel/packs";
import { CLASS_POINT } from "@permitzip/bim-kernel/registry";
import { INSTALLED_PACKS, bindServedModelPacks } from "../packs";

const zz = definePack({ id: "zz", name: "Test add-on", version: "1.0.0", kernel: "^1.0.0" }, []);

afterEach(() => {
  unbindModelPacks("m-pins");
  unbindModelPacks("m-plain");
});

it("ships Civil (round 8, Preview); a model that doesn't switch it on is served without it, with Structural first-party (round 14)", () => {
  expect(INSTALLED_PACKS.map((p) => p.manifest.id)).toEqual(["civil"]);
  bindServedModelPacks("m-plain", DEFAULT_SETTINGS);
  expect(withModelPacks("m-plain", () => [activePackSet().has("civil"), activePackSet().packItems(CLASS_POINT).some((c) => c.id.startsWith("civil.")), activePackSet().packItems(CLASS_POINT).some((c) => c.id === "struct.beam_steel")])).toEqual([false, false, true]);
});

it("binds the pinned add-ons the server has and reports the rest", () => {
  const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  bindServedModelPacks("m-pins", { ...DEFAULT_SETTINGS, packs: [{ id: "zz", version: "1.0.0" }, { id: "civil", version: "0.1.0" }, { id: "struct", version: "0.1.0" }] }, [zz]);
  bindServedModelPacks("m-plain", DEFAULT_SETTINGS, [zz]);
  expect(withModelPacks("m-pins", () => activePackSet().pins())).toEqual([{ id: "zz", version: "1.0.0" }]);
  expect(withModelPacks("m-plain", () => activePackSet().pins())).toEqual([]);
  // Structural's stored pin is first-party now, so only Civil is reported.
  expect(spy).toHaveBeenCalledWith(expect.stringContaining("add-ons this server doesn't have"), { modelId: "m-pins", missing: [{ id: "civil", version: "0.1.0" }] });
});
