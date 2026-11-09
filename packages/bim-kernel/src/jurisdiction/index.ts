/**
 * The open jurisdiction id (round 10 lane C10, FOUNDATION-REVIEW §6.2): where
 * a code applies, in any country, written before anything is signed with it
 * because signed payloads are forever.
 *
 *   { country: "US", subdivision: "US-VA" }                       Virginia
 *   { country: "CA", subdivision: "CA-ON", locality: "Toronto" }  Toronto
 *   { country: "SE" }                                             Sweden
 *   { country: "US", subdivision: "US-VA", locality: "Fairfax County", authority: "Fire Marshal" }
 *
 * `country` is ISO 3166-1 alpha-2, `subdivision` ISO 3166-2 ("<country>-<code>"),
 * `locality` and `authority` free words. Readers are tolerant: a stored US
 * state ("VA", the shape every record before round 10 used) reads as
 * `{ country: "US", subdivision: "US-VA" }`. A bare two-letter code that is a
 * US state reads as that state (so a stored "CA" stays California); write a
 * country on its own as an object or the key form ("CA" for Canada is
 * `{ country: "CA" }`, key `"CA"` only when it isn't a state code: use
 * `jurisdictionKey`, which is never ambiguous).
 */

export interface JurisdictionId {
  /** ISO 3166-1 alpha-2, upper case ("US", "CA", "SE", "GB"). */
  readonly country: string;
  /** ISO 3166-2 ("US-VA", "CA-ON", "GB-SCT"). */
  readonly subdivision?: string;
  /** A county, city or district, in its own words ("Fairfax County", "Toronto"). */
  readonly locality?: string;
  /** The adopting body when it isn't the general one ("Fire Marshal", "Building Department"). */
  readonly authority?: string;
}

const COUNTRY = /^[A-Z]{2}$/;
const SUBDIVISION = /^([A-Z]{2})-[A-Z0-9]{1,3}$/;
const WORDS_MAX = 120;

/** US states, DC and territories by postal code: the stored shape before round 10. */
export const US_SUBDIVISIONS: Readonly<Record<string, string>> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico",
  NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island",
  SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", PR: "Puerto Rico", GU: "Guam", VI: "U.S. Virgin Islands", AS: "American Samoa", MP: "Northern Mariana Islands",
};

function words(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().replace(/\s+/g, " ");
  return t.length > 0 && t.length <= WORDS_MAX ? t : undefined;
}

function fromObject(v: Readonly<Record<string, unknown>>): JurisdictionId | null {
  const country = typeof v.country === "string" ? v.country.trim().toUpperCase() : "";
  if (!COUNTRY.test(country)) return null;
  const subRaw = typeof v.subdivision === "string" ? v.subdivision.trim().toUpperCase() : undefined;
  let subdivision: string | undefined;
  if (subRaw !== undefined && subRaw !== "") {
    const m = SUBDIVISION.exec(subRaw);
    if (!m || m[1] !== country) return null;
    subdivision = subRaw;
  }
  const locality = words(v.locality);
  const authority = words(v.authority);
  return { country, ...(subdivision ? { subdivision } : {}), ...(locality ? { locality } : {}), ...(authority ? { authority } : {}) };
}

function fromText(raw: string): JurisdictionId | null {
  const text = raw.trim();
  if (!text) return null;
  // The key form: "US/US-VA/Fairfax County#Fire Marshal".
  if (text.includes("/") || text.includes("#")) {
    const [path = "", authority] = text.split("#", 2);
    const [country = "", second, ...rest] = path.split("/");
    const sub = second && SUBDIVISION.test(second.trim().toUpperCase()) ? second : undefined;
    const locality = sub ? rest.join("/") : [second, ...rest].filter((s): s is string => s !== undefined).join("/");
    return fromObject({ country, subdivision: sub, locality: locality || undefined, authority });
  }
  const upper = text.toUpperCase();
  if (upper.length === 2 && US_SUBDIVISIONS[upper]) return { country: "US", subdivision: `US-${upper}` };
  if (COUNTRY.test(upper)) return { country: upper };
  const m = SUBDIVISION.exec(upper);
  if (m && m[1]) return { country: m[1], subdivision: upper };
  // A state written out ("Virginia").
  const named = Object.entries(US_SUBDIVISIONS).find(([, name]) => name.toLowerCase() === text.toLowerCase());
  return named ? { country: "US", subdivision: `US-${named[0]}` } : null;
}

/** Any stored jurisdiction (an id, its key, an ISO code, a stored US state, a state name), or null when it isn't one. */
export function parseJurisdiction(raw: unknown): JurisdictionId | null {
  if (typeof raw === "string") return fromText(raw);
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) return fromObject(raw as Readonly<Record<string, unknown>>);
  return null;
}

/** The never-ambiguous text form: "US/US-VA", "CA/CA-ON/Toronto", "SE", "US/US-VA/Fairfax County#Fire Marshal". */
export function jurisdictionKey(j: JurisdictionId): string {
  const path = [j.country, j.subdivision, j.locality].filter((s): s is string => s !== undefined).join("/");
  return j.authority ? `${path}#${j.authority}` : path;
}

/** The plain object a payload stores (sorted keys come from canonicalization; absent fields stay absent). */
export function writeJurisdiction(j: JurisdictionId): { readonly [key: string]: string } {
  const out: { [key: string]: string } = { country: j.country };
  if (j.subdivision) out.subdivision = j.subdivision;
  if (j.locality) out.locality = j.locality;
  if (j.authority) out.authority = j.authority;
  return out;
}

/** The US postal code of a US subdivision ("US-VA" → "VA"); null outside the US. Bridges the older state-keyed tables. */
export function usStateOf(j: JurisdictionId | null): string | null {
  if (!j || j.country !== "US" || !j.subdivision) return null;
  const code = j.subdivision.slice(3);
  return US_SUBDIVISIONS[code] ? code : null;
}

let regionNames: Intl.DisplayNames | null | undefined;

function countryName(code: string): string {
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch (err) {
      console.error("[bim-kernel] country names are unavailable here; showing codes", err);
      regionNames = null;
    }
  }
  return regionNames?.of(code) ?? code;
}

/** "Virginia", "Fairfax County, Virginia (Fire Marshal)", "Sweden", "Toronto, CA-ON, Canada" (a non-US subdivision shows its code with the country). */
export function jurisdictionWords(j: JurisdictionId): string {
  let place: string;
  if (j.country === "US" && j.subdivision && US_SUBDIVISIONS[j.subdivision.slice(3)]) place = US_SUBDIVISIONS[j.subdivision.slice(3)] ?? j.subdivision;
  else if (j.subdivision) place = `${j.subdivision}, ${countryName(j.country)}`;
  else place = countryName(j.country);
  const where = j.locality ? `${j.locality}, ${place}` : place;
  return j.authority ? `${where} (${j.authority})` : where;
}

/** Whether `inner` lies inside `outer` (same country; each field `outer` names matches). An authority narrows. */
export function jurisdictionWithin(inner: JurisdictionId, outer: JurisdictionId): boolean {
  if (inner.country !== outer.country) return false;
  if (outer.subdivision && inner.subdivision !== outer.subdivision) return false;
  if (outer.locality && inner.locality?.toLowerCase() !== outer.locality.toLowerCase()) return false;
  if (outer.authority && inner.authority?.toLowerCase() !== outer.authority.toLowerCase()) return false;
  return true;
}

export function sameJurisdiction(a: JurisdictionId, b: JurisdictionId): boolean {
  return jurisdictionKey(a).toLowerCase() === jurisdictionKey(b).toLowerCase();
}
