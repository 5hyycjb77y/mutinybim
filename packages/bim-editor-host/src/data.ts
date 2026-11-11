/**
 * The editor's server requests, one optional port per capability (linked
 * models, title blocks, sign-off, questions, firm library, …). A host leaves
 * out a port it cannot serve; the editor then shows, in plain words, what the
 * feature needs and where to connect it (`EditorHostCapabilities`), never an
 * error.
 *
 * Each method takes what the editor sends, typed, and resolves to the host's
 * answer as the editor reads it: whether it worked, its status number (the
 * editor tells "you may not" from "it broke" with it) and the JSON body. The
 * editor checks every body's shape itself, so a host only has to answer with
 * the same JSON its server would. A method rejects only when no answer came
 * at all (offline); the editor says so in its own words.
 */

/** A host's answer to one request. A `fetch` `Response` is one. */
export interface EditorDataAnswer {
  readonly ok: boolean
  /** 200 when it worked; 401/403 when the person may not; 404 when it's gone; 409 when someone else changed it first. */
  readonly status: number
  /** The body. Rejects when it isn't JSON. */
  json(): Promise<unknown>
  /** The body as text ("" when there is none). Read either this or `json`, once. */
  text(): Promise<string>
}

/** A file's bytes from a host (a picture on a sheet). A `fetch` `Response` is one. */
export interface EditorFileAnswer {
  readonly ok: boolean
  readonly status: number
  arrayBuffer(): Promise<ArrayBuffer>
}

/** A JSON object the editor sends as a request body. */
export type EditorRequestBody = { readonly [key: string]: unknown }

export interface EditorRequestOptions {
  readonly signal?: AbortSignal
}

/** Live blocks placed on sheets, checked against their latest issue. */
export interface EditorBlocksPort {
  freshness(input: { readonly projectId: string; readonly modelId: string; /** Sheet ids joined with commas; empty for every sheet. */ readonly sheets: string }, options: EditorRequestOptions): Promise<EditorDataAnswer>
}

/** The branch an agent thread works on (its bookmark), so the page can follow it. */
export interface EditorThreadBranchPort {
  /** Body: `{ branchId: string | null }`. */
  read(input: { readonly projectId: string; readonly threadId: string }): Promise<EditorDataAnswer>
}

/** A code-study requirement linked to something in the model, as the host stores it. */
export interface EditorRequirementLink {
  readonly requirement_id: string
  readonly model_id: string
  readonly target_kind: string
  readonly target_id: string
  readonly link_kind: string
}

/** The project's code study: its rules as a requirements snapshot, links, offered overrides, and write-back. */
export interface EditorCodeStudyPort {
  /**
   * snapshot: `{ ok: true, revision, snapshot }`; revision: `{ ok: true, revision }`; links: `{ links: EditorRequirementLink[] }`;
   * offers: `{ offers: [...] }`; rights: `{ canVerify }`. 403 when the person can't read it.
   */
  read(input: { readonly projectId: string; readonly part: "snapshot" | "revision" | "links" | "offers" | "rights" }, options: EditorRequestOptions): Promise<EditorDataAnswer>
  /** One write-back (`payload.action`: record_determination, offer_override, verify_rule, link_requirement, unlink_requirement, decide_override). Body: `{ ok: true, note? }` or `{ ok: false, reason }`. */
  write(input: { readonly projectId: string; readonly payload: EditorRequestBody }): Promise<EditorDataAnswer>
}

/** Manage › Coordination: the person's lint settings, accepted findings and the linked models' index. */
export interface EditorCoordinationPort {
  /** Body: `{ settings, acceptances, linked, linkedNote, projectName }`. */
  read(input: { readonly projectId: string; readonly modelId: string }): Promise<EditorDataAnswer>
  /** `body.action`: accept, retract or settings. Body: `{ acceptances?, settings? }`. */
  save(input: { readonly projectId: string; readonly modelId: string; readonly body: EditorRequestBody }): Promise<EditorDataAnswer>
}

