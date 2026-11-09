/** What GET …/building-model/linked/levels answers (lib/building-model/linked-levels.ts reads it). Safe in the browser. */

export interface LinkedStoreyLevel {
  readonly storeyId: string;
  /** Up to 40 characters (a level name's limit). */
  readonly name: string;
  /** Floor height in this model, mm. */
  readonly elevationMm: number;
  /** The Elevation the file writes for the storey, mm in this model; null when it writes none. Differs from `elevationMm` only when the file's placement and attribute disagree. */
  readonly declaredElevationMm: number | null;
}

export interface LinkedModelStoreys {
  readonly referenceId: string;
  readonly label: string;
  readonly discipline: string;
  /** The version the storeys come from. */
  readonly versionId: string;
  readonly storeys: readonly LinkedStoreyLevel[];
  /** recorded: read when converted. read_now: read from the stored IFC for this request. */
  readonly read: "recorded" | "read_now";
  /** Why this model has no storeys to offer, in words; null when it has them. */
  readonly problem: string | null;
}

export interface LinkedLevelsResponse {
  readonly models: readonly LinkedModelStoreys[];
}

export function isLinkedLevelsResponse(v: unknown): v is LinkedLevelsResponse {
  if (typeof v !== "object" || v === null || !("models" in v) || !Array.isArray(v.models)) return false;
  return v.models.every(
    (m: unknown) =>
      typeof m === "object" &&
      m !== null &&
      "referenceId" in m &&
      typeof m.referenceId === "string" &&
      "label" in m &&
      typeof m.label === "string" &&
      "storeys" in m &&
      Array.isArray(m.storeys) &&
      m.storeys.every((s: unknown) => typeof s === "object" && s !== null && "storeyId" in s && typeof s.storeyId === "string" && "name" in s && typeof s.name === "string" && "elevationMm" in s && typeof s.elevationMm === "number"),
  );
}
