import { DISCIPLINES_REGISTRY_FEATURE, ORGANIZATION_SETUP_FEATURE, ELEMENT_TYPES_FEATURE, ELEMENTS_CORE_FEATURE, LINKS_DESIGN_FEATURE, PARTITION_DISCIPLINES_FEATURE, PARTS_LINE_HOST_FEATURE, PARTS_PACK_VALUES_FEATURE, PARTS_UNIT_CODES_FEATURE, SPACES_PARAMETER_RATES_FEATURE, PARTS_CONNECTOR_VALUES_FEATURE, SERVICES_REGISTRY_FEATURE, gatedRecordFeatures } from "@permitzip/bim-kernel";
import { PACKS_PINS_FEATURE } from "@permitzip/bim-kernel/packs";
import { QUESTION_ANSWERS_FEATURE, QUESTION_CUSTODY_FEATURE, QUESTION_FORWARD_PERSON_FEATURE, QUESTION_THREADS_FEATURE, SUBMITTAL_DIVERGENCE_FEATURE, SUBMITTAL_RECORDS_FEATURE, VALIDITY_RELIANCE_FEATURE } from "@permitzip/bim-kernel";
import { ACTORS_PROVIDER_FEATURE, BRANCHES_IMPORT_FEATURE, CEILINGS_FEATURE, CONNECTOR_END_TYPES_FEATURE, JOIN_PARTS_FEATURE, KINDS_ADDON_OWNED_FEATURE } from "@permitzip/bim-kernel";
import { KINDS_ADDON_SHAPES_FEATURE, PIPES_ADDON_PRODUCTS_FEATURE, SIGNOFFS_CHECKING_CONTEXT_FEATURE, SIGNOFFS_DISPOSITIONS_FEATURE } from "@permitzip/bim-kernel";
import { FINDINGS_LEDGER_FEATURE } from "@permitzip/bim-kernel/findings";
import { GATES_RECORDS_FEATURE } from "@permitzip/bim-kernel/lifecycle";
import { LINEAGES_ACCEPT_BACK_FEATURE, LINEAGES_REVIEW_FEATURE, LINEAGES_ROLES_FEATURE } from "@permitzip/bim-kernel/lineages";
import { VALUES_BASIS_FEATURE } from "@permitzip/bim-kernel/basis";
import { BLOCKS_CALC_FEATURE, DIAGRAM_FAULT_CURRENT_FEATURE, TYPICALS_MIRROR_FEATURE, VIEW_HASH_MARKS_FEATURE, VIEW_TYP_LABELS_FEATURE } from "@permitzip/bim-kernel";
import { PACKS_OUTSIDE_PINS_FEATURE } from "@permitzip/bim-kernel/packs";
import { DIAGRAM_OPEN_KINDS_FEATURE, LIBRARY_ADDON_ROWS_FEATURE, ROUTING_INSERT_PART_FEATURE, ROUTING_TAP_OFFSET_FEATURE } from "@permitzip/bim-kernel";
import { DOCUMENTS_SHEET_SETS_FEATURE, GEOMETRY_SOLID_PROGRAM_2_FEATURE, PARTS_CLASS_SOLIDS_FEATURE, PROJECT_PARAMETERS_FEATURE, ROUTING_CONNECT_INTO_FEATURE, ROUTING_PLUS_EVERY_RUN_FEATURE, SCHEDULES_EDIT_STEPS_FEATURE, WALLS_TOP_CONSTRAINT_FEATURE, WALLS_SURFACE_BINDING_FEATURE, ANNOTATION_LINKED_ANCHORS_FEATURE, ELEMENTS_LINKED_COPY_FEATURE } from "@permitzip/bim-kernel";
import { DOCUMENTS_PRINT_BLACK_ONLY_FEATURE, LEVELS_STARTER_FEATURE } from "@permitzip/bim-kernel";
import { SCHEDULES_COLUMN_WIDTHS_FEATURE, TAGS_MASK_LEADER_FEATURE, TAGS_SLOPE_ARROW_FEATURE } from "@permitzip/bim-kernel";
import { ELEMENTS_CREATE_FEATURE, PIPES_OPEN_SPECS_FEATURE, ROUTING_TAP_FACES_FEATURE, SPACES_BOUNDED_FEATURE, SPACES_NESTED_FEATURE, SPACES_SEPARATORS_FEATURE } from "@permitzip/bim-kernel";
import { z } from "zod";
import { LINEAGES_DELTA_FEATURE, LINEAGES_GRANTS_FEATURE } from "./lineages/features";
import { BRANCHES_SESSIONS_FEATURE, BRANCHES_STATE_BROADCAST_FEATURE, HISTORY_REVISION_READS_FEATURE } from "./branches/protocol";
import { HISTORY_COVERAGE_READ_FEATURE } from "./branches/coverage";
import { MERGE_FEATURE } from "./merge/messages";
import { QUANTITY_DELTA_FEATURE } from "./delta/messages";