/**
 * The firm's (and a project's) library: classes, disciplines, tag types,
 * design limits, lookup tables, shared fields, part types and schedule
 * templates. Scopes are `firm` or `project:<id>`. Publishing answers 403 with
 * `{ error }` where the person (or the host) can't save.
 */
export interface EditorFirmLibraryPort {
  /** Body: `{ scopes, capabilities }`. */
  scopes(): Promise<EditorDataAnswer>
  /** One item type in one scope. Body: `{ items: [...] }`. */
  listOfType(input: { readonly scope: string; readonly type: string }): Promise<EditorDataAnswer>
  /** A search across one scope. Body: `{ items: [...] }`. */
  search(query: { readonly scope: string; readonly type?: string; readonly text?: string; readonly includeDeprecated?: boolean }): Promise<EditorDataAnswer>
  /** Save one item revision (`baseRevision` 0 for a new one). Body: a publish result, or `{ error }` / `{ message }`; 409 when someone changed it first. */
  publish(input: { readonly scope: string; readonly item: unknown; readonly baseRevision: number }): Promise<EditorDataAnswer>
  /** The firm's and the project's shared fields. Body: `{ fields, project? }`. */
  fields(input: { readonly projectId: string }): Promise<EditorDataAnswer>
  /** Every part type with its revisions. Body: `{ canPublish, partTypes }`. */
  partTypes(): Promise<EditorDataAnswer>
  /** Publish a drawn part type as its next revision. Body: `{ status: 'saved', summary }`, `{ status: 'up_to_date', revision }` or `{ message }`. */
  publishPartType(input: { readonly definition: unknown }): Promise<EditorDataAnswer>
  /** Save a part type imported from a Revit parameter export. Body on refusal: `{ error }`. */
  importPartType(input: { readonly definition: unknown }): Promise<EditorDataAnswer>
  /** The firm part library Place part offers. Body: `{ canWrite, parts: [{ definition }] }`; 401/403 when the person has no firm library. The part editor saves to it with `importPartType`. */
  firmParts(): Promise<EditorDataAnswer>
  /** The firm's schedule templates. Body: `{ canWrite, firm: [...] }`; 401/403 when the person can't read them. */
  scheduleTemplates(): Promise<EditorDataAnswer>
  saveScheduleTemplate(input: { readonly kind: string; readonly name: string; readonly template: unknown; readonly makeDefault: boolean }): Promise<EditorDataAnswer>
}

/** The codes a project has adopted, as its code study records them. */
export interface EditorCodeAdoptionPort {
  /** Body: `{ adopted_codes: [{ discipline, code_name, edition, status }] }`; 401/403 when the person can't read it. */
  read(input: { readonly projectId: string }): Promise<EditorDataAnswer>
}

/** Export IFC: the model's IFC exports, starting one, and a download link. */
export interface EditorIfcExportPort {
  /** Body: `{ exports: [...] }`. */
  list(input: { readonly projectId: string }): Promise<EditorDataAnswer>
  /** Body: the new export. */
  start(input: { readonly projectId: string; readonly modelId: string }): Promise<EditorDataAnswer>
  /** Body: `{ url }`. */
  download(input: { readonly projectId: string; readonly artifactId: string }): Promise<EditorDataAnswer>
}

/** Propose changes to this model from a linked model's IFC (an agreement, a run, its progress). */
export interface EditorIfcImportPort {
  state(input: { readonly projectId: string; readonly referenceId: string }, options: EditorRequestOptions): Promise<EditorDataAnswer>
  start(input: { readonly projectId: string; readonly referenceId: string; readonly body: unknown }): Promise<EditorDataAnswer>
  progress(input: { readonly projectId: string; readonly referenceId: string; readonly runId: string; readonly jobId: string }): Promise<EditorDataAnswer>
  /** Body: `{ ok }`. */
  stop(input: { readonly projectId: string; readonly referenceId: string; readonly runId: string }): Promise<EditorDataAnswer>
}

/** Storeys of the linked models, placed in this model. */
export interface EditorLevelsPort {
  linked(input: { readonly projectId: string }, options: EditorRequestOptions): Promise<EditorDataAnswer>
}

