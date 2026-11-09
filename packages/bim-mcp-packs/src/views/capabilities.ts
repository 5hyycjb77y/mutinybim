import type { Registry } from "@permitzip/bim-kernel";
import type { LinkedModelIndex } from "@permitzip/bim-lint";
import type { SheetImageSource } from "@permitzip/bim-sheets";
import type { Extra } from "../runtime";
import type { ResolveSheetTitle } from "./sheet-title";

/** Where a printed PDF goes; returns a short-lived download link. */
export type StoreSheetPdf = (extra: Extra, projectId: string, path: string, bytes: Uint8Array) => Promise<{ readonly downloadUrl: string; readonly expiresInSeconds: number }>;

/** The firm's own classes layered over the built-in ones, as the caller may read them. */
export interface FirmClasses {
  readonly registry: Registry;
  /** Set when the firm's classes could not be layered and the built-in classes stand alone. */
  readonly warning?: string;
}

/** The caller's firm classes, for Visibility/Graphics on a firm class. Throws when they can't be read. */
export type FirmClassesSource = (extra: Extra) => Promise<FirmClasses>;

/** Pictures placed on a project's sheets, for printing. */
export type SheetImagesFor = (extra: Extra, projectId: string) => SheetImageSource;

/** The project's linked models' indexes, for fitting a plan's crop to what it draws. Throws when they can't be read. */
export type LinkedModelsForFit = (extra: Extra, projectId: string) => Promise<readonly LinkedModelIndex[]>;

/** Everything the views and sheets tools need from their host beyond the caller. */
export interface ViewToolsHost {
  readonly storeSheetPdf: StoreSheetPdf;
  readonly sheetTitle: ResolveSheetTitle;
  readonly firmClasses: FirmClassesSource;
  readonly sheetImages: SheetImagesFor;
  readonly linkedModels: LinkedModelsForFit;
}
