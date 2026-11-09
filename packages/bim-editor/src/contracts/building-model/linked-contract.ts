/**
 * What the Building Model's "Linked models" panel and its routes exchange, and
 * the limits and wording both sides share. No database or server imports, so
 * the browser bundle can use it.
 */
import { disciplineDef, disciplineLabel, disciplineWriteProblem, isRegisteredDiscipline, isRegistryIdShape, listDisciplines } from "@permitzip/bim-kernel";
import type { PackSet } from "@permitzip/bim-kernel/packs";

export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
/** Conversion runs on a Vercel function for now; bigger files wait for the Fly worker. */
export const MAX_CONVERT_BYTES = 150 * 1024 * 1024;

/**
 * What a linked model shows: one of the host's four (`LINKED_DISCIPLINES`) or
 * any registered discipline id (an add-on's `vt.elevators`, a firm's
 * `firm:low_voltage`). The database checks the id's shape only; the registry
 * lives in the model.
 */
export type LinkedDiscipline = string;
export type VersionStatus = "awaiting_upload" | "queued" | "converting" | "ready" | "failed" | "abandoned";
export type JobStatus = "queued" | "running" | "done" | "failed";
/**
 * Peers: a supplied IFC file (often a client's own Revit export), the export of
 * our Revit file with its links, or a file picked from Autodesk Docs.
 */
export type LinkedSource = "ifc_upload" | "autodesk_docs" | "autodesk_docs_item";
/** Where a version's position came from. */
export type PlacementBasis = "revit_link" | "revit_shared_coordinates" | "file_georeference" | "file_origin";
/** Everything is accepted today; submitted / rejected are for a future client-portal upload. */
export type ReviewState = "submitted" | "accepted" | "rejected";
/** What the worker decided about a version's position (stored on the version). */
export type VersionAlignment = "pending" | "automatic" | "needs_alignment" | "review";
/** What the panel says about the shown version's position, once the person's adjustment is taken into account. */
export type AlignmentState = "placed" | "needs_alignment" | "aligned_by_hand" | "review";

/** The host's own four, which every picker offers first, in this order ("mep" and "other" are not registry rows). */
export const LINKED_DISCIPLINES: readonly LinkedDiscipline[] = ["architecture", "mep", "structure", "other"];

/** A value a linked model may be stored as: a well-formed registry id (the database's check). */
export function isLinkedDiscipline(value: string): value is LinkedDiscipline {
  return isRegistryIdShape(value);
}

/** A stored value as readers keep it: the id as stored when well formed (registered or not), else "other". */
export function readLinkedDiscipline(raw: unknown): LinkedDiscipline {
  return isRegistryIdShape(raw) ? raw : "other";
}

/** Why `id` can't be chosen for a linked model with `set`'s registry, in plain words, or null when it can (the host's four always can). */
export function linkedDisciplineProblem(id: string, set?: PackSet): string | null {
  return (LINKED_DISCIPLINES as readonly string[]).includes(id) ? null : disciplineWriteProblem(id, set);
}

export interface LinkedDisciplineChoice {
  readonly value: LinkedDiscipline;
  readonly label: string;
  readonly colour: string | null;
}

/**
 * What a "What it shows" picker lists: the host's four, then every other
 * discipline `set` registers (add-on and firm rows, children as
 * "Parent › Child"). `current` stays listed in its own words when the set
 * doesn't know it, so the field never reads blank.
 */
export function linkedDisciplineChoices(set?: PackSet, current?: string): readonly LinkedDisciplineChoice[] {
  const choice = (value: string, label: string): LinkedDisciplineChoice => ({ value, label, colour: linkedDisciplineColour(value, set) });
  const rows = [
    ...LINKED_DISCIPLINES.map((d) => choice(d, linkedDisciplineLabel(d, set))),
    ...listDisciplines(set)
      .filter((d) => !(LINKED_DISCIPLINES as readonly string[]).includes(d.id) && d.id !== "documentation" && d.id !== "general")
      .map((d) => choice(d.id, d.parent ? `${disciplineLabel(d.parent, set)} › ${d.label}` : d.label)),
  ];
  return current && !rows.some((r) => r.value === current) ? [...rows, choice(current, `${linkedDisciplineLabel(current, set)} (not in this model's add-ons)`)] : rows;
}