/** The firm's title blocks, as the sheet dialog and Settings list them. */
export interface EditorTitleBlocksPort {
  /** Body: `{ choices: [{ id, name, paperName, row, isDefault }], defaultId, canWrite }`. */
  list(): Promise<EditorDataAnswer>
  makeDefault(input: { readonly id: string }): Promise<EditorDataAnswer>
}

/** Print set and Issue set: the host prints and issues, and keeps the set's history. */
export interface EditorDrawingSetsPort {
  /** Body: `{ check, history, codeCheck? }`. */
  status(input: { readonly projectId: string; readonly modelId: string; readonly sheets?: readonly string[] }): Promise<EditorDataAnswer>
  print(input: { readonly projectId: string; readonly modelId: string; readonly input: { readonly sheets?: readonly string[]; readonly title?: string } }): Promise<EditorDataAnswer>
  issue(input: { readonly projectId: string; readonly modelId: string; readonly input: { readonly name: string; readonly expectedRevision: number; readonly sheets?: readonly string[]; readonly addRevision?: unknown; readonly acceptChangesSincePrint?: boolean } }): Promise<EditorDataAnswer>
}

/** Pictures placed on sheets: kept as files of the project, read through a short-lived link. */
export interface EditorSheetImagesPort {
  /** Body: `{ download_url, download_error?, error? }`; 404 when the file is gone. */
  link(input: { readonly projectId: string; readonly fileId: string }): Promise<EditorDataAnswer>
  /** The bytes behind a link `link` gave. */
  bytes(input: { readonly url: string }): Promise<EditorFileAnswer>
  /** Body: `{ results: [{ ok, id?, error? }], error? }`; 403 when the person can't add files. */
  upload(input: { readonly projectId: string; readonly file: Blob }): Promise<EditorDataAnswer>
}

/** An upload in flight: `done` settles when it finishes; a cancelled one rejects with an Error named `AbortError`. */
export interface EditorUploadHandle {
  readonly done: Promise<void>
  cancel(): void
}

/**
 * Linked reference models: the list, placement and unlinking, plus one group
 * of methods per place a model can be linked from. A host leaves out the
 * groups it cannot serve, and the editor offers only the sources whose whole
 * group is there:
 *
 * - an uploaded IFC file: `startUpload`, `putFile`, `convert`
 * - the project's connected Revit model and its links: `autodeskExport`, `updateFromRevit`
 * - files picked from Autodesk Docs: `browseDocs`, `addDocs`, `refreshDocs`, `lineUp`
 */
export interface EditorLinkedModelsPort {
  /** Body: `{ canEdit, references, revitModel, autodeskExport }`. */
  list(input: { readonly projectId: string }, options: EditorRequestOptions): Promise<EditorDataAnswer>
  /** Body: `{ referenceId, versionId, sourcePath }`. */
  startUpload?(input: { readonly projectId: string; readonly request: unknown }): Promise<EditorDataAnswer>
  /** Upload the file to `sourcePath` (from `startUpload`), reporting progress 0–1. Rejects in words a person can act on (signed out). */
  putFile?(input: { readonly sourcePath: string; readonly file: Blob }, onProgress: (fraction: number) => void): Promise<EditorUploadHandle>
  /** Queue (or retry) the conversion of an uploaded version. Body: `{ ok: true }`. */
  convert?(input: { readonly projectId: string; readonly versionId: string }): Promise<EditorDataAnswer>
  autodeskExport?(input: { readonly projectId: string }): Promise<EditorDataAnswer>
  /** Body: `{ folders, files }`. */
  browseDocs?(input: { readonly projectId: string; readonly request: { readonly folderId: string | null; readonly query?: string } }, options: EditorRequestOptions): Promise<EditorDataAnswer>
  /** Body: `{ results }`. */
  addDocs?(input: { readonly projectId: string; readonly items: readonly unknown[] }): Promise<EditorDataAnswer>
  /** Body: `{ outcome, versionNumber }`. */
  refreshDocs?(input: { readonly projectId: string; readonly referenceId: string; readonly mode: "check" | "relink" }): Promise<EditorDataAnswer>
  /** Whether each linked model is behind its source in Autodesk. Body: `{ models: [{ referenceId, state, ... }] }`. Absent: nothing is checked. */
  freshness?(input: { readonly projectId: string }, options: EditorRequestOptions): Promise<EditorDataAnswer>
  /** Body: `{ outcome, kind }`. */
  updateFromRevit?(input: { readonly projectId: string; readonly referenceId: string; readonly force: boolean }): Promise<EditorDataAnswer>
  lineUp?(input: { readonly projectId: string; readonly referenceId: string }): Promise<EditorDataAnswer>
  update(input: { readonly projectId: string; readonly referenceId: string; readonly patch: unknown }): Promise<EditorDataAnswer>
  unlink(input: { readonly projectId: string; readonly referenceId: string }): Promise<EditorDataAnswer>
}

