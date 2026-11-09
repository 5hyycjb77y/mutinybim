"use client";

import { Button } from "@permitzip/bim-ui";
import { useId, useMemo, useState } from "react";
import { Checkbox, Input, NativeSelect, NativeSelectOption, Textarea } from "./components/ui/fields";
import type { ExpandPaper, FilterOp, ScheduleColumnDef, ScheduleDefinitionV2, ScheduleFilter } from "./contracts";
import { LibraryBrowser } from "./LibraryBrowser";
import type { CatalogField, FormulaEnginePort, FormulaError, FormulaSchema, FormulaType, LibraryProviderPort, ScheduleCatalog } from "./ports";
import { SaveToLibraryDialog } from "./SaveToLibrary";
import { Sheet } from "./ui/overlays";

export type BuilderSectionId = "source" | "fields" | "formulas" | "filters" | "arrange" | "paper";

/** A discipline the catalog didn't label, in the id's own words (`firm:site_work` → "Site work"); never the raw id. */
function disciplineWords(id: string): string {
  const words = id.replace(/^[a-z]+:/, "").replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : id;
}

const FILTER_OPS: readonly { readonly value: FilterOp; readonly label: string; readonly needsValue: boolean }[] = [
  { value: "equals", label: "is", needsValue: true },
  { value: "not_equals", label: "is not", needsValue: true },
  { value: "contains", label: "contains", needsValue: true },
  { value: "greater_than", label: "is more than", needsValue: true },
  { value: "less_than", label: "is less than", needsValue: true },
  { value: "present", label: "has a value", needsValue: false },
  { value: "absent", label: "is empty", needsValue: false },
];

export function emptyDefinition(name = "New schedule"): ScheduleDefinitionV2 {
  return {
    name,
    source: { kind: "classes", classes: [], includeSubclasses: true },
    columns: [],
    filters: [],
    sort: [],
    groups: [],
    grandTotals: false,
    itemize: true,
    presentation: { kind: "list" },
    display: { textSizeMm: 2.5, emptyText: "" },
  };
}

export interface ScheduleBuilderProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly catalog: ScheduleCatalog;
  readonly formulaEngine: FormulaEnginePort;
  readonly library?: LibraryProviderPort;
  readonly initial?: ScheduleDefinitionV2;
  /** Section to land on (Fields / Arrange in the grid toolbar). */
  readonly section?: BuilderSectionId;
  readonly onSave: (definition: ScheduleDefinitionV2) => void | Promise<void>;
}

/** The excerpt with the offending span marked, so the fault is at the cursor (heuristics 5, 9). */
function SpanView({ source, error }: { source: string; error: FormulaError }) {
  const { start, end } = error.span;
  const s = Math.max(0, Math.min(start, source.length));
  const e = Math.max(s, Math.min(end === start ? start + 1 : end, source.length));
  return (
    <p className="mutiny-sched-error-span" aria-hidden>
      {source.slice(0, s)}
      <mark>{source.slice(s, e) || " "}</mark>
      {source.slice(e)}
    </p>
  );
}

