/**
 * The add-ons the sealed script child carries (bundled into
 * `script-child.cjs`) and how it installs the ones a run names. The child
 * starts with a bare kernel: no trade knows duct, pipe or wire until its
 * add-on is installed, so a run installs exactly the add-ons its slice names
 * (`ModelSlice.addOns`, the model's set as the host resolved it) and the
 * kernel decides each edit as the model server will.
 *
 * Same list as the hosts: the first-party trades (`@permitzip/bim-first-party`)
 * plus the add-ons a model may switch on (`INSTALLED_PACKS` in
 * `services/bim-authority/src/packs.ts` and `lib/building-model/installed-packs.ts`).
 */
import { FIRST_PARTY_ADDONS } from "@permitzip/bim-first-party";
import { CIVIL_PACK } from "@permitzip/bim-pack-civil";
import { PackSet, firstPartyPackName, installFirstPartyPacks, isFirstPartyPackId, type Pack } from "@permitzip/bim-kernel/packs";
import type { ScriptAddOn } from "@permitzip/bim-script";

export const RUNNER_ADDONS: readonly Pack[] = [...FIRST_PARTY_ADDONS, CIVIL_PACK];

function words(addOn: ScriptAddOn): string {
  const name = isFirstPartyPackId(addOn.id) ? firstPartyPackName(addOn.id) : null;
  return name ? `${name} (${addOn.id}) ${addOn.version}` : `${addOn.id} ${addOn.version}`;
}

/**
 * Installs the run's first-party add-ons in this process and returns the
 * run's own set (its other add-ons). Throws, naming each one, when the slice
 * names an add-on or a version this child doesn't carry: a run never goes
 * ahead with an add-on silently left out.
 */
export function installRunAddOns(addOns: readonly ScriptAddOn[], carried: readonly Pack[] = RUNNER_ADDONS): PackSet {
  const problems: string[] = [];
  const firstParty: Pack[] = [];
  const own: Pack[] = [];
  for (const addOn of addOns) {
    const pack = carried.find((p) => p.manifest.id === addOn.id);
    if (!pack) problems.push(`${words(addOn)} (this script machine doesn't carry it)`);
    else if (pack.manifest.version !== addOn.version) problems.push(`${words(addOn)} (this script machine carries ${pack.manifest.version}; it needs the current development image)`);
    else if (pack.manifest.firstParty === true) firstParty.push(pack);
    else if (!own.includes(pack)) own.push(pack);
  }
  if (problems.length > 0) throw new Error(`This model uses add-ons the script machine can't load, so the script wasn't run: ${problems.join("; ")}.`);
  installFirstPartyPacks(firstParty);
  return PackSet.create(own);
}
