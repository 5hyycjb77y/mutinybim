import type { UnitErrorCode } from "./types";

/** A refused unit operation. `message` is plain words a person can act on. */
export class UnitError extends Error {
  readonly code: UnitErrorCode;

  constructor(code: UnitErrorCode, message: string) {
    super(message);
    this.name = "UnitError";
    this.code = code;
  }
}
