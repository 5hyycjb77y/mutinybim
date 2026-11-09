"use client";

import { Button, Spinner } from "@permitzip/bim-ui";
import { useId, useState } from "react";
import { Input, NativeSelect, NativeSelectOption } from "./components/ui/fields";
import type { FieldLibraryItem, LibraryProviderPort, SharedFieldItemBody } from "./ports";

/**
 * New shared field (KERNEL-FOUNDATION §3.2, decision 3): a library editor
 * adds a parameter to the firm's library ("Hood ID"), and it appears in the
 * equipment list, the Inspector and tags with no code change. Stored as a
 * part parameter on equipment and fixtures; the database decides who may
 * publish to which library.
 */

export const NEW_FIELD_UNITS: readonly { readonly unit: string; readonly kind: string; readonly label: string }[] = [
  { unit: "1", kind: "dimensionless", label: "No unit" },
  { unit: "V", kind: "voltage", label: "Volts (V)" },
  { unit: "A", kind: "current", label: "Amps (A)" },
  { unit: "VA", kind: "power_apparent", label: "VA" },
  { unit: "kW", kind: "power_real", label: "kW" },
  { unit: "hp", kind: "power_mechanical", label: "Horsepower (hp)" },
  { unit: "Btu/h", kind: "thermal_power", label: "Btu/h" },
  { unit: "cfm", kind: "flow_air", label: "CFM" },
  { unit: "gpm", kind: "flow_liquid", label: "GPM" },
  { unit: "psi", kind: "pressure", label: "psi" },
  { unit: "lb", kind: "mass", label: "Pounds (lb)" },
];

export type NewFieldHolds = "text" | "number" | "yes_no";

/** "Hood ID" → `hood_id`; null when no letters or digits are left. */
export function fieldNameOf(label: string): string | null {
  const name = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "f_$1")
    .slice(0, 60);
  return /^[a-z][a-z0-9_]*$/.test(name) ? name : null;
}

const EQUIPMENT = ["mep.equipment", "mep.plumbing_fixture"];

/** The field item New field publishes, or why it can't. */
export function newFieldItem(scope: string, input: { readonly label: string; readonly group: string; readonly holds: NewFieldHolds; readonly unit: string }): { readonly item: FieldLibraryItem } | { readonly refused: string } {
  const label = input.label.trim();
  if (label === "") return { refused: "Give the field a name (Hood ID)." };
  if (label.length > 80) return { refused: "Keep the name to 80 characters." };
  const name = fieldNameOf(label);
  if (!name) return { refused: "Use letters or digits in the name." };
  const group = input.group.trim().slice(0, 60);
  const base: SharedFieldItemBody = {
    id: `${scope.replace(/[^A-Za-z0-9._:-]/g, "-")}:field:${name}`.slice(0, 200),
    revision: 1,
    key: `param.${name}`,
    label,
    appliesTo: EQUIPMENT,
    valueType: "text",
    ...(group ? { group } : {}),
    editable: true,
    storage: { kind: "parameter", scope: "instance", name },
  };
  if (input.holds === "text") return { item: { type: "field", body: base } };
  if (input.holds === "yes_no") return { item: { type: "field", body: { ...base, valueType: "boolean" } } };
  const unit = NEW_FIELD_UNITS.find((u) => u.unit === input.unit);
  if (!unit) return { refused: "Choose the unit the number is in." };
  return { item: { type: "field", body: { ...base, valueType: "quantity", kind: unit.kind, unit: unit.unit } } };
}

export interface NewFieldFormProps {
  readonly provider: LibraryProviderPort;
  readonly scope: string;
  readonly scopeName: string;
  readonly onPublished: () => void;
  readonly onCancel: () => void;
}

export function NewFieldForm({ provider, scope, scopeName, onPublished, onCancel }: NewFieldFormProps) {
  const ids = useId();
  const [label, setLabel] = useState("");
  const [group, setGroup] = useState("");
  const [holds, setHolds] = useState<NewFieldHolds>("text");
  const [unit, setUnit] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const why = !provider.publish ? "This library can't be published to from here." : label.trim() === "" ? "Give the field a name first." : holds === "number" && unit === "" ? "Choose the unit first." : null;

  const publish = async () => {
    if (!provider.publish) return;
    const made = newFieldItem(scope, { label, group, holds, unit });
    if ("refused" in made) {
      setProblem(made.refused);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const result = await provider.publish(scope, made.item, 0);
      if (!result.ok) {
        setProblem(result.code === "conflict" ? `${label.trim()} is already in ${scopeName}; find it in the list and change it there.` : `${result.message} Nothing was saved.`);
        return;
      }
      onPublished();
    } catch (err) {
      console.error("[NewFieldForm] publish failed", err);
      setProblem("Saving the field failed: the connection dropped. Nothing was saved; try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mutiny-sched-section" role="group" aria-label={`New field in ${scopeName}`} data-testid="library-new-field">
      <div className="mutiny-sched-row">
        <div className="mutiny-sched-field">
          <label htmlFor={`${ids}-label`}>Name</label>
          <Input id={`${ids}-label`} value={label} placeholder="Hood ID" onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div className="mutiny-sched-field">
          <label htmlFor={`${ids}-group`}>Section</label>
          <Input id={`${ids}-group`} value={group} placeholder="Kitchen" onChange={(e) => setGroup(e.target.value)} />
        </div>
        <div className="mutiny-sched-field">
          <label htmlFor={`${ids}-holds`}>Holds</label>
          <NativeSelect id={`${ids}-holds`} value={holds} onChange={(e) => setHolds(e.target.value === "number" || e.target.value === "yes_no" ? e.target.value : "text")}>
            <NativeSelectOption value="text">Text</NativeSelectOption>
            <NativeSelectOption value="number">A number</NativeSelectOption>
            <NativeSelectOption value="yes_no">Yes or no</NativeSelectOption>
          </NativeSelect>
        </div>
        {holds === "number" ? (
          <div className="mutiny-sched-field">
            <label htmlFor={`${ids}-unit`}>Unit</label>
            <NativeSelect id={`${ids}-unit`} value={unit} onChange={(e) => setUnit(e.target.value)}>
              <NativeSelectOption value="">Choose</NativeSelectOption>
              {NEW_FIELD_UNITS.map((u) => (
                <NativeSelectOption key={u.unit} value={u.unit}>
                  {u.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        ) : null}
      </div>
      <p className="mutiny-sched-help">It applies to equipment and fixtures. Projects show it in the equipment list (Add column), the Inspector and tags; the section names its column group.</p>
      {problem ? (
        <p className="mutiny-sched-error" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="mutiny-sched-row">
        <Button size="sm" disabled={why !== null || busy} title={why ?? undefined} onClick={() => void publish()}>
          {busy ? <Spinner /> : null}
          {busy ? "Saving…" : `Add to ${scopeName}`}
        </Button>
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {why && !busy ? <p className="mutiny-sched-muted">{why}</p> : null}
    </div>
  );
}
