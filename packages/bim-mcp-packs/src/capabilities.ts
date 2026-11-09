/**
 * The typed, trade-neutral services some packs need from their host beyond
 * the caller (where a sheet PDF is stored, the firm's part library, linked
 * models…). Each family declares its own in `<family>/capabilities.ts`; this
 * module collects them. A host supplies each one, or the `notAvailableHere`
 * answer with plain words when it has no equivalent (a local server has no
 * Autodesk link, for instance).
 */

/** A host service that exists here, or the words saying why it doesn't. */
export type Capability<T> = { readonly available: true; readonly service: T } | { readonly available: false; readonly reason: string };

export function notAvailableHere<T>(reason: string): Capability<T> {
  return { available: false, reason };
}

export function available<T>(service: T): Capability<T> {
  return { available: true, service };
}

/** The service, or an Error with the host's words (a tool's catch turns it into its usual failure answer). */
export function serviceOf<T>(capability: Capability<T> | undefined, what: string): T {
  if (!capability) throw new Error(`${what} isn't available on this MutinyBIM server.`);
  if (!capability.available) throw new Error(`${what} isn't available here: ${capability.reason}`);
  return capability.service;
}
