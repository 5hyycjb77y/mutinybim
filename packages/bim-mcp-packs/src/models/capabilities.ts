import type { IntakeProposal } from "@permitzip/bim-kernel/intake";
import type { RouteDefaultDomain, RouteDefaults } from "@permitzip/bim-editor/contracts/building-model/route-defaults";
import type { DocsAddItem, DocsAddResult, DocsBrowseResponse, LinkedModelsResponse } from "@permitzip/bim-editor/contracts/building-model/linked-contract";
import type { Extra } from "../runtime";
import type { LinkedModelUpdateArgs } from "./linked-models";

/**
 * The host services the models tools need beyond the caller: where linked
 * models are kept (and the document service they are linked from), the
 * firm disciplines the open model pins, the picture reader that turns a
 * schedule picture into rows, and the person's saved route defaults.
 */

// ---------------------------------------------------------------------------
// Linked models

/** The firm disciplines the project's open model pins (`firm:<slug>` ids); null when the project has no model the person can open. */
export type ModelFirmDisciplines = (extra: Extra, projectId: string) => Promise<ReadonlySet<string> | null>;

/** What an action did: saved now, handed to the linked-models worker, or nothing to do. */
export type LinkedOutcome = { status: "saved" | "queued" | "unchanged" | "refused"; message: string } & Record<string, unknown>;

/** The linked-model actions open to one caller on one project, after the host's access check. */
export interface LinkedModelAccess {
  /** Every linked model on the project, with whether the caller may change them. */
  list(): Promise<LinkedModelsResponse>;
  /** A folder of the project's document service (top folders when `folderId` is null), or a search below it by name. */
  browseDocs(folderId: string | null, query: string | null): Promise<DocsBrowseResponse>;
  /** Bring files from the document service in as linked models (a file already linked adds a version). */
  linkFromDocs(items: readonly DocsAddItem[]): Promise<readonly DocsAddResult[]>;
  /** One action on one linked model, as the Linked models panel offers it. */
  update(args: LinkedModelUpdateArgs): Promise<LinkedOutcome>;
  /** Take a linked model out of the Building Model for everyone; returns the label people saw. */
  unlink(referenceId: string): Promise<{ readonly label: string }>;
}

/** Where the project's linked models are kept. */
export interface LinkedModelStore {
  /** The caller's linked-model actions; throws (a refusal) when the caller may not read, or with `write` change, the project's model. */
  open(extra: Extra, projectId: string, write: boolean): Promise<LinkedModelAccess>;
  /** The words of a refusal the person can act on (no access, gone, not linked from the document service), or null for a fault. */
  refusalMessage(err: unknown): string | null;
}

/** Everything the linked-model tools need from their host beyond the caller. */
export interface LinkedModelToolsHost {
  readonly store: LinkedModelStore;
  readonly modelFirmDisciplines: ModelFirmDisciplines;
}

// ---------------------------------------------------------------------------
// Reading rows from a picture

export interface PictureFile {
  readonly fileId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

/** Fetch the picture or PDF a call names, as the caller (this project only). Throws `PictureNotFound` with plain words when there is none to read. */
export type ReadPictureFile = (extra: Extra, projectId: string, fileId: string) => Promise<PictureFile>;

/** What a picture read found: the rows proposed from it, or why it read nothing. */
export type PictureRowsOutcome = { readonly ok: true; readonly proposal: IntakeProposal } | { readonly ok: false; readonly message: string };

/** Read a schedule's rows from a picture with an AI model (`callKey`: a retried call is one read). The host bills the read. */
export type ReadPictureRows = (args: { readonly extra: Extra; readonly userId: string; readonly projectId: string; readonly file: PictureFile; readonly hint?: string; readonly callKey: string }) => Promise<PictureRowsOutcome>;

export interface PictureRowsReader {
  readonly readPicture: ReadPictureFile;
  readonly read: ReadPictureRows;
}

// ---------------------------------------------------------------------------
// Route defaults

/** The caller's own saved route defaults that apply on this project for `domain`, or null when they saved none. */
export type RouteDefaultsStore = (extra: unknown, projectId: string, domain: RouteDefaultDomain) => Promise<RouteDefaults | null>;
