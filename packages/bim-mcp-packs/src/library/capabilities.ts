import type { PartTypeDefinition, Registry } from "@permitzip/bim-kernel";
import type { LibraryProvider } from "@permitzip/bim-library";
import type { ProjectAdoptionLookup } from "../calc/capabilities";
import type { FirmPartsSource } from "../parts/capabilities";
import type { Extra } from "../runtime";
import type { FirmScheduleTemplatesStore } from "./firm-schedule-templates";

/**
 * The host services the library tools need beyond the caller: the library a
 * project's schedules read (built-in, firm and project scopes), the firm's
 * schedule templates and parts, whether the caller may read or write the firm
 * library, the code edition a project adopted, and the PDFs a cut sheet is
 * read from. A host keeps each wherever it keeps firm and project data.
 */

/** A library provider and the registry schedules read under it. */
export interface ScheduleLibrary {
  readonly provider: LibraryProvider;
  readonly registry: Registry;
  /** Set when the library could not be layered and schedules read the kernel's fields only. */
  readonly warning?: string;
}

/** The library a project's schedules read, as the caller. */
export type ScheduleLibrarySource = (extra: Extra, projectId: string) => Promise<ScheduleLibrary>;

/** The firm schedule templates, read and written as the caller. */
export type FirmScheduleTemplatesSource = (extra: Extra) => Promise<FirmScheduleTemplatesStore>;

/** Whether the caller may read / write the firm library. */
export type FirmLibraryAccess = (extra: Extra) => Promise<{ read: boolean; write: boolean }>;

/** What the schedule tools are given. */
export interface ScheduleToolsHost {
  /** The project's adopted electrical code (null: none recorded). */
  readonly projectAdoption: ProjectAdoptionLookup;
  readonly scheduleTemplates: FirmScheduleTemplatesSource;
  readonly firmLibraryAccess: FirmLibraryAccess;
  readonly library: ScheduleLibrarySource;
}

/** Any of the schedule host services, replaced (a drill or test); the rest stay the host's own. */
export type BimScheduleToolOptions = Partial<ScheduleToolsHost>;

/** One firm library part as a list shows it: every size's type id, its revision and where it came from. */
export interface FirmPartListing {
  readonly modelId: string;
  readonly partName: string;
  readonly category: string;
  readonly sizes: readonly { readonly typeId: string; readonly name: string }[];
  readonly revision: number;
  readonly updatedAt: string;
  readonly source: unknown;
}

/** The firm part library as the caller may read and write it (the parts family reads one part by model id). */
export interface FirmPartLibrary extends FirmPartsSource {
  list(filter?: { readonly search?: string; readonly category?: string }): Promise<FirmPartListing[]>;
  /** Add or replace the part with this definition's model id; refuses (FirmPartRefusal) one that doesn't check out. */
  save(definition: PartTypeDefinition, userId: string): Promise<{ status: "added" | "updated"; revision: number; modelId: string }>;
}

/** The firm part library as the caller. */
export type FirmPartLibrarySource = (extra: Extra) => Promise<FirmPartLibrary>;

/** The signed-in person an approved firm library save is recorded against. */
export type SignedInPerson = (extra: Extra) => Promise<string>;

/** A cut sheet PDF, read. */
export interface CutSheetFile {
  readonly fileName: string;
  readonly fileId?: string;
  readonly bytes: Uint8Array;
}

/** Fetch the PDF a call names, as the caller. Throws CutSheetNotFound (plain words) when there is no such PDF the caller may read. */
export type ReadCutSheetFile = (extra: Extra, projectId: string, ref: { readonly fileId?: string; readonly fileUrl?: string }) => Promise<CutSheetFile>;

/** What the cut-sheet and firm part tools are given. */
export interface CutSheetToolsHost {
  readonly readCutSheet: ReadCutSheetFile;
  readonly firmParts: FirmPartLibrarySource;
  readonly signedInPerson: SignedInPerson;
}
