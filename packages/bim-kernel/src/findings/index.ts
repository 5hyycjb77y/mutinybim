/**
 * Findings and their dispositions (round 10 C10; round 11 F11, D2).
 *
 * The leaf shapes, exported here: the disposition shape and its readers
 * (`disposition.ts`, C10's), the read shape every producer emits (`ref.ts`),
 * dispositions inside signed payloads (`signed.ts`) and the lint-acceptance
 * mapping (`lint-acceptance.ts`). None of them imports a producer, so the
 * checking context can import this file. The ledger, its sources, the
 * disposition record, standing per copy, who may decide and the agent's
 * orientation import the producers and are exported from `api.ts`.
 */
export * from "./disposition";
export * from "./ref";
export * from "./signed";
export * from "./lint-acceptance";
