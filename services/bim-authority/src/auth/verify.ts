import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { supabaseSignIn, type SignInSource } from "../host/contract";

/** "host": the host plug-in's sign-ins. "test": the authority database's own Auth (seeded test users). */
export type LoginIssuer = "host" | "test";

export interface VerifiedLogin {
  readonly userId: string;
  readonly issuer: LoginIssuer;
  /** Token expiry (epoch seconds); the live session is re-checked before then. */
  readonly expiresAt: number | null;
}

interface Issuer {
  readonly kind: LoginIssuer;
  readonly source: SignInSource;
  readonly keys: JWTVerifyGetKey;
}

/**
 * Verifies access tokens (published key set) from the host plug-in's sign-in
 * source and, on a disposable stack, from the authority database's own Auth
 * (seeded test users). Nothing else is accepted.
 */
export class LoginVerifier {
  private readonly issuers: Issuer[];

  constructor(sources: { readonly host: SignInSource | null; readonly testUrl: string | null }) {
    this.issuers = [];
    if (sources.host) this.issuers.push(issuer("host", sources.host));
    if (sources.testUrl) this.issuers.push(issuer("test", supabaseSignIn(sources.testUrl)));
  }

  async verify(token: string): Promise<VerifiedLogin> {
    const iss = issuerClaim(token);
    const match = this.issuers.find((i) => i.source.issuer === iss);
    if (!match) throw new Error(`Sign-in from an unknown issuer (${iss ?? "none"})`);
    const { payload } = await jwtVerify(token, match.keys, { issuer: match.source.issuer, audience: match.source.audience });
    if (typeof payload.sub !== "string" || !payload.sub) throw new Error("Token has no subject");
    return { userId: payload.sub, issuer: match.kind, expiresAt: typeof payload.exp === "number" ? payload.exp : null };
  }
}

function issuer(kind: LoginIssuer, source: SignInSource): Issuer {
  return { kind, source, keys: createRemoteJWKSet(new URL(source.jwksUrl)) };
}

/** The unverified `iss` claim, only to pick which key set to verify against. */
function issuerClaim(token: string): string | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const json: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (typeof json === "object" && json !== null && "iss" in json && typeof json.iss === "string") return json.iss;
    return null;
  } catch (err) {
    console.error("[bim-authority] token payload is not JSON", err instanceof Error ? err.message : err);
    return null;
  }
}
