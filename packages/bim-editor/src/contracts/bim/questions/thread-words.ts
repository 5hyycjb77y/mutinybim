import type { QuestionEvent, QuestionStatus } from "@permitzip/bim-kernel"

/**
 * The words a question's thread uses for a change of state and for custody
 * events, shared by the thread in the Building Model and the read-only copy
 * a reader outside the project sees.
 */

export const STATUS_ACT: Readonly<Record<QuestionStatus, string>> = { open: "Asked again", answered: "Answered", assumed: "Going ahead on an assumption", withdrawn: "Withdrew it", declined: "Declined", not_in_scope: "Marked not in scope" }

export function eventWords(e: QuestionEvent): string {
  switch (e.kind) {
    case "took_over":
      return e.from ? `Took it over from ${e.from.label}` : "Took it over"
    case "forwarded":
      return `Forwarded it${e.from ? ` from ${e.from.label}` : ""}${e.to ? ` to ${e.to.label}` : ""}`
    case "kept_closed":
      return `Kept it closed${e.reason ? `: '${e.reason}'` : ""}`
    default: {
      const words = e.kind.replace(/[._]/g, " ").trim()
      return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Changed it"
    }
  }
}
