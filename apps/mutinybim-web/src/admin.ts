/**
 * Operator commands for the hosted app, run on the server with the same
 * settings as the app (MUTINYBIM_WEB_DATA, MUTINYBIM_WEB_ORIGIN):
 *
 *   npm run web:reset-password -- person@example.com
 *
 * prints a one-time link that sets a new password for that account. It works
 * once, for an hour; only its digest is stored. Hand it to the person over a
 * channel you trust. This is the recovery path for accounts with no linked
 * sign-in when the server sends no email, and it keeps working when it does.
 *
 *   npm run web:confirm-email -- person@example.com
 *
 * confirms that account's current address, so invitations to it can be
 * accepted. Run it only once you know the person controls the inbox. It's the
 * way to confirm an address on a server with no email and no sign-in provider.
 */
import path from "node:path";
import { readConfig } from "./config";
import { openDb } from "./db";
import { openSupabaseStore } from "./db-supabase";
import { issuePasswordReset, RESET_LINK_HOURS } from "./secrets";

const USAGE = "Usage: npm run web:reset-password -- person@example.com\n       npm run web:confirm-email -- person@example.com";

async function main(argv: readonly string[]): Promise<number> {
  const [command, email] = argv;
  if ((command !== "reset-password" && command !== "confirm-email") || !email) {
    console.error(USAGE);
    return 2;
  }
  const config = readConfig();
  const db = config.supabase?.secretKey ? openSupabaseStore({ url: config.supabase.url, secretKey: config.supabase.secretKey }) : openDb(path.join(config.dataDir, "accounts.sqlite"));
  try {
    const user = await db.userByEmail(email.trim().toLowerCase());
    if (!user) {
      console.error(`No account uses ${email} in ${config.supabase?.secretKey ? "Supabase" : config.dataDir}. Check the address and configuration.`);
      return 1;
    }
    if (command === "confirm-email") {
      if (user.email_confirmed_at) {
        console.log(`${user.email} was already confirmed on ${user.email_confirmed_at}. Nothing changed.`);
        return 0;
      }
      if (!(await db.confirmEmail(user.id, user.email))) {
        console.error(`The account's address changed while confirming ${user.email}. Nothing changed; run the command again with its current address.`);
        return 1;
      }
      console.log(`Confirmed ${user.email}. Invitations to this address can now be accepted.`);
      return 0;
    }
    const token = await issuePasswordReset(db.createPasswordReset, user.id);
    console.log(`Reset link for ${user.email} (works once, for ${RESET_LINK_HOURS} hour):\n${config.origin}/reset/${token}`);
    return 0;
  } finally {
    await db.close();
  }
}

void main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  },
);