/**
 * Wire protocol version and features (MIGRATION-PLAN §3, "Protocol").
 *
 * `hello` (client → server) and `welcome` (server → client) carry an
 * optional `protocol`. Absent means version 1 with no features: every peer
 * deployed before round 5. A writer emits a newer shape only when the peer
 * advertised the feature for it; the model server advertises what it can
 * store and forward, a client what it can read. Withdrawing a feature is
 * deploying a server that no longer advertises it: clients then write the
 * old shape again.
 */
export const PROTOCOL_VERSION = 2;

export const PROTOCOL_FEATURES = {
  /** Unknown or unreadable messages are answered with an `error` carrying `code` (never dropped). */
  unknownMessageAck: "ack:unknown_message",
  /**
   * Record schema versions: the peer reads `schemaVersion` on records and
   * the upgraded shapes of every gated step it lists (`schema:<kind>@<version>`).
   */
  recordSchemaVersion: "schema:record_version",
  /** The model server stores changeset patches beside full bodies (storage only; the wire still carries full changesets). */
  changesetPatch: "changeset:patch",
  /** The model server loads the head in pages (storage only). */
  pagedBoot: "boot:paged",
  /** Service registry rows new in round 5b (grease and indirect waste systems, fire protection, chilled and heating water): the peer reads and stores them. */
  servicesRegistry: SERVICES_REGISTRY_FEATURE,
  /** Service links carry `adapter` and per-adapter `design` (round 5b): the peer reads and stores them. */
  linksDesign: LINKS_DESIGN_FEATURE,
  /** Part-type connectors carry `values` keyed by parameter keys (round 5b): the peer reads and stores them. */
  partsConnectorValues: PARTS_CONNECTOR_VALUES_FEATURE,
  /** Model settings carry the add-on packs the model uses (round 5c): the peer reads and stores them. */
  packsPins: PACKS_PINS_FEATURE,
  /** Building and structure records carry class, type, values, provenance, placement and lock (round 5c): the peer reads and stores them. */
  elementsCore: ELEMENTS_CORE_FEATURE,
  /** A space's pinned use carries add-on rates keyed by parameter (round 5c): the peer reads and stores them. */
  spacesParameterRates: SPACES_PARAMETER_RATES_FEATURE,
  /** A part's values carry add-on parameters of its class beside its type's (round 5c): the peer reads and stores them. */
  partsPackValues: PARTS_PACK_VALUES_FEATURE,
  /** Part type number parameters carry any bim-units unit code (round 5c): the peer reads and stores them. */
  partsUnitCodes: PARTS_UNIT_CODES_FEATURE,
  /** A part may stand on a line-placed element at a station (round 5c): the peer reads and stores the host. */
  partsLineHost: PARTS_LINE_HOST_FEATURE,
  /** Shared element types for walls, beams, columns, slabs and components (round 5c): the peer reads and stores them. */
  elementTypes: ELEMENT_TYPES_FEATURE,
  /** Partitions store the class discipline of an add-on's or firm's service row (round 5c): the peer reads and stores it. */
  partitionClassDisciplines: PARTITION_DISCIPLINES_FEATURE,
  /** Partitions and views store any registered discipline (`fire_alarm`, a pack's, a firm's), not only the ten class disciplines (round 8). Implies `partitionClassDisciplines`. */
  disciplinesRegistry: DISCIPLINES_REGISTRY_FEATURE,
  /** Organization records carry add-on switches and pinned firm disciplines (round 8): the peer reads and stores them. */
  organizationSetup: ORGANIZATION_SETUP_FEATURE,
  /** Round 9 lane Q9: `question_answer` records with an outcome (reserved in 1.5.0). */
  questionsAnswers: QUESTION_ANSWERS_FEATURE,
  /** Round 9 lane Q9: reply records, authors on questions / answers / replies, declined and not in scope, asker-only Ask again. */
  questionsThreads: QUESTION_THREADS_FEATURE,
  /** Round 9 lane Q9: a question's owner (Take over), former addressees (Forward), kept-closed questions and the asked-before link. */
  questionsCustody: QUESTION_CUSTODY_FEATURE,
  /** Round 10 lane Q10: a forward names one person (`AuthorRef`) as the new addressee, not only words. */
  questionsForwardPerson: QUESTION_FORWARD_PERSON_FEATURE,
  /** Round 9 lane Q9: `submittal` records reviewed per item (reserved in 1.5.0). */
  submittalsRecords: SUBMITTAL_RECORDS_FEATURE,
  /** Round 9 lane Q9: `divergence` records, approved substitutions beside the design (reserved in 1.5.0). */
  submittalsDivergence: SUBMITTAL_DIVERGENCE_FEATURE,
  /** Round 9 lane Q9: records carry what they relied on (`reliance`), so a later revision can say they may no longer hold. */
  validityReliance: VALIDITY_RELIANCE_FEATURE,
  /** Round 9 A9: add-on-owned element kinds in their parameter form. Also a gated record step, so every peer of this release advertises it through `gatedRecordFeatures()`. */
  kindsAddonOwned: KINDS_ADDON_OWNED_FEATURE,
  /** Round 7: `ceiling` records. A gated record step, so every peer of this release advertises it through `gatedRecordFeatures()`; named here so a host that lists the protocol's features (a script's slice) sees it. */
  elementsCeilings: CEILINGS_FEATURE,
  /** Round 9 J9: part-type connectors carry an `endType` from the connector end-type point: the peer reads and stores it. */
  partsConnectorEndTypes: CONNECTOR_END_TYPES_FEATURE,
  /** Round 9 J9: `join_parts`, two parts' connectors (or a part and a load point) joined end to end: the peer reads and stores the links. */
  partsDirectJoins: JOIN_PARTS_FEATURE,
  /** Round 9 S9: a changeset actor's optional `provider` (the identity provider that authorized it): the peer reads and stores it. */
  actorsProvider: ACTORS_PROVIDER_FEATURE,
  /** Round 10 P10: pipe fittings may keep an add-on product's joint by end type (`end_type`): the peer reads and stores it. An older peer gets the stored joint name only. */
  pipesAddonProducts: PIPES_ADDON_PRODUCTS_FEATURE,
  /** Round 10 K10: element kinds whose shape and connector ends come from their add-on's row: the peer reads and stores new records of them. */
  kindsAddonShapes: KINDS_ADDON_SHAPES_FEATURE,
  /** Round 10 C10: sign-off records carry the checking context they were checked against (host log; an older peer keeps payloads untouched). */
  signoffsCheckingContext: SIGNOFFS_CHECKING_CONTEXT_FEATURE,
  /** Round 10 C10: `finding_disposition` events (the signer's override with a reason) in the sign-off chain. */
  signoffsDispositions: SIGNOFFS_DISPOSITIONS_FEATURE,
  /**
   * Round 8b, served features: a server advertises each only when its hub
   * serves it (never in `SERVER_FEATURES`), and a client asks only then.
   * Branch list / create / close and `~` branch sessions; welcome carries the branch.
   */
  branchesSessions: BRANCHES_SESSIONS_FEATURE,
  /** `merge_preview` / `merge_apply` on a branch session. */
  branchesMerge: MERGE_FEATURE,
  /** `state_at` and `changed_between` history reads. */
  historyRevisionReads: HISTORY_REVISION_READS_FEATURE,
  /** `quantity_delta` between two revisions or Main and a branch. */
  historyQuantityDelta: QUANTITY_DELTA_FEATURE,
  /** Round 9 B9: `branch_state` when this session's branch is closed or merged (here or elsewhere). Served with branches; a client reads it. */
  branchesStateBroadcast: BRANCHES_STATE_BROADCAST_FEATURE,
  /** Round 9 B9: `coverage_check`, who covers a change, read by the server from its history (served, never in `SERVER_FEATURES`). */
  historyCoverageRead: HISTORY_COVERAGE_READ_FEATURE,
  /** Round 9 I9: the model server lands a linked IFC model on a new branch (HTTP import; clients never send `import_elements`). Served, never in `SERVER_FEATURES`. */
  branchesImport: BRANCHES_IMPORT_FEATURE,
  /**
   * Round 11 wave 1, reserved: each is advertised only once its writer lands (W11 for copies;
   * the stage and confidence writers in ST11), never in `SERVER_FEATURES` / `CLIENT_FEATURES` before.
   * Copies with a purpose: list, create (any depth), compare.
   */
  lineagesRoles: LINEAGES_ROLES_FEATURE,
  /** `lineage_review`: an outcome on a copy's delta that lands nothing. */
  lineagesReview: LINEAGES_REVIEW_FEATURE,
  /** `lineage_accept_back`: chosen records land on the parent or an ancestor, citing the delta digest. */
  lineagesAcceptBack: LINEAGES_ACCEPT_BACK_FEATURE,
  /** `finding_disposition` model records (the problem list's decisions). */
  findingsLedger: FINDINGS_LEDGER_FEATURE,
  /** `gate` and `stage_plan` records (also gated record steps). */
  gatesRecords: GATES_RECORDS_FEATURE,
  /** `provenance.basis` / `valueBasis` on records (reserved; no writer yet). */
  valuesBasis: VALUES_BASIS_FEATURE,
  /** Round 11 W11, served: per-copy rights (who may edit, propose, review); advertised by a hub that serves it. */
  lineagesGrants: LINEAGES_GRANTS_FEATURE,
  /** Round 16 contractor copies, served: `lineage_delta` (what a review or accept back cites); advertised by a hub that serves copies. */
  lineagesDelta: LINEAGES_DELTA_FEATURE,
  /** Round 12 S12: typical copies may be mirror images; a peer draws and checks them mirrored. */
  typicalsMirror: TYPICALS_MIRROR_FEATURE,
  /** Round 12 S12: a field block may be a live calculation sheet (`calc`): the peer stores and draws it. */
  blocksCalc: BLOCKS_CALC_FEATURE,
  /** Round 12 E12: plan views store wire hash mark styles on their circuit graphics. */
  viewsHashMarks: VIEW_HASH_MARKS_FEATURE,
  /** Round 13 E13: a typical's repeated circuits labelled once ("(3) TYP."), switched per view. */
  viewsTypLabels: VIEW_TYP_LABELS_FEATURE,
  /** Round 12 E12: one-line views store the Show fault current switch. */
  diagramsFaultCurrent: DIAGRAM_FAULT_CURRENT_FEATURE,
  /** Round 13 wave 0: spaces whose outline is found from the bounding elements around a clicked seed (`bounds.kind = "bounded"`). Readers show the stored outline. */
  spacesBounded: SPACES_BOUNDED_FEATURE,
  /** Round 13 wave 0: `space_separator` records (imaginary lines that split a space into sub-rooms). */
  spacesSeparators: SPACES_SEPARATORS_FEATURE,
  /** Round 13 wave 0: spaces and zones nested inside a parent of the same kind (`parentId`). */
  spacesNested: SPACES_NESTED_FEATURE,
  /** Round 13 lane M13: taps placed on any connector face (`{ hostId, face, s, t }`); a peer without it is never sent a top or bottom tap. */
  routingTapFaces: ROUTING_TAP_FACES_FEATURE,
  /** Round 13 lane A13a: the `create_element` / `create_elements` / `create_hosted` command family. */
  elementsCreate: ELEMENTS_CREATE_FEATURE,
  /** Round 13 lane P13: pipe specs by any add-on's id (`pipes:open_specs`); a peer without it is sent only the names the core listed. */
  pipesOpenSpecs: PIPES_OPEN_SPECS_FEATURE,
  /** Round 14: add-ons contribute built-in library rows; the library joins them after the kernel's own (lane K14), advertised by both peers. */
  libraryAddonRows: LIBRARY_ADDON_ROWS_FEATURE,
  /** Round 14: taps off a face's centre line (`HostedOn.t`, lanes K14 / M14); a peer without it is never sent one. */
  routingTapOffset: ROUTING_TAP_OFFSET_FEATURE,
  /** Round 14: a part inserted on a run (a proposed cleanout, valve or damper placed inline, lane P14); it runs existing commands as one batch. */
  routingInsertPart: ROUTING_INSERT_PART_FEATURE,
  /** Round 14: a view's diagram kind is any kind an add-on's layout row draws (lane K14); an older peer is sent only the four round-5 kinds. */
  diagramsOpenKinds: DIAGRAM_OPEN_KINDS_FEATURE,
  /** Round 11 A11, reserved: model pins carry an outside add-on's digest and trust tier. */
  packsOutsidePins: PACKS_OUTSIDE_PINS_FEATURE,
  /**
   * Round 15 wave 0, declared: each is advertised only once its writer and readers land, never in
   * `SERVER_FEATURES` / `CLIENT_FEATURES` before. Part model schema 2, the solid program, and the
   * `script` part source: advertised by both peers since lane G15 built the engine and every reader.
   */
  geometrySolidProgram2: GEOMETRY_SOLID_PROGRAM_2_FEATURE,
  /** `connect_into`: open ends joined into a run in one action (lane K15); advertised by both peers since K15 built it. */
  routingConnectInto: ROUTING_CONNECT_INTO_FEATURE,
  /** Sheet set records and their three commands (lane D15). */
  documentsSheetSets: DOCUMENTS_SHEET_SETS_FEATURE,
  /** `edit_schedule` steps and `insert_library_view` (lane D15). Advertised by both peers since lane SC15 built `edit_schedule`; `insert_library_view` still refuses in words until D15 builds it. */
  schedulesEditSteps: SCHEDULES_EDIT_STEPS_FEATURE,
  /** Round 16 B2: project parameters (`organization` records of type `project_parameter`): the peer reads and stores them. */
  projectParameters: PROJECT_PARAMETERS_FEATURE,
  /** A wall's top tied to a level (lane A15); a peer without it is sent the height it works out to. Advertised by both peers since the Architecture follow-ups built the writer and readers. */
  wallsTopConstraint: WALLS_TOP_CONSTRAINT_FEATURE,
  /** Nov 8: a wall's top or base bound to a surface (the structure above, a ceiling, a roof, the floor under it) and its derived body profile; a peer without it is sent the height and offsets they work out to. Advertised by both peers. */
  wallsSurfaceBinding: WALLS_SURFACE_BINDING_FEATURE,
  /** Bodies by class, `kernel.class_solids` (lane A15). */
  partsClassSolids: PARTS_CLASS_SOLIDS_FEATURE,
  /** Batch 16-B: tags with an opaque background, their own leader choice, name-and-number words, room and space tag styles. */
  tagsMaskLeader: TAGS_MASK_LEADER_FEATURE,
  /** Batch 16-B: `edit_schedule`'s `resize_column` step (a column's width dragged on a sheet). */
  schedulesColumnWidths: SCHEDULES_COLUMN_WIDTHS_FEATURE,
  /** Nov 2026 batch 16-C: the "+" on every run kind, an elbow right at a continued end, and a route finished with flex. No new records; advertised by both peers. */
  routingPlusEveryRun: ROUTING_PLUS_EVERY_RUN_FEATURE,
  /** Nov 2026 plumbing follow-ups: a tag style's `arrow` along its run (towards the lower or higher end); advertised by both peers. */
  tagsSlopeArrow: TAGS_SLOPE_ARROW_FEATURE,
  /** Batch 16-D: a dimension point anchored to a linked model's element by its key (`linked:<model>:<GlobalId>`). No new records; advertised by both peers. */
  annotationLinkedAnchors: ANNOTATION_LINKED_ANCHORS_FEATURE,
  /** Batch 16-D: an element copied from a linked model carries where it came from (`set_element_linked_copy`) and is kept in step on review. Advertised by both peers. */
  elementsLinkedCopy: ELEMENTS_LINKED_COPY_FEATURE,
  /** Round 16 s5a: `ensure_starter_level`, an empty model's Level 1 (`Level.starter`). An older server refuses it in words; the client then asks nothing. Advertised by both peers. */
  levelsStarter: LEVELS_STARTER_FEATURE,
  /** Round 16 s5b: the project's black-only printing choice (`set_print_black_only`, organization settings). Advertised by both peers. */
  documentsPrintBlackOnly: DOCUMENTS_PRINT_BLACK_ONLY_FEATURE,
} as const;

