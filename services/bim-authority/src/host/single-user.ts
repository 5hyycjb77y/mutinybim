import { NO_MODEL_ACCESS } from "@permitzip/bim-sync";
import type { ModelServerHost, ModelServerHostContext } from "./contract";

/**
 * Example host plug-in: one person may read, edit and issue every model this
 * server serves; everyone else is refused. For a laptop or a single-seat
 * install, and as the smallest complete host to copy when writing your own.
 *
 *   MUTINYBIM_AUTHORIZER_MODULE=./src/host/single-user.ts
 *   MUTINYBIM_SINGLE_USER_ID=<the token's sub>
 *   MUTINYBIM_SINGLE_USER_ISSUER=<the token's iss>
 *   MUTINYBIM_SINGLE_USER_JWKS_URL=<that issuer's published key set>
 *   MUTINYBIM_SINGLE_USER_AUDIENCE=<the token's aud> (default "authenticated")
 *
 * A real host answers per project and per person from its own permission
 * system, as the signed-in person (their token), never with a service key.
 */

function required(env: ModelServerHostContext["env"], name: string): string {
  const value = env[name];
  if (!value) throw new Error(`[single-user host] ${name} is required`);
  return value;
}

export function createModelServerHost(context: ModelServerHostContext): ModelServerHost {
  const userId = required(context.env, "MUTINYBIM_SINGLE_USER_ID");
  const authorizer = {
    async capabilities(input: { readonly userId: string }) {
      if (input.userId !== userId) return { ok: false as const, reason: NO_MODEL_ACCESS };
      return { ok: true as const, capabilities: new Set(["model.read", "model.edit", "model.issue"] as const) };
    },
  };
  return {
    name: "single-user",
    signIn: {
      issuer: required(context.env, "MUTINYBIM_SINGLE_USER_ISSUER"),
      jwksUrl: required(context.env, "MUTINYBIM_SINGLE_USER_JWKS_URL"),
      audience: context.env.MUTINYBIM_SINGLE_USER_AUDIENCE || "authenticated",
    },
    authorizer: () => authorizer,
  };
}
