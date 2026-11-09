"use client";

import { Button, Spinner } from "@permitzip/bim-ui";
import { Input, Textarea, NativeSelect, NativeSelectOption } from "./components/ui/fields";
import { useEffect, useId, useState } from "react";
import type { FormulaType, LibraryItemSummary, LibraryProviderPort, LibraryScope, OperandType, ScopeCapabilities } from "./ports";
import { Dialog } from "./ui/overlays";

/** `PZ.GasDemandBtuh`: publisher prefix, a dot, a name (B's `CALCULATION_KEY_PATTERN`). */
const CALCULATION_KEY_PATTERN = /^[A-Z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

export function suggestCalculationKey(name: string, prefix = "PZ"): string {
  const words = name.replace(/[^A-Za-z0-9 ]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const body = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  return body ? `${prefix}.${/^[A-Za-z]/.test(body) ? body : `C${body}`}` : "";
}

function operand(t: FormulaType): OperandType {
  return t.type === "quantity" ? { valueType: "quantity", kind: t.kind, unit: t.unit } : { valueType: t.type };
}

function newId(): string {
  const c = globalThis.crypto;
  return c && "randomUUID" in c ? c.randomUUID() : `calc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface SaveToLibraryDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly provider: LibraryProviderPort;
  readonly expression: string;
  readonly result: FormulaType;
  /** Object classes the calculation applies to. */
  readonly appliesTo: readonly string[];
  readonly defaultName?: string;
  readonly onSaved?: (summary: LibraryItemSummary) => void;
}

type ScopeRow = LibraryScope & { readonly caps: ScopeCapabilities };

/**
 * "Save to firm library" (§3a): publishes a named calculation as revision 1
 * of a new library item. Libraries that can't take it are listed with the
 * reason, never hidden; refusals name the item and the fault.
 */
export function SaveToLibraryDialog({ open, onOpenChange, provider, expression, result, appliesTo, defaultName = "", onSaved }: SaveToLibraryDialogProps) {
  const ids = useId();
  const [scopes, setScopes] = useState<readonly ScopeRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scope, setScope] = useState("");
  const [name, setName] = useState(defaultName);
  const [key, setKey] = useState(suggestCalculationKey(defaultName));
  const [keyTouched, setKeyTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string; problems?: readonly string[] } | null>(null);

  // Each opening starts fresh (reset during render, not in an effect).
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setOutcome(null);
      setLoadError(null);
      setScopes(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    let live = true;
    (async () => {
      try {
        const list = await provider.scopes();
        const rows = await Promise.all(list.map(async (s) => ({ ...s, caps: await provider.capabilities(s.id) })));
        if (!live) return;
        setScopes(rows);
        const firstWritable = rows.find((r) => r.caps.publish && r.kind === "firm") ?? rows.find((r) => r.caps.publish);
        setScope(firstWritable?.id ?? "");
      } catch (err) {
        console.error("[SaveToLibraryDialog] loading libraries failed", err);
        if (live) setLoadError("Couldn't load your libraries. Check your connection and try again.");
      }
    })();
    return () => {
      live = false;
    };
  }, [open, provider]);

  const keyProblem = key === "" ? "Give the calculation a name." : !CALCULATION_KEY_PATTERN.test(key) ? "Use a prefix, a dot and a name with no spaces, like PZ.GasDemandBtuh." : null;
  const writable = scopes?.filter((s) => s.caps.publish) ?? [];
  const blocked = !provider.publish ? "This library can only be read." : writable.length === 0 ? (scopes?.find((s) => s.caps.reason)?.caps.reason ?? "You can't publish to any library here.") : name.trim() === "" ? "Give the calculation a name." : keyProblem;

  const publish = async () => {
    if (!provider.publish || blocked) return;
    setBusy(true);
    setOutcome(null);
    try {
      const res = await provider.publish(
        scope,
        { type: "formula", body: { id: newId(), revision: 1, key, name: name.trim(), expression, result: operand(result), appliesTo: [...appliesTo], params: [], ...(description.trim() ? { description: description.trim() } : {}) } },
        0,
      );
      if (res.ok) {
        const where = scopes?.find((s) => s.id === scope)?.name ?? "the library";
        setOutcome({ ok: true, message: `Saved to ${where} as ${res.summary.key}, revision ${res.summary.revision}.` });
        onSaved?.(res.summary);
      } else {
        setOutcome({ ok: false, message: res.message, ...(res.problems ? { problems: res.problems.map((p) => (p.line ? `Line ${p.line}: ${p.message}` : p.message)) } : {}) });
      }
    } catch (err) {
      console.error("[SaveToLibraryDialog] publish failed", err);
      setOutcome({ ok: false, message: "The library didn't answer, so nothing was saved. Try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Save to firm library"
      footer={
        <>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {outcome?.ok ? "Done" : "Cancel"}
          </Button>
          {!outcome?.ok ? (
            <Button variant="default" size="sm" disabled={busy || blocked !== null} aria-describedby={blocked ? `${ids}-blocked` : undefined} onClick={() => void publish()}>
              {busy ? <Spinner /> : null} Publish
            </Button>
          ) : null}
        </>
      }
    >
      <div className="mutiny-sched-section">
        <p className="mutiny-sched-help">
          Everyone with access to the library can use <code>{expression}</code> in their schedules. Schedules that use it keep their own copy until they choose to update.
        </p>
        {loadError ? <p className="mutiny-sched-error">{loadError}</p> : null}
        {scopes === null && !loadError ? (
          <p className="mutiny-sched-muted">
            <Spinner /> Loading libraries…
          </p>
        ) : null}
        {scopes ? (
          <div className="mutiny-sched-field">
            <label htmlFor={`${ids}-scope`}>Library</label>
            <NativeSelect id={`${ids}-scope`} value={scope} onChange={(e) => setScope(e.target.value)}>
              {scopes.map((s) => (
                <NativeSelectOption key={s.id} value={s.id} disabled={!s.caps.publish}>
                  {s.name}
                  {!s.caps.publish && s.caps.reason ? ` (${s.caps.reason})` : ""}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        ) : null}
        <div className="mutiny-sched-field">
          <label htmlFor={`${ids}-name`}>Name</label>
          <Input
            id={`${ids}-name`}
           
            value={name}
            placeholder="Gas demand (Btu/h)"
            onChange={(e) => {
              setName(e.target.value);
              if (!keyTouched) setKey(suggestCalculationKey(e.target.value));
            }}
          />
        </div>
        <div className="mutiny-sched-field">
          <label htmlFor={`${ids}-key`}>Formula name</label>
          <Input
            id={`${ids}-key`}
           
            value={key}
            aria-invalid={keyProblem !== null && key !== ""}
            aria-describedby={`${ids}-key-help`}
            onChange={(e) => {
              setKey(e.target.value);
              setKeyTouched(true);
            }}
          />
          <p id={`${ids}-key-help`} className={keyProblem && key !== "" ? "mutiny-sched-error" : "mutiny-sched-help"}>
            {keyProblem && key !== "" ? keyProblem : "How formulas call it, e.g. PZ.GasDemandBtuh({own.mbh})."}
          </p>
        </div>
        <div className="mutiny-sched-field">
          <label htmlFor={`${ids}-desc`}>Description (optional)</label>
          <Textarea id={`${ids}-desc`} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        {blocked && scopes ? (
          <p id={`${ids}-blocked`} className="mutiny-sched-help">
            {blocked}
          </p>
        ) : null}
        <div role="status" aria-live="polite">
          {outcome ? (
            <div className={outcome.ok ? "mutiny-sched-help" : "mutiny-sched-error"}>
              <p>{outcome.message}</p>
              {outcome.problems?.length ? (
                <ul>
                  {outcome.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