/** One person's panel layout (collapsed sections, widths), by surface. */
export interface EditorLayoutPrefsPort {
  /** Body: `{ surfaces: [{ surface, collapsed, widthPx }] }`. */
  read(options: EditorRequestOptions): Promise<EditorDataAnswer>
  /** `keepalive`: the page is going away; the save must still land. */
  save(input: { readonly surface: string; readonly collapsed: { readonly [sectionId: string]: boolean }; readonly widthPx: number | null }, options: { readonly keepalive: boolean }): Promise<EditorDataAnswer>
}

/** The model's list schedules, for a tree of the project's things. */
export interface EditorModelSchedulesPort {
  /** Body: `{ views: [{ id, name, listable }] }`. */
  list(input: { readonly projectId: string }, options: EditorRequestOptions): Promise<EditorDataAnswer>
}

/** How one person last left a schedule grid, and which schedule they last opened. */
export interface EditorSchedulePrefsPort {
  /** Body: `{ viewId, columnWidths, frozenColumns, expandedRows, lastOpenedViewId }`. */
  read(input: { readonly projectId: string; readonly viewId: string }, options: EditorRequestOptions): Promise<EditorDataAnswer>
  /** Remember this as the schedule last opened. */
  opened(input: { readonly projectId: string; readonly viewId: string }, options: EditorRequestOptions): Promise<EditorDataAnswer>
  saveColumnWidths(input: { readonly projectId: string; readonly viewId: string; readonly columnWidths: { readonly [column: string]: number } }): Promise<EditorDataAnswer>
}

/** Drawings in the project to trace over: the list, a page's size and picture, its linework. */
export interface EditorUnderlaysPort {
  /** Body: `{ files: [...] }`; 401 signed out, 403 no access. */
  candidates(input: { readonly projectId: string }): Promise<EditorDataAnswer>
  /** Body: the page's size, picture link and `lineworkUrl`. */
  pageInfo(input: { readonly projectId: string; readonly fileId: string; readonly page: number }): Promise<EditorDataAnswer>
  /** `url` is the page's `lineworkUrl`. Body: `{ segments }`. */
  linework(input: { readonly url: string }): Promise<EditorDataAnswer>
}

/** A person's saved Route defaults on a project (and across all projects). */
export interface EditorRouteDefaultsPort {
  /** Body: `{ defaults: [...] }`. */
  read(input: { readonly projectId: string }): Promise<EditorDataAnswer>
  /** `settings` null forgets that scope. Body: `{ defaults: [...] }`. */
  save(input: { readonly projectId: string; readonly domain: string; readonly scope: "project" | "all"; readonly settings: unknown }): Promise<EditorDataAnswer>
}

