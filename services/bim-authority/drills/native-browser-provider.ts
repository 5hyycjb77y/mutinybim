/** Development identity provider for the local Compose stack and browser drill. */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const port = Number(process.env.MUTINYBIM_DEMO_SIGNIN_PORT ?? process.env.NATIVE_DRILL_ISSUER_PORT);
const editor = new URL(process.env.MUTINYBIM_EDITOR_ORIGIN ?? "");
const password = process.env.MUTINYBIM_DEMO_PASSWORD ?? process.env.NATIVE_DRILL_PASSWORD;
if (!Number.isInteger(port) || port < 1 || port > 65535 || editor.protocol !== "http:" || editor.hostname !== "127.0.0.1" ||
    editor.href !== editor.origin + "/" || !password || password.length < 16) throw new Error("Supply the disposable loopback editor, issuer port and drill password.");
const issuer = "http://127.0.0.1:" + port;
const callback = editor.origin + "/auth/native/callback";
const client = "east-plant-editor";
const names = new Map([["mara", "Mara"], ["jules", "Jules"]]);
const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
const kid = randomBytes(16).toString("hex");
const jwks = { keys: [{ ...await exportJWK(publicKey), kid, alg: "ES256", use: "sig" }] };
const secret = () => randomBytes(32).toString("base64url");
type Login = { state: string; nonce: string; challenge: string; expires: number };
const requests = new Map<string, Login>();
const codes = new Map<string, Login & { subject: string }>();

function send(res: ServerResponse, status: number, value: object) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", issuer);
    res.setHeader("referrer-policy", "same-origin");
    res.setHeader("cache-control", "no-store");
    if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") return send(res, 200, {
      issuer, authorization_endpoint: issuer + "/authorize", token_endpoint: issuer + "/token", jwks_uri: issuer + "/keys",
      response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["ES256"],
      code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
    });
    if (req.method === "GET" && url.pathname === "/keys") return send(res, 200, jwks);
    if (req.method === "GET" && url.pathname === "/authorize") {
      const p = url.searchParams, state = p.get("state"), nonce = p.get("nonce"), challenge = p.get("code_challenge");
      if (p.get("client_id") !== client || p.get("redirect_uri") !== callback || p.get("response_type") !== "code" ||
          !p.get("scope")?.split(" ").includes("openid") || p.get("code_challenge_method") !== "S256" ||
          !state || !nonce || !challenge) return send(res, 400, { error: "invalid_request" });
      const id = secret();
      requests.set(id, { state, nonce, challenge, expires: Date.now() + 120_000 });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; form-action 'self' " + callback + "; frame-ancestors 'none'; base-uri 'none'" });
      return res.end('<!doctype html><html lang="en"><title>East plant development sign-in</title><main><h1>Sign in to East plant</h1><form method="post" action="/login"><input type="hidden" name="request" value="' + id + '"><p><label>Username <input name="username" autocomplete="username" required></label></p><p><label>Password <input type="password" name="password" autocomplete="current-password" required></label></p><button>Sign in</button></form></main></html>');
    }
    if (req.method !== "POST" || !["/login", "/token"].includes(url.pathname)) return send(res, 404, { error: "not_found" });
    let body = "";
    for await (const bytes of req) {
      body += bytes.toString();
      if (body.length > 8192) return send(res, 400, { error: "invalid_request" });
    }
    const form = new URLSearchParams(body);
    if (url.pathname === "/login") {
      const id = form.get("request") ?? "", subject = form.get("username") ?? "";
      const login = requests.get(id);
      if (req.headers.origin !== issuer || !login || login.expires <= Date.now() || !names.has(subject) || form.get("password") !== password) {
        return send(res, 403, { error: "login_refused" });
      }
      requests.delete(id);
      const code = secret();
      codes.set(code, { ...login, subject });
      const back = new URL(callback);
      back.searchParams.set("state", login.state);
      back.searchParams.set("code", code);
      res.writeHead(303, { location: back.href });
      return res.end();
    }
    const code = form.get("code") ?? "", login = codes.get(code);
    codes.delete(code);
    if (!login || login.expires <= Date.now() || form.get("grant_type") !== "authorization_code" ||
        form.get("client_id") !== client || form.get("redirect_uri") !== callback ||
        createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== login.challenge) {
      return send(res, 400, { error: "invalid_grant" });
    }
    const id_token = await new SignJWT({ nonce: login.nonce, name: names.get(login.subject) }).setProtectedHeader({ alg: "ES256", kid })
      .setIssuer(issuer).setAudience(client).setSubject(login.subject).setIssuedAt().setExpirationTime("2m").sign(privateKey);
    return send(res, 200, { id_token, access_token: secret(), token_type: "Bearer", expires_in: 120 });
  } catch { return send(res, 400, { error: "invalid_request" }); }
});
const bindHost = process.env.MUTINYBIM_DEMO_CONTAINER === "1" ? "0.0.0.0" : "127.0.0.1";
server.listen(port, bindHost, () => console.log("East plant development sign-in ready."));
