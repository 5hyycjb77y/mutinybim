const PLACEHOLDER_REASONS = new Set(["na", "none", "test", "testing", "tbd", "todo", "ok", "okay", "yes", "no", "x", "xx", "xxx", "asdf", "reason", "accept", "accepted", "noop"]);

/** Why a reason isn't one a person would give (blank, punctuation, a placeholder), or null when it is. */
export function acceptanceReasonProblem(reason: string): string | null {
  const words = reason.trim().toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 0);
  const letters = words.join("").replace(/[^a-z]/g, "").length;
  if (letters < 3) return "Say why in words (at least a few).";
  if (words.length <= 2 && words.every((w) => PLACEHOLDER_REASONS.has(w))) return `"${reason.trim()}" isn't a reason. Say why, in the person's words.`;
  return null;
}