/** Price books: the firm's and shared rates a schedule or a change can be priced with. */
export interface EditorCostSourcePort {
  /** Body: `{ books: [...] }` (readable on the project when `projectId` is set). */
  list(input: { readonly projectId: string | null }): Promise<EditorDataAnswer>
  read(input: { readonly id: string; readonly projectId: string | null }): Promise<EditorDataAnswer>
  create(input: { readonly organizationId: string; readonly input: object }): Promise<EditorDataAnswer>
  update(input: { readonly id: string; readonly input: unknown }): Promise<EditorDataAnswer>
  remove(input: { readonly id: string }): Promise<EditorDataAnswer>
  replaceRates(input: { readonly id: string; readonly rates: readonly unknown[] }): Promise<EditorDataAnswer>
  shares(input: { readonly id: string }): Promise<EditorDataAnswer>
  shareTargets(input: { readonly id: string; readonly projectId: string }): Promise<EditorDataAnswer>
  share(input: { readonly id: string; readonly organizationId: string; readonly projectId: string }): Promise<EditorDataAnswer>
  unshare(input: { readonly id: string; readonly shareId: string }): Promise<EditorDataAnswer>
}

/** Who is responsible for what on a model, and the merges they approve. Bodies carry `{ error }` on refusal. */
export interface EditorResponsibilitiesPort {
  list(input: { readonly projectId: string }, options: EditorRequestOptions): Promise<EditorDataAnswer>
  name(input: { readonly projectId: string; readonly input: unknown }): Promise<EditorDataAnswer>
  take(input: { readonly projectId: string; readonly input: unknown }): Promise<EditorDataAnswer>
  decideRequest(input: { readonly projectId: string; readonly id: string; readonly input: unknown }): Promise<EditorDataAnswer>
  remove(input: { readonly projectId: string; readonly id: string }): Promise<EditorDataAnswer>
  /** `checkingContext`, when given, is what the acceptance was checked against. */
  accept(input: { readonly projectId: string; readonly id: string; readonly checkingContext?: unknown }): Promise<EditorDataAnswer>
  merges(input: { readonly projectId: string }, options: EditorRequestOptions): Promise<EditorDataAnswer>
  proposeMerge(input: { readonly projectId: string; readonly body: unknown }): Promise<EditorDataAnswer>
  decideMergePart(input: { readonly projectId: string; readonly proposalId: string; readonly input: unknown }): Promise<EditorDataAnswer>
  recordLanded(input: { readonly projectId: string; readonly proposalId: string; readonly input: unknown }): Promise<EditorDataAnswer>
}

/** "What kind of change was this?" and change orders: who they go to, their status, and the ones waiting on the person. No price is ever sent. */
export interface EditorChangeOrdersPort {
  significance(input: { readonly projectId: string }, options: EditorRequestOptions): Promise<EditorDataAnswer>
  classify(input: { readonly projectId: string; readonly body: unknown }): Promise<EditorDataAnswer>
  list(input: { readonly projectId: string }, options: EditorRequestOptions): Promise<EditorDataAnswer>
  read(input: { readonly projectId: string; readonly id: string }, options: EditorRequestOptions): Promise<EditorDataAnswer>
  open(input: { readonly projectId: string; readonly body: unknown }): Promise<EditorDataAnswer>
  setStatus(input: { readonly projectId: string; readonly id: string; readonly input: unknown }): Promise<EditorDataAnswer>
  searchAddressees(input: { readonly projectId: string; readonly q: string }, options: EditorRequestOptions): Promise<EditorDataAnswer>
  /** Give the addressee a login to this project. Body: `{ id }` (their access). */
  invite(input: { readonly projectId: string; readonly email: string }): Promise<EditorDataAnswer>
  /** Record which contact an invite was for. */
  linkInvite(input: { readonly projectId: string; readonly accessId: string; readonly contactId: string }): Promise<EditorDataAnswer>
  /** Sent change orders waiting on the person, on every project. */
  forMe(options: EditorRequestOptions): Promise<EditorDataAnswer>
}

/** Code-of-record changes: the person's notices, a model's approvals, telling the signers, overrides. */
export interface EditorCodeChangePort {
  notices(options: EditorRequestOptions): Promise<EditorDataAnswer>
  markRead(input: { readonly ids: readonly string[] }): Promise<EditorDataAnswer>
  signoffs(input: { readonly projectId: string; readonly modelId: string }, options: EditorRequestOptions): Promise<EditorDataAnswer>
  record(input: { readonly projectId: string; readonly body: unknown }): Promise<EditorDataAnswer>
  override(input: { readonly projectId: string; readonly body: unknown }): Promise<EditorDataAnswer>
}

