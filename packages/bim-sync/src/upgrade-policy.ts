import { withUpgradePolicy, withoutUpgrades, type Command, type UpgradePolicy } from "@permitzip/bim-kernel";

/**
 * Decide one command with record upgrades on edit (product decision 6):
 * gated steps run when `policy` says the peers read their shape. Undo
 * restores stored records exactly, so it never upgrades; the next edit does.
 * The sequencer (what is stored) and the client (its prediction) both decide through this.
 */
export function decideWithUpgrades<T>(command: Command, policy: UpgradePolicy, decide: () => T): T {
  if (command.type === "undo") return withoutUpgrades(decide);
  return withUpgradePolicy(policy, decide);
}
