// The people who can sign in to the local stack (docker compose up). The sign-in
// service issues tokens only for these names, and the seed makes each of them a
// member of the demo project, so the model server lets them read and edit.
import { createHash } from "node:crypto";

export const LOCAL_PEOPLE = ["You", "Avery", "Priya", "Sam"] as const;

export interface LocalPerson {
  readonly name: (typeof LOCAL_PEOPLE)[number];
  readonly userId: string;
}

/** A stable id per name, so a restart signs the same person in as the same user. */
export function localUserId(name: string): string {
  const hex = createHash("sha256").update(`mutinybim-local-stack:${name.toLowerCase()}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function localPerson(name: string): LocalPerson | null {
  const match = LOCAL_PEOPLE.find((p) => p.toLowerCase() === name.trim().toLowerCase());
  return match ? { name: match, userId: localUserId(match) } : null;
}
