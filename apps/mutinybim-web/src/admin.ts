/**
 * Operator commands for the hosted app, run on the server with the same
 * settings as the app (MUTINYBIM_WEB_DATA, MUTINYBIM_WEB_ORIGIN):
 *
 *   npm run web:reset-password -- person@example.com
 *
 * prints a one-time link that sets a new password for that account. It works
 * once, for an hour; only its digest is stored. Hand it to the person over a
 * channel you trust. This is the recovery path for accounts with no linked
 * sign-in, because the app sends no email.
 */
import path from "node:path";
import { readConfig } from "./config";
import { openDb } from "./db";
import { digest, randomToken, RESET_LINK_HOURS } from "./secrets";

function main(argv: readonly string[]): number {
  const [command, email] = argv;
  if (command !== "reset-password" || !email) {
    console.error("Usage: npm run web:reset-password -- person@example.com");
    return 2;
  }
  const config = readConfig();
  const db = openDb(path.join(config.dataDir, "accounts.sqlite"));
  try {
    const user = db.userByEmail(email.trim().toLowerCase());
    if (!user) {
      console.error(`No account uses ${email} in ${config.dataDir}. Check the address and MUTINYBIM_WEB_DATA.`);
      return 1;
    }
    const token = randomToken();
    db.createPasswordReset(digest(token), user.id, new Date(Date.now() + RESET_LINK_HOURS * 3_600_000));
    console.log(`Reset link for ${user.email} (works once, for ${RESET_LINK_HOURS} hour):\n${config.origin}/reset/${token}`);
    return 0;
  } finally {
    db.close();
  }
}

process.exitCode = main(process.argv.slice(2));
