import {
  instancePoint,
  intakeOf,
  partsOfTypical,
  placedConnectors,
  typicalCapStatus,
  typicalInstances,
  typicalOfGroup,
  virtualCopyId,
  worldConnector,
  type BimElement,
  type PartInstance,
  type TypicalInstance,
  type TypicalSpec,
  type Vec2,
} from "@permitzip/bim-kernel";
import { clip, feet, feetInches } from "../format";
import type { RuleContext, RuleDef } from "../registry";

/**
 * Typicals (ROADMAP F6). Unit 001 is drawn once and repeated, so a check that
 * depends on where something lands has to be asked per copy: copy 002's
 * outdoor-air intake can sit next to the original's exhaust even though
 * unit 001 on its own is fine. Copies are not elements; a finding names an
 * element as it stands in a copy with the virtual id `<group>#<mark>/<element>`
 * (`parseVirtualCopyId` gets back to the element). Checks run lazily: only for
 * a typical whose record or member parts the edit touched (or in a full
 * check), and only between instances close enough to matter.
 *
 * Also here: the contract covers a number of typical types (STATUS decision
 * 15, default 10, a model setting); more is a warning, never a refusal.
 */

const MM_PER_FT = 304.8;
/** IMC 401.4 / IBC: an outdoor-air intake at least 10 ft horizontally from an exhaust outlet or plumbing vent, unless at least 3 ft below it. */
const SEPARATION_MM = 10 * MM_PER_FT;
const BELOW_MM = 3 * MM_PER_FT;

type OpeningRole = "intake" | "exhaust" | "vent";

interface Opening {
  readonly part: PartInstance;
  readonly role: OpeningRole;
  readonly label: string;
  readonly plan: Vec2;
  readonly z: number;
}

/**
 * A part's openings to outdoors, wherever its type says: a duct connector
 * with a hood, louver or screen (outdoor air in, exhaust or relief out), or a
 * vent terminal (a part whose only pipe connection is a vent).
 */
function openingsOf(els: Readonly<Record<string, BimElement>>, part: PartInstance): Opening[] {
  const type = els[part.typeId];
  if (type?.kind !== "part_type") return [];
  const connectors = placedConnectors(type, part);
  const pipes = connectors.filter((c) => c.domain === "pipe");
  const out: Opening[] = [];
  for (const c of connectors) {
    let role: OpeningRole | null = null;
    if (c.domain === "duct" && intakeOf(c, part.intakes) !== null) {
      if (c.systemKind === "outside_air") role = "intake";
      else if (/exhaust|relief/.test(c.systemKind)) role = "exhaust";
    } else if (c.domain === "pipe" && c.systemKind === "vent" && pipes.length === 1) role = "vent";
    if (!role) continue;
    const w = worldConnector(part, c);
    out.push({ part, role, label: c.label, plan: { x: w.position.x, y: w.position.y }, z: w.position.z });
  }
  return out;
}

const ROLE_WORDS: Readonly<Record<OpeningRole, string>> = { intake: "outdoor-air intake", exhaust: "exhaust outlet", vent: "plumbing vent" };

function partName(ctx: RuleContext, part: PartInstance): string {
  return part.mark && part.mark.trim() !== "" ? part.mark : ctx.name(part.id);
}

/** "copy 002's" / "unit 001's" for messages. */
function whose(spec: TypicalSpec, inst: TypicalInstance): string {
  return `${inst.copy ? "copy" : spec.label.toLowerCase()} ${inst.mark}'s`;
}

