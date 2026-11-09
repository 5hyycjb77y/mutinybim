"use client";

import { useState } from "react";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "../../ui/field";
import { Input } from "../../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { Spinner } from "../../ui/spinner";
import type { VersionEntry } from "../../contracts/building-model/branch-versions";

export interface NewBranchDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Versions to start from ("Now" first); null while they load. */
  readonly versions: readonly VersionEntry[] | null;
  /** Preselected version key (from Versions › New branch from this version). */
  readonly fromKey?: string;
  /** Starts the branch; throws an Error with words to show when refused. */
  readonly onCreate: (
    name: string,
    fromRevision: number | undefined,
  ) => Promise<void>;
}

/** New branch: a name and where it starts (now, or a saved or issued version). Esc and Cancel close it without starting anything. */
export function NewBranchDialog({
  open,
  onOpenChange,
  versions,
  fromKey,
  onCreate,
}: NewBranchDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New branch</DialogTitle>
          <DialogDescription>
            A copy of the model you and others can change. Main is not changed
            until a merge lands.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted per opening, so every opening starts blank at the chosen version. */}
        {open ? (
          <NewBranchForm
            key={fromKey ?? "now"}
            versions={versions}
            fromKey={fromKey}
            onCreate={onCreate}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function NewBranchForm({
  versions,
  fromKey,
  onCreate,
  onDone,
}: Pick<NewBranchDialogProps, "versions" | "fromKey" | "onCreate"> & {
  readonly onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [from, setFrom] = useState(fromKey ?? "now");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const picked = versions?.find((v) => v.key === from) ?? null;
  const trimmed = name.trim();
  const blocked =
    trimmed.length === 0
      ? "Give the branch a name."
      : versions === null
        ? "Versions are still loading."
        : null;

  async function submit() {
    if (blocked) return;
    setSaving(true);
    setError(null);
    try {
      await onCreate(
        trimmed,
        picked && picked.kind !== "now" ? picked.revision : undefined,
      );
      onDone();
    } catch (err) {
      console.error("[NewBranchDialog] starting the branch failed", err);
      setError(
        err instanceof Error
          ? err.message
          : "Couldn't start the branch. Try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="new-branch-name">Name</FieldLabel>
          <Input
            id="new-branch-name"
            value={name}
            maxLength={80}
            autoFocus
            placeholder="Lobby option B"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="new-branch-from">Start from</FieldLabel>
          {versions === null ? (
            <div
              role="status"
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              <Spinner aria-hidden /> Loading versions…
            </div>
          ) : (
            <Select value={from} onValueChange={setFrom}>
              <SelectTrigger id="new-branch-from" aria-label="Start from">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {versions.map((v) => (
                  <SelectItem key={v.key} value={v.key}>
                    {v.kind === "now"
                      ? "Now"
                      : `${v.label} (version ${v.revision})`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {picked ? <FieldDescription>{picked.detail}</FieldDescription> : null}
        </Field>
        {error ? <FieldError>{error}</FieldError> : null}
      </FieldGroup>
      <DialogFooter className="mt-4">
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button
          type="submit"
          disabled={blocked !== null || saving}
          title={blocked ?? undefined}
        >
          {saving ? <Spinner aria-hidden /> : null}
          Start branch
        </Button>
      </DialogFooter>
    </form>
  );
}