/** Words for the two stored values that aren't registered disciplines ("mep" is the MEP group of existing work; "other" is anything else). */
const HOST_WORDS: Readonly<Record<string, string>> = { mep: "Existing MEP", other: "Other" };

/** A linked model's discipline in words: the registry's label (Architecture, Structure, any registered id), else the host's words, else the id's own words. */
export function linkedDisciplineLabel(discipline: string, set?: PackSet): string {
  return isRegisteredDiscipline(discipline, set) ? disciplineLabel(discipline, set) : (HOST_WORDS[discipline] ?? disciplineLabel(discipline, set));
}

/** At most this many disciplines on one linked model (the database's check). */
export const MAX_LINKED_DISCIPLINES = 16;
/** Longest company or contact name a linked model keeps (the database's check). */
export const MAX_CONTRIBUTOR_CHARS = 200;

/**
 * A stored set as readers keep it: the set when one is stored (well-formed ids,
 * each once, `primary` first), else the set of the one `primary`. Rows from
 * before round 9 carry no set and read as a set of one.
 */
export function readLinkedDisciplines(rawSet: unknown, primary: unknown): readonly LinkedDiscipline[] {
  const first = readLinkedDiscipline(primary);
  if (!Array.isArray(rawSet)) return [first];
  const rest = rawSet.filter((d): d is string => isRegistryIdShape(d) && d !== first);
  return [first, ...new Set(rest)];
}

/** The set a person picked, primary first, each once (empty entries dropped). */
export function normaliseLinkedDisciplines(primary: LinkedDiscipline, more: readonly string[] = []): readonly LinkedDiscipline[] {
  return [primary, ...new Set(more.filter((d) => d !== primary && d.length > 0))];
}

/** Why a set can't be chosen for a linked model with `set`'s registry, in plain words, or null. */
export function linkedDisciplinesProblem(ids: readonly string[], set?: PackSet): string | null {
  if (ids.length === 0) return "Pick at least one discipline this model shows.";
  if (ids.length > MAX_LINKED_DISCIPLINES) return `A linked model can show up to ${MAX_LINKED_DISCIPLINES} disciplines; pick fewer.`;
  if (new Set(ids).size !== ids.length) return "Each discipline can be picked once.";
  for (const id of ids) {
    if (!isLinkedDiscipline(id)) return "Pick what the model shows from the list.";
    const problem = linkedDisciplineProblem(id, set);
    if (problem) return problem;
  }
  return null;
}

/** Every discipline a linked model (or a Docs file coming in) shows, first = its `discipline`. */
export function disciplinesOf(ref: { readonly discipline: LinkedDiscipline; readonly disciplines?: readonly LinkedDiscipline[] }): readonly LinkedDiscipline[] {
  return ref.disciplines && ref.disciplines.length > 0 ? ref.disciplines : [ref.discipline];
}

/** A linked model's disciplines in words, in their stored order ("Mechanical, Electrical"). */
export function linkedDisciplinesLabel(ids: readonly string[], set?: PackSet): string {
  return ids.map((d) => linkedDisciplineLabel(d, set)).join(", ");
}

/** Who contributed a linked model: the company, and the person there to ask. Either may be unknown. */
export interface LinkedContributor {
  readonly organization: string | null;
  readonly contact: string | null;
}

/** A contributor as a person types it when linking (either part may be left out). */
export interface LinkedContributorInput {
  readonly organization?: string;
  readonly contact?: string;
}

