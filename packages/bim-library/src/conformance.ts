import { contentHashOf } from "./hash";
import { LibraryError, type LibraryChange, type LibraryProvider, type PublishResult } from "./provider";
import { LIBRARY_ITEM_TYPES, makeItem, type LibraryItem } from "./schema";

/**
 * The `LibraryProvider` contract as executable checks (PROVIDER.md). Any host
 * runs it against its provider: standalone MutinyBIM against
 * `FileLibraryProvider`, a host app against its database-backed provider.
 * It returns a report instead of asserting, so it works under any test runner.
 *
 * The publish checks write to `writableScope`. Point it at a throwaway scope:
 * the items it publishes are left behind, deprecated.
 */

export interface ConformanceSubject {
  readonly provider: LibraryProvider;
  /** A scope the caller may publish to. Absent: publishing is checked to be refused everywhere. */
  readonly writableScope?: string;
  /** A scope the caller may read and not publish to. */
  readonly readOnlyScope?: string;
  /** A new, valid item for `writableScope`. Absent: a text field on generic models with a fresh id. */
  readonly newItem?: () => LibraryItem;
}

export interface ConformanceCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface ConformanceReport {
  readonly ok: boolean;
  readonly checks: readonly ConformanceCheck[];
  readonly failures: readonly ConformanceCheck[];
}

function defaultNewItem(): LibraryItem {
  const suffix = Math.random().toString(36).slice(2, 10);
  return makeItem("field", {
    id: `conformance-${suffix}`,
    revision: 1,
    key: `conformance_note_${suffix}`,
    label: "Conformance note",
    appliesTo: ["gen.generic_model"],
    valueType: "text",
    editable: true,
    storage: { kind: "parameter", scope: "instance", name: `conformance_note_${suffix}` },
  });
}

/** The item made invalid in a way only full validation (not the schema) catches: a quantity with no unit. */
function brokenCopy(item: LibraryItem, id: string): LibraryItem {
  return makeItem("field", {
    id,
    revision: 1,
    key: `${item.body.key.replace(/[^a-z0-9_]/g, "_").toLowerCase()}_broken`,
    label: "Broken quantity",
    appliesTo: ["gen.generic_model"],
    valueType: "quantity",
    kind: "length",
    editable: true,
    storage: { kind: "parameter", scope: "instance", name: "broken_quantity" },
  });
}

async function expectNotFound(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return "returned an item instead of refusing";
  } catch (err) {
    if (err instanceof LibraryError && err.code === "not_found") return null;
    return `threw ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)} instead of LibraryError "not_found"`;
  }
}

