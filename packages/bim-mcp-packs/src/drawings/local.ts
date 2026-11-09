import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { LinkedModelStoreys } from "@permitzip/bim-editor/contracts/building-model/linked-levels-contract";
import { localFirmClasses, localSheetImages, localSheetPdfStore, localSheetTitle } from "../views/local";
import { memoryBlockSnapshotStore, type BlockSnapshotStore } from "./block-snapshots";
import {
  NO_LINKED_BACKGROUNDS,
  type BlockSnapshotsFor,
  type DrawingSetFiles,
  type DrawingSetFilesFor,
  type DrawingSetToolsHost,
  type IssueApprovalCheck,
  type LinkedBackgroundsFor,
  type LinkedStoreysFor,
  type QuestionNotices,
  type RenderToolsHost,
  type StoreProjectFile,
} from "./capabilities";

export { memoryDrawingSetFiles } from "./memory";

/** A local file link does not expire; the tools still say how long it lasts, so a day is what they report. */
const LOCAL_LINK_SECONDS = 24 * 60 * 60;

/** Within `root`, or null when `relative` would leave it. */
function inside(root: string, relative: string): string | null {
  const base = path.resolve(root);
  const full = path.resolve(base, relative);
  return full.startsWith(base + path.sep) ? full : null;
}

function within(root: string, relative: string): string {
  const full = inside(root, relative);
  if (!full) throw new Error(`"${relative}" is outside the output folder.`);
  return full;
}

const isMissing = (err: unknown) => typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
const isExisting = (err: unknown) => typeof err === "object" && err !== null && "code" in err && err.code === "EEXIST";

/** Write once under `root`: true when the file was already there (a retry). */
async function writeOnce(root: string, relative: string, bytes: Uint8Array): Promise<{ full: string; existed: boolean }> {
  const full = within(root, relative);
  await mkdir(path.dirname(full), { recursive: true });
  try {
    await writeFile(full, bytes, { flag: "wx" });
    return { full, existed: false };
  } catch (err) {
    if (isExisting(err)) return { full, existed: true };
    throw err;
  }
}

/** Printed and issued sets as files under `dir` (the tools' own project/model paths below it), linked as file URLs. There is no project Workspace to file an issue in. */
export function localDrawingSetFiles(dir: string): DrawingSetFilesFor {
  const files: DrawingSetFiles = {
    async put(relative, bytes) {
      const { full, existed } = await writeOnce(dir, relative, bytes);
      return { existed, downloadUrl: pathToFileURL(full).href, expiresInSeconds: LOCAL_LINK_SECONDS };
    },
    async list(folder, limit) {
      const full = within(dir, folder);
      let names: string[];
      try {
        names = await readdir(full);
      } catch (err) {
        if (isMissing(err)) return [];
        throw err;
      }
      const listed = await Promise.all(
        names.map(async (name) => {
          const info = await stat(path.join(full, name));
          return info.isFile() ? { name, createdAt: info.birthtime.toISOString(), at: info.birthtimeMs } : null;
        }),
      );
      return listed
        .flatMap((f) => (f ? [f] : []))
        .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name))
        .slice(0, limit)
        .map(({ name, createdAt }) => ({ name, createdAt }));
    },
    async read(relative) {
      try {
        return new Uint8Array(await readFile(within(dir, relative)));
      } catch (err) {
        if (isMissing(err)) return null;
        throw err;
      }
    },
    async link(relative) {
      return { downloadUrl: pathToFileURL(within(dir, relative)).href, expiresInSeconds: LOCAL_LINK_SECONDS };
    },
    async fileInProject() {
      return { status: "not_filed", reason: "This server keeps issued sets in its output folder; there is no project Workspace to file them in. The download link still works." };
    },
  };
  return () => files;
}

/** Write-once project files under `dir`, linked as file URLs. */
export function localStoreProjectFile(dir: string): StoreProjectFile {
  return async (_extra, _projectId, relative, bytes) => {
    const { full, existed } = await writeOnce(dir, relative, bytes);
    return { existed, downloadUrl: pathToFileURL(full).href, expiresInSeconds: LOCAL_LINK_SECONDS };
  };
}

/** No linked-model backgrounds: drawings show only this model's work. */
export const noLinkedBackgrounds: LinkedBackgroundsFor = async () => NO_LINKED_BACKGROUNDS;

/** Issue snapshots of live blocks kept in memory for as long as the server runs (one store for every project). */
export function localBlockSnapshots(store: BlockSnapshotStore = memoryBlockSnapshotStore()): BlockSnapshotsFor {
  return async () => store;
}

/** No approvals check before an issue: nothing here records sign-offs against code rules. */
export const noIssueApprovalChecks: IssueApprovalCheck = async () => null;

/** No question notices: nobody here has a bell to tell. */
export const noQuestionNotices: QuestionNotices = async () => ({ written: 0 });

/** The linked models' storeys a local server knows (none unless given). */
export function localLinkedStoreys(models: readonly LinkedModelStoreys[] = []): LinkedStoreysFor {
  return async () => models;
}

/** The drawing-set host for a local server: sets on disk under `dir`, no backgrounds, no Verify codes, no notices. */
export function localDrawingSetToolsHost(dir: string, overrides: Partial<DrawingSetToolsHost> = {}): DrawingSetToolsHost {
  return {
    setFiles: localDrawingSetFiles(path.join(dir, "sets")),
    sheetTitle: localSheetTitle(),
    backgrounds: noLinkedBackgrounds,
    sheetImages: localSheetImages(path.join(dir, "images")),
    blockSnapshots: localBlockSnapshots(),
    issueCheck: noIssueApprovalChecks,
    questionNotices: noQuestionNotices,
    ...overrides,
  };
}

/** The pictures and view-PDF host for a local server: PDFs and kept pictures on disk under `dir`. */
export function localRenderToolsHost(dir: string, overrides: Partial<RenderToolsHost> = {}): RenderToolsHost {
  return {
    storeSheetPdf: localSheetPdfStore(path.join(dir, "printed")),
    storeProjectFile: localStoreProjectFile(path.join(dir, "files")),
    backgrounds: noLinkedBackgrounds,
    sheetTitle: localSheetTitle(),
    firmClasses: localFirmClasses(),
    ...overrides,
  };
}
