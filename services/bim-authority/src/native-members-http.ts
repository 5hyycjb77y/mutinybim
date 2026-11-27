import type { IncomingMessage } from "node:http";
import { parseBranchModelId } from "@permitzip/bim-kernel";
import { servedModelId, type ServedModels } from "./config";
import type { PgNativeModelMembers } from "./native-model-members";

type MemberStore = Pick<PgNativeModelMembers, "updateMembership" | "readMemberships">;
interface Reply {
  status: number;
  body: object;
  headers?: Record<string, string>;
}

const signIn = { status: 401, body: { error: "Sign in to the model server again." }, headers: { "www-authenticate": "Bearer" } };
const invalidChange = { status: 400, body: { error: "Supply the person's ID, their expected role and the role to save." } };
const tooLarge = { status: 413, body: { error: "The membership change is too large." } };
const maxBytes = 4096;

/** The route accepts base-model membership changes on a native authority. Copy grants are resolved separately. */
export async function nativeMembershipRequest(req: IncomingMessage, encodedModel: string, served: ServedModels, members: MemberStore, targetId: string | null = null): Promise<Reply> {
  if (req.method !== "POST" && req.method !== "GET") return { status: 405, body: { error: "Use GET to review members or POST to change a membership." }, headers: { allow: "GET, POST, OPTIONS" } };
  const token = /^Bearer[ \t]+([^\s,]+)$/i.exec(req.headers.authorization ?? "")?.[1];
  if (!token) return signIn;
  let modelId: string | null;
  try {
    modelId = servedModelId(served, decodeURIComponent(encodedModel));
  } catch {
    modelId = null;
  }
  if (!modelId || parseBranchModelId(modelId)) return { status: 404, body: { error: "Use the Main model address on its model server." } };
  if (req.method === "GET") {
    try {
      const read = await members.readMemberships(modelId, token, targetId);
      switch (read.result) {
        case "ok": return { status: 200, body: { ownerId: read.ownerId, members: read.members } };
        case "unauthenticated": return signIn;
        case "denied": return { status: 403, body: { error: "Only the model owner or a manager can manage members." } };
        case "unknown_person": return { status: 404, body: { error: "Ask the person to sign in and check their person ID." } };
        case "invalid": return { status: 400, body: { error: "Enter the person's full ID." } };
      }
    } catch {
      return { status: 503, body: { error: "Members could not be loaded. Try again." } };
    }
  }
  if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return { status: 415, body: { error: "Send the membership change as application/json." } };
  }

  if (Number(req.headers["content-length"]) > maxBytes) return tooLarge;
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > maxBytes) {
      req.resume();
      return tooLarge;
    }
    chunks.push(bytes);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return invalidChange;
  }

  try {
    const decision = await members.updateMembership(modelId, token, body);
    switch (decision.result) {
      case "changed":
      case "unchanged": return { status: 200, body: decision };
      case "conflict": return { status: 409, body: { ...decision, error: "This person's role changed. Review the returned role before trying again." } };
      case "unauthenticated": return signIn;
      case "denied": return { status: 403, body: { error: "You cannot change this person's membership on this model." } };
      case "unknown_person": return { status: 404, body: { error: "Ask the person to sign in and confirm their person ID." } };
      case "invalid": return invalidChange;
    }
  } catch {
    return { status: 503, body: { error: "The server could not confirm the change. Retry with the same expected role." } };
  }
}
