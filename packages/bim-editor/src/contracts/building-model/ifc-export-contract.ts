import { z } from "zod";

/**
 * What Building Model › Export IFC sends and gets back
 * (`/api/projects/[id]/building-model/ifc-export`). Shared by the route and
 * the dialog, so a change to one is a type error in the other.
 */

export const IFC_EXPORT_STATUSES = ["exporting", "ready", "failed"] as const;
export type IfcExportStatus = (typeof IFC_EXPORT_STATUSES)[number];

export const ifcExportCountsSchema = z.object({
  storeys: z.number(),
  spaces: z.number(),
  zones: z.number(),
  systems: z.number(),
  circuits: z.number(),
  elements: z.number(),
  planned: z.number(),
  ports: z.number(),
});
export type IfcExportSummaryCounts = z.infer<typeof ifcExportCountsSchema>;

export const ifcExportViewSchema = z.object({
  jobId: z.string(),
  status: z.enum(IFC_EXPORT_STATUSES),
  modelId: z.string().nullable(),
  revision: z.number().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  /** Plain words: why it failed. */
  error: z.string().nullable(),
  file: z.object({ artifactId: z.string(), name: z.string(), bytes: z.number() }).nullable(),
  counts: ifcExportCountsSchema.nullable(),
  /** How many elements were written as generic proxies or had a type adjusted (the details are in the job's result). */
  warnings: z.number(),
  byName: z.string().nullable(),
  /** Where the file also shows in the project's Files, or why it couldn't be added there (the download still works). Null for exports made before 5c. */
  workspace: z.union([z.object({ status: z.literal("filed"), folder: z.string(), name: z.string() }), z.object({ status: z.literal("not_filed"), reason: z.string() })]).nullable(),
});
export type IfcExportView = z.infer<typeof ifcExportViewSchema>;

export const ifcExportListSchema = z.object({ exports: z.array(ifcExportViewSchema) });
export const ifcExportDownloadSchema = z.object({ url: z.string().url(), expiresInSeconds: z.number() });

export const ifcExportStartSchema = z.object({ model: z.string().trim().min(1).max(200) });

/** What the job's `result` holds once the file is stored (written by the server, read tolerantly). */
export const ifcExportResultSchema = z.object({
  modelId: z.string().optional(),
  revision: z.number().optional(),
  artifactId: z.string().optional(),
  fileName: z.string().optional(),
  bytes: z.number().optional(),
  counts: ifcExportCountsSchema.optional(),
  warningCount: z.number().optional(),
  warnings: z.array(z.string()).optional(),
  byName: z.string().optional(),
  workspace: z.union([z.object({ status: z.literal("filed"), folder: z.string(), name: z.string(), fileId: z.string() }), z.object({ status: z.literal("not_filed"), reason: z.string() })]).optional(),
});
