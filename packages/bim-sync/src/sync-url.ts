/**
 * The socket address for one model. The model id rides in the query so a
 * multi-machine authority can route the connection to the machine that owns
 * that model before the socket opens (the hello comes too late to move it).
 * The server never trusts this for access: it only picks where to look.
 */
export function syncUrlForModel(syncUrl: string, modelId: string): string {
  const url = new URL(syncUrl);
  url.searchParams.set("model", modelId);
  return url.toString();
}