/** Questions on a model: links to records, notices to the people asked, and sharing a thread with readers. */
export interface EditorQuestionsPort {
  /** Body: `{ links }`. */
  links(input: { readonly projectId: string; readonly modelId: string; readonly recordId: string }): Promise<EditorDataAnswer>
  /** Body: `{ candidates }`. */
  linkCandidates(input: { readonly projectId: string }): Promise<EditorDataAnswer>
  /** Body: `{ link }`. */
  createLink(input: { readonly projectId: string; readonly link: unknown }): Promise<EditorDataAnswer>
  removeLink(input: { readonly projectId: string; readonly linkId: string }): Promise<EditorDataAnswer>
  /** Tell the people a question concerns. Body: `{ written }`. */
  notify(input: { readonly projectId: string; readonly body: unknown }): Promise<EditorDataAnswer>
  /** The person's question notices, on every project. Body: `{ notices }`. */
  forMe(): Promise<EditorDataAnswer>
  /** 404 when already gone. */
  dismiss(input: { readonly ids: readonly string[] }): Promise<EditorDataAnswer>
  /** Body: `{ people }`. */
  people(input: { readonly projectId: string }): Promise<EditorDataAnswer>
  /** Body: `{ readers }`. */
  readers(input: { readonly projectId: string; readonly modelId: string; readonly questionId: string }): Promise<EditorDataAnswer>
  /** Body: `{ name, created }`. */
  addReader(input: { readonly projectId: string; readonly request: unknown }): Promise<EditorDataAnswer>
  removeReader(input: { readonly projectId: string; readonly readerId: string }): Promise<EditorDataAnswer>
  refreshCopy(input: { readonly projectId: string; readonly request: unknown }): Promise<EditorDataAnswer>
  /** Body: `{ threads }`. */
  sharedWithMe(): Promise<EditorDataAnswer>
}

/** Signing sign-off entries: the person's passkeys, an authenticator app, and attaching a signature or a verification. */
export interface EditorSigningPort {
  keys(options: EditorRequestOptions): Promise<EditorDataAnswer>
  /** Body: the passkey enrolment options (`challengeId`, `publicKey`). */
  beginPasskey(): Promise<EditorDataAnswer>
  addPasskey(input: { readonly body: unknown }): Promise<EditorDataAnswer>
  renamePasskey(input: { readonly id: string; readonly label: string }): Promise<EditorDataAnswer>
  removePasskey(input: { readonly id: string }): Promise<EditorDataAnswer>
  /** Body: `{ entries }` about one subject. */
  entries(input: { readonly projectId: string; readonly subjectId: string }, options: EditorRequestOptions): Promise<EditorDataAnswer>
  attachSignature(input: { readonly projectId: string; readonly entryId: string; readonly body: unknown }): Promise<EditorDataAnswer>
  attachVerification(input: { readonly projectId: string; readonly entryId: string; readonly grantId: string }): Promise<EditorDataAnswer>
  beginTotp(): Promise<EditorDataAnswer>
  /** These three answer `{ ok: true | false, ... }` even when the code is refused (400 / 429). */
  confirmTotp(input: { readonly factorId: string; readonly code: string }): Promise<EditorDataAnswer>
  removeTotp(input: { readonly code: string }): Promise<EditorDataAnswer>
  checkTotp(input: { readonly code: string }): Promise<EditorDataAnswer>
}

/** Linked reference models as the open model's config lists them: each one's file, and its element parameters. */
export interface EditorReferencesPort {
  /** The model file behind a reference's `url` (from the session config). */
  bytes(input: { readonly url: string }): Promise<EditorFileAnswer>
  /** A reference's element parameters, or the devices its IFC left out, at a `url` built from `revitParametersUrl`. Body: `{ available, ... }`. */
  read(input: { readonly url: string }): Promise<EditorDataAnswer>
}

