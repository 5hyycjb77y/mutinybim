import type { ElementKindItem, KindRecordRead } from "../../registry/element-kind-point";
import { storedField } from "../index";
import { QUESTION_ANSWERS_FEATURE, QUESTION_ANSWER_KIND, QUESTION_REPLY_KIND, QUESTION_THREADS_FEATURE, readQuestionAnswerBody, readQuestionReplyBody } from "../../questions/records";
import { readDivergenceBody, readSubmittalBody } from "../../submittals/records";
import { DIVERGENCE_KIND, SUBMITTAL_DIVERGENCE_FEATURE, SUBMITTAL_KIND, SUBMITTAL_RECORDS_FEATURE } from "../../submittals/types";

/**
 * The four record kinds the kernel keeps outside the element union
 * (submittals, divergences, answers and replies), as kernel rows: never
 * drawn, no shape, no connector ends, sitting nowhere. Each row's `read` is
 * the body reader its domain already uses (tolerant: unknown fields, states
 * and outcomes are kept), so a stored record reads the same through the row
 * as through its domain. Writers stay their domains' (`submittals/`,
 * `questions/`), gated on the feature the row names.
 */

type ReadBody = (raw: unknown) => { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** `read` for a record whose body sits under `field`. */
function bodyAt(field: string, readBody: ReadBody): (record: object) => KindRecordRead {
  return (record) => {
    const result = readBody(storedField(record, field));
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  };
}

export const SUBMITTAL_KIND_ROW: ElementKindItem = {
  kind: SUBMITTAL_KIND,
  label: "Submittal",
  nature: "record",
  upgrade: { feature: SUBMITTAL_RECORDS_FEATURE },
  read: bodyAt("submittal", readSubmittalBody),
};

export const DIVERGENCE_KIND_ROW: ElementKindItem = {
  kind: DIVERGENCE_KIND,
  label: "Approved difference",
  nature: "record",
  upgrade: { feature: SUBMITTAL_DIVERGENCE_FEATURE },
  read: bodyAt("divergence", readDivergenceBody),
};

export const QUESTION_ANSWER_KIND_ROW: ElementKindItem = {
  kind: QUESTION_ANSWER_KIND,
  label: "Answer",
  nature: "record",
  upgrade: { feature: QUESTION_ANSWERS_FEATURE },
  read: bodyAt("answer", readQuestionAnswerBody),
};

export const QUESTION_REPLY_KIND_ROW: ElementKindItem = {
  kind: QUESTION_REPLY_KIND,
  label: "Reply",
  nature: "record",
  upgrade: { feature: QUESTION_THREADS_FEATURE },
  read: bodyAt("reply", readQuestionReplyBody),
};

export const RECORD_KIND_ROWS: readonly ElementKindItem[] = [SUBMITTAL_KIND_ROW, DIVERGENCE_KIND_ROW, QUESTION_ANSWER_KIND_ROW, QUESTION_REPLY_KIND_ROW];
