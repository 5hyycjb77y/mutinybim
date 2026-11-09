/**
 * The questions module of the kernel, for the host app code. Until the kernel's
 * index exports it (an internal design note, `index.ts`), the
 * package entry point doesn't carry these names; everything in the app reads
 * them through the kernel's `questions` subpath here, so switching to
 * `@permitzip/bim-kernel` is one line.
 */
export * from "@permitzip/bim-kernel/questions";
