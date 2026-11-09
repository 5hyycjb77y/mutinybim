/**
 * Kernel extension points that no kernel module consumes yet; the host does.
 * Every other kernel point is declared beside the code that reads it
 * (`NETWORK_ADAPTER_POINT` in connections/model.ts, `SERVICE_POINT` in
 * services/registry.ts, …); `@permitzip/bim-pack` re-exports them all.
 */
import type { ModelState } from "../types";
import { defineExtensionPoint } from "./contract";

/** A JSON Schema object, as plain data (what an agent host shows a model). */
export interface JsonSchemaObject {
  readonly type: "object";
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly description?: string;
}

/** What an agent tool runs: one kernel command (an edit), one read, or one command built from the model. */
export type AgentToolTarget =
  /** An edit: the tool's input, as validated, becomes this command type (`ModelCommand.type`). */
  | { readonly kind: "command"; readonly command: string }
  /** A read: the host calls the pack's read by this id with the model and the input. */
  | { readonly kind: "read"; readonly read: string }
  /**
   * An edit built from the model (sizes, slots, plans, one of several
   * commands): the host calls the pack's `COMMAND_BUILDER_POINT` row by this
   * id with the model and the input, then sends the command it returns
   * through the edit spine like any command, or returns its refusal.
   */
  | { readonly kind: "build_command"; readonly build: string };

/**
 * Input keys the host fills for every model tool: the project, the model,
 * and the revision a write is based on. A model tool never declares them in
 * `AgentToolDescriptor.input`. A tool that reads no model (a planner from an
 * equipment list) may declare its own `project_id`; `model_id` and
 * `base_revision` are never a pack's (`reservedToolInputProblem`).
 */
export const HOST_RESERVED_TOOL_INPUT_KEYS = ["project_id", "model_id", "base_revision"] as const;

const NEVER_DECLARED_KEYS = ["model_id", "base_revision"] as const;

/** A read or command builder declining in plain words ("The panel L1 has no spare positions"). The host returns it as the tool's error result. */
export interface PackRefusal {
  readonly refused: string;
}

export function isPackRefusal(value: unknown): value is PackRefusal {
  return typeof value === "object" && value !== null && "refused" in value && typeof value.refused === "string";
}

/**
 * A tool a pack offers an agent, as data. The host MAY expose it within its
 * tool budget (lane G owns that side); nothing in the kernel runs it.
 */
export interface AgentToolDescriptor {
  /** `<pack>_<verb>` ("struct_size_beam"): a tool name, so underscores, not dots. */
  readonly name: string;
  readonly title: string;
  /** What it does and when to use it, in plain words, for the model reading the tool list. */
  readonly description: string;
  readonly input: JsonSchemaObject;
  /** The permission verb it needs on the project: reading never edits; `write` goes through the edit spine like any command. */
  readonly permission: "read" | "write";
  readonly target: AgentToolTarget;
  /**
   * The tool pack it belongs to (an `AGENT_TOOL_PACK_POINT` id, or a pack in
   * the host's catalogue). Every tool sits in exactly one pack; a row with no
   * pack belongs to `addon.<packId>` (`agentToolPackOf`).
   */
  readonly pack?: string;
}

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{1,23}_[a-z][a-z0-9_]{0,40}$/;

/** The frozen prefix of the tools the first-party add-ons declare (`bim_size_circuit`, since round 3). */
export const FIRST_PARTY_TOOL_PREFIX = "bim_";

/**
 * Whether `name` is a tool name a pack `packId` may use: `<packId>_<verb>`.
 * `firstParty` (the pack `keepsBareIds`): its frozen `bim_` names are allowed
 * too. No other pack may take `bim_`.
 */
export function agentToolNameProblem(packId: string, name: string, firstParty = false): string | null {
  if (!TOOL_NAME_PATTERN.test(name)) return `agent tool "${name}" must be lower case letters, digits and underscores, "<pack>_<verb>", at most 64 characters`;
  if (firstParty && name.startsWith(FIRST_PARTY_TOOL_PREFIX)) return null;
  if (!name.startsWith(`${packId}_`)) return `agent tool "${name}" must start with "${packId}_"`;
  return null;
}

/** Why a descriptor's input declares a key the host fills, or null. */
export function reservedToolInputProblem(tool: Pick<AgentToolDescriptor, "name" | "input">): string | null {
  const taken = NEVER_DECLARED_KEYS.filter((k) => k in tool.input.properties);
  return taken.length > 0 ? `agent tool "${tool.name}" declares ${taken.join(", ")}, which the host fills for every model tool` : null;
}

/**
 * Agent-tool descriptors (v1). Not namespaced by the contract's dotted rule
 * (tool names can't hold dots); `runPackConformance` checks `<pack>_<verb>`.
 */
export const AGENT_TOOL_POINT = defineExtensionPoint<AgentToolDescriptor>({
  id: "kernel.agent_tool",
  version: 1,
  label: "Agent tools",
  idOf: (tool) => tool.name,
  namespaced: false,
  builtins: () => [],
});

/** The pack an add-on's untagged tool rows form: `addon.<packId>`. */
export const ADDON_TOOL_PACK_PREFIX = "addon.";

/** The pack a tool row belongs to: its own `pack`, else its add-on's `addon.<packId>`. */
export function agentToolPackOf(packId: string, tool: Pick<AgentToolDescriptor, "pack">): string {
  return tool.pack ?? `${ADDON_TOOL_PACK_PREFIX}${packId}`;
}

