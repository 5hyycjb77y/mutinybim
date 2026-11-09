import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ModelServerHost, ModelServerHostContext, ModelServerHostModule } from "./contract";

/**
 * Loads the host plug-in named by MUTINYBIM_AUTHORIZER_MODULE: a path (relative
 * to the working directory, or absolute) or a package name. Anything that does
 * not keep the contract (`contract.ts`) stops the server at start, never later.
 */

export type ModuleImporter = (specifier: string) => Promise<unknown>;

const importModule: ModuleImporter = (specifier) => import(specifier);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function specifierFor(spec: string, cwd: string): string {
  if (spec.startsWith(".") || isAbsolute(spec)) return pathToFileURL(isAbsolute(spec) ? spec : resolve(cwd, spec)).href;
  return spec;
}

/** The module's exports checked against the contract. */
export function asHostModule(value: unknown, spec: string): ModelServerHostModule {
  if (!isRecord(value)) throw new Error(`[host] ${spec} did not load as a module`);
  const create = value.createModelServerHost;
  if (typeof create !== "function") throw new Error(`[host] ${spec} must export createModelServerHost(context)`);
  const digests = value.forbiddenDbRefDigests;
  if (digests !== undefined && !(Array.isArray(digests) && digests.every((d) => typeof d === "string" && /^[0-9a-f]{64}$/.test(d)))) {
    throw new Error(`[host] ${spec}: forbiddenDbRefDigests must be SHA-256 hex digests`);
  }
  return {
    ...(digests ? { forbiddenDbRefDigests: digests } : {}),
    createModelServerHost: (context: ModelServerHostContext) => create(context),
  };
}

export async function loadModelServerHostModule(
  spec: string | null | undefined,
  cwd: string = process.cwd(),
  importer: ModuleImporter = importModule,
): Promise<ModelServerHostModule | null> {
  if (!spec) return null;
  let loaded: unknown;
  try {
    loaded = await importer(specifierFor(spec, cwd));
  } catch (err) {
    throw new Error(`[host] could not load MUTINYBIM_AUTHORIZER_MODULE ${spec}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return asHostModule(loaded, spec);
}

function isUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value) return false;
  try {
    new URL(value);
    return true;
  } catch (err) {
    console.error("[host] not a URL", { value, err: err instanceof Error ? err.message : err });
    return false;
  }
}

/** Throws unless `value` keeps the ModelServerHost contract. */
export function assertModelServerHost(value: unknown, spec: string): asserts value is ModelServerHost {
  if (!isRecord(value)) throw new Error(`[host] ${spec}: createModelServerHost returned no host`);
  if (typeof value.name !== "string" || !value.name) throw new Error(`[host] ${spec}: the host needs a name`);
  const signIn = value.signIn;
  if (!isRecord(signIn) || !isUrl(signIn.issuer) || !isUrl(signIn.jwksUrl) || typeof signIn.audience !== "string" || !signIn.audience) {
    throw new Error(`[host] ${spec}: signIn needs an issuer URL, a jwksUrl and an audience`);
  }
  if (typeof value.authorizer !== "function") throw new Error(`[host] ${spec}: the host needs authorizer(projectHint)`);
  for (const optional of ["servesOnDemand", "allowsImportSource", "lineageActs"] as const) {
    if (value[optional] !== undefined && typeof value[optional] !== "function") throw new Error(`[host] ${spec}: ${optional} must be a function`);
  }
  const merge = value.mergeApprovals;
  if (merge !== undefined && !(isRecord(merge) && typeof merge.responsibilitiesFor === "function" && typeof merge.proposalFor === "function")) {
    throw new Error(`[host] ${spec}: mergeApprovals must answer responsibilitiesFor and proposalFor`);
  }
}

/** Creates the host from a loaded module and checks it. */
export async function createHost(module: ModelServerHostModule, context: ModelServerHostContext, spec: string): Promise<ModelServerHost> {
  const host: unknown = await module.createModelServerHost(context);
  assertModelServerHost(host, spec);
  return host;
}
