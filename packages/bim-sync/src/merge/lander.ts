import type { Actor } from "@permitzip/bim-kernel";
import type { Sequencer } from "../sequencer";
import type { MainLander } from "./engine";

/**
 * Lands merged parts on Main through Main's own sequencer, as the person who
 * pressed Merge: one `merge_branch_part` revision per part, the records
 * supplied as the server's command context (never on the wire). Every part
 * of one apply shares a session id, so a part decided on the merge's Main
 * head doesn't read the parts before it as someone else's change; a change
 * anyone else made on Main since then to what a part writes refuses that part.
 */
export function sequencerLander(input: {
  readonly sequencer: Pick<Sequencer, "head" | "submit">;
  readonly actor: Actor;
  readonly branchModelId: string;
}): MainLander {
  const session = `merge-${globalThis.crypto.randomUUID()}`;
  return {
    async land({ writes, add, remove, label, discipline, mainHead }) {
      const base = mainHead ?? (await input.sequencer.head()).revision;
      const outcome = await input.sequencer.submit(
        {
          idempotencyKey: `${session}-${globalThis.crypto.randomUUID()}`.slice(0, 128),
          baseRevision: base,
          actor: input.actor,
          clientSessionId: session,
          command: { type: "merge_branch_part", branchModelId: input.branchModelId, discipline: discipline ?? "unassigned", label: label.slice(0, 160) },
        },
        { mergeLanding: { writes, add, remove } },
      );
      return outcome.status === "committed" ? { ok: true, revision: outcome.revision } : { ok: false, message: outcome.error.message };
    },
  };
}
