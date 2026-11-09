import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { builtinPartType, canonicalJson, commandIssueMessage, commandSchema, type Command, type ModelState } from "@permitzip/bim-kernel";
import type { IntakeProposal } from "@permitzip/bim-kernel/intake";
import type { Capability } from "../capabilities";
import type { PictureRowsReader } from "./capabilities";
import { baseRevision, editIdempotencyKey, editResultBody, explain, failure, notSent, target, text, withSession, type Extra, type ResolveBimCaller } from "../runtime";

/** A part type parameter name, as the kernel's part schema accepts it. */
const PARAM_NAME = /^[a-z][a-z0-9_]{0,47}$/;

/**
 * bim_read_picture_rows (round 12 S12): read an equipment schedule from a
 * picture or a cut sheet on the project and add its rows as planned
 * equipment.
 *
 * Confirm-gated like the schedule tools. The first call reads the file
 * through the host's picture reader (which bills the read as it does), maps the cells to rows
 * deterministically and saves nothing: each row with its page, its values,
 * and the cells the reader was unsure of ("check this"), plus a
 * preview_token. The commit call (user_confirmed, the rows the person kept,
 * base_revision, preview_token) pauses on the Approve card, which lists the
 * rows with their page citations, and runs once from the persisted action
 * row: one batch of plan_part, one undo step. It never reads the file again,
 * so approving costs nothing more. Deny writes nothing.
 */

export const BIM_READ_PICTURE_ROWS = "bim_read_picture_rows";

const MAX_ROWS = 200;

export class PictureNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PictureNotFound";
  }
}

/** A row as the preview returns it and the commit sends it back (page is 1-based, as people say it). */
const rowArg = z.object({
  key: z.string().min(1).max(40),
  page: z.number().int().min(1).max(500),
  mark: z.string().max(40).optional(),
  values: z.record(z.string().min(1).max(120), z.union([z.string().max(400), z.number().finite()])),
});
type RowArg = z.infer<typeof rowArg>;

/** The preview's rows: every row, ticked when every cell is sure; values from sure cells only. */
export function previewRows(proposal: IntakeProposal, markField = "mark"): { rows: (RowArg & { readonly ticked: boolean; readonly check_this: readonly string[] })[]; kept_as_text: readonly string[] } {
  const rows = proposal.rows.slice(0, MAX_ROWS).map((r) => {
    const { [markField]: mark, ...values } = r.values;
    return {
      key: r.key,
      page: r.page + 1,
      ...(mark !== undefined ? { mark: String(mark).slice(0, 40) } : {}),
      values,
      ticked: r.sure,
      check_this: r.cells.filter((c) => !c.sure).map((c) => `${c.heading || `column ${c.column + 1}`}: "${c.text}"`),
    };
  });
  return { rows, kept_as_text: proposal.columns.filter((c) => c.field === null).map((c) => c.heading) };
}

export function pictureToken(parts: unknown): string {
  return createHash("sha256").update(canonicalJson(parts)).digest("hex").slice(0, 32);
}

/** The one edit the commit makes: a plan_part per kept row (values a part type takes; the rest in its note), as one batch. */
export function intakeEdit(model: ModelState, rows: readonly RowArg[], typeId: string, fileName: string, key: string): Command | string {
  const inModel = model.elements[typeId]?.kind === "part_type";
  const builtin = inModel ? undefined : builtinPartType(typeId);
  if (!inModel && !builtin) return `No part type ${typeId} in this model or the starter library. Call bim_list_part_types and use one of its ids.`;
  const commands = rows.map((r, i) => {
    const params: Record<string, number | string> = {};
    const extra: string[] = [];
    for (const [k, v] of Object.entries(r.values)) {
      if (PARAM_NAME.test(k)) params[k] = v;
      else extra.push(`${k.replace(/^[a-z0-9]+\./, "")} ${v}`);
    }
    const note = [`From ${fileName}, page ${r.page}`, ...extra].join("; ").slice(0, 200);
    return {
      type: "plan_part" as const,
      partId: `${key.slice(0, 24)}-${i + 1}`,
      typeId,
      ...(builtin ? { partType: builtin.definition } : {}),
      ...(r.mark ? { mark: r.mark } : {}),
      ...(Object.keys(params).length > 0 ? { values: params } : {}),
      note,
    };
  });
  const label = `Add ${rows.length} row${rows.length === 1 ? "" : "s"} from ${fileName}`.slice(0, 160);
  const parsed = commandSchema.safeParse(commands.length === 1 ? commands[0] : { type: "batch_edits", label, commands });
  return parsed.success ? parsed.data : notSent(commandIssueMessage(parsed.error, commands[0]));
}

