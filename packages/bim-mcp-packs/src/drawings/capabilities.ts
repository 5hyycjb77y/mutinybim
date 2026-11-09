import type { Command, ModelState, SheetRevision, ViewBackgrounds, ViewElement } from "@permitzip/bim-kernel";
import type { FiledInProject } from "@permitzip/bim-editor/contracts/bim/filed-in-project";
import type { LinkedModelStoreys } from "@permitzip/bim-editor/contracts/building-model/linked-levels-contract";
import type { Extra } from "../runtime";
import type { FirmClassesSource, SheetImagesFor, StoreSheetPdf } from "../views/capabilities";
import type { ResolveSheetTitle } from "../views/sheet-title";
import type { BlockSnapshotStore } from "./block-snapshots";

/**
 * The host services the drawings tools need beyond the caller: where printed
 * and issued sets are kept, linked-model backgrounds under a drawing, where an
 * issue freezes its live blocks and records each sheet's Verify code, the
 * approvals check before an issue, question notices after a saved question
 * command, and the linked models' storeys for levels.
 */

// ---------------------------------------------------------------------------
// Linked-model backgrounds

export interface LinkedBackgrounds {
  readonly backgrounds: ViewBackgrounds;
  /** Plain words for what could not be cut (the picture still draws without it). */
  readonly missing: readonly string[];
}

/** Linked-model backgrounds for the views a drawing shows; never throws (what can't be cut is named in `missing`). */
export type LinkedBackgroundsFor = (extra: Extra, projectId: string, model: ModelState, views: readonly ViewElement[]) => Promise<LinkedBackgrounds>;

export const NO_LINKED_BACKGROUNDS: LinkedBackgrounds = { backgrounds: {}, missing: [] };

// ---------------------------------------------------------------------------
// Set files

/** The folder an issued PDF is shown in, in the project's files. */
export const ISSUED_FOLDER = "Issued drawings";

export interface StoredFile {
  readonly existed: boolean;
  readonly downloadUrl: string;
  readonly expiresInSeconds: number;
}

export interface ListedFile {
  readonly name: string;
  readonly createdAt: string;
}

export type { FiledInProject };

/** Where a model's printed and issued sets live: write-once files, plus the issued PDF shown in the project's files. */
export interface DrawingSetFiles {
  /** Write once; `existed` when the same path was already stored (a retry). */
  put(path: string, bytes: Uint8Array, contentType: string): Promise<StoredFile>;
  /** Files directly under a folder, newest first (at most `limit`). */
  list(folder: string, limit: number): Promise<ListedFile[]>;
  /** A stored file's bytes; null when it isn't there. */
  read(path: string): Promise<Uint8Array | null>;
  link(path: string): Promise<{ readonly downloadUrl: string; readonly expiresInSeconds: number }>;
  /** Show an issued PDF in the project's files (the stored bytes, not a copy). */
  fileInProject(input: { readonly storagePath: string; readonly name: string; readonly sizeBytes: number; readonly sha256: string; readonly userId: string }): Promise<FiledInProject>;
}

export type DrawingSetFilesFor = (extra: Extra, projectId: string) => DrawingSetFiles;

/** Write-once project file; `existed` when the same path was already stored (a retried issue). */
export type StoreProjectFile = (
  extra: Extra,
  projectId: string,
  path: string,
  bytes: Uint8Array,
  contentType: string,
) => Promise<{ readonly existed: boolean; readonly downloadUrl: string; readonly expiresInSeconds: number }>;

// ---------------------------------------------------------------------------
// Issue records

/** Where an issue freezes its live blocks, as the caller. */
export type BlockSnapshotsFor = (extra: Extra, projectId: string) => Promise<BlockSnapshotStore>;

export interface ReserveSheetsInput {
  readonly projectId: string;
  readonly modelId: string;
  readonly issueId: string;
  readonly issueName: string;
  readonly modelRevision: number;
  readonly issuedAt: string;
  readonly sheets: ReadonlyArray<{ readonly sheetId: string; readonly number: string; readonly title: string; readonly revisions: readonly SheetRevision[] }>;
}

export interface RecordSheetsInput {
  readonly projectId: string;
  readonly modelId: string;
  readonly issueId: string;
  readonly setPdfSha256: string;
  /** The captured model the set was drawn from: which approvals cover which sheet is read against it. */
  readonly model: ModelState;
  readonly sheets: ReadonlyArray<{ readonly sheetId: string; readonly sha256: string; readonly storagePath: string; readonly byteSize: number }>;
}

/** Where each issued sheet's Verify code and fingerprint are recorded. */
export interface IssuedSheetRecorder {
  /** The Verify link to print on each sheet, by sheet id. */
  reserve(input: ReserveSheetsInput): Promise<Record<string, string>>;
  /** Record each sheet's file and fingerprint; returns how many were newly recorded (0 on a retry). */
  record(input: RecordSheetsInput): Promise<number>;
}

export type IssuedSheetRecorderFor = (extra: Extra, projectId: string) => Promise<IssuedSheetRecorder>;

/** The refusal an issue gives when the sheets' approvals were checked against older rules; null when nothing blocks. */
export type IssueApprovalCheck = (extra: Extra, projectId: string, modelId: string, model: ModelState, sheets: readonly string[] | undefined) => Promise<string | null>;

/** Tell the people a saved question command concerns. Never fails the edit: what couldn't be told is named in `failed`. */
export type QuestionNotices = (input: {
  readonly extra: Extra;
  readonly projectId: string;
  readonly modelId: string;
  readonly command: Command;
  readonly saved: ModelState;
}) => Promise<{ readonly written: number; readonly failed?: string }>;

// ---------------------------------------------------------------------------
// Levels

/** The linked models' storeys for this project, read as the caller. */
export type LinkedStoreysFor = (extra: Extra, projectId: string) => Promise<readonly LinkedModelStoreys[]>;

// ---------------------------------------------------------------------------
// The hosts

/** Everything the drawing-set tools (save a previewed edit, views, sheets, layout, print and issue a set) need from their host. */
export interface DrawingSetToolsHost {
  readonly setFiles: DrawingSetFilesFor;
  readonly sheetTitle: ResolveSheetTitle;
  readonly backgrounds: LinkedBackgroundsFor;
  readonly sheetImages: SheetImagesFor;
  readonly blockSnapshots: BlockSnapshotsFor;
  /** Absent: issued sheets print no Verify code. */
  readonly verify?: IssuedSheetRecorderFor;
  readonly issueCheck: IssueApprovalCheck;
  readonly questionNotices: QuestionNotices;
}

/** Everything the picture and view-PDF tools need from their host. */
export interface RenderToolsHost {
  readonly storeSheetPdf: StoreSheetPdf;
  readonly storeProjectFile: StoreProjectFile;
  readonly backgrounds: LinkedBackgroundsFor;
  readonly sheetTitle: ResolveSheetTitle;
  readonly firmClasses: FirmClassesSource;
}
