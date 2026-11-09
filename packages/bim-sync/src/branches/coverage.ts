import { z } from "zod";
import {
  classifyingResponsibilities,
  coveringResponsibilities,
  modelCoverageContext,
  sheetMembership,
  type BimElement,
  type BranchRef,
  type ElementCoverage,
  type ModelState,
  type Responsibility,
} from "@permitzip/bim-kernel";
import { idsChangedBetween, idsChangedMainVsBranch, type HistoryReader } from "./history";

/**
 * Round 9 lane B9: `coverage_check`, the server's own answer to "whose
 * accepted responsibility covers what changed here". The change-significance
 * route used to run coverage on element records the screen sent, so a
 * modified page could send records shaped to fall inside the person's scope.
 * Now the route sends only which change (a version range, or this branch
 * against the copy it came from) and the person's own responsibility rows from the database;
 * the model server reads the changed ids and their records from its history
 * and runs the kernel's coverage on the model it holds (sheets included).
 */

/** The server answers `coverage_check` (history read; served only by a hub whose branch service can read the head). */
export const HISTORY_COVERAGE_READ_FEATURE = "history:coverage_read";

/** Most changed elements one check reads; beyond it the answer says it was cut short. */
export const COVERAGE_MAX_IDS = 20_000;

const requestId = z.string().min(1).max(100);
const revision = z.number().int().min(0);
const ids = z.array(z.string().min(1).max(200)).max(500);
const filterOps = z.enum(["equals", "not_equals", "contains", "greater_than", "less_than", "present", "absent"]);

/** A responsibility row as the host read it (kernel `Responsibility`); tolerant of fields this release doesn't know. */
export const responsibilityWireSchema = z.object({
  id: z.string().min(1).max(100),
  party: z.object({ kind: z.enum(["person", "firm"]), ref: z.string().min(1).max(200), label: z.string().max(300) }),
  discipline: z.string().min(1).max(96),
  scope: z
    .object({
      systems: ids.optional(),
      groups: ids.optional(),
      levels: ids.optional(),
      zones: z.array(z.object({ level: z.string().min(1).max(200), zone: z.string().min(1).max(200) })).max(500).optional(),
      sheets: ids.optional(),
      classes: ids.optional(),
      types: ids.optional(),
      where: z.array(z.object({ path: z.string().min(1).max(200), op: filterOps, value: z.string().max(400).optional() })).max(50).optional(),
    })
    .optional(),
  acceptedAt: z.string().min(1).max(100).optional(),
  approval: z.object({ group: z.string().min(1).max(100), rule: z.enum(["each", "any_one"]) }).optional(),
});

export const coverageCheckSchema = z.object({
  type: z.literal("coverage_check"),
  requestId,
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("version_range"), fromRevision: revision, toRevision: revision }),
    /** This copy's session against the copy it came from (its parent, any depth) at `mainRevision` ("head": the parent now). The wire names stay `branch` / `mainRevision`. */
    z.object({ kind: z.literal("branch"), mainRevision: z.union([revision, z.literal("head")]) }),
  ]),
  /** The person the host classifies for (its id on the responsibility rows). */
  personRef: z.string().min(1).max(200),
  responsibilities: z.array(responsibilityWireSchema).max(200),
});

export type CoverageCheck = z.infer<typeof coverageCheckSchema>;

export interface CoverageResult {
  readonly type: "coverage_result";
  readonly requestId: string;
  /** How many elements changed in the target. */
  readonly changed: number;
  /** The person's accepted rows that cover at least one changed element (they may classify under these). */
  readonly classifying: readonly string[];
  /** More changed elements than one check reads: classifying was decided on the first `COVERAGE_MAX_IDS`. */
  readonly truncated: boolean;
}

export const COVERAGE_WORDS = {
  unavailable: "This model server can't check who covers a change yet. Try again once it is updated.",
  notOnBranch: "This session is on Main, so there is no branch to compare. Open the branch first.",
  backwards: "The later version has to come after the earlier one.",
} as const;

export class CoverageRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoverageRefusal";
  }
}

/** The kernel's `Responsibility` from a checked wire row (copies, so nothing the sender holds is shared). */
function toResponsibility(r: z.infer<typeof responsibilityWireSchema>): Responsibility {
  return {
    id: r.id,
    party: { ...r.party },
    discipline: r.discipline,
    ...(r.scope ? { scope: r.scope } : {}),
    ...(r.acceptedAt ? { acceptedAt: r.acceptedAt } : {}),
    ...(r.approval ? { approval: { ...r.approval } } : {}),
  };
}

/**
 * The check itself, over the history this hub serves. `head` is the model as
 * it stands (classes, systems and sheets are read from it); the changed
 * records come from the history at the later end (the earlier end for a
 * removed element), never from the asker.
 */
export async function answerCoverage(
  msg: CoverageCheck,
  sides: { readonly history: HistoryReader; readonly main: HistoryReader | null; readonly branch: BranchRef | null; readonly head: () => Promise<ModelState> },
): Promise<CoverageResult> {
  type Read = (ids: readonly string[]) => Promise<Readonly<Record<string, BimElement | null>>>;
  let changedIds: readonly string[];
  let laterAt: Read;
  let earlierAt: Read;
  if (msg.target.kind === "version_range") {
    const { fromRevision, toRevision } = msg.target;
    if (toRevision < fromRevision) throw new CoverageRefusal(COVERAGE_WORDS.backwards);
    changedIds = await idsChangedBetween(sides.history, fromRevision, toRevision);
    laterAt = (ids) => sides.history.elementsAt(toRevision, ids);
    earlierAt = (ids) => sides.history.elementsAt(fromRevision, ids);
  } else {
    if (!sides.branch || !sides.main) throw new CoverageRefusal(COVERAGE_WORDS.notOnBranch);
    const main = sides.main;
    const mainRevision = msg.target.mainRevision === "head" ? await main.headRevision() : msg.target.mainRevision;
    changedIds = await idsChangedMainVsBranch(sides.branch, sides.history, main, mainRevision);
    const branchHead = await sides.history.headRevision();
    laterAt = (ids) => sides.history.elementsAt(branchHead, ids);
    earlierAt = (ids) => main.elementsAt(mainRevision, ids);
  }
  const capped = changedIds.slice(0, COVERAGE_MAX_IDS);
  const later = await laterAt(capped);
  const removed = capped.filter((id) => !later[id]);
  const before: Readonly<Record<string, BimElement | null>> = removed.length > 0 ? await earlierAt(removed) : {};
  const records = capped.flatMap((id) => {
    const r = later[id] ?? before[id];
    return r ? [r] : [];
  });
  const head = await sides.head();
  const ctx = modelCoverageContext(head, { sheetsOf: sheetMembership(head) });
  const coverage: ElementCoverage[] = coveringResponsibilities(records, msg.responsibilities.map(toResponsibility), ctx);
  return {
    type: "coverage_result",
    requestId: msg.requestId,
    changed: changedIds.length,
    classifying: classifyingResponsibilities(coverage, msg.personRef).map((r) => r.id),
    truncated: changedIds.length > COVERAGE_MAX_IDS,
  };
}
