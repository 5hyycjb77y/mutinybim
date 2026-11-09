import { authorWords } from "./author";
import type { AuthorshipRole, LicenceClaim } from "./types";

/**
 * Most people acting on a model hold no licence (employees, drafters,
 * contractors, third parties, agents acting for them), and every role but
 * sealing is open to them. Only `sealed` needs a licence on record.
 */
export function requiresLicence(role: AuthorshipRole): boolean {
  return role === "sealed";
}

/**
 * Why this act can't be recorded, in words, or null when it can: a seal
 * needs a licence claim for the jurisdiction; every other role needs none.
 * Whether that claim is proven is `licenceStanding`'s to say, not this check's.
 */
export function licenceRefusal(role: AuthorshipRole, licences: readonly LicenceClaim[], jurisdiction: string): string | null {
  if (!requiresLicence(role)) return null;
  if (licences.some((l) => l.jurisdiction === jurisdiction)) return null;
  return `Sealing needs a licence on record for ${jurisdiction}; approving doesn't.`;
}

/**
 * How far a licence claim is proven, in words. Only the issuing body's own
 * credential reads as confirmed; an organization vouching for one of its own
 * people stays visibly weaker than that.
 */
export interface LicenceStanding {
  readonly level: "confirmed_by_issuer" | "vouched" | "self_reported";
  readonly words: string;
}

export function licenceStanding(claim: LicenceClaim): LicenceStanding {
  const issuer = claim.issuer.name ?? claim.issuer.id;
  if (claim.evidence === "issuer_credential") return { level: "confirmed_by_issuer", words: `Confirmed by ${issuer}.` };
  if (claim.evidence === "vouched" && claim.vouchedBy) {
    const v = claim.vouchedBy;
    const whose = v.relationship === "own_staff" ? " for its own staff" : "";
    return { level: "vouched", words: `Vouched for by ${v.organization.name}${whose} (checked by ${authorWords(v.voucher)} on ${v.at.slice(0, 10)}). Not confirmed by ${issuer}.` };
  }
  return { level: "self_reported", words: `Self-reported. Not confirmed by ${issuer}.` };
}