export function registerBimIntakeTools(server: McpServer, caller: ResolveBimCaller, pictures: Capability<PictureRowsReader>): void {

  server.registerTool(
    BIM_READ_PICTURE_ROWS,
    {
      title: "Read rows from a picture or cut sheet",
      description:
        "Equipment schedule (picture or PDF on the project) to planned rows. First call saves nothing: rows (page, values, check_this) and next steps. Commit: rows, type_id, file_name, base_revision, preview_token, user_confirmed (pauses for approval).",
      inputSchema: {
        ...target,
        ...baseRevision,
        file_id: z.string().uuid(),
        hint: z.string().max(200).optional(),
        type_id: z.string().min(1).max(200).optional(),
        file_name: z.string().max(200).optional(),
        rows: z.array(rowArg).max(MAX_ROWS).optional(),
        preview_token: z.string().min(16).max(64).optional(),
        user_confirmed: z.boolean().optional(),
      },
    },
    async (args, extra: Extra) => {
      try {
        const commit = args.user_confirmed === true;
        if (commit) {
          if (args.base_revision === undefined || !args.preview_token || !args.rows || args.rows.length === 0 || !args.type_id) return failure(`${BIM_READ_PICTURE_ROWS} adds only previewed rows: call it without user_confirmed first, then again with rows, type_id, base_revision and preview_token.`);
          const who = await caller(extra, args.project_id, true);
          const rows = args.rows;
          const typeId = args.type_id;
          return await withSession(who, args.model_id, undefined, async (s) => {
            const base = args.base_revision ?? s.revision();
            const token = pictureToken({ file_id: args.file_id, file_name: args.file_name ?? null, model_id: args.model_id, base, type_id: typeId, rows });
            if (token !== args.preview_token) return failure("These aren't the rows that were previewed (or the type changed). Preview again with the rows the person kept and type_id, then commit with the new preview_token.");
            const key = editIdempotencyKey(who.runId, BIM_READ_PICTURE_ROWS, { model_id: args.model_id, token }, base);
            const edit = intakeEdit(s.model(), rows, typeId, args.file_name ?? "the picture", key);
            if (typeof edit === "string") return failure(edit);
            const result = await s.edit(edit, { idempotencyKey: key, baseRevision: base });
            return text({ ...editResultBody(result, args.model_id), added_rows: rows.map((r) => ({ key: r.key, mark: r.mark ?? null, page: r.page })) });
          });
        }
        const who = await caller(extra, args.project_id, false);
        if (args.rows && args.type_id) {
          // A changed set of rows or a type for rows already read: no second read (nothing more to pay for).
          const rowsToAdd = args.rows;
          const typeId = args.type_id;
          return await withSession(who, args.model_id, undefined, async (s) => {
            const base = s.revision();
            return text({ status: "preview", rows: rowsToAdd, type_id: typeId, base_revision: base, preview_token: pictureToken({ file_id: args.file_id, file_name: args.file_name ?? null, model_id: args.model_id, base, type_id: typeId, rows: rowsToAdd }), next: "Nothing is added yet. To add exactly these rows, call again with the same rows, type_id, file_name, base_revision, preview_token and user_confirmed: true; the person approves them on the Approve card first." });
          });
        }
        if (!pictures.available) return failure(`${pictures.reason} To add rows without a read, call again with rows, type_id and file_name.`);
        const { readPicture: readFile, read } = pictures.service;
        const file = await readFile(extra, args.project_id, args.file_id);
        const callKey = `intake:${pictureToken({ run: who.runId, file: args.file_id, hint: args.hint ?? "" })}`;
        const outcome = await read({ extra, userId: who.userId, projectId: args.project_id, file, ...(args.hint ? { hint: args.hint } : {}), callKey });
        if (!outcome.ok) return failure(outcome.message);
        const { rows, kept_as_text } = previewRows(outcome.proposal);
        return await withSession(who, args.model_id, undefined, async (s) => {
          const base = s.revision();
          const kept = rows.filter((r) => r.ticked).map(({ ticked: _t, check_this: _c, ...r }) => r);
          const token = args.type_id ? pictureToken({ file_id: args.file_id, file_name: file.fileName, model_id: args.model_id, base, type_id: args.type_id, rows: kept }) : null;
          return text({
            status: "preview",
            file: { name: file.fileName, file_id: file.fileId },
            rows,
            unticked: rows.filter((r) => !r.ticked).length,
            ...(kept_as_text.length > 0 ? { columns_kept_as_text: kept_as_text } : {}),
            notes: outcome.proposal.notes,
            base_revision: base,
            ...(token ? { preview_token: token } : {}),
            next: token
              ? `Nothing is added yet. Show the person the rows (page by page) and the check_this cells. To add exactly the ticked rows, call again with rows (the ticked ones as listed, without ticked/check_this), type_id, file_name "${file.fileName}", base_revision, preview_token and user_confirmed: true. For a different set, preview again with rows, type_id and file_name (no second read).`
              : `Nothing is added yet. Pick the part type the rows are planned as (bim_list_part_types), then preview again with rows (the ones the person keeps), type_id and file_name "${file.fileName}" for a preview_token (no second read).`,
          });
        });
      } catch (err) {
        if (err instanceof PictureNotFound) return failure(err.message);
        return explain(err, BIM_READ_PICTURE_ROWS);
      }
    },
  );
}
