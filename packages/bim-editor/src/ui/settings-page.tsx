"use client";

/**
 * The one shape every Settings page uses. Pages render beside an open agent
 * chat (documents pane, ~600–900px), so everything is a single column and
 * responds to the pane through container queries (`@2xl:`), never window
 * breakpoints (`sm:` / `lg:`). The settings layouts declare the container.
 *
 *   <SettingsPage title description actions>
 *     <SettingsCard title description footer={<SettingsSaveFooter … />}>
 *       <FieldGroup><Field>…</Field></FieldGroup>
 *     </SettingsCard>
 *     <SettingsCard tone="danger" …><SettingsDangerAction … /></SettingsCard>
 *   </SettingsPage>
 */

import * as React from "react";
import Link from "../host/link";
import { AlertCircleIcon, ArrowLeftIcon, CheckIcon, LockIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "./alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./alert-dialog";
import { Button } from "./button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./empty";
import { Skeleton } from "./skeleton";
import { Spinner } from "./spinner";
import { cn } from "./cn";

export type SettingsPageWidth = "default" | "wide";

const WIDTH_CLASS: Record<SettingsPageWidth, string> = {
  default: "max-w-3xl",
  wide: "max-w-5xl",
};

export function SettingsPage({
  title,
  description,
  actions,
  back,
  width = "default",
  className,
  children,
}: {
  title: string;
  /** One plain sentence: what this page controls. */
  description?: React.ReactNode;
  /** Up to three header buttons. Secondary actions go in a ⋯ menu. */
  actions?: React.ReactNode;
  /**
   * Parent page for sub-pages ("Hubstaff" above "Hubstaff issues"). Pass
   * `onNavigate` when "back" is an in-page view change (a `?param=` the page
   * wrote itself): the link still works when opened in a new tab.
   */
  back?: { href: string; label: string; onNavigate?: () => void };
  /** `wide` only for pages whose job is a table or matrix. */
  width?: SettingsPageWidth;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn("flex w-full flex-col gap-6", WIDTH_CLASS[width], className)}
      data-settings-page=""
    >
      <header className="flex flex-col gap-2">
        {back ? (
          <Button asChild variant="link" size="sm" className="h-auto self-start p-0 text-muted-foreground">
            <Link
              href={back.href}
              prefetch={false}
              onClick={
                back.onNavigate
                  ? (event) => {
                      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                      event.preventDefault();
                      back.onNavigate?.();
                    }
                  : undefined
              }
            >
              <ArrowLeftIcon data-icon="inline-start" />
              {back.label}
            </Link>
          </Button>
        ) : null}
        <div className="flex flex-col gap-3 @xl:flex-row @xl:items-start @xl:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
            {description ? (
              <p className="text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      </header>
      {children}
    </div>
  );
}

export function SettingsCard({
  title,
  description,
  actions,
  footer,
  tone = "default",
  id,
  className,
  contentClassName,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  /** One or two small controls at the card's top-right. */
  actions?: React.ReactNode;
  /** Usually a `SettingsSaveFooter`. */
  footer?: React.ReactNode;
  tone?: "default" | "danger";
  /** Anchor for deep links (`/settings/twilio#agent-secretary`). */
  id?: string;
  className?: string;
  contentClassName?: string;
  children?: React.ReactNode;
}) {
  return (
    <Card
      id={id}
      className={cn(
        "scroll-mt-4",
        tone === "danger" && "ring-danger-300 dark:ring-danger-800",
        className,
      )}
      data-settings-card={tone}
    >
      <CardHeader>
        <CardTitle
          role="heading"
          aria-level={2}
          className={cn(tone === "danger" && "text-danger-700 dark:text-danger-300")}
        >
          {title}
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
        {actions ? <CardAction className="flex items-center gap-2">{actions}</CardAction> : null}
      </CardHeader>
      {children !== undefined ? (
        <CardContent className={cn("flex flex-col gap-4", contentClassName)}>{children}</CardContent>
      ) : null}
      {footer ? <CardFooter className="border-t py-3">{footer}</CardFooter> : null}
    </Card>
  );
}

export type SettingsSaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at?: Date }
  | { kind: "error"; message: string };

/**
 * Save row for a card's form. Save is disabled with a stated reason when
 * nothing changed or the form is invalid; while saving it shows a spinner;
 * on failure the values stay and the message says what to do next.
 */
export function SettingsSaveFooter({
  dirty,
  state,
  onSave,
  onReset,
  invalidReason,
  saveLabel = "Save changes",
}: {
  dirty: boolean;
  state: SettingsSaveState;
  onSave: () => void;
  /** Shown as "Discard" while there are unsaved changes. */
  onReset?: () => void;
  /** Why Save can't run yet ("Enter a rate above $0"). */
  invalidReason?: string | null;
  saveLabel?: string;
}) {
  const saving = state.kind === "saving";
  const disabledReason = saving
    ? null
    : invalidReason
      ? invalidReason
      : !dirty
        ? "No changes to save"
        : null;
  return (
    <div className="flex w-full flex-wrap items-center justify-end gap-3">
      <p className="mr-auto min-w-0 text-xs text-muted-foreground" role="status" aria-live="polite">
        {state.kind === "error" ? (
          <span className="inline-flex items-center gap-1 text-danger-700 dark:text-danger-300">
            <AlertCircleIcon className="size-3.5" aria-hidden />
            {state.message}
          </span>
        ) : saving ? (
          "Saving…"
        ) : state.kind === "saved" && !dirty ? (
          <span className="inline-flex items-center gap-1 text-success-700 dark:text-success-300">
            <CheckIcon className="size-3.5" aria-hidden />
            Saved
          </span>
        ) : dirty ? (
          "Unsaved changes"
        ) : (
          disabledReason
        )}
      </p>
      {onReset && dirty && !saving ? (
        <Button type="button" variant="ghost" size="sm" onClick={onReset}>
          Discard
        </Button>
      ) : null}
      <Button
        type="button"
        size="sm"
        onClick={onSave}
        disabled={saving || disabledReason !== null}
        title={disabledReason ?? undefined}
      >
        {saving ? <Spinner data-icon="inline-start" /> : null}
        {state.kind === "error" && dirty ? "Try again" : saveLabel}
      </Button>
    </div>
  );
}

/**
 * Status line for controls that save as soon as they change (switches,
 * radios, selects). Put it in the card's `actions` or `footer`.
 */
export function SettingsSaveStatus({
  state,
  onRetry,
  className,
}: {
  state: SettingsSaveState;
  /** Re-run the failed save. */
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <p
      className={cn("flex min-h-7 items-center gap-2 text-xs text-muted-foreground", className)}
      role="status"
      aria-live="polite"
    >
      {state.kind === "saving" ? (
        <>
          <Spinner className="size-3.5" />
          Saving…
        </>
      ) : state.kind === "saved" ? (
        <span className="inline-flex items-center gap-1 text-success-700 dark:text-success-300">
          <CheckIcon className="size-3.5" aria-hidden />
          Saved
        </span>
      ) : state.kind === "error" ? (
        <>
          <span className="inline-flex items-center gap-1 text-danger-700 dark:text-danger-300">
            <AlertCircleIcon className="size-3.5" aria-hidden />
            {state.message}
          </span>
          {onRetry ? (
            <Button type="button" variant="outline" size="xs" onClick={onRetry}>
              Retry
            </Button>
          ) : null}
        </>
      ) : null}
    </p>
  );
}

/**
 * Save state for controls that save immediately. `run` marks the card as
 * saving, awaits the write and records Saved or the error, keeping the last
 * attempt so Retry can repeat it.
 */
export function useSettingsAutosave(failureMessage: string | ((err: unknown) => string)) {
  const [state, setState] = React.useState<SettingsSaveState>({ kind: "idle" });
  const lastAttempt = React.useRef<(() => Promise<unknown>) | null>(null);

  const run = React.useCallback(
    async (write: () => Promise<unknown>): Promise<boolean> => {
      lastAttempt.current = write;
      setState({ kind: "saving" });
      try {
        await write();
        setState({ kind: "saved", at: new Date() });
        return true;
      } catch (err) {
        console.error("[settings] autosave failed", err);
        setState({
          kind: "error",
          message: typeof failureMessage === "function" ? failureMessage(err) : failureMessage,
        });
        return false;
      }
    },
    [failureMessage],
  );

  const retry = React.useCallback(() => {
    const attempt = lastAttempt.current;
    if (attempt) void run(attempt);
  }, [run]);

  return { state, run, retry };
}

/** A destructive act inside a danger card, always behind a confirm dialog. */
export function SettingsDangerAction({
  title,
  description,
  actionLabel,
  confirmTitle,
  confirmDescription,
  confirmLabel,
  onConfirm,
  busy = false,
  disabledReason,
}: {
  title: string;
  description: React.ReactNode;
  actionLabel: string;
  confirmTitle: string;
  confirmDescription: React.ReactNode;
  /** Defaults to `actionLabel`. */
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
  busy?: boolean;
  disabledReason?: string;
}) {
  return (
    <div className="flex flex-col gap-3 @xl:flex-row @xl:items-center @xl:justify-between">
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="shrink-0 self-start @xl:self-auto"
            disabled={busy || disabledReason !== undefined}
            title={disabledReason}
          >
            {busy ? <Spinner data-icon="inline-start" /> : null}
            {actionLabel}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>{confirmDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void onConfirm()}>
              {confirmLabel ?? actionLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Shown instead of a page the person can't use. Says what access is needed
 * in plain words and who can grant it, never "Forbidden".
 */
export function SettingsAccessDenied({
  title = "You don't have access to this page",
  need,
  backHref = "/settings",
}: {
  title?: string;
  /** "change billing rates", "manage who can sign in" */
  need: string;
  backHref?: string;
}) {
  return (
    <Empty className="border" data-settings-access-denied="">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <LockIcon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>
          This page is for people who can {need}. Ask an administrator to give you that access in
          Access control.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild variant="outline" size="sm">
          <Link href={backHref} prefetch={false}>
            Back to Settings
          </Link>
        </Button>
      </EmptyContent>
    </Empty>
  );
}

/** Skeleton for a loading settings card. */
export function SettingsLoading({ rows = 3, label = "Loading settings" }: { rows?: number; label?: string }) {
  return (
    <Card aria-busy="true" aria-label={label}>
      <CardHeader>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-64" />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}

/** A section's data didn't load: name the fault and offer Retry. */
export function SettingsLoadError({
  title = "This didn't load",
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <Alert variant="destructive">
      <AlertCircleIcon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-2">
        <span>{message}</span>
        {onRetry ? (
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
