"use client";

import { Button, Spinner } from "@permitzip/bim-ui";
import { Input, NativeSelect, NativeSelectOption, Checkbox } from "./components/ui/fields";
import { useCallback, useEffect, useId, useState } from "react";
import type { LibraryItemSummary, LibraryItemType, LibraryProviderPort, LibraryScope, ScopeCapabilities } from "./ports";
import { NewFieldForm } from "./NewFieldForm";

const TYPE_LABELS: Readonly<Record<LibraryItemType, { one: string; many: string }>> = {
  formula: { one: "calculation", many: "Calculations" },
  field: { one: "shared field", many: "Shared fields" },
  schedule_template: { one: "schedule template", many: "Schedule templates" },
  unit_profile: { one: "display profile", many: "Display profiles" },
  class: { one: "object class", many: "Object classes" },
  relationship: { one: "relationship", many: "Relationships" },
  tag_type: { one: "tag type", many: "Tag types" },
  discipline: { one: "discipline", many: "Disciplines" },
  element_type: { one: "type", many: "Types" },
};

export interface LibraryBrowserProps {
  readonly provider: LibraryProviderPort;
  /** Types offered in the "Show" picker, first is the default. */
  readonly types?: readonly LibraryItemType[];
  /** "Use" on an item (insert a calculation, start from a template). Absent: browse only. */
  readonly onUse?: (item: LibraryItemSummary) => void;
  readonly useLabel?: string;
}

type Load = { readonly kind: "loading" } | { readonly kind: "error"; readonly message: string } | { readonly kind: "ready"; readonly items: readonly LibraryItemSummary[] };

/**
 * Browses library items by scope (built-in, firm, project) and type, with
 * search. Shows loading, empty, error and read-only states in plain words.
 */
