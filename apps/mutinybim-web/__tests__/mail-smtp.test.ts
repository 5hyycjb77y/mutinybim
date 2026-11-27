/**
 * @jest-environment node
 *
 * The app's own email through real Nodemailer and a small SMTP server on this
 * computer: the settings, what goes over the wire, a stuck server, and Forgot
 * password end to end with mail configured the way a deployment would.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { createApp, type App } from "../src/app";
import { parseMail, senderDomain, type MailConfig, type WebConfig } from "../src/config";
import { resetMail, smtpMailer } from "../src/mailer";

interface Received {
  readonly from: string;
  readonly to: readonly string[];
  readonly auth: string | null;
  readonly data: string;
}

/** Just enough SMTP to accept a message (no TLS). "silent" accepts the connection and never greets. */
async function fakeSmtp(mode: "normal" | "silent" = "normal"): Promise<{ port: number; received: Received[]; close(): Promise<void> }> {
  const received: Received[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    if (mode === "silent") return;
    const say = (line: string) => socket.write(`${line}\r\n`);
    let buffer = "";
    let inData = false;
    let current = { from: "", to: [] as string[], auth: null as string | null, data: "" };
    say("220 fake.test ESMTP");
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let end = buffer.indexOf("\r\n"); end >= 0; end = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            received.push({ ...current, to: [...current.to] });
            current = { from: "", to: [], auth: current.auth, data: "" };
            say("250 queued");
          } else {
            current.data += `${line.startsWith("..") ? line.slice(1) : line}\n`;
          }
          continue;
        }
        const upper = line.toUpperCase();
        if (upper.startsWith("EHLO")) socket.write("250-fake.test\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n");
        else if (upper.startsWith("HELO")) say("250 fake.test");
        else if (upper.startsWith("AUTH PLAIN ")) {
          current.auth = Buffer.from(line.slice("AUTH PLAIN ".length).trim(), "base64").toString("utf8");
          say("235 accepted");
        } else if (upper.startsWith("MAIL FROM:")) {
          current.from = line.match(/<([^>]*)>/)?.[1] ?? "";
          say("250 ok");
        } else if (upper.startsWith("RCPT TO:")) {
          current.to.push(line.match(/<([^>]*)>/)?.[1] ?? "");
          say("250 ok");
        } else if (upper === "DATA") {
          inData = true;
          say("354 go ahead");
        } else if (upper === "QUIT") {
          say("221 bye");
          socket.end();
        } else if (upper === "RSET" || upper === "NOOP") say("250 ok");
        else say("502 not here");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    port: address.port,
    received,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The message's headers and its decoded plain-text body (quoted-printable soft breaks undone). */
