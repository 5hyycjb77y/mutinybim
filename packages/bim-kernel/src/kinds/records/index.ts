import { registerKernelKindRows } from "../../registry/element-kind-point";
import { RECORD_KIND_ROWS } from "./rows";

// The record kinds the kernel keeps join the kernel's rows when the command layer loads (commands.ts imports this module).
registerKernelKindRows("kernel.records", RECORD_KIND_ROWS);

export * from "./rows";
