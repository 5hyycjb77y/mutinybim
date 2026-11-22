/** A heading's anchor as GitHub makes it (lower case, punctuation dropped, spaces to dashes). The docs site uses it too, so links match. */
export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 _-]/g, "").trim().replace(/\s+/g, "-");
}
