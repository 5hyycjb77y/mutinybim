/**
 * Outgoing mail. Routes build each message from a fixed plain-text template
 * here and hand it to a `Mailer`. `createApp` builds an SMTP mailer (through
 * Nodemailer) when MUTINYBIM_WEB_MAIL=smtp, or takes one through
 * `AppOptions.mailer` (tests pass a recording mailer). With neither, the app
 * sends nothing and keeps its no-email recovery paths.
 *
 * Rules for every message: a fixed subject per purpose, a plain-text body, one
 * recipient that passed the app's email check, and links built from
 * `MUTINYBIM_WEB_ORIGIN`. Callers never log a message's text, because it
 * carries a live link.
 */
import { createTransport } from "nodemailer";
import type { MailConfig } from "./config";
import { INVITATION_DAYS } from "./model-invitations";
import { CONFIRM_LINK_HOURS, RESET_LINK_HOURS } from "./secrets";

export interface Mail {
  readonly to: string;
  readonly purpose: "reset" | "confirm" | "invite";
  readonly subject: string;
  readonly text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** The app's email check: one address, no spaces or line breaks. */
export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The message that carries a password reset link to the account's own address. */
export function resetMail(origin: string, to: string, token: string): Mail {
  if (!EMAIL_SHAPE.test(to)) throw new Error("[mutinybim-web mail] a message needs one plain recipient address");
  return {
    to,
    purpose: "reset",
    subject: "Reset your MutinyBIM password",
    text: [
      `Someone asked to reset the password for the MutinyBIM account that uses ${to}.`,
      "",
      `To choose a new password, open this link within ${RESET_LINK_HOURS} hour:`,
      `${origin}/reset/${token}`,
      "",
      "The link works once. Saving a new password signs you out everywhere else.",
      "",
      "If you didn't ask for this, ignore this email. Your password stays the same.",
    ].join("\n"),
  };
}

/** The message that asks the account's owner to confirm its address. */
export function confirmMail(origin: string, to: string, token: string): Mail {
  if (!EMAIL_SHAPE.test(to)) throw new Error("[mutinybim-web mail] a message needs one plain recipient address");
  return {
    to,
    purpose: "confirm",
    subject: "Confirm your email for MutinyBIM",
    text: [
      `Someone asked to confirm ${to} for a MutinyBIM account.`,
      "",
      `To confirm it, open this link within ${CONFIRM_LINK_HOURS} hours while logged in to that account:`,
      `${origin}/confirm/${token}`,
      "",
      "Once it's confirmed, you can accept invitations to models sent to this address.",
      "",
      "If you didn't ask for this, ignore this email.",
    ].join("\n"),
  };
}

/** Person-supplied text for a message body: one line, no control characters, at most `max` characters. */
export function oneLine(text: string, max: number): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** The message that invites an address to a model. Names stay in the body, never the subject. */
export function invitationMail(origin: string, to: string, token: string, invite: { readonly inviter: string; readonly model: string; readonly role: "view" | "edit" }): Mail {
  if (!EMAIL_SHAPE.test(to)) throw new Error("[mutinybim-web mail] a message needs one plain recipient address");
  return {
    to,
    purpose: "invite",
    subject: "You're invited to a model on MutinyBIM",
    text: [
      `${oneLine(invite.inviter, 80)} invited ${to} to ${invite.role === "edit" ? "edit" : "view"} the model "${oneLine(invite.model, 120)}" on MutinyBIM.`,
      "",
      `To accept, open this link within ${INVITATION_DAYS} days while logged in to an account that uses ${to}:`,
      `${origin}/invitations/${token}`,
      "",
      "No account yet? Sign up with this address and confirm it in Settings, then open the link again.",
      "The invitation also waits on your My models page once your address is confirmed.",
      "",
      "If you don't know the sender, ignore this email. Nothing is shared until you accept.",
    ].join("\n"),
  };
}

/** How long one SMTP exchange may take, so a stuck server can't hold a send (or shutdown) forever. */
export interface SmtpTimeouts {
  readonly connectMs: number;
  readonly greetingMs: number;
  readonly socketMs: number;
}

const SMTP_TIMEOUTS: SmtpTimeouts = { connectMs: 10_000, greetingMs: 10_000, socketMs: 20_000 };
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * A Mailer that hands each message to an SMTP server. smtps:// connects over
 * TLS; smtp:// must upgrade with STARTTLS unless the server is this computer.
 * Messages carry no attachments, and Nodemailer may not read files or fetch
 * addresses while building them.
 */
export function smtpMailer(config: MailConfig, timeouts: SmtpTimeouts = SMTP_TIMEOUTS): Mailer {
  const server = new URL(config.url);
  const transport = createTransport(
    {
      url: config.url,
      requireTLS: server.protocol === "smtp:" && !LOOPBACK_HOSTS.has(server.hostname),
      connectionTimeout: timeouts.connectMs,
      greetingTimeout: timeouts.greetingMs,
      socketTimeout: timeouts.socketMs,
      disableFileAccess: true,
      disableUrlAccess: true,
    },
    { from: config.from },
  );
  return {
    async send(mail) {
      if (!EMAIL_SHAPE.test(mail.to)) throw new Error("[mutinybim-web mail] a message needs one plain recipient address");
      await transport.sendMail({ to: mail.to, subject: mail.subject, text: mail.text, disableFileAccess: true, disableUrlAccess: true });
    },
  };
}
