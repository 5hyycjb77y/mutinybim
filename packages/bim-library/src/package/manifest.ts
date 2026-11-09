import { z } from "zod";
import { authorRefSchema } from "../items/script";
import { contentHash, isoTime, semver, spdxExpression, text } from "../item-base";

/**
 * `mutinybim.json`: the manifest of a MutinyBIM package (round 11 X11;
 * D5; SCRIPTING-PROPOSAL §5.5), format `mutinybim-package` v1. A package is
 * a directory (or a `.tgz` of one):
 *
 *   mutinybim.json          this manifest
 *   parts/<id>.json         part-type library items
 *   scripts/<id>.json       script library items (source inside)
 *   addons/<id>.json        add-on manifests (A11)
 *   README.md
 *   LICENSE                 the licence the manifest names
 *   signatures/<n>.json     8b SignatureEnvelopes over the manifest
 *
 * The manifest lists every content file's hash, and signatures cover the
 * manifest's canonical bytes, so a signature covers every byte of content.
 * Stored and signed: readers stay tolerant (unknown fields are kept in the
 * signed bytes; unknown content types are kept and named), writers strict.
 */

export const PACKAGE_FORMAT = "mutinybim-package";
export const PACKAGE_FORMAT_VERSION = 1;
export const PACKAGE_MANIFEST_PATH = "mutinybim.json";
export const PACKAGE_LICENSE_PATH = "LICENSE";
export const PACKAGE_SIGNATURES_DIR = "signatures/";

/** `@acme-mech/fan-coils`: a scope and a name, lower case. */
export const PACKAGE_NAME_PATTERN = /^@([a-z0-9][a-z0-9-]{0,63})\/([a-z0-9][a-z0-9._-]{0,99})$/;
/** A path inside a package: relative, forward slashes, no `.` or `..` parts. */
export const PACKAGE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/;

/** Content types this format names. Open: a newer publisher's type is kept and reported. */
export const PACKAGE_CONTENT_TYPES = ["part_type", "script", "addon"] as const;
export type PackageContentType = (typeof PACKAGE_CONTENT_TYPES)[number] | (string & {});

export const packageContentSchema = z.object({
  type: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/) as z.ZodType<PackageContentType>,
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),
  path: z.string().max(300).regex(PACKAGE_PATH_PATTERN, "a relative path inside the package"),
  /** `sha256:` of the file's bytes. */
  hash: contentHash,
});
export type PackageContent = z.infer<typeof packageContentSchema>;

/**
 * Why the publisher may share what's inside (product decision, Nov 2, answer 9): anyone
 * may publish a part made from a manufacturer's cut sheet if they declare
 * the right to share it. The declaration is signed with the manifest; the
 * catalogue shows who published it. It's a statement, not a check.
 */
export const RIGHTS_BASES = ["own_work", "manufacturer", "licensed", "permission", "public_domain"] as const;
export type RightsBasis = (typeof RIGHTS_BASES)[number] | (string & {});

export const rightsDeclarationSchema = z.object({
  /** `own_work`, `manufacturer` (the publisher is the maker), `licensed`, `permission` (the maker allows sharing), `public_domain`. Open. */
  basis: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/) as z.ZodType<RightsBasis>,
  /** In the publisher's words ("Drawn from Acme's published cut sheets; Acme allows redistribution of dimensional data."). */
  statement: text(2000),
  declaredBy: authorRefSchema,
  declaredAt: isoTime,
  /** What it was made from, by title only (never the document's text). */
  sources: z.array(z.object({ kind: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), title: text(300) })).max(50).optional(),
});
export type RightsDeclaration = z.infer<typeof rightsDeclarationSchema>;

export const packageManifestSchema = z.object({
  format: z.literal(PACKAGE_FORMAT),
  formatVersion: z.literal(PACKAGE_FORMAT_VERSION),
  name: z.string().regex(PACKAGE_NAME_PATTERN, "a package name such as @acme-mech/fan-coils"),
  version: semver,
  license: spdxExpression,
  summary: text(300).optional(),
  authors: z.array(authorRefSchema).min(1).max(20),
  requires: z.object({
    /** The add-on contract range (`>=1.9.0`). */
    kernelContract: text(40),
    /** Add-ons the contents need, `<pack id>` or `<pack id>@<range>` (`mutinybim.plumbing@>=1`). */
    packs: z.array(text(120)).max(50).optional(),
  }),
  contents: z.array(packageContentSchema).min(1).max(5000),
  rightsDeclaration: rightsDeclarationSchema,
  tags: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)).max(20).optional(),
});
export type PackageManifest = z.infer<typeof packageManifestSchema>;
export type PackageManifestInput = z.input<typeof packageManifestSchema>;

/** `{ scope, name }` of `@scope/name`, or null. */
export function splitPackageName(name: string): { readonly scope: string; readonly name: string } | null {
  const m = PACKAGE_NAME_PATTERN.exec(name);
  return m?.[1] && m[2] ? { scope: m[1], name: m[2] } : null;
}