/** One person's memory of each view on a project: where they left each 3D view, and whether each view opens on the live model or its printed drawing. */
export interface EditorViewPrefsPort {
  /** Body: `{ cameras: { [viewKey]: camera } }`. */
  cameras(input: { readonly projectId: string }, options: EditorRequestOptions): Promise<EditorDataAnswer>
  /** Remember where one 3D view was left. Sent as the page may be going away: the save must still land. */
  saveCamera(input: { readonly projectId: string; readonly viewKey: string; readonly camera: unknown }): Promise<EditorDataAnswer>
  /** Body: `{ displays: { [viewId]: 'model' | 'drawing' } }`. */
  displays(input: { readonly projectId: string }, options: EditorRequestOptions): Promise<EditorDataAnswer>
  saveDisplay(input: { readonly projectId: string; readonly viewId: string; readonly display: "model" | "drawing" }): Promise<EditorDataAnswer>
}

/** The linked models cut for one drawing view (a plan at its level, a section along its line), drawn under it. */
export interface EditorViewBackgroundsPort {
  /** `request` is the view's cut. Body: `{ backgrounds: [{ plan, label }], skipped: [{ referenceId, label, reason, levelChoice? }] }`, or `{ error }`. */
  cut(input: { readonly projectId: string; readonly request: unknown }): Promise<EditorDataAnswer>
}

/** Manage › Copies › a copy › People: who is named on a contractor's or shop's copy, and naming them. */
export interface EditorCopiesPort {
  /** Body: `{ people: [{ grantId, userId, company, capability, label, … }], candidates: [{ userId, label }] | null }` (null: the viewer may not read the project's roster). */
  people(input: { readonly projectId: string; readonly copyId: string }, options: EditorRequestOptions): Promise<EditorDataAnswer>
  /** Name a person; `capability`: read, propose, review or edit. Body: `{ person }`; 403 with `{ error }` when they may not. */
  name(input: { readonly projectId: string; readonly copyId: string; readonly userId: string; readonly capability: string }): Promise<EditorDataAnswer>
  /** Take someone off the copy. Body: `{ person }`. */
  remove(input: { readonly projectId: string; readonly grantId: string }): Promise<EditorDataAnswer>
}

/** Everything the editor asks of a host's server. Every port is optional. */
export interface EditorDataHost {
  readonly blocks?: EditorBlocksPort
  readonly threadBranch?: EditorThreadBranchPort
  readonly codeStudy?: EditorCodeStudyPort
  readonly coordination?: EditorCoordinationPort
  readonly firmLibrary?: EditorFirmLibraryPort
  readonly codeAdoption?: EditorCodeAdoptionPort
  readonly ifcExport?: EditorIfcExportPort
  readonly ifcImport?: EditorIfcImportPort
  readonly levels?: EditorLevelsPort
  readonly titleBlocks?: EditorTitleBlocksPort
  readonly drawingSets?: EditorDrawingSetsPort
  readonly sheetImages?: EditorSheetImagesPort
  readonly linkedModels?: EditorLinkedModelsPort
  readonly layoutPrefs?: EditorLayoutPrefsPort
  readonly modelSchedules?: EditorModelSchedulesPort
  readonly schedulePrefs?: EditorSchedulePrefsPort
  readonly underlays?: EditorUnderlaysPort
  readonly routeDefaults?: EditorRouteDefaultsPort
  readonly costSource?: EditorCostSourcePort
  readonly responsibilities?: EditorResponsibilitiesPort
  readonly changeOrders?: EditorChangeOrdersPort
  readonly codeChange?: EditorCodeChangePort
  readonly questions?: EditorQuestionsPort
  readonly signing?: EditorSigningPort
  readonly viewPrefs?: EditorViewPrefsPort
  readonly viewBackgrounds?: EditorViewBackgroundsPort
  readonly references?: EditorReferencesPort
  readonly copies?: EditorCopiesPort
}
