/**
 * The product owner's answers (Nov 1) to the round 8b questions that shape merge
 * approvals, each kept here so it can flip in one place (round 8b README,
 * "the product owner's answers (Nov 1)").
 */
export const MERGE_POLICY = {
  /**
   * Answer 2. Only a change inside an approver's part asks them again: an
   * approval names its part's delta digest, and counts only while the part
   * still has that digest. `any_change` would ask everyone again on any
   * branch change (the kernel evaluator supports both).
   */
  reapproval: "inside_part",
  /**
   * Answer 3. Parts no one is named for go to the project lead; with no lead
   * they wait, and anyone who can see them may "Take responsibility for
   * this": at once with the host's project-write permission here and no one named for that
   * discipline, otherwise as a request the lead grants
   * (`bim_take_responsibility`, `bim_decide_responsibility_request`).
   */
  uncoveredWithoutLead: "wait_or_take",
  /**
   * Answer 7. A firm entry names one or several people, each accepting for
   * themselves, approving under the entry's rule (each / any one of). The
   * entry itself never approves. A changed area asks each person to accept
   * again (`bim_responsibilities_touch`, `bim_responsibilities_firm_follow`).
   */
  firmRowsApprove: false,
} as const satisfies {
  readonly reapproval: "inside_part" | "any_change"
  readonly uncoveredWithoutLead: "wait_or_take" | "wait"
  readonly firmRowsApprove: boolean
}

export const NO_LEAD_WORDS = "No project lead is named. Name one in Manage › Responsibilities."
