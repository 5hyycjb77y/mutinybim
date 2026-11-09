/**
 * One firm's outside add-ons, in memory: what a standalone MutinyBIM host
 * keeps (a host app may keep the same in its own tables),
 * and how a model opens with them. Install runs the gate and waits `pending`;
 * a person approves per version; a model pinning an add-on loads it only
 * while its build is approved (or yanked, with a warning).
 */
import { modelSetupOf, resolveModelSetup, type ModelState } from "@permitzip/bim-kernel";
import { type Pack, type PackSet, type OutsidePackPin, type PackPin, missingPinWords, outsidePacksForPins, type BlockedPin, type InstalledOutsidePack, applyReviewAct, type InstallReview, type ReviewAct } from "@permitzip/bim-kernel/packs";
import { checkOutsidePackage, type GatedAddon, type InstallGateOptions, type InstallOutcome } from "./gate";
import type { OutsidePackage } from "./package";

interface Entry {
  review: InstallReview;
  readonly addons: readonly GatedAddon[];
}

const keyOf = (name: string, version: string): string => `${name}@${version}`;

export class OutsideAddonLibrary {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly gate: InstallGateOptions) {}

  /** Check and record a package as pending. A second install of the same version must be the same build. */
  async install(pkg: OutsidePackage): Promise<InstallOutcome> {
    const outcome = await checkOutsidePackage(pkg, this.gate);
    if (!outcome.ok) return outcome;
    const key = keyOf(outcome.review.packageName, outcome.review.version);
    const had = this.entries.get(key);
    if (had && had.review.digest !== outcome.review.digest) {
      return { ok: false, refused: `${outcome.review.packageName} ${outcome.review.version} is already installed as a different build. A catalogue never changes a published version; report it to the catalogue.`, checks: outcome.review.checks, packageName: outcome.review.packageName, version: outcome.review.version };
    }
    if (!had) this.entries.set(key, { review: outcome.review, addons: outcome.addons });
    return had ? { ...outcome, review: had.review } : outcome;
  }

  /** A person's approval or rejection, or the catalogue's yank or removal. Throws `ReviewActError` in words. */
  act(packageName: string, version: string, act: ReviewAct): InstallReview {
    const entry = this.entries.get(keyOf(packageName, version));
    if (!entry) throw new Error(`${packageName} ${version} isn't installed in this library`);
    entry.review = applyReviewAct(entry.review, act);
    return entry.review;
  }

  review(packageName: string, version: string): InstallReview | null {
    return this.entries.get(keyOf(packageName, version))?.review ?? null;
  }

  reviews(): readonly InstallReview[] {
    return [...this.entries.values()].map((e) => e.review);
  }

  /** The pins a model stores to use this package's add-ons. */
  pinsFor(packageName: string, version: string): readonly OutsidePackPin[] {
    return this.entries.get(keyOf(packageName, version))?.addons.map((a) => a.pin) ?? [];
  }

  /** Every data add-on installed, with its review, for `outsidePacksForPins`. */
  installed(): readonly InstalledOutsidePack[] {
    return [...this.entries.values()].flatMap((e) => e.addons.flatMap((a) => (a.pack ? [{ pack: a.pack, pin: a.pin, review: e.review }] : [])));
  }
}

export interface OpenedWithOutsidePacks {
  readonly set: PackSet;
  /** "This model needs add-on X v1.2: …", one per pin it opened without. The model's records are untouched. */
  readonly needs: readonly string[];
  readonly blocked: readonly BlockedPin[];
  /** Loaded with something to say (yanked, pinned before builds were recorded). */
  readonly warnings: readonly string[];
}

/** A setup pin (id and version) with the digest and tier its `settings.packs` entry recorded for the same version. */
function withStoredBuild(pin: PackPin, stored: readonly PackPin[] | undefined): PackPin {
  if (pin.digest) return pin;
  const match = stored?.find((s) => s.id === pin.id && s.version === pin.version && s.digest);
  return match ?? pin;
}

/**
 * The set a model opens with on a host whose own add-ons are `hostPacks` and
 * whose firm installed `installed`: the model's setup, outside pins checked
 * for build and review, then resolved together. Never throws for stored data.
 */
export function openWithOutsidePacks(model: Pick<ModelState, "elements" | "connections" | "settings">, hostPacks: readonly Pack[], installed: readonly InstalledOutsidePack[]): OpenedWithOutsidePacks {
  const setup = modelSetupOf(model);
  const pins = setup.pins.map((p) => withStoredBuild(p, model.settings.packs));
  const outside = outsidePacksForPins(pins, installed);
  const resolved = resolveModelSetup({ ...setup, pins }, [...hostPacks, ...outside.available]);
  const blockedKeys = new Set(outside.blocked.map((b) => keyOf(b.pin.id, b.pin.version)));
  const needs = [...outside.blocked.map((b) => b.words), ...resolved.missing.filter((m) => !blockedKeys.has(keyOf(m.id, m.version))).map(missingPinWords)];
  return { set: resolved.set, needs, blocked: outside.blocked, warnings: outside.warnings };
}
