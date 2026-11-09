import { MAX_PLACE_DEVICES, builtinPartType, elementsOfKind, roomGeometriesFromModel, type ModelState, type PartTypeDefinition, type PartTypeElement, type ProposeCommand, type RoomGeometry } from "@permitzip/bim-kernel";
import type { ReceptacleRules } from "@permitzip/bim-calc";
import type { ReceptacleProposal } from "./types";

/**
 * The one edit that accepts a receptacle proposal (moved from the kernel in round 8): the devices whose keys are in `keep`
 * (all of them when `keep` is null), on the rooms' level, each part type
 * pinned from the starter library when the model doesn't have it yet. The
 * Electrical tab and the agent both send this. Returns why not, in words,
 * when it can't be built.
 */
export function acceptProposalCommand(model: Pick<ModelState, "elements">, proposal: ReceptacleProposal, keep: readonly string[] | null, options: { readonly fallbackLevelId?: string; readonly label?: string } = {}): ProposeCommand | string {
  const wanted = keep ? new Set(keep) : null;
  const devices = proposal.devices.filter((d) => !wanted || wanted.has(d.key));
  if (wanted) {
    const missing = [...wanted].filter((k) => !proposal.devices.some((d) => d.key === k));
    if (missing.length > 0) return `Not in this proposal: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}. Propose again and keep keys from that answer.`;
  }
  if (devices.length === 0) return "Nothing to place: no proposed device was kept.";
  if (devices.length > MAX_PLACE_DEVICES) return `${devices.length} devices is more than one edit takes (${MAX_PLACE_DEVICES}); accept fewer rooms at a time.`;
  const levelNames = new Set(devices.map((d) => model.elements[d.roomId]?.partition?.level).filter((l): l is string => typeof l === "string"));
  if (levelNames.size > 1) return `These rooms are on ${levelNames.size} levels; accept one level at a time.`;
  const name = [...levelNames][0];
  const levelId = (name ? elementsOfKind(model.elements, "level").find((l) => l.name === name)?.id : undefined) ?? options.fallbackLevelId ?? null;
  if (!levelId) return "Choose the level to place them on.";
  const partTypes: Array<{ typeId: string; definition: PartTypeDefinition }> = [];
  for (const typeId of new Set(devices.map((d) => d.typeId))) {
    if (model.elements[typeId]?.kind === "part_type") continue;
    const builtin = builtinPartType(typeId);
    if (!builtin) return `Part type ${typeId} isn't in this model or the starter library.`;
    partTypes.push({ typeId, definition: builtin.definition });
  }
  const rooms = [...new Set(devices.map((d) => d.roomId))].length;
  const rule = proposal.preset ? `${proposal.preset} density, firm preset` : `${proposal.code} 210.52`;
  const label = options.label ?? `Receptacles (${rule}): ${devices.length} of ${proposal.devices.length} proposed in ${rooms} room${rooms === 1 ? "" : "s"}`;
  return {
    type: "place_devices",
    label: label.slice(0, 160),
    levelId,
    ...(partTypes.length > 0 ? { partTypes } : {}),
    devices: devices.map((d) => {
      const zone = model.elements[d.roomId]?.partition?.zone;
      return { partId: `rcpt-${d.roomId}-${d.kind}-${Math.round(d.position.x)}-${Math.round(d.position.y)}`.slice(0, 200), typeId: d.typeId, position: d.position, rotationDeg: d.rotationDeg, offsetMm: d.heightMm, ...(zone ? { zone } : {}) };
    }),
  };
}

/** Whether a part type is a receptacle (a connector's load class says so, else its names do). */
export function isReceptacleType(type: PartTypeElement): boolean {
  if (type.definition.category !== "electrical_device") return false;
  const classes = type.definition.connectors.map((c) => c.loadClass).filter((c): c is string => c !== undefined);
  if (classes.length > 0) return classes.includes("receptacle");
  return /\b(receptacle|outlet)\b/i.test(`${type.definition.familyName} ${type.definition.typeName}`);
}

/** The rooms as the receptacle proposer reads them: the kernel's room geometry, with receptacles already there and the rules' appliance marks. */
export function receptacleRoomGeometries(model: Pick<ModelState, "elements" | "connections">, roomIds: readonly string[], rules: Pick<ReceptacleRules, "applianceMarks">): RoomGeometry[] {
  return roomGeometriesFromModel(model, roomIds, { applianceMarks: rules.applianceMarks, isExistingDevice: isReceptacleType });
}