export function LibraryBrowser({ provider, types = ["formula", "schedule_template", "field"], onUse, useLabel = "Use" }: LibraryBrowserProps) {
  const ids = useId();
  const [scopes, setScopes] = useState<readonly LibraryScope[] | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [scope, setScope] = useState("");
  const [type, setType] = useState<LibraryItemType>(types[0] ?? "formula");
  const [text, setText] = useState("");
  const [showDeprecated, setShowDeprecated] = useState(false);
  const [loaded, setLoaded] = useState<{ readonly key: string; readonly load: Load } | null>(null);
  const [caps, setCaps] = useState<ScopeCapabilities | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let live = true;
    provider
      .scopes()
      .then((list) => {
        if (!live) return;
        setScopes(list);
        setScope((s) => s || (list.find((x) => x.kind === "firm") ?? list[0])?.id || "");
      })
      .catch((err: unknown) => {
        console.error("[LibraryBrowser] scopes failed", err);
        if (live) setScopeError("Couldn't load your libraries. Check your connection and try again.");
      });
    return () => {
      live = false;
    };
  }, [provider, attempt]);

  // Results belong to the query that asked for them; anything else is still loading.
  const queryKey = JSON.stringify([scope, type, text.trim(), showDeprecated, attempt]);
  const load: Load = loaded && loaded.key === queryKey ? loaded.load : { kind: "loading" };

  useEffect(() => {
    if (!scope) return;
    let live = true;
    Promise.all([provider.list(scope, { type, ...(text.trim() ? { text: text.trim() } : {}), includeDeprecated: showDeprecated }), provider.capabilities(scope)])
      .then(([items, c]) => {
        if (!live) return;
        setLoaded({ key: queryKey, load: { kind: "ready", items } });
        setCaps(c);
      })
      .catch((err: unknown) => {
        console.error("[LibraryBrowser] list failed", err);
        if (live) setLoaded({ key: queryKey, load: { kind: "error", message: "Couldn't load this library. Try again." } });
      });
    return () => {
      live = false;
    };
  }, [provider, scope, type, text, showDeprecated, attempt, queryKey]);

  const retry = useCallback(() => {
    setScopeError(null);
    setAttempt((n) => n + 1);
  }, []);

  const scopeName = scopes?.find((s) => s.id === scope)?.name ?? "this library";
  const label = TYPE_LABELS[type];

  if (scopeError) {
    return (
      <div className="mutiny-sched-section" role="region" aria-label="Library">
        <p className="mutiny-sched-error">{scopeError}</p>
        <Button variant="outline" size="sm" onClick={retry}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="mutiny-sched-section" role="region" aria-label="Library">
      <div className="mutiny-sched-row">
        <div className="mutiny-sched-field">
          <label htmlFor={`${ids}-scope`}>Library</label>
          <NativeSelect id={`${ids}-scope`} value={scope} disabled={!scopes} onChange={(e) => setScope(e.target.value)}>
            {(scopes ?? []).map((s) => (
              <NativeSelectOption key={s.id} value={s.id}>
                {s.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        {types.length > 1 ? (
          <div className="mutiny-sched-field">
            <label htmlFor={`${ids}-type`}>Show</label>
            <NativeSelect id={`${ids}-type`} value={type} onChange={(e) => {
                const next = types.find((t) => t === e.target.value);
                if (next) setType(next);
              }}
            >
              {types.map((t) => (
                <NativeSelectOption key={t} value={t}>
                  {TYPE_LABELS[t].many}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        ) : null}
        <div className="mutiny-sched-field">
          <label htmlFor={`${ids}-q`}>Search</label>
          <Input id={`${ids}-q`} type="search" placeholder="Name or formula name" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
      </div>
      <label className="mutiny-sched-row">
        <Checkbox checked={showDeprecated} onChange={(e) => setShowDeprecated(e.target.checked)} /> Include retired items
      </label>
      {caps && !caps.publish ? <p className="mutiny-sched-help">{caps.reason ?? `${scopeName} is read-only here.`}</p> : null}
      {type === "field" && provider.publish ? (
        adding && caps?.publish ? (
          <NewFieldForm
            provider={provider}
            scope={scope}
            scopeName={scopeName}
            onCancel={() => setAdding(false)}
            onPublished={() => {
              setAdding(false);
              retry();
            }}
          />
        ) : (
          <div className="mutiny-sched-row">
            <Button size="sm" variant="outline" disabled={!caps?.publish} title={caps?.publish ? undefined : (caps?.reason ?? `${scopeName} is read-only here.`)} onClick={() => setAdding(true)} data-testid="library-add-field">
              New field
            </Button>
          </div>
        )
      ) : null}
      {load.kind === "loading" ? (
        <p className="mutiny-sched-muted" role="status">
          <Spinner /> Loading {label.many.toLowerCase()}…
        </p>
      ) : load.kind === "error" ? (
        <div>
          <p className="mutiny-sched-error">{load.message}</p>
          <Button variant="outline" size="sm" onClick={retry}>
            Try again
          </Button>
        </div>
      ) : load.items.length === 0 ? (
        <p className="mutiny-sched-muted">{text.trim() ? `No ${label.many.toLowerCase()} in ${scopeName} match “${text.trim()}”.` : `${scopeName} has no ${label.many.toLowerCase()} yet.`}</p>
      ) : (
        <ul className="mutiny-sched-list" aria-label={`${label.many} in ${scopeName}`}>
          {load.items.map((item) => (
            <li key={item.id} className="mutiny-sched-list-item">
              <div className="mutiny-sched-grow">
                <div>{item.name}</div>
                <div className="mutiny-sched-muted">
                  <code>{item.key}</code> · revision {item.revision}
                </div>
              </div>
              {item.deprecated ? <span className="mutiny-sched-badge">Retired</span> : null}
              {onUse ? (
                <Button variant="outline" size="sm" aria-label={`${useLabel} ${item.name}`} onClick={() => onUse(item)}>
                  {useLabel}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
