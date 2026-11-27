/** @jest-environment node */
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { nativeMembershipRequest } from "../native-members-http";
import { PgNativeModelMembers } from "../native-model-members";
import type { Sql } from "../pg-store";

const served = { servedModels: new Set(["east-plant"]), aliases: new Map([["plant", "east-plant"]]) };
const change = { personId: "12345678-0000-0000-0000-000000000036", expectedRole: "viewer", role: "editor" };
const headers = { authorization: "Bearer test-session", "content-type": "application/json; charset=utf-8" };

function store(updateMembership = jest.fn(), readMemberships = jest.fn()) {
  return { updateMembership, readMemberships };
}

function request(body: string | string[] = JSON.stringify(change), overrides: IncomingMessage["headers"] = {}, method = "POST") {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.headers = { ...headers, ...overrides };
  for (const part of Array.isArray(body) ? body : [body]) req.push(Buffer.from(part));
  req.push(null);
  return req;
}

describe("native membership HTTP", () => {
  it("returns the decision for the canonical base model and the session from the header", async () => {
    const updateMembership = jest.fn().mockResolvedValue({ result: "changed", role: "editor" });
    const reply = await nativeMembershipRequest(request(), "plant", served, store(updateMembership));
    expect(updateMembership).toHaveBeenCalledWith("east-plant", "test-session", change);
    expect(reply).toEqual({ status: 200, body: { result: "changed", role: "editor" } });
  });

  it.each([
    ["unchanged", null, 200], ["conflict", "editor", 409], ["conflict", null, 409],
  ])("returns the observed role for %s (%s)", async (result, role, status) => {
    const updateMembership = jest.fn().mockResolvedValue({ result, role });
    const reply = await nativeMembershipRequest(request(), "east-plant", served, store(updateMembership));
    expect(reply).toMatchObject({ status, body: { result, role } });
  });

  it.each([
    ["unauthenticated", 401], ["denied", 403], ["unknown_person", 404], ["invalid", 400],
  ])("returns a readable error for %s", async (result, status) => {
    const updateMembership = jest.fn().mockResolvedValue({ result });
    const reply = await nativeMembershipRequest(request(), "east-plant", served, store(updateMembership));
    expect(reply.status).toBe(status);
    expect(reply.body).toEqual({ error: expect.any(String) });
  });

  it("reports an unconfirmed change when storage cannot answer", async () => {
    const updateMembership = jest.fn().mockRejectedValue(new Error("internal database detail"));
    const reply = await nativeMembershipRequest(request(), "east-plant", served, store(updateMembership));
    expect(reply.status).toBe(503);
    expect(reply.body).toEqual({ error: expect.stringMatching(/same expected role/) });
  });

  it.each(["west-plant", "east-plant~proposal", "%"])("refuses the model address %s before changing membership", async model => {
    const updateMembership = jest.fn();
    const reply = await nativeMembershipRequest(request(), model, served, store(updateMembership));
    expect(reply.status).toBe(404);
    expect(updateMembership).not.toHaveBeenCalled();
  });

  it("requires a bearer, a supported method and a bounded JSON mutation", async () => {
    const updateMembership = jest.fn();
    const send = (req: IncomingMessage) => nativeMembershipRequest(req, "east-plant", served, store(updateMembership));
    expect(await send(request(undefined, { authorization: undefined, cookie: "session=test-session" })))
      .toMatchObject({ status: 401, headers: { "www-authenticate": "Bearer" } });
    expect(await send(request(undefined, {}, "PUT"))).toMatchObject({ status: 405, headers: { allow: "GET, POST, OPTIONS" } });
    expect((await send(request(undefined, { "content-type": "text/plain" }))).status).toBe(415);
    expect((await send(request("unfinished"))).status).toBe(400);
    expect((await send(request("", { "content-length": "4097" }))).status).toBe(413);
    expect((await send(request([" ".repeat(3000), " ".repeat(1200)]))).status).toBe(413);
    expect(updateMembership).not.toHaveBeenCalled();
  });

  it.each([
    { ...change, role: "owner" }, { ...change, actorId: "mara" },
    { personId: change.personId, role: null }, { ...change, personId: "Mara" },
  ])("validates the exact change before touching storage", async input => {
    const begin = jest.fn();
    const members = new PgNativeModelMembers({ begin } as unknown as Sql);
    const reply = await nativeMembershipRequest(request(JSON.stringify(input)), "east-plant", served, members);
    expect(reply.status).toBe(400);
    expect(begin).not.toHaveBeenCalled();
  });

  it.each([null, change.personId])("reads the model roster or an exact person without changing it (%s)", async target => {
    const person = { personId: change.personId, displayName: "Jules", role: target ? null : "viewer" };
    const members = store();
    members.readMemberships.mockResolvedValue({ result: "ok", ownerId: "mara", members: [person] });
    const reply = await nativeMembershipRequest(request("", { "content-type": undefined }, "GET"), "plant", served, members, target);
    expect(reply).toEqual({ status: 200, body: { ownerId: "mara", members: [person] } });
    expect(members.readMemberships).toHaveBeenCalledWith("east-plant", "test-session", target);
    expect(members.updateMembership).not.toHaveBeenCalled();
  });

  it.each([["denied", 403], ["unauthenticated", 401], ["unknown_person", 404], ["invalid", 400]])(
    "does not return person details for a %s read", async (result, status) => {
      const members = store();
      members.readMemberships.mockResolvedValue({ result });
      const reply = await nativeMembershipRequest(request("", {}, "GET"), "east-plant", served, members, change.personId);
      expect(reply.status).toBe(status);
      expect(reply.body).toEqual({ error: expect.any(String) });
      expect(members.updateMembership).not.toHaveBeenCalled();
    });

  it("requires a native bearer to read and handles an unavailable store", async () => {
    const members = store();
    const send = (req: IncomingMessage) => nativeMembershipRequest(req, "east-plant", served, members);
    expect((await send(request("", { authorization: undefined }, "GET"))).status).toBe(401);
    expect(members.readMemberships).not.toHaveBeenCalled();
    members.readMemberships.mockRejectedValue(new Error("internal detail"));
    expect(await send(request("", {}, "GET"))).toEqual({ status: 503, body: { error: "Members could not be loaded. Try again." } });
    expect(members.updateMembership).not.toHaveBeenCalled();
  });

  it("validates an exact person ID before opening a read transaction", async () => {
    const begin = jest.fn();
    const members = new PgNativeModelMembers({ begin } as unknown as Sql);
    const reply = await nativeMembershipRequest(request("", {}, "GET"), "east-plant", served, members, "Jules");
    expect(reply.status).toBe(400);
    expect(begin).not.toHaveBeenCalled();
  });
});