let columnSeq = 0;
const nextColumnId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(columnSeq++).toString(36)}`;

/**
 * The schedule builder (§7): what to list, columns (fields, formulas, library
 * calculations), filters, sort / group / totals and paper. Formulas check as
 * you type; a unit mismatch is refused inline with the offending span.
 */
export function ScheduleBuilder({ open, onOpenChange, catalog, formulaEngine, library, initial, section, onSave }: ScheduleBuilderProps) {
  const ids = useId();
  const [draft, setDraft] = useState<ScheduleDefinitionV2>(initial ?? emptyDefinition());
  const [fieldQuery, setFieldQuery] = useState("");
  const [formulaHeading, setFormulaHeading] = useState("");
  const [expression, setExpression] = useState("");
  const [saveOpen, setSaveOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Each opening starts from the schedule as it is now (reset during render, not in an effect).
  const [openedWith, setOpenedWith] = useState<{ open: boolean; initial: ScheduleDefinitionV2 | undefined }>({ open, initial });
  if (openedWith.open !== open || openedWith.initial !== initial) {
    setOpenedWith({ open, initial });
    if (open) {
      setDraft(initial ?? emptyDefinition());
      setSaveError(null);
    }
  }

  const classes = useMemo<readonly string[]>(() => (draft.source.kind === "classes" ? draft.source.classes : []), [draft.source]);
  const fields = useMemo(() => catalog.fieldsFor(classes), [catalog, classes]);
  const fieldByPath = useMemo(() => new Map(fields.map((f) => [f.path, f] as const)), [fields]);
  const relationships = useMemo(() => catalog.relationshipsFor(classes), [catalog, classes]);

  const schema = useMemo<FormulaSchema>(
    () => ({
      field(path) {
        const f = fieldByPath.get(path);
        if (!f) return undefined;
        const type: FormulaType = f.valueType === "quantity" && f.kind && f.unit ? { type: "quantity", kind: f.kind, unit: f.unit } : f.valueType === "boolean" ? { type: "boolean" } : { type: "text" };
        return { type, label: f.label.toLowerCase() };
      },
      relationship: () => undefined,
    }),
    [fieldByPath],
  );

  const check = useMemo(() => (expression.trim() ? formulaEngine.compile(expression, schema) : null), [expression, schema, formulaEngine]);
  const firstError = check && !check.ok ? (check.errors[0] ?? null) : null;

  const byDiscipline = useMemo(() => {
    const groups = new Map<string, { label: string; list: { id: string; label: string }[] }>();
    for (const c of catalog.classes()) {
      const group = groups.get(c.discipline) ?? { label: c.disciplineLabel ?? disciplineWords(c.discipline), list: [] };
      group.list.push({ id: c.id, label: c.label });
      groups.set(c.discipline, group);
    }
    return [...groups.entries()];
  }, [catalog]);

  const update = (patch: Partial<ScheduleDefinitionV2>) => setDraft((d) => ({ ...d, ...patch }));
  const setClasses = (next: readonly string[]) => update({ source: { kind: "classes", classes: next, includeSubclasses: draft.source.kind === "classes" ? draft.source.includeSubclasses : true } });

  const usedPaths = new Set(draft.columns.flatMap((c) => (c.kind === "field" || c.kind === "parameter" ? [c.path] : [])));
  const q = fieldQuery.trim().toLowerCase();
  const available = fields.filter((f) => !usedPaths.has(f.path) && (!q || f.label.toLowerCase().includes(q) || f.path.includes(q)));

  const headingOf = (c: ScheduleColumnDef): string => {
    if (c.heading) return c.heading;
    if (c.kind === "field" || c.kind === "parameter") return fieldByPath.get(c.path)?.label ?? c.path;
    if (c.kind === "formula") return c.calculation ?? c.expression;
    if (c.kind === "aggregate") return `${c.fn} of ${c.relationship}`;
    return c.relationship;
  };

  const totalRefusal = (c: ScheduleColumnDef): string | null => {
    if (c.kind === "expand") return "Sub-lists aren't totalled; total a column inside them instead.";
    if (c.kind === "field" || c.kind === "parameter") {
      const f = fieldByPath.get(c.path);
      if (!f) return null;
      if (f.totalRefusedReason) return f.totalRefusedReason;
      if (f.valueType !== "quantity") return `${f.label} is text, so it has no total.`;
      if (f.aggregation === "none") return `${f.label} values aren't added together.`;
    }
    return null;
  };

  const move = (index: number, delta: number) => {
    const next = [...draft.columns];
    const [col] = next.splice(index, 1);
    if (!col) return;
    next.splice(Math.max(0, Math.min(next.length, index + delta)), 0, col);
    update({ columns: next });
  };

  const addField = (f: CatalogField) => update({ columns: [...draft.columns, { id: nextColumnId("f"), kind: f.editable ? "parameter" : "field", path: f.path }] });

  const addFormula = () => {
    if (!check?.ok) return;
    update({ columns: [...draft.columns, { id: nextColumnId("calc"), kind: "formula", expression, ...(formulaHeading.trim() ? { heading: formulaHeading.trim() } : {}) }] });
    setExpression("");
    setFormulaHeading("");
  };

  const addFormulaBlocked = !expression.trim() ? "Type a formula first." : firstError ? "Fix the formula first." : null;
  const saveBlocked = classes.length === 0 ? "Choose at least one kind of item to list." : draft.columns.length === 0 ? "Add at least one column." : draft.name.trim() === "" ? "Give the schedule a name." : null;
  const hasExpand = draft.columns.some((c) => c.kind === "expand");
  const expandCol = draft.columns.find((c): c is Extract<ScheduleColumnDef, { kind: "expand" }> => c.kind === "expand");

  const save = async () => {
    if (saveBlocked) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(draft);
      onOpenChange(false);
    } catch (err) {
      console.error("[ScheduleBuilder] save failed", err);
      setSaveError(err instanceof Error ? `Not saved: ${err.message}` : "Not saved. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const setFilter = (i: number, patch: Partial<ScheduleFilter>) => update({ filters: draft.filters.map((f, k) => (k === i ? { ...f, ...patch } : f)) });

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={onOpenChange}
        title={initial ? `Edit ${initial.name}` : "New schedule"}
        description="Choose what this schedule lists, its columns and how it reads on paper."
        initialFocusId={section ? `${ids}-${section}` : undefined}
        footer={
          <>
            {saveBlocked ? <span className="mutiny-sched-help">{saveBlocked}</span> : null}
            {saveError ? (
              <span className="mutiny-sched-error" role="alert">
                {saveError}
              </span>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="default" size="sm" disabled={saveBlocked !== null || saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save schedule"}
            </Button>
          </>
        }
      >
        <section className="mutiny-sched-section" aria-labelledby={`${ids}-source`}>
          <h3 id={`${ids}-source`} tabIndex={-1} className="mutiny-sched-section-title">
            What to list
          </h3>
          <div className="mutiny-sched-field">
            <label htmlFor={`${ids}-name`}>Schedule name</label>
            <Input id={`${ids}-name`} value={draft.name} onChange={(e) => update({ name: e.target.value })} />
          </div>
          {byDiscipline.map(([discipline, { label: disciplineHeading, list }]) => (
            <fieldset key={discipline} className="mutiny-sched-section">
              <legend className="mutiny-sched-discipline">{disciplineHeading}</legend>
              <div className="mutiny-sched-row">
                {list.map((c) => (
                  <label key={c.id} className="mutiny-sched-row">
                    <Checkbox checked={classes.includes(c.id)} onChange={(e) => setClasses(e.target.checked ? [...classes, c.id] : classes.filter((x) => x !== c.id))} /> {c.label}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          {draft.source.kind === "classes" ? (
            <label className="mutiny-sched-row">
              <Checkbox checked={draft.source.includeSubclasses} onChange={(e) => update({ source: { kind: "classes", classes, includeSubclasses: e.target.checked } })} /> Include more specific kinds (a pump schedule also lists booster pumps)
            </label>
          ) : null}
        </section>

        <section className="mutiny-sched-section" aria-labelledby={`${ids}-fields`}>
          <h3 id={`${ids}-fields`} tabIndex={-1} className="mutiny-sched-section-title">
            Columns
          </h3>
          {draft.columns.length === 0 ? <p className="mutiny-sched-muted">No columns yet. Add fields or a calculation below.</p> : null}
          <ul className="mutiny-sched-list" aria-label="Columns in this schedule">
            {draft.columns.map((c, i) => {
              const refusal = totalRefusal(c);
              const heading = headingOf(c);
              return (
                <li key={c.id} className="mutiny-sched-list-item">
                  <span className="mutiny-sched-grow">{heading}</span>
                  <span className="mutiny-sched-badge">{c.kind === "formula" ? "Calculation" : c.kind === "expand" ? "Sub-list" : c.kind === "aggregate" ? "Total" : "Field"}</span>
                  <label className="mutiny-sched-row" title={refusal ?? undefined}>
                    <Input
                      type="checkbox"
                      checked={Boolean(c.total) && !refusal}
                      disabled={refusal !== null}
                      aria-describedby={refusal ? `${ids}-total-${c.id}` : undefined}
                      onChange={(e) => update({ columns: draft.columns.map((x) => (x.id === c.id ? { ...x, total: e.target.checked } : x)) })}
                    />
                    Total
                  </label>
                  {refusal ? (
                    <span id={`${ids}-total-${c.id}`} className="mutiny-sched-help mutiny-sched-list-note">
                      {refusal}
                    </span>
                  ) : null}
                  <Button variant="ghost" size="icon-sm" aria-label={`Move ${heading} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                    ↑
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`Move ${heading} down`} disabled={i === draft.columns.length - 1} onClick={() => move(i, 1)}>
                    ↓
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`Remove ${heading}`} onClick={() => update({ columns: draft.columns.filter((x) => x.id !== c.id) })}>
                    ×
                  </Button>
                </li>
              );
            })}
          </ul>
          <div className="mutiny-sched-field">
            <label htmlFor={`${ids}-fieldq`}>Add a field</label>
            <Input
              id={`${ids}-fieldq`}
              type="search"
             
              placeholder={classes.length ? "Search fields" : "Choose what to list first"}
              disabled={classes.length === 0}
              value={fieldQuery}
              onChange={(e) => setFieldQuery(e.target.value)}
            />
          </div>
          {classes.length > 0 ? (
            available.length ? (
              <ul className="mutiny-sched-list" aria-label="Fields you can add">
                {available.map((f) => (
                  <li key={f.path} className="mutiny-sched-list-item">
                    <span className="mutiny-sched-grow">
                      {f.label} <span className="mutiny-sched-muted">{f.unit ? `(${f.unit})` : ""}</span>
                      {!f.editable ? <span className="mutiny-sched-muted"> · from the model</span> : null}
                    </span>
                    <Button variant="outline" size="sm" aria-label={`Add ${f.label}`} onClick={() => addField(f)}>
                      Add
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mutiny-sched-muted">{q ? `No fields match “${fieldQuery.trim()}”.` : "Every field is already a column."}</p>
            )
          ) : null}
          {relationships.map((r) => (
            <div key={r.id} className="mutiny-sched-row">
              <Button
                variant="outline"
                size="sm"
                disabled={draft.columns.some((c) => c.kind === "aggregate" && c.relationship === r.id && c.fn === "count")}
                onClick={() => update({ columns: [...draft.columns, { id: nextColumnId("agg"), kind: "aggregate", fn: "count", relationship: r.id, heading: `${r.label} count` }] })}
              >
                Add {r.label} count
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={draft.columns.some((c) => c.kind === "expand" && c.relationship === r.id)}
                onClick={() => update({ columns: [...draft.columns, { id: nextColumnId("exp"), kind: "expand", relationship: r.id, columns: ["mark"], paper: "nested", heading: r.label }] })}
              >
                Add {r.label} as a sub-list
              </Button>
            </div>
          ))}
        </section>

        <section className="mutiny-sched-section" aria-labelledby={`${ids}-formulas`}>
          <h3 id={`${ids}-formulas`} tabIndex={-1} className="mutiny-sched-section-title">
            Calculations
          </h3>
          <div className="mutiny-sched-field">
            <label htmlFor={`${ids}-fh`}>Column heading</label>
            <Input id={`${ids}-fh`} value={formulaHeading} placeholder="Gas input (Btu/h)" onChange={(e) => setFormulaHeading(e.target.value)} />
          </div>
          <div className="mutiny-sched-field">
            <label htmlFor={`${ids}-expr`}>Formula</label>
            <Textarea
              id={`${ids}-expr`}
             
              value={expression}
              placeholder="{own.mbh} * 1000"
              spellCheck={false}
              aria-invalid={firstError !== null}
              aria-describedby={`${ids}-expr-help`}
              disabled={classes.length === 0}
              onChange={(e) => setExpression(e.target.value)}
            />
            <div id={`${ids}-expr-help`} aria-live="polite">
              {firstError ? (
                <>
                  <p className="mutiny-sched-error">{firstError.message}</p>
                  <SpanView source={expression} error={firstError} />
                </>
              ) : check?.ok ? (
                <p className="mutiny-sched-help">Result: {check.formula.type.type === "quantity" ? `${check.formula.type.kind.replace(/_/g, " ")} (${check.formula.type.unit})` : check.formula.type.type}</p>
              ) : (
                <p className="mutiny-sched-help">{classes.length ? "Use fields in braces, like {own.mbh} * 1000. Units are checked as you type." : "Choose what to list first."}</p>
              )}
            </div>
          </div>
          <div className="mutiny-sched-row">
            <Button variant="outline" size="sm" disabled={addFormulaBlocked !== null} title={addFormulaBlocked ?? undefined} onClick={addFormula}>
              Add as column
            </Button>
            {library ? (
              <Button variant="outline" size="sm" disabled={!check?.ok} title={check?.ok ? undefined : "Fix the formula first."} onClick={() => setSaveOpen(true)}>
                Save to firm library
              </Button>
            ) : null}
            {addFormulaBlocked && expression.trim() ? <span className="mutiny-sched-help">{addFormulaBlocked}</span> : null}
          </div>
          {library ? (
            <details open={libraryOpen} onToggle={(e) => setLibraryOpen(e.currentTarget.open)}>
              <summary>Use a calculation from a library</summary>
              {libraryOpen ? (
              <LibraryBrowser
                provider={library}
                types={["formula"]}
                useLabel="Add"
                onUse={(item) => update({ columns: [...draft.columns, { id: nextColumnId("lib"), kind: "formula", calculation: item.key, expression: "", heading: item.name }] })}
              />
              ) : null}
            </details>
          ) : null}
        </section>

        <section className="mutiny-sched-section" aria-labelledby={`${ids}-filters`}>
          <h3 id={`${ids}-filters`} tabIndex={-1} className="mutiny-sched-section-title">
            Filters
          </h3>
          {draft.filters.length === 0 ? <p className="mutiny-sched-muted">Every matching item is listed.</p> : null}
          {draft.filters.map((f, i) => {
            const op = FILTER_OPS.find((o) => o.value === f.op);
            return (
              <div key={i} className="mutiny-sched-row" role="group" aria-label={`Filter ${i + 1}`}>
                <NativeSelect aria-label="Field" value={f.path} onChange={(e) => setFilter(i, { path: e.target.value })}>
                  {fields.map((x) => (
                    <NativeSelectOption key={x.path} value={x.path}>
                      {x.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <NativeSelect
                  aria-label="Condition"
                 
                  value={f.op}
                  onChange={(e) => {
                    const next = FILTER_OPS.find((o) => o.value === e.target.value);
                    if (next) setFilter(i, { op: next.value });
                  }}
                >
                  {FILTER_OPS.map((o) => (
                    <NativeSelectOption key={o.value} value={o.value}>
                      {o.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                {op?.needsValue ? <Input aria-label="Value" value={f.value ?? ""} onChange={(e) => setFilter(i, { value: e.target.value })} /> : null}
                <Button variant="ghost" size="icon-sm" aria-label={`Remove filter ${i + 1}`} onClick={() => update({ filters: draft.filters.filter((_, k) => k !== i) })}>
                  ×
                </Button>
              </div>
            );
          })}
          <div>
            <Button variant="outline" size="sm" disabled={fields.length === 0} onClick={() => update({ filters: [...draft.filters, { path: fields[0]?.path ?? "mark", op: "equals", value: "" }] })}>
              Add filter
            </Button>
          </div>
        </section>

        <section className="mutiny-sched-section" aria-labelledby={`${ids}-arrange`}>
          <h3 id={`${ids}-arrange`} tabIndex={-1} className="mutiny-sched-section-title">
            Sort, group and totals
          </h3>
          <div className="mutiny-sched-row">
            <div className="mutiny-sched-field">
              <label htmlFor={`${ids}-sort`}>Sort by</label>
              <NativeSelect
                id={`${ids}-sort`}
               
                value={draft.sort[0]?.path ?? ""}
                onChange={(e) => update({ sort: e.target.value ? [{ path: e.target.value, direction: draft.sort[0]?.direction ?? "asc" }] : [] })}
              >
                <NativeSelectOption value="">Model order</NativeSelectOption>
                {fields.map((f) => (
                  <NativeSelectOption key={f.path} value={f.path}>
                    {f.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="mutiny-sched-field">
              <label htmlFor={`${ids}-dir`}>Order</label>
              <NativeSelect
                id={`${ids}-dir`}
               
                disabled={!draft.sort[0]}
                value={draft.sort[0]?.direction ?? "asc"}
                onChange={(e) => {
                  const first = draft.sort[0];
                  if (first) update({ sort: [{ path: first.path, direction: e.target.value === "desc" ? "desc" : "asc" }] });
                }}
              >
                <NativeSelectOption value="asc">A to Z, smallest first</NativeSelectOption>
                <NativeSelectOption value="desc">Z to A, largest first</NativeSelectOption>
              </NativeSelect>
            </div>
            <div className="mutiny-sched-field">
              <label htmlFor={`${ids}-group`}>Group by</label>
              <NativeSelect
                id={`${ids}-group`}
               
                value={draft.groups[0]?.path ?? ""}
                onChange={(e) => update({ groups: e.target.value ? [{ path: e.target.value, header: true, footer: true, totals: draft.groups[0]?.totals ?? true }] : [] })}
              >
                <NativeSelectOption value="">No groups</NativeSelectOption>
                {fields
                  .filter((f) => f.valueType !== "quantity")
                  .map((f) => (
                    <NativeSelectOption key={f.path} value={f.path}>
                      {f.label}
                    </NativeSelectOption>
                  ))}
              </NativeSelect>
            </div>
          </div>
          <label className="mutiny-sched-row">
            <Checkbox checked={draft.groups[0]?.totals ?? false} disabled={!draft.groups[0]} onChange={(e) => update({ groups: draft.groups.map((g, k) => (k === 0 ? { ...g, totals: e.target.checked } : g)) })} /> Totals for each group
          </label>
          <label className="mutiny-sched-row">
            <Checkbox checked={draft.grandTotals} onChange={(e) => update({ grandTotals: e.target.checked })} /> Grand totals at the bottom
          </label>
          <p className="mutiny-sched-help">Only columns ticked “Total” are added up, and only where adding makes sense for that kind of value.</p>
        </section>

        <section className="mutiny-sched-section" aria-labelledby={`${ids}-paper`}>
          <h3 id={`${ids}-paper`} tabIndex={-1} className="mutiny-sched-section-title">
            Presentation and paper
          </h3>
          {hasExpand && expandCol ? (
            <div className="mutiny-sched-field">
              <label htmlFor={`${ids}-paper-expand`}>{headingOf(expandCol)} on the sheet</label>
              <NativeSelect
                id={`${ids}-paper-expand`}
               
                value={expandCol.paper}
                onChange={(e) => {
                  const paper: ExpandPaper = e.target.value === "summary" ? "summary" : e.target.value === "hidden" ? "hidden" : "nested";
                  update({ columns: draft.columns.map((c) => (c.id === expandCol.id ? { ...expandCol, paper } : c)) });
                }}
              >
                <NativeSelectOption value="nested">Indented rows under each item</NativeSelectOption>
                <NativeSelectOption value="summary">One summary value</NativeSelectOption>
                <NativeSelectOption value="hidden">Not printed</NativeSelectOption>
              </NativeSelect>
            </div>
          ) : null}
          <div className="mutiny-sched-row">
            <div className="mutiny-sched-field">
              <label htmlFor={`${ids}-text`}>Text height on paper (mm)</label>
              <Input
                id={`${ids}-text`}
                type="number"
                min={1.5}
                max={6}
                step={0.5}
               
                value={draft.display.textSizeMm}
                onChange={(e) => update({ display: { ...draft.display, textSizeMm: Number(e.target.value) || 2.5 } })}
              />
            </div>
            <div className="mutiny-sched-field">
              <label htmlFor={`${ids}-empty`}>Empty cells show</label>
              <Input id={`${ids}-empty`} value={draft.display.emptyText} placeholder="(blank)" onChange={(e) => update({ display: { ...draft.display, emptyText: e.target.value } })} />
            </div>
          </div>
        </section>
      </Sheet>
      {library && check?.ok ? (
        <SaveToLibraryDialog open={saveOpen} onOpenChange={setSaveOpen} provider={library} expression={expression} result={check.formula.type} appliesTo={classes} defaultName={formulaHeading} />
      ) : null}
    </>
  );
}
