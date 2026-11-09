import { readFile } from "node:fs/promises";
import path from "node:path";
import { noAdoptedElectricalCode } from "../calc/local";
import type { CutSheetToolsHost, FirmLibraryAccess, FirmPartLibrary, FirmScheduleTemplatesSource, ReadCutSheetFile, ScheduleToolsHost, SignedInPerson } from "./capabilities";
import { CutSheetNotFound } from "./cut-sheet";
import { memoryFirmPartLibrary } from "./firm-parts";
import { memoryFirmScheduleTemplatesStore } from "./firm-schedule-templates";
import { builtinScheduleLibrary } from "./schedules";

/**
 * A local server's library: the built-in AEC + MEP libraries, firm schedule
 * templates and parts held in memory, cut sheets read from a folder. The
 * person running it is the firm, so they may read and write its library.
 */

/** Firm schedule templates in memory, one store for the server's life. */
export function localScheduleTemplates(): FirmScheduleTemplatesSource {
  const store = memoryFirmScheduleTemplatesStore();
  return async () => store;
}

/** The person running a local server may read and write their own firm library. */
export const localFirmLibraryAccess: FirmLibraryAccess = async () => ({ read: true, write: true });

/** The schedule tools' host for a local server. */
export function localScheduleToolsHost(overrides: Partial<ScheduleToolsHost> = {}): ScheduleToolsHost {
  return {
    projectAdoption: noAdoptedElectricalCode,
    scheduleTemplates: localScheduleTemplates(),
    firmLibraryAccess: localFirmLibraryAccess,
    library: () => builtinScheduleLibrary(),
    ...overrides,
  };
}

/** Within `root`, or null when `relative` would leave it. */
function inside(root: string, relative: string): string | null {
  const base = path.resolve(root);
  const full = path.resolve(base, relative);
  return full.startsWith(base + path.sep) ? full : null;
}

/**
 * Cut sheet PDFs read from `dir`, named by their file id (a file name under
 * the folder; a project's own subfolder when one exists). URLs are refused:
 * a local server fetches nothing from the network.
 */
export function localCutSheets(dir: string): ReadCutSheetFile {
  return async (_extra, projectId, ref) => {
    if (!ref.fileId) throw new CutSheetNotFound("A local server reads cut sheets from its folder, not from links. Put the PDF in the cut sheets folder and pass its file name as file_id.");
    const candidates = [inside(path.join(dir, projectId), ref.fileId), inside(dir, ref.fileId)].filter((p): p is string => p !== null);
    if (candidates.length === 0) throw new CutSheetNotFound(`"${ref.fileId}" isn't a file in the cut sheets folder.`);
    if (!/\.pdf$/i.test(ref.fileId)) throw new CutSheetNotFound(`${path.basename(ref.fileId)} isn't a PDF. Cut sheets are read from PDFs.`);
    for (const full of candidates) {
      try {
        return { fileName: path.basename(full), fileId: ref.fileId, bytes: new Uint8Array(await readFile(full)) };
      } catch (err) {
        if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
      }
    }
    throw new CutSheetNotFound(`No cut sheet "${ref.fileId}" in the cut sheets folder.`);
  };
}

/** The person a local server records firm library saves against. */
export function localSignedInPerson(person = "local"): SignedInPerson {
  return async () => person;
}

/** The cut-sheet tools' host for a local server: PDFs from `dir`, firm parts in memory. */
export function localCutSheetToolsHost(dir: string, overrides: Partial<CutSheetToolsHost> & { readonly firmLibrary?: FirmPartLibrary } = {}): CutSheetToolsHost {
  const { firmLibrary, ...rest } = overrides;
  const library = firmLibrary ?? memoryFirmPartLibrary();
  return {
    readCutSheet: localCutSheets(dir),
    firmParts: async () => library,
    signedInPerson: localSignedInPerson(),
    ...rest,
  };
}