/**
 * A group of agent tools an agent loads together (v1): one MCP endpoint and
 * one same-named Agent Skill. Packs never overlap: every tool is in exactly
 * one. Hosts serve each pack at its own endpoint so a client connects only
 * the packs it needs (MCP lists may not vary per connection).
 */
export interface AgentToolPackDescriptor {
  /** `core`, a first-party pack id, or `<packId>.<name>` for an add-on's own pack. */
  readonly id: string;
  /** Short name people see ("Drafting and annotation"). */
  readonly label: string;
  /** One plain sentence: what the pack's connection is for ("Dimensions, tags, notes and details"). */
  readonly purpose: string;
  /** The Agent Skill of the same pack: lower case, digits and hyphens, at most 64 characters. */
  readonly skill: string;
  /** The endpoint path segment (`/packs/<slug>/mcp`): lower case, digits and hyphens. */
  readonly slug: string;
  /** Most tool-text tokens the pack's tools may add to one agent step. */
  readonly tokenCap: number;
  /** Only `read` tools; a host may offer it to people who can't edit. */
  readonly readOnly?: boolean;
}

const PACK_SLUG_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** Problems with one pack row, in plain words. */
export function agentToolPackRowProblems(pack: AgentToolPackDescriptor): string[] {
  const out: string[] = [];
  if (!pack.id) out.push("an agent tool pack has no id");
  if (!pack.label?.trim()) out.push(`agent tool pack ${pack.id} has no label`);
  if (!pack.purpose?.trim()) out.push(`agent tool pack ${pack.id} has no purpose`);
  if (!PACK_SLUG_PATTERN.test(pack.slug)) out.push(`agent tool pack ${pack.id}: slug "${pack.slug}" must be lower case letters, digits and hyphens`);
  if (!SKILL_NAME_PATTERN.test(pack.skill) || pack.skill.includes("--")) out.push(`agent tool pack ${pack.id}: skill "${pack.skill}" must be lower case letters, digits and single hyphens, at most 64 characters`);
  if (typeof pack.tokenCap !== "number" || !Number.isFinite(pack.tokenCap) || pack.tokenCap <= 0) out.push(`agent tool pack ${pack.id}: tokenCap must be a positive number`);
  return out;
}

/**
 * Problems across a set of packs and tools: pack ids, slugs and skills
 * unique; every tool in exactly one known pack; a read-only pack holds only
 * reads. `tools` pairs each row with the add-on that declared it.
 */
export function agentToolPackSetProblems(packs: readonly AgentToolPackDescriptor[], tools: ReadonlyArray<{ readonly packId: string; readonly tool: AgentToolDescriptor }>): string[] {
  const out: string[] = [];
  for (const key of ["id", "slug", "skill"] as const) {
    const seen = new Set<string>();
    for (const p of packs) {
      if (seen.has(p[key])) out.push(`two agent tool packs share the ${key} "${p[key]}"`);
      seen.add(p[key]);
    }
  }
  const byId = new Map(packs.map((p) => [p.id, p]));
  const owner = new Map<string, string>();
  for (const { packId, tool } of tools) {
    const packOf = agentToolPackOf(packId, tool);
    const prior = owner.get(tool.name);
    if (prior !== undefined && prior !== packOf) out.push(`agent tool "${tool.name}" is in two packs: ${prior} and ${packOf}`);
    owner.set(tool.name, packOf);
    const pack = byId.get(packOf);
    if (!pack && !packOf.startsWith(ADDON_TOOL_PACK_PREFIX)) out.push(`agent tool "${tool.name}" names pack "${packOf}", which no add-on declares`);
    if (pack?.readOnly && tool.permission !== "read") out.push(`agent tool "${tool.name}" edits the model, but pack ${pack.id} is read-only`);
  }
  return out;
}

/** Agent tool packs (v1), by id. Namespaced `<packId>.<name>` for an add-on's own pack. */
export const AGENT_TOOL_PACK_POINT = defineExtensionPoint<AgentToolPackDescriptor>({
  id: "kernel.agent_tool_pack",
  version: 1,
  label: "Agent tool packs",
  idOf: (pack) => pack.id,
  builtins: () => [],
});

/**
 * A read a pack offers its agent tools (`AgentToolTarget.read`): the host
 * calls `run` with the open model and the tool's validated input, inside the
 * model's pack scope. Reads never edit; an edit is a command.
 */
export interface PackReadDef {
  readonly id: string;
  readonly label: string;
  /** The read's result as plain data, or a `PackRefusal` (`{ refused }`) the host returns as an error. */
  run(model: ModelState, input: unknown): unknown;
}

/** Pack reads (v1), by id. Ids are the strings agent-tool descriptors name. */
export const PACK_READ_POINT = defineExtensionPoint<PackReadDef>({ id: "kernel.pack_read", version: 1, label: "Pack reads", idOf: (r) => r.id, namespaced: false });

/** A command a builder returns: the kernel's or a pack's, checked by `commandSchema` before it is sent. */
export interface BuiltCommand {
  readonly command: { readonly type: string };
}

/**
 * Builds one edit from the model and a tool's input (v1): what an agent
 * tool's `{ kind: "build_command" }` target names. Never edits; the host
 * sends the returned command through the edit spine, or returns the refusal.
 */
export interface CommandBuilderDef {
  readonly id: string;
  readonly label: string;
  build(model: ModelState, input: unknown): BuiltCommand | PackRefusal;
}

/** Command builders (v1), by id. Ids are the strings agent-tool descriptors name. */
export const COMMAND_BUILDER_POINT = defineExtensionPoint<CommandBuilderDef>({ id: "kernel.command_builder", version: 1, label: "Command builders", idOf: (b) => b.id, namespaced: false });