/** The feature a gated record step names: readers of `<kind>` at `<version>`. */
export function recordFeature(kind: string, version: number): string {
  return `schema:${kind}@${version}`;
}

export const protocolSchema = z.object({
  version: z.number().int().min(1).max(1000),
  features: z.array(z.string().min(1).max(100)).max(200),
});
export type Protocol = z.infer<typeof protocolSchema>;

/** Peers that send no `protocol` (deployed before round 5). */
export const LEGACY_PROTOCOL: Protocol = { version: 1, features: [] };

/** What a peer speaks: its advertised protocol, or version 1 with no features. */
export function peerProtocol(advertised: Protocol | undefined): Protocol {
  return advertised ?? LEGACY_PROTOCOL;
}

export function peerHas(protocol: Protocol | undefined, feature: string): boolean {
  return protocol !== undefined && protocol.features.includes(feature);
}

/** Features a client of this release reads. */
export const CLIENT_FEATURES: readonly string[] = [PROTOCOL_FEATURES.unknownMessageAck, PROTOCOL_FEATURES.recordSchemaVersion, PROTOCOL_FEATURES.servicesRegistry, PROTOCOL_FEATURES.linksDesign, PROTOCOL_FEATURES.partsConnectorValues, PROTOCOL_FEATURES.packsPins, PROTOCOL_FEATURES.elementsCore, PROTOCOL_FEATURES.spacesParameterRates, PROTOCOL_FEATURES.partsPackValues, PROTOCOL_FEATURES.partsUnitCodes, PROTOCOL_FEATURES.partsLineHost, PROTOCOL_FEATURES.elementTypes, PROTOCOL_FEATURES.partitionClassDisciplines, PROTOCOL_FEATURES.disciplinesRegistry, PROTOCOL_FEATURES.organizationSetup, PROTOCOL_FEATURES.questionsAnswers, PROTOCOL_FEATURES.questionsThreads, PROTOCOL_FEATURES.questionsCustody, PROTOCOL_FEATURES.questionsForwardPerson, PROTOCOL_FEATURES.submittalsRecords, PROTOCOL_FEATURES.submittalsDivergence, PROTOCOL_FEATURES.validityReliance, PROTOCOL_FEATURES.branchesStateBroadcast, PROTOCOL_FEATURES.kindsAddonOwned, PROTOCOL_FEATURES.partsConnectorEndTypes, PROTOCOL_FEATURES.partsDirectJoins, PROTOCOL_FEATURES.actorsProvider, PROTOCOL_FEATURES.pipesAddonProducts, PROTOCOL_FEATURES.kindsAddonShapes, PROTOCOL_FEATURES.signoffsCheckingContext, PROTOCOL_FEATURES.signoffsDispositions, PROTOCOL_FEATURES.typicalsMirror, PROTOCOL_FEATURES.blocksCalc, PROTOCOL_FEATURES.viewsHashMarks, PROTOCOL_FEATURES.diagramsFaultCurrent, PROTOCOL_FEATURES.spacesBounded, PROTOCOL_FEATURES.spacesSeparators, PROTOCOL_FEATURES.spacesNested, PROTOCOL_FEATURES.elementsCreate, PROTOCOL_FEATURES.viewsTypLabels, PROTOCOL_FEATURES.pipesOpenSpecs, PROTOCOL_FEATURES.routingTapFaces, PROTOCOL_FEATURES.libraryAddonRows, PROTOCOL_FEATURES.routingTapOffset, PROTOCOL_FEATURES.routingInsertPart, PROTOCOL_FEATURES.diagramsOpenKinds, PROTOCOL_FEATURES.routingConnectInto, PROTOCOL_FEATURES.geometrySolidProgram2, PROTOCOL_FEATURES.schedulesEditSteps, PROTOCOL_FEATURES.tagsMaskLeader, PROTOCOL_FEATURES.schedulesColumnWidths, PROTOCOL_FEATURES.projectParameters, PROTOCOL_FEATURES.routingPlusEveryRun, PROTOCOL_FEATURES.tagsSlopeArrow, PROTOCOL_FEATURES.wallsTopConstraint, PROTOCOL_FEATURES.wallsSurfaceBinding, PROTOCOL_FEATURES.annotationLinkedAnchors, PROTOCOL_FEATURES.elementsLinkedCopy, PROTOCOL_FEATURES.levelsStarter, PROTOCOL_FEATURES.documentsPrintBlackOnly];