export async function runProviderConformance(subject: ConformanceSubject): Promise<ConformanceReport> {
  const { provider } = subject;
  const checks: ConformanceCheck[] = [];
  const check = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail === undefined || ok ? {} : { detail }) });
  const attempt = async (name: string, run: () => Promise<string | null | void>) => {
    try {
      const failure = await run();
      check(name, failure === null || failure === undefined, failure ?? undefined);
    } catch (err) {
      check(name, false, `threw ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    }
  };

  const scopes = await provider.scopes();
  check("lists at least one scope", scopes.length > 0, "scopes() returned none");
  check("scope ids are unique", new Set(scopes.map((s) => s.id)).size === scopes.length, scopes.map((s) => s.id).join(", "));
  check(
    "every scope has a kind and a name",
    scopes.every((s) => ["builtin", "firm", "project", "file"].includes(s.kind) && s.name.trim().length > 0),
  );

  for (const scope of scopes) {
    await attempt(`${scope.id}: capabilities say it can be read`, async () => {
      const caps = await provider.capabilities(scope.id);
      if (!caps.read) return `capabilities() says it can't be read${caps.reason ? `: ${caps.reason}` : ""}`;
      if (!caps.publish && !caps.reason) return "it can't be published to, but gives no reason a person could act on";
      return null;
    });
    await attempt(`${scope.id}: every listed item reads back with a matching revision and content hash`, async () => {
      const summaries = await provider.list(scope.id, { includeDeprecated: true });
      for (const s of summaries) {
        if (!LIBRARY_ITEM_TYPES.includes(s.type)) return `${s.id} has unknown type ${s.type}`;
        if (s.scope !== scope.id) return `${s.id} is listed under ${scope.id} but says scope ${s.scope}`;
        const item = await provider.get(s.id);
        if (item.body.id !== s.id || item.type !== s.type) return `get(${s.id}) returned ${item.type} ${item.body.id}`;
        const computed = contentHashOf(item);
        if (item.body.contentHash !== computed) return `${s.key}'s stored content hash doesn't match its content`;
        if (item.scope === scope.id && (item.body.revision !== s.revision || s.contentHash !== computed)) return `${s.key} is listed at revision ${s.revision} but reads back at ${item.body.revision}`;
        const pinned = await provider.get(s.id, s.revision);
        if (pinned.body.revision !== s.revision || contentHashOf(pinned) !== s.contentHash) return `get(${s.id}, ${s.revision}) did not return that revision`;
      }
      return null;
    });
    await attempt(`${scope.id}: a type filter returns only that type`, async () => {
      const fields = await provider.list(scope.id, { type: "field", includeDeprecated: true });
      const wrong = fields.find((s) => s.type !== "field");
      return wrong ? `list(type: field) returned ${wrong.type} ${wrong.key}` : null;
    });
  }

  await attempt("an unknown item id is refused as not found", () => expectNotFound(() => provider.get(`missing-${Math.random().toString(36).slice(2)}`)));

  const readOnly = subject.readOnlyScope ?? scopes.find((s) => s.id !== subject.writableScope)?.id;
  if (readOnly !== undefined && readOnly !== subject.writableScope) {
    await attempt(`${readOnly}: publishing is refused with a reason`, async () => {
      const caps = await provider.capabilities(readOnly);
      if (caps.publish) return subject.readOnlyScope === undefined ? null : "capabilities() says it can be published to";
      if (!provider.publish) return null;
      const result = await provider.publish(readOnly, (subject.newItem ?? defaultNewItem)(), 0);
      if (result.ok) return "publish succeeded on a scope that says it is read-only";
      return result.code === "read_only" || result.code === "forbidden" ? (result.message.trim() ? null : "the refusal has no message") : `refused with "${result.code}", expected read_only or forbidden`;
    });
  }

  const writable = subject.writableScope;
  if (writable === undefined) {
    check("a provider with no writable scope is read-only everywhere", (await Promise.all(scopes.map((s) => provider.capabilities(s.id)))).every((c) => !c.publish));
    return report(checks);
  }

  const publish = provider.publish?.bind(provider);
  if (!publish) {
    check(`${writable}: publish exists`, false, "writableScope was given but the provider has no publish()");
    return report(checks);
  }
  const item = (subject.newItem ?? defaultNewItem)();
  const id = item.body.id;
  const changes: LibraryChange[] = [];
  const unwatch = provider.watch?.(writable, (c) => changes.push(c));

  let first: PublishResult | undefined;
  await attempt(`${writable}: publishing a new item from revision 0 stores revision 1`, async () => {
    first = await publish(writable, item, 0);
    if (!first.ok) return `refused: ${first.code}: ${first.message}`;
    if (first.summary.revision !== 1) return `stored revision ${first.summary.revision}`;
    const back = await provider.get(id);
    if (back.scope !== writable) return `get() found it in ${back.scope}`;
    if (back.body.contentHash !== contentHashOf(back) || back.body.contentHash !== first.summary.contentHash) return "the stored content hash is not the item's content hash";
    const listed = await provider.list(writable);
    return listed.some((s) => s.id === id && s.revision === 1) ? null : "list() does not show it";
  });
  if (!first?.ok) {
    unwatch?.();
    return report(checks);
  }
  const firstHash = first.summary.contentHash;

  await attempt(`${writable}: publishing from a stale revision is a conflict that names the current one`, async () => {
    const stale = await publish(writable, item, 0);
    if (stale.ok) return "a second publish from revision 0 succeeded";
    if (stale.code !== "conflict") return `refused with "${stale.code}", expected conflict`;
    return stale.currentRevision === 1 ? null : `currentRevision is ${String(stale.currentRevision)}, expected 1`;
  });

  await attempt(`${writable}: an edit from the current revision stores the next one and keeps the old`, async () => {
    const edited = makeItem(item.type, { ...item.body, description: "Edited by the conformance suite." });
    const second = await publish(writable, edited, 1);
    if (!second.ok) return `refused: ${second.code}: ${second.message}`;
    if (second.summary.revision !== 2) return `stored revision ${second.summary.revision}`;
    if (second.summary.contentHash === firstHash) return "the content hash did not change with the content";
    const old = await provider.get(id, 1);
    return contentHashOf(old) === firstHash ? null : "get(id, 1) no longer returns revision 1 as it was";
  });

  await attempt(`${writable}: an invalid item is refused whole and changes nothing`, async () => {
    const before = await provider.list(writable, { includeDeprecated: true });
    const bad = brokenCopy(item, `${id}-broken`);
    const result = await publish(writable, bad, 0);
    if (result.ok) return "an item with a quantity and no unit was published";
    if (result.code !== "invalid") return `refused with "${result.code}", expected invalid`;
    const after = await provider.list(writable, { includeDeprecated: true });
    const changed = after.length !== before.length || after.some((s) => !before.some((b) => b.id === s.id && b.revision === s.revision));
    return changed ? "the scope changed even though the publish was refused" : null;
  });

  if (unwatch) {
    check(`${writable}: watchers hear each publish`, changes.filter((c) => c.summary.id === id).length >= 2, `heard ${changes.length} change(s)`);
    unwatch();
  }

  await attempt(`${writable}: the test item is left deprecated`, async () => {
    const retired = await publish(writable, makeItem(item.type, { ...item.body, description: "Edited by the conformance suite.", deprecated: true }), 2);
    return retired.ok ? null : `refused: ${retired.code}: ${retired.message}`;
  });
  return report(checks);
}

function report(checks: readonly ConformanceCheck[]): ConformanceReport {
  const failures = checks.filter((c) => !c.ok);
  return { ok: failures.length === 0, checks, failures };
}
