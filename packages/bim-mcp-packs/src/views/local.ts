import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { builtinRegistry, type Registry } from "@permitzip/bim-kernel";
import type { LinkedModelIndex } from "@permitzip/bim-lint";
import type { SheetTitle } from "@permitzip/bim-editor/contracts/building-model/sheet-title";
import type { FirmClassesSource, LinkedModelsForFit, SheetImagesFor, StoreSheetPdf, ViewToolsHost } from "./capabilities";
import type { ResolveSheetTitle } from "./sheet-title";

/** A local file link does not expire; the tool still says how long it lasts, so a day is what it reports. */
const LOCAL_LINK_SECONDS = 24 * 60 * 60;

/** Within `root`, or null when `relative` would leave it. */
function inside(root: string, relative: string): string | null {
  const base = path.resolve(root);
  const full = path.resolve(base, relative);
  return full.startsWith(base + path.sep) ? full : null;
}

/** Printed PDFs written under `dir` (the tool's own project/model path below it), linked as file URLs. */
export function localSheetPdfStore(dir: string): StoreSheetPdf {
  return async (_extra, _projectId, relative, bytes) => {
    const full = inside(dir, relative);
    if (!full) throw new Error(`The PDF was drawn but couldn't be stored: "${relative}" is outside the output folder.`);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, bytes, { flag: "wx" });
    return { downloadUrl: pathToFileURL(full).href, expiresInSeconds: LOCAL_LINK_SECONDS };
  };
}

/** The same title-block fallback for every project (blank unless given). */
export function localSheetTitle(title: Partial<SheetTitle> = {}): ResolveSheetTitle {
  return async () => ({ projectName: title.projectName ?? "", projectNumber: title.projectNumber ?? "", firmName: title.firmName ?? "" });
}

/** The given class registry as the firm's classes (default: the built-in classes, so firm-class graphics print as their parent category). */
export function localFirmClasses(registry: Registry = builtinRegistry()): FirmClassesSource {
  return async () => ({ registry });
}

/** Sheet pictures read from files named by their file id under `dir`. */
export function localSheetImages(dir: string): SheetImagesFor {
  return () => ({
    load: async (fileId) => {
      const full = inside(dir, fileId);
      if (!full) throw new Error(`"${fileId}" isn't a picture in this folder`);
      return new Uint8Array(await readFile(full));
    },
  });
}

/** The linked models a local server knows (none unless given), for a plan's fit. */
export function localLinkedModels(models: readonly LinkedModelIndex[] = []): LinkedModelsForFit {
  return async () => models;
}

/** The views and sheets host for a local server: PDFs and pictures on disk under `dir`. */
export function localViewToolsHost(dir: string, overrides: Partial<ViewToolsHost> = {}): ViewToolsHost {
  return {
    storeSheetPdf: localSheetPdfStore(path.join(dir, "printed")),
    sheetTitle: localSheetTitle(),
    firmClasses: localFirmClasses(),
    sheetImages: localSheetImages(path.join(dir, "images")),
    linkedModels: localLinkedModels(),
    ...overrides,
  };
}
