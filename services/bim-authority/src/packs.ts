import { bindModelPacks, PackSet, type Pack } from "@permitzip/bim-kernel/packs";
import { installModelSetupHost, isModelSetupRecordId, modelSetupOf, pinnedPacks, resolveModelSetup, type ModelSettings, type ModelState } from "@permitzip/bim-kernel";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { CIVIL_PACK } from "@permitzip/bim-pack-civil";

/**
 * Add-ons this model server can load beyond the first-party trades: Civil as
 * a Preview add-on (round 8). A model uses it only when its own add-on switch
 * is on (an organization record, `set_model_addon`), so every other model is
 * served exactly as before. Structural is first-party since round 14. A host's
 * editor installs the same list.
 */
export const INSTALLED_PACKS: readonly Pack[] = [CIVIL_PACK];

let firstPartyInstalled = false;

/**
 * The first-party add-ons (Electrical, Plumbing and gas, Mechanical, Fire
 * protection): every model opens with them, whatever it pins. Once per
 * process, with this server's add-on list registered as the kernel's
 * model-state binder, so a command on a model with add-on switches or pinned
 * firm disciplines runs with the set its own state names.
 */
export function ensureFirstPartyAddOns(): void {
  if (firstPartyInstalled) return;
  installFirstPartyAddOns();
  installModelSetupHost(() => INSTALLED_PACKS, {
    onProblem: (modelId, resolved) => console.error("[bim-authority] model uses add-ons this server doesn't have; opening it without them", { modelId, missing: resolved.missing, firmProblems: resolved.firmProblems }),
  });
  firstPartyInstalled = true;
}

/**
 * Bind a model to the packs it pins, so its commands, warm-up and schedule
 * reads see exactly those add-ons and no other firm's. A pin this server
 * lacks is logged and the model opens with built-ins only for it.
 */
export function bindServedModelPacks(modelId: string, settings: ModelSettings, installed: readonly Pack[] = INSTALLED_PACKS): void {
  ensureFirstPartyAddOns();
  const { chosen, missing } = pinnedPacks(settings.packs ?? [], installed);
  const set = PackSet.create(chosen);
  if (missing.length > 0) console.error("[bim-authority] model uses add-ons this server doesn't have; opening it without them", { modelId, missing });
  bindModelPacks(modelId, set);
}

/**
 * Rebind a served model from its head: its pins plus its own add-on
 * switches and pinned firm disciplines. Call on open and after every commit
 * whose changeset touches a setup record (`setup-addon:` / `setup-discipline:`
 * ids), so reads by id (graph, warm-up, schedules) see the switch.
 */
export function bindServedModelState(head: Pick<ModelState, "modelId" | "settings" | "elements" | "connections">, installed: readonly Pack[] = INSTALLED_PACKS): void {
  ensureFirstPartyAddOns();
  const setup = modelSetupOf(head);
  if (!setup.hasEntries) {
    bindServedModelPacks(head.modelId, head.settings, installed);
    return;
  }
  const { set, missing, firmProblems } = resolveModelSetup(setup, installed);
  if (missing.length > 0 || firmProblems.length > 0) console.error("[bim-authority] model uses add-ons this server doesn't have; opening it without them", { modelId: head.modelId, missing, firmProblems });
  bindModelPacks(head.modelId, set);
}

/** Whether a committed change touched a model's setup (so the server rebinds it). */
export function touchesModelSetup(changedIds: Iterable<string>): boolean {
  for (const id of changedIds) if (isModelSetupRecordId(id)) return true;
  return false;
}