function parseMessage(data: string): { headers: string; body: string } {
  const split = data.indexOf("\n\n");
  const headers = data.slice(0, split);
  const raw = data.slice(split + 2);
  const body = /content-transfer-encoding:\s*quoted-printable/i.test(headers)
    ? raw.replace(/=\n/g, "").replace(/=([0-9A-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    : raw;
  return { headers, body };
}

const FROM = "MutinyBIM <no-reply@example.test>";
const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

describe("MUTINYBIM_WEB_MAIL settings", () => {
  test("mail is off unless chosen", () => {
    expect(parseMail({})).toBeNull();
    expect(parseMail({ MUTINYBIM_WEB_MAIL: "off" })).toBeNull();
  });

  test("smtp needs a server and a sender, and errors never repeat the server address", () => {
    const secretUrl = "smtps://mailer:hunter2-secret@smtp.example.test:465";
    expect(() => parseMail({ MUTINYBIM_WEB_MAIL: "smtp", MUTINYBIM_WEB_MAIL_URL: secretUrl })).toThrow(/MUTINYBIM_WEB_MAIL_FROM/);
    expect(() => parseMail({ MUTINYBIM_WEB_MAIL: "smtp", MUTINYBIM_WEB_MAIL_FROM: FROM })).toThrow(/MUTINYBIM_WEB_MAIL_URL/);
    expect(() => parseMail({ MUTINYBIM_WEB_MAIL: "sendmail" })).toThrow(/off or smtp/);
    for (const bad of ["https://mailer:hunter2-secret@smtp.example.test", "not a url hunter2-secret"]) {
      let message = "";
      try {
        parseMail({ MUTINYBIM_WEB_MAIL: "smtp", MUTINYBIM_WEB_MAIL_URL: bad, MUTINYBIM_WEB_MAIL_FROM: FROM });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/smtp:\/\/ or smtps:\/\//);
      expect(message).not.toContain("hunter2");
    }
  });

  test("the sender is one address with no line breaks", () => {
    const base = { MUTINYBIM_WEB_MAIL: "smtp", MUTINYBIM_WEB_MAIL_URL: "smtps://u:p@smtp.example.test:465" };
    for (const bad of ["MutinyBIM <no-reply@example.test>\r\nBcc: x@example.test", "a@example.test, b@example.test", "no-reply"]) {
      expect(() => parseMail({ ...base, MUTINYBIM_WEB_MAIL_FROM: bad })).toThrow(/MUTINYBIM_WEB_MAIL_FROM/);
    }
    const mail = parseMail({ ...base, MUTINYBIM_WEB_MAIL_FROM: FROM });
    expect(mail).toEqual({ kind: "smtp", url: base.MUTINYBIM_WEB_MAIL_URL, from: FROM });
    expect(mail && senderDomain(mail)).toBe("example.test");
    expect(senderDomain({ kind: "smtp", url: "smtp://h", from: "bare@mail.example.test" })).toBe("mail.example.test");
  });
});

test("an SMTP send signs in, addresses the envelope and headers exactly, and carries the link", async () => {
  const smtp = await fakeSmtp();
  servers.push(smtp);
  const mailer = smtpMailer({ kind: "smtp", url: `smtp://mailer%40example.test:s3cret@127.0.0.1:${smtp.port}`, from: FROM });
  await mailer.send(resetMail("https://app.example.test", "bea@example.test", "tok_abcdefghijklmnopqrstuvwxyz0123456789"));

  expect(smtp.received).toHaveLength(1);
  const [message] = smtp.received;
  expect(message?.auth).toBe("\u0000mailer@example.test\u0000s3cret");
  expect(message?.from).toBe("no-reply@example.test");
  expect(message?.to).toEqual(["bea@example.test"]);
  const { headers, body } = parseMessage(message?.data ?? "");
  expect(headers).toMatch(/^From: MutinyBIM <no-reply@example\.test>$/m);
  expect(headers).toMatch(/^To: bea@example\.test$/m);
  expect(headers).toMatch(/^Subject: Reset your MutinyBIM password$/m);
  expect(headers).not.toMatch(/^(Cc|Bcc):/im);
  expect(body).toContain("https://app.example.test/reset/tok_abcdefghijklmnopqrstuvwxyz0123456789");
});

test("a recipient that isn't one plain address never reaches the server", async () => {
  const smtp = await fakeSmtp();
  servers.push(smtp);
  const mailer = smtpMailer({ kind: "smtp", url: `smtp://127.0.0.1:${smtp.port}`, from: FROM });
  await expect(mailer.send({ to: "bea@example.test\r\nBcc: x@example.test", purpose: "reset", subject: "s", text: "t" })).rejects.toThrow(/one plain recipient/);
  expect(smtp.received).toHaveLength(0);
});

test("a server that never answers gives up within the timeout", async () => {
  const smtp = await fakeSmtp("silent");
  servers.push(smtp);
  const mailer = smtpMailer({ kind: "smtp", url: `smtp://127.0.0.1:${smtp.port}`, from: FROM }, { connectMs: 500, greetingMs: 500, socketMs: 1_000 });
  const started = Date.now();
  await expect(mailer.send(resetMail("https://app.example.test", "bea@example.test", "tok_abcdefghijklmnopqrstuvwxyz"))).rejects.toMatchObject({ code: "ETIMEDOUT" });
  expect(Date.now() - started).toBeLessThan(5_000);
});

describe("Forgot password with MUTINYBIM_WEB_MAIL=smtp", () => {
  let dataDir = "";
  let app: App | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  test("the configured server receives one link that works once", async () => {
    const smtp = await fakeSmtp();
    servers.push(smtp);
    dataDir = await mkdtemp(path.join(os.tmpdir(), "mutinybim-web-smtp-"));
    const mail: MailConfig = { kind: "smtp", url: `smtp://127.0.0.1:${smtp.port}`, from: FROM };
    const config = (port: number): WebConfig => ({ port, host: "127.0.0.1", origin: `http://127.0.0.1:${port}`, dataDir, modelLimit: 3, signupOpen: true, providers: [], quote: null, secure: false, mail });
    const probe = createApp(config(0), { editor: false });
    await probe.listen();
    const address = probe.server.address();
    await probe.close();
    if (!address || typeof address === "string") throw new Error("no port");
    app = createApp(config(address.port), { editor: false });
    await app.listen();
    const base = `http://127.0.0.1:${address.port}`;
    const post = (pathname: string, form: Record<string, string>) =>
      fetch(`${base}${pathname}`, { method: "POST", redirect: "manual", headers: { origin: base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });

    expect(await (await fetch(`${base}/forgot`)).text()).toContain("Send reset link");
    expect((await post("/signup", { name: "Bea Example", email: "bea@example.test", password: "correct-horse" })).status).toBe(303);
    const reply = await post("/forgot", { email: "bea@example.test" });
    expect(reply.status).toBe(200);
    await app.settled();

    expect(smtp.received.map((m) => m.to)).toEqual([["bea@example.test"]]);
    const token = parseMessage(smtp.received[0]?.data ?? "").body.match(new RegExp(`${base.replace(/\./g, "\\.")}/reset/([A-Za-z0-9_-]{20,80})`))?.[1];
    if (!token) throw new Error("the email held no reset link for this server");
    expect((await post(`/reset/${token}`, { password: "new-password-2" })).status).toBe(303);
    expect((await post(`/reset/${token}`, { password: "new-password-3" })).status).toBe(410);
  });
});
