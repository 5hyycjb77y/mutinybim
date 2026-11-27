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
import { RESET_LINK_HOURS } from "./secrets";

export interface Mail {
  readonly to: string;
  readonly purpose: "reset";
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
