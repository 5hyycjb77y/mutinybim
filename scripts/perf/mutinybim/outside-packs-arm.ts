/**
 * The `outside` arm of `outside-packs.ts` (round 11 A11): one approved
 * 50-class data add-on, installed through the gate and pinned on the model.
 * Uses the test identity provider (a shared-secret hash, never a product
 * signature) so the run needs no network or key store.
 */
import type { ModelState } from "../../../packages/bim-kernel/src";
import type { Pack } from "../../../packages/bim-kernel/src/packs";
import { outsidePacksForPins } from "../../../packages/bim-kernel/src/packs/set";
import { OutsideAddonLibrary, checkOutsidePackage } from "../../../packages/bim-pack/src/install";
import { LICENCES, REVIEWER, registry, signedPackage } from "../../../packages/bim-pack/__tests__/fixtures/a11-outside";

const CLASSES = 50;
const VERIFY_SAMPLES = 15;

/** The install gate alone on one signed 50-class package, VERIFY_SAMPLES times after a warm-up. */
export async function verifyArm(): Promise<{ verifyMs: number[]; classes: number }> {
  const pkg = signedPackage({ classes: CLASSES });
  const options = { registry: registry(), licences: LICENCES };
  const verifyMs: number[] = [];
  await checkOutsidePackage(pkg, options);
  for (let i = 0; i < VERIFY_SAMPLES; i++) {
    const t0 = performance.now();
    const outcome = await checkOutsidePackage(pkg, options);
    verifyMs.push(performance.now() - t0);
    if (!outcome.ok) throw new Error(`[perf/outside-packs] the fixture package was refused: ${outcome.refused}`);
  }
  return { verifyMs, classes: CLASSES };
}

export async function outsideArm(head: ModelState): Promise<{ model: ModelState; host: readonly Pack[]; verifyMs: number[]; pinned: string; classes: number }> {
  const { verifyMs } = await verifyArm();
  const pkg = signedPackage({ classes: CLASSES });
  const options = { registry: registry(), licences: LICENCES };
  const library = new OutsideAddonLibrary(options);
  const installed = await library.install(pkg);
  if (!installed.ok) throw new Error(installed.refused);
  library.act(installed.review.packageName, installed.review.version, { kind: "approve", by: REVIEWER, at: "2026-11-02T13:00:00Z" });
  const pins = library.pinsFor(installed.review.packageName, installed.review.version);
  const model: ModelState = { ...head, settings: { ...head.settings, packs: [...(head.settings.packs ?? []), ...pins] } };
  // The host's list for this model: its own add-ons (none here) plus the outside ones its pins may load.
  const { available } = outsidePacksForPins(pins, library.installed());
  return { model, host: available, verifyMs, pinned: pins.map((p) => `${p.id}@${p.version}`).join(","), classes: CLASSES };
}