/** Features a model server of this release stores and forwards. */
export const SERVER_FEATURES: readonly string[] = [PROTOCOL_FEATURES.unknownMessageAck, PROTOCOL_FEATURES.recordSchemaVersion, PROTOCOL_FEATURES.servicesRegistry, PROTOCOL_FEATURES.linksDesign, PROTOCOL_FEATURES.partsConnectorValues, PROTOCOL_FEATURES.packsPins, PROTOCOL_FEATURES.elementsCore, PROTOCOL_FEATURES.spacesParameterRates, PROTOCOL_FEATURES.partsPackValues, PROTOCOL_FEATURES.partsUnitCodes, PROTOCOL_FEATURES.partsLineHost, PROTOCOL_FEATURES.elementTypes, PROTOCOL_FEATURES.partitionClassDisciplines, PROTOCOL_FEATURES.disciplinesRegistry, PROTOCOL_FEATURES.organizationSetup, PROTOCOL_FEATURES.questionsAnswers, PROTOCOL_FEATURES.questionsThreads, PROTOCOL_FEATURES.questionsCustody, PROTOCOL_FEATURES.questionsForwardPerson, PROTOCOL_FEATURES.submittalsRecords, PROTOCOL_FEATURES.submittalsDivergence, PROTOCOL_FEATURES.validityReliance, PROTOCOL_FEATURES.kindsAddonOwned, PROTOCOL_FEATURES.partsConnectorEndTypes, PROTOCOL_FEATURES.partsDirectJoins, PROTOCOL_FEATURES.actorsProvider, PROTOCOL_FEATURES.pipesAddonProducts, PROTOCOL_FEATURES.kindsAddonShapes, PROTOCOL_FEATURES.signoffsCheckingContext, PROTOCOL_FEATURES.signoffsDispositions, PROTOCOL_FEATURES.typicalsMirror, PROTOCOL_FEATURES.blocksCalc, PROTOCOL_FEATURES.viewsHashMarks, PROTOCOL_FEATURES.diagramsFaultCurrent, PROTOCOL_FEATURES.spacesBounded, PROTOCOL_FEATURES.spacesSeparators, PROTOCOL_FEATURES.spacesNested, PROTOCOL_FEATURES.elementsCreate, PROTOCOL_FEATURES.viewsTypLabels, PROTOCOL_FEATURES.pipesOpenSpecs, PROTOCOL_FEATURES.routingTapFaces, PROTOCOL_FEATURES.libraryAddonRows, PROTOCOL_FEATURES.routingTapOffset, PROTOCOL_FEATURES.routingInsertPart, PROTOCOL_FEATURES.diagramsOpenKinds, PROTOCOL_FEATURES.routingConnectInto, PROTOCOL_FEATURES.geometrySolidProgram2, PROTOCOL_FEATURES.schedulesEditSteps, PROTOCOL_FEATURES.tagsMaskLeader, PROTOCOL_FEATURES.schedulesColumnWidths, PROTOCOL_FEATURES.projectParameters, PROTOCOL_FEATURES.routingPlusEveryRun, PROTOCOL_FEATURES.tagsSlopeArrow, PROTOCOL_FEATURES.wallsTopConstraint, PROTOCOL_FEATURES.wallsSurfaceBinding, PROTOCOL_FEATURES.annotationLinkedAnchors, PROTOCOL_FEATURES.elementsLinkedCopy, PROTOCOL_FEATURES.levelsStarter, PROTOCOL_FEATURES.documentsPrintBlackOnly];

/** This client's protocol: the release's features plus every gated record shape its kernel registered (it reads them). */
export function clientProtocol(extra: readonly string[] = []): Protocol {
  return { version: PROTOCOL_VERSION, features: [...new Set([...CLIENT_FEATURES, ...gatedRecordFeatures(), ...extra])] };
}

/** This server's protocol: the release's features plus every gated record shape its kernel registered (it stores and forwards them). */
export function serverProtocol(extra: readonly string[] = []): Protocol {
  return { version: PROTOCOL_VERSION, features: [...new Set([...SERVER_FEATURES, ...gatedRecordFeatures(), ...extra])] };
}
