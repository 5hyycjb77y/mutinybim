import { refuse, registerEditHook } from "../command-core";
import { disciplineLabel, disciplineWriteFeature, disciplineWriteProblem } from "../disciplines/registry";
import { DISCIPLINES_REGISTRY_FEATURE } from "../disciplines/types";
import { PARTITION_DISCIPLINES_FEATURE } from "../partition";
import type { BimElement, ElementId } from "../types";
import { decidingUndo, peerReads } from "./feature";

/**
 * Stored disciplines, expand then contract (round 5c, registry in round 8):
 * readers keep any registry id. A record newly stored with a discipline
 * beyond the six must name a discipline the model's registry knows, and is
 * written only when the peers can store it: the four class disciplines need
 * `partition:class_disciplines`, any other registered id `disciplines:registry`
 * (which implies the first). A discipline a record already carried passes;
 * undo stands aside. Document commands (views, sheets) don't run the edit
 * hooks, so their finish calls this directly.
 */
export function checkStoredDisciplines(base: Readonly<Record<string, BimElement>>, working: Readonly<Record<string, BimElement>>, touchedIds: readonly ElementId[]): void {
  if (decidingUndo()) return;
  for (const id of touchedIds) {
    const d = working[id]?.partition?.discipline;
    if (d === undefined || base[id]?.partition?.discipline === d) continue;
    const feature = disciplineWriteFeature(d);
    if (feature === null) continue;
    const problem = disciplineWriteProblem(d);
    if (problem) refuse("invalid_value", problem, [id]);
    // The registry feature implies the class-discipline one, so a peer missing the older can store neither.
    const readsExtra = peerReads(PARTITION_DISCIPLINES_FEATURE);
    const readable = feature === PARTITION_DISCIPLINES_FEATURE ? readsExtra : readsExtra && peerReads(DISCIPLINES_REGISTRY_FEATURE);
    if (!readable) refuse("invalid_value", `This can't be saved under ${disciplineLabel(d)} yet: the model server this model is open on is an older version that doesn't store that discipline. Try again once the server is updated`, [id]);
  }
}

registerEditHook("partition-disciplines", (base, working, touchedIds) => {
  checkStoredDisciplines(base.elements, working, touchedIds);
});
