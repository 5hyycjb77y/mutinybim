// Local sign-in for `docker compose up`: an ES256 token issuer shaped like the
// sign-in the model server already verifies (a published key set at
// /auth/v1/.well-known/jwks.json, tokens with iss <url>/auth/v1 and aud
// "authenticated"). For a computer you trust; it signs in anyone who asks for
// one of the local names. Never point a deployed model server at it.
//
//   GET /token?name=Avery   -> { access_token, user_id, name, expires_in }
//   GET /auth/v1/.well-known/jwks.json
//   GET /health
//
// A new key pair at every start: tokens from before a restart stop working, and
// the editor page gets a fresh one when it reloads.
//
//   node --import tsx src/local-stack/signin.ts      (in the model server's image)
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { LOCAL_PEOPLE, localPerson, type LocalPerson } from "./people";

const port = Number(process.env.SIGNIN_PORT ?? 9999);
const issuer = `${(process.env.SIGNIN_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, "")}/auth/v1`;
const TOKEN_SECONDS = 12 * 60 * 60;

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const kid = randomUUID();
const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig" }] };

const b64url = (value: string | object): string => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

function tokenFor(person: LocalPerson): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url({ alg: "ES256", typ: "JWT", kid });
  const body = b64url({ iss: issuer, sub: person.userId, aud: "authenticated", role: "authenticated", iat: now, exp: now + TOKEN_SECONDS, user_metadata: { name: person.name } });
  const signature = sign("sha256", Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${head}.${body}.${signature}`;
}

function send(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://local");
  if (req.method === "GET" && url.pathname === "/auth/v1/.well-known/jwks.json") return send(res, 200, jwks);
  if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, issuer });
  if (req.method === "GET" && url.pathname === "/token") {
    const person = localPerson(url.searchParams.get("name") ?? "You");
    if (!person) return send(res, 403, { error: `Only the local people can sign in here: ${LOCAL_PEOPLE.join(", ")}. Open the editor with ?name=<one of them>.` });
    console.log(`[local-signin] signed in ${person.name}`);
    return send(res, 200, { access_token: tokenFor(person), user_id: person.userId, name: person.name, expires_in: TOKEN_SECONDS });
  }
  send(res, 404, { error: "Not found" });
});
server.on("error", (err) => {
  console.error("[local-signin] could not start", err);
  process.exit(1);
});
server.listen(port, () => console.log(`[local-signin] issuing local tokens as ${issuer} on port ${port} for ${LOCAL_PEOPLE.join(", ")}`));