/** Every intake within code distance of an exhaust or vent in another instance of the same typical. */
function checkCopies(ctx: RuleContext, groupId: string): void {
  const els = ctx.model.elements;
  const t = typicalOfGroup(els, groupId);
  if (!t || t.spec.copies.length === 0) return;
  const openings = partsOfTypical(els, groupId).flatMap((p) => openingsOf(els, p));
  const intakes = openings.filter((o) => o.role === "intake");
  const sources = openings.filter((o) => o.role !== "intake");
  if (intakes.length === 0 || sources.length === 0) return;
  const spec = t.spec;
  const instances = typicalInstances(spec);
  // Lazy: two instances can only meet when the openings' spread plus the code distance reaches across their offset.
  let reach = 0;
  for (const a of intakes) for (const b of sources) reach = Math.max(reach, Math.hypot(a.plan.x - b.plan.x, a.plan.y - b.plan.y));
  reach += SEPARATION_MM;
  const anchor = intakes[0]?.plan ?? { x: 0, y: 0 };
  const at = instances.map((inst) => instancePoint(spec, inst, anchor));
  for (let i = 0; i < instances.length; i++) {
    for (let j = 0; j < instances.length; j++) {
      if (i === j) continue;
      const ai = at[i];
      const aj = at[j];
      const ii = instances[i];
      const ij = instances[j];
      if (!ai || !aj || !ii || !ij || Math.hypot(ai.x - aj.x, ai.y - aj.y) > reach) continue;
      for (const a of intakes) {
        const pa = instancePoint(spec, ii, a.plan);
        for (const b of sources) {
          const pb = instancePoint(spec, ij, b.plan);
          const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
          if (d >= SEPARATION_MM || a.z <= b.z - BELOW_MM) continue;
          ctx.emit({
            rule: "typical-copy-intake-near-exhaust",
            severity: "warning",
            elementIds: [virtualCopyId(groupId, ii, a.part.id), virtualCopyId(groupId, ij, b.part.id)],
            at: { level: ctx.levelNameOf(a.part), x_ft: feet(pa.x), y_ft: feet(pa.y), z_ft: feet(a.z) },
            message: clip(`In ${whose(spec, ii)} ${partName(ctx, a.part)}, the ${ROLE_WORDS.intake} is ${feetInches(d)} from ${whose(spec, ij)} ${ROLE_WORDS[b.role]} on ${partName(ctx, b.part)}; the code wants 10 ft, or 3 ft below it`),
            fix: { tool: "bim_update_group", hint: "space the copies further apart (typical spacing_ft), or move the intake or exhaust in unit 001 (every copy follows)" },
          });
        }
      }
    }
  }
}

function isTypicalGroupRecord(el: BimElement): boolean {
  return el.kind === "organization" && el.entry.type === "group" && el.entry.typical !== undefined;
}

export const typicalRules: readonly RuleDef[] = [
  {
    id: "typicals-over-contract",
    version: 1,
    pack: "documents",
    severity: "warning",
    title: "More typical types than the contract covers",
    scope: "element",
    kinds: ["organization"],
    run: (ctx, el) => {
      // A typical's record or the settings (where the contract's count lives) changed, or a full check.
      if (!isTypicalGroupRecord(el) && !(el.kind === "organization" && el.entry.type === "settings")) return;
      const status = typicalCapStatus(ctx.model);
      if (!status.over || !status.message) return;
      ctx.emit({
        rule: "typicals-over-contract",
        severity: "warning",
        elementIds: [...status.groupIds],
        at: { level: "", x_ft: 0, y_ft: 0, z_ft: 0 },
        message: clip(`${status.message}. Agree the extra ${status.count - status.cap === 1 ? "one" : "ones"} with the client, or set the count the contract covers`),
        fix: { tool: "bim_update_group", hint: "stop repeating a group (typical null), or ask the operator to change the number the contract covers in Manage groups" },
      });
    },
  },
  {
    id: "typical-copy-intake-near-exhaust",
    version: 1,
    pack: "clearance",
    severity: "warning",
    title: "A typical copy's outdoor-air intake lands within 10 ft of another copy's exhaust or plumbing vent",
    scope: "element",
    kinds: ["organization", "part"],
    run: (ctx, el) => {
      if (isTypicalGroupRecord(el)) return checkCopies(ctx, el.id);
      if (el.kind !== "part" || !el.groupId) return;
      checkCopies(ctx, el.groupId);
    },
  },
];