/** "Acme Engineering · J. Rao", "Acme Engineering", "J. Rao", or null when neither is known. */
export function linkedContributorLabel(c: LinkedContributor | null): string | null {
  if (!c) return null;
  const parts = [c.organization, c.contact].filter((p): p is string => p !== null && p.trim().length > 0);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** The registry's colour for a linked model's discipline, or null when it isn't a registered discipline ("mep", "other"). */
export function linkedDisciplineColour(discipline: string, set?: PackSet): string | null {
  return disciplineDef(discipline, set)?.display.colour ?? null;
}

export interface LinkedVersionView {
  readonly id: string;
  readonly number: number;
  readonly status: VersionStatus;
  /** Plain-English reason when status is failed. */
  readonly error: string | null;
  readonly source: LinkedSource;
  /** The file name as supplied. */
  readonly originalFileName: string;
  /** Who supplied it: the person in the host app, plus the outside party when they passed someone else's file on. */
  readonly suppliedBy: { readonly name: string; readonly organization: string | null };
  readonly bytes: number | null;
  readonly createdAt: string;
  /** Null until the worker has read the file. */
  readonly placementBasis: PlacementBasis | null;
  readonly reviewState: ReviewState;
  readonly alignment: VersionAlignment;
  /** Plain-English reason with "needs alignment" / "review alignment". */
  readonly alignmentNote: string | null;
  /** reexport_host: our Revit model's last export didn't record enough, so exporting it again fixes it. line_up: our model came in after this was placed; Line up places it now. */
  readonly alignmentRemedy: "reexport_host" | "line_up" | null;
  /** When the version became ready (compared with the last position save). */
  readonly readyAt: string | null;
}

export interface PlacementAdjustment {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rotationDeg: number;
}

export interface LinkedReferenceView {
  readonly id: string;
  readonly label: string;
  /** The first of `disciplines` (what readers of one value use). */
  readonly discipline: LinkedDiscipline;
  /** Every discipline it shows, first = `discipline` (read with `disciplinesOf`). */
  readonly disciplines?: readonly LinkedDiscipline[];
  /** The company and contact who contributed it, when someone said. */
  readonly contributor?: LinkedContributor | null;
  readonly source: LinkedSource;
  /** The project's own connected Revit model (listed first), not one of its links or an upload. */
  readonly isProjectModel: boolean;
  readonly currentVersionId: string | null;
  /** Newest first. */
  readonly versions: readonly LinkedVersionView[];
  readonly adjustment: PlacementAdjustment;
  /** When the adjustment was last saved. */
  readonly adjustedAt: string | null;
  /** Picked from Autodesk Docs: the file and the Docs version its newest export came from. */
  readonly docsItem: { readonly fileName: string; readonly versionNumber: number | null } | null;
}

export interface MissingLinkView {
  readonly title: string;
  readonly reason: string;
  /** What Revit itself reported, when the export recorded it. */
  readonly detail?: string;
}

/** An element Revit's IFC exporter named when it failed, or that the add-in left out to finish. */
export interface ExportFailureElementView {
  readonly id: string;
  readonly category: string | null;
  readonly family: string | null;
  readonly type: string | null;
  readonly reason: string;
}

/** One Autodesk run of a job (a job can run twice when Revit crashed and it retried automatically). */
export interface ExportAttemptView {
  readonly attempt: number;
  readonly autodeskJobId: string;
  readonly autodeskStatus: string;
  readonly finishedAt: string;
  readonly outcome: "succeeded" | "revit_crashed" | "failed";
  /** The exception, or how Revit crashed. */
  readonly headline: string | null;
}

/** Why an export from Revit failed, read from Autodesk's job report when it finished. */
export interface ExportFailureDetailsView {
  /** False when no report was kept for this attempt (it ran before reports were stored). */
  readonly recorded: boolean;
  /** Autodesk's job id (Design Automation work item), for Autodesk support. */
  readonly autodeskJobId: string | null;
  readonly autodeskStatus: string | null;
  readonly engineYear: number | null;
  readonly attempt: number | null;
  readonly finishedAt: string | null;
  /** The step that failed, as the add-in or the report names it. */
  readonly step: string | null;
  /** The exception, "Type: message". */
  readonly exception: string | null;
  /** How Revit itself stopped, when it crashed. */
  readonly crash: string | null;
  readonly elements: readonly ExportFailureElementView[];
  readonly skippedElements: readonly ExportFailureElementView[];
  readonly reportFetched: boolean;
  readonly reportError: string | null;
  /** Every Autodesk run of this job, oldest first. */
  readonly attempts: readonly ExportAttemptView[];
}

export interface AutodeskExportView {
  readonly id: string;
  readonly status: JobStatus;
  readonly error: string | null;
  /** Set when the export failed. */
  readonly details: ExportFailureDetailsView | null;
  /** Set when it finished after an automatic retry ("Revit crashed during the export; retried automatically."). */
  readonly notice: string | null;
  readonly createdAt: string;
  /** Revit links the export found but could not bring in, with why. */
  readonly missingLinks: readonly MissingLinkView[];
  /** The finished export found no Revit links in the connected model at all. */
  readonly foundNoRevitLinks: boolean;
  /** The add-in's post-run check found elements still borrowed by the Autodesk login it ran as (null when none). */
  readonly leftLocks?: string | null;
}

/** How a linked model is updated from its source. */
export type LinkedRefreshKind = "project_model" | "revit_link" | "docs_item" | "upload";

export function refreshKindOfView(ref: Pick<LinkedReferenceView, "source" | "isProjectModel">): LinkedRefreshKind {
  if (ref.source === "autodesk_docs_item") return "docs_item";
  if (ref.source === "autodesk_docs") return ref.isProjectModel ? "project_model" : "revit_link";
  return "upload";
}

/** Whether a linked model is behind its source in Autodesk Docs. */
export interface LinkedFreshnessView {
  readonly referenceId: string;
  readonly kind: LinkedRefreshKind;
  readonly state: "up_to_date" | "newer_available" | "never_recorded" | "updating" | "unknown" | "manual";
  /** The Docs version the model in the Building Model came from (our model's, for a Revit link). */
  readonly exportedDocsVersion: number | null;
  /** The newest version in Autodesk Docs. */
  readonly latestDocsVersion: number | null;
  readonly latestPublishedAt: string | null;
  /** When its newest version finished coming in. */
  readonly lastUpdatedAt: string | null;
  /** Why Docs couldn't be checked, in words a person can act on. */
  readonly problem: string | null;
}

export interface LinkedUpdateOutcome {
  readonly kind: LinkedRefreshKind;
  readonly outcome: "up_to_date" | "queued" | "already_running";
  readonly latestDocsVersion: number | null;
}

/** The line under a linked model that says how current it is. */
export function freshnessLabel(f: LinkedFreshnessView, hostName: string): string {
  const updated = f.lastUpdatedAt ? `Updated ${new Date(f.lastUpdatedAt).toLocaleDateString()}` : "Not in yet";
  const via = f.kind === "revit_link" ? ` (comes in with ${hostName})` : "";
  switch (f.state) {
    case "manual":
      return `${updated} · uploaded IFC; upload its new version to update it`;
    case "updating":
      return "Updating from Revit…";
    case "up_to_date":
      return `${updated} · up to date with Autodesk Docs${f.latestDocsVersion !== null ? ` version ${f.latestDocsVersion}` : ""}${via}`;
    case "newer_available":
      return `Newer version in Autodesk Docs${f.latestDocsVersion !== null ? ` (version ${f.latestDocsVersion}` : " ("}${f.exportedDocsVersion !== null ? `; this is version ${f.exportedDocsVersion})` : ")"}${via}`;
    case "never_recorded":
      return `${updated} · not sure it's the newest: it came in before versions were tracked. Update to be sure${via}`;
    case "unknown":
      return `${updated} · couldn't check Autodesk Docs${f.problem ? `: ${f.problem}` : ""}`;
  }
}

/** What to tell the person after they press Update from Revit. */
export function updateOutcomeMessage(label: string, result: LinkedUpdateOutcome, hostName: string): string {
  if (result.outcome === "up_to_date") return `${label} is already the newest version in Autodesk Docs${result.latestDocsVersion !== null ? ` (version ${result.latestDocsVersion})` : ""}.`;
  if (result.outcome === "already_running") return `${label} is already updating.`;
  return result.kind === "docs_item"
    ? `Updating ${label} from Autodesk Docs (usually 2–5 minutes)…`
    : `Exporting ${hostName} from Revit; it and every model linked in it update together (usually 2–5 minutes)…`;
}

/** A model whose newest version finished coming in since the last look, for a success or failure message. */
export interface FinishedUpdate {
  readonly referenceId: string;
  readonly label: string;
  readonly versionNumber: number;
  readonly status: "ready" | "failed";
  readonly error: string | null;
}

/** Newest versions that were coming in at `before` and are now ready or failed. */
export function finishedUpdates(before: LinkedModelsResponse | null, after: LinkedModelsResponse): FinishedUpdate[] {
  if (!before) return [];
  const wasInProgress = new Set(before.references.flatMap((r) => r.versions.filter((v) => isInProgress(v.status)).map((v) => v.id)));
  return after.references.flatMap((r) => {
    const v = r.versions[0];
    if (!v || !wasInProgress.has(v.id) || (v.status !== "ready" && v.status !== "failed")) return [];
    return [{ referenceId: r.id, label: r.label, versionNumber: v.number, status: v.status, error: v.error }];
  });
}

/** A file picked from Autodesk Docs that is still coming in, or that failed last time. */
export interface DocsImportView {
  readonly jobId: string;
  readonly itemId: string;
  readonly fileName: string;
  readonly label: string;
  readonly discipline: LinkedDiscipline;
  readonly disciplines?: readonly LinkedDiscipline[];
  readonly status: JobStatus;
  readonly error: string | null;
  /** Set when the import failed. */
  readonly details: ExportFailureDetailsView | null;
  /** Set when it came in after an automatic retry. */
  readonly notice: string | null;
  /** The linked model it adds a version to, when it already exists. */
  readonly referenceId: string | null;
}

export interface LinkedModelsResponse {
  readonly canEdit: boolean;
  /** The project's connected Revit model, when there is one (its Docs project is where "Add from Autodesk Docs" browses). */
  readonly revitModel: { readonly name: string } | null;
  readonly references: readonly LinkedReferenceView[];
  /** The newest Autodesk export while it runs or when it failed last. */
  readonly autodeskExport: AutodeskExportView | null;
  /** Docs files still coming in or failed, newest first. */
  readonly docsImports: readonly DocsImportView[];
}

export interface StartUploadRequest {
  readonly fileName: string;
  readonly bytes: number;
  readonly label: string;
  readonly discipline: LinkedDiscipline;
  /** Every discipline it shows, `discipline` first; omit for one. */
  readonly disciplines?: readonly LinkedDiscipline[];
  readonly contributor?: LinkedContributorInput;
  /** Who sent the file when it isn't the uploader's own, e.g. "Acme Architects, by email". */
  readonly suppliedByName?: string;
  /** Set to add a new version to an existing reference. */
  readonly referenceId?: string;
}

export interface StartUploadResponse {
  readonly referenceId: string;
  readonly versionId: string;
  /** The one storage path this upload may be written to (with the person's own session). */
  readonly sourcePath: string;
}

export const PLACEMENT_BASIS_LABEL: Readonly<Record<PlacementBasis, string>> = {
  revit_link: "Placed where it's linked in Revit",
  revit_shared_coordinates: "Placed by Revit shared coordinates",
  file_georeference: "Placed from the file's location data",
  file_origin: "Placed at the file's origin — not lined up with the project model",
};

export const isUsable = (v: Pick<LinkedVersionView, "status" | "reviewState">): boolean => v.status === "ready" && v.reviewState === "accepted";

export function versionStatusLabel(version: Pick<LinkedVersionView, "status" | "error"> & Partial<Pick<LinkedVersionView, "reviewState">>): string {
  if (version.reviewState === "submitted" && version.status !== "failed") return "Submitted, waiting for PermitZIP to accept it";
  if (version.reviewState === "rejected") return "Not accepted";
  switch (version.status) {
    case "awaiting_upload":
      return "Upload didn't finish";
    case "abandoned":
      return version.error ?? "The upload didn't finish. Upload the file again.";
    case "queued":
      return "Waiting to convert";
    case "converting":
      return "Converting for the 3D view…";
    case "ready":
      return "Ready";
    case "failed":
      return version.error ?? "Couldn't be converted";
  }
}

export function exportStatusLabel(job: Pick<AutodeskExportView, "status" | "error">): string {
  switch (job.status) {
    case "queued":
      return "Waiting for Autodesk…";
    case "running":
      return "Exporting from Revit (usually 2–5 minutes)…";
    case "done":
      return "Revit models are in";
    case "failed":
      return job.error ?? "The export from Revit didn't finish";
  }
}

export function docsImportStatusLabel(job: Pick<DocsImportView, "status" | "error" | "fileName">): string {
  const revit = /\.rvt$/i.test(job.fileName);
  switch (job.status) {
    case "queued":
      return "Waiting to start…";
    case "running":
      return revit ? "Exporting from Revit (usually 2–5 minutes)…" : "Downloading from Autodesk Docs…";
    case "done":
      return "In";
    case "failed":
      return job.error ?? (revit ? "The export from Revit didn't finish" : "The download from Autodesk Docs didn't finish");
  }
}

export const isInProgress = (status: VersionStatus | JobStatus): boolean =>
  status === "queued" || status === "converting" || status === "running";

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Why this file can't be linked, in the person's words; null when it can. */
export function uploadProblem(file: { readonly name: string; readonly size: number }): string | null {
  if (!/\.ifc$/i.test(file.name)) return "Choose an IFC file (.ifc). Export one from Revit with File → Export → IFC.";
  if (file.size === 0) return "That file is empty.";
  if (file.size > MAX_UPLOAD_BYTES) return `This file is ${formatBytes(file.size)}; the most you can upload is 1 GB.`;
  if (file.size > MAX_CONVERT_BYTES) {
    return `This file is too large to show yet (${formatBytes(file.size)}; the limit for now is 150 MB). Export just the architecture, or one building or phase at a time.`;
  }
  return null;
}

export function tooLargeToConvertMessage(bytes: number): string {
  return `This file is too large to show yet (${formatBytes(bytes)}; the limit for now is 150 MB). Upload a smaller export, such as one building or phase.`;
}

/**
 * The shown version's position state: automatic placement, needs lining up,
 * lined up by hand, or a replacement to check. A model sitting at its file's
 * origin is never "In position", whatever the version recorded.
 */
export function alignmentState(
  version: Pick<LinkedVersionView, "alignment" | "readyAt"> & Partial<Pick<LinkedVersionView, "placementBasis">>,
  reference: Pick<LinkedReferenceView, "adjustment" | "adjustedAt"> & Partial<Pick<LinkedReferenceView, "isProjectModel">>,
): AlignmentState | null {
  const adjusted = reference.adjustment.x !== 0 || reference.adjustment.y !== 0 || reference.adjustment.z !== 0 || reference.adjustment.rotationDeg !== 0;
  switch (version.alignment) {
    case "pending":
      return null;
    case "automatic":
      if (version.placementBasis === "file_origin" && reference.isProjectModel !== true) return adjusted ? "aligned_by_hand" : "needs_alignment";
      return "placed";
    case "needs_alignment":
      return adjusted ? "aligned_by_hand" : "needs_alignment";
    case "review": {
      const savedSince = reference.adjustedAt !== null && version.readyAt !== null && Date.parse(reference.adjustedAt) > Date.parse(version.readyAt);
      return savedSince ? "aligned_by_hand" : "review";
    }
  }
}

export const ALIGNMENT_LABEL: Readonly<Record<AlignmentState, string>> = {
  placed: "In position",
  needs_alignment: "Needs alignment",
  aligned_by_hand: "Lined up by hand",
  review: "Review alignment",
};

// ── Add from Autodesk Docs ───────────────────────────────────────────────────

/** What a Docs file is, by its extension. Revit and IFC can be linked; Navisworks can't be shown. */
export type DocsFileKind = "rvt" | "ifc" | "nwc" | "other";

export function docsFileKind(name: string): DocsFileKind {
  if (/\.rvt$/i.test(name)) return "rvt";
  if (/\.ifc$/i.test(name)) return "ifc";
  if (/\.nw[cd]$/i.test(name)) return "nwc";
  return "other";
}

export interface DocsFolderView {
  readonly id: string;
  readonly name: string;
}

export interface DocsFileView {
  /** The Docs item (lineage) id: what the linked model is keyed by. */
  readonly itemId: string;
  readonly name: string;
  readonly kind: DocsFileKind;
  readonly versionNumber: number | null;
  readonly lastModified: string | null;
  readonly bytes: number | null;
  /** Revit: published from Revit cloud worksharing, so Autodesk can open it for us. */
  readonly isCloudModel: boolean;
  /** Revit: the release it is saved in, when Autodesk says. */
  readonly revitYear: number | null;
  /** The folder it is in (search results come from anywhere below the folder searched). */
  readonly folderPath: string | null;
  /** Already linked: the linked model it would add a version to. */
  readonly linked: { readonly referenceId: string; readonly label: string } | null;
  /** Why it can't be added, in the person's words; null when it can. */
  readonly blockedReason: string | null;
}

export interface DocsBrowseResponse {
  readonly folders: readonly DocsFolderView[];
  readonly files: readonly DocsFileView[];
}

export interface DocsAddItem {
  readonly itemId: string;
  readonly label: string;
  readonly discipline: LinkedDiscipline;
  /** Every discipline it shows, `discipline` first; omit for one. */
  readonly disciplines?: readonly LinkedDiscipline[];
  readonly contributor?: LinkedContributorInput;
}

export interface DocsAddResult {
  readonly itemId: string;
  readonly outcome: "queued" | "already_running";
}

export const UPLOADED_RVT_REASON =
  "This Revit file was uploaded to Docs rather than published from Revit, so Autodesk can't open it for us. Open it in Revit, export an IFC, and use Upload IFC.";
export const NAVISWORKS_REASON = "Navisworks files can't be shown yet. Ask for the Revit model or an IFC export instead.";
export const PROJECT_MODEL_REASON =
  "This is the project's own Revit model, so it isn't added as a linked model. It comes in by itself once it's connected; its card at the top of Linked models shows how it's going.";

/** What a Docs file probably shows, from its name; the person can change it before adding. */
export function guessDiscipline(fileName: string): LinkedDiscipline {
  const name = fileName.replace(/\.[a-z0-9]+$/i, "").replace(/[_\-.]+/g, " ");
  if (/\b(arch|archi|architect\w*|architectural|arc|ar|a)\b/i.test(name)) return "architecture";
  if (/\b(struct\w*|str|s)\b/i.test(name)) return "structure";
  if (/\b(mep|mech\w*|elec\w*|plumb\w*|hvac|fp|fire|m|e|p)\b/i.test(name)) return "mep";
  return "other";
}

function elementLine(e: ExportFailureElementView): string {
  const what = [e.category, e.family && e.type ? `${e.family} : ${e.type}` : (e.family ?? e.type)].filter(Boolean).join(" · ");
  return `element ${e.id}${what ? ` (${what})` : ""}: ${e.reason}`;
}

/** The element list a person reads: id, then category and family : type when known. */
export function exportFailureElementLabel(e: ExportFailureElementView): string {
  return elementLine(e);
}

/** Plain text for "Copy for support": what was being done, Autodesk's job id, and what Revit reported. */
export function exportFailureSupportText(what: { readonly title: string; readonly jobId: string; readonly error: string | null }, d: ExportFailureDetailsView): string {
  const lines = [`Building Model export failure: ${what.title}`, `Host job: ${what.jobId}`];
  if (what.error) lines.push(`Shown to the person: ${what.error}`);
  if (!d.recorded) {
    lines.push("No Autodesk report was kept for this attempt.");
    return lines.join("\n");
  }
  lines.push(`Autodesk job (Design Automation work item): ${d.autodeskJobId ?? "unknown"} — ${d.autodeskStatus ?? "unknown"}${d.engineYear ? `, Revit ${d.engineYear} engine` : ""}${d.attempt ? `, attempt ${d.attempt}` : ""}${d.finishedAt ? `, finished ${d.finishedAt}` : ""}`);
  if (d.step) lines.push(`Failed step: ${d.step}`);
  if (d.crash) lines.push(`Revit: ${d.crash}`);
  if (d.exception) lines.push(`Exception: ${d.exception}`);
  if (d.elements.length > 0) lines.push("Elements named:", ...d.elements.map((e) => `  ${elementLine(e)}`));
  if (d.skippedElements.length > 0) lines.push("Elements skipped to finish the export:", ...d.skippedElements.map((e) => `  ${elementLine(e)}`));
  if (!d.reportFetched) lines.push(`Report: not downloaded (${d.reportError ?? "unknown reason"})`);
  if (d.attempts.length > 1) {
    lines.push("Attempts:", ...d.attempts.map((a) => `  ${a.attempt}. Autodesk job ${a.autodeskJobId} — ${a.autodeskStatus}, ${a.outcome.replace("_", " ")}${a.headline ? `: ${a.headline}` : ""}`));
  }
  return lines.join("\n");
}
