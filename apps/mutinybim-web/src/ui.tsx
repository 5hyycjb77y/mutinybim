/** @jsxRuntime automatic */
/**
 * The frame every server-rendered page shares: header, flash message, body,
 * footer. Drawn with the MutinyBIM primitives and theme (packages/bim-ui),
 * the same ones the editor uses; the theme arrives as `--mutiny-*`
 * variables from `themeStyleSheet`, light, dark or the computer's setting.
 */
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Alert, Badge, Button, MutinyWordmark, themeStyleSheet, type MutinyColorScheme } from "@permitzip/bim-ui";
import type { QuoteConfig } from "./config";

const THEME_CSS = themeStyleSheet();

export interface FrameUser {
  readonly displayName: string;
  readonly email: string;
  readonly scheme: MutinyColorScheme;
  /** Changes from outside assistants waiting for this person's answer (shown in the header when any). */
  readonly waitingApprovals: number;
}

let waitingApprovals: (userId: string) => number = () => 0;
/** The app tells the frame how to count a person's waiting approvals. */
export function setWaitingApprovals(count: (userId: string) => number): void {
  waitingApprovals = count;
}
export function waitingApprovalsOf(userId: string): number {
  return waitingApprovals(userId);
}

export type Flash = { readonly kind: "ok" | "error"; readonly text: string } | null;

export interface FrameOptions {
  readonly title: string;
  readonly user: FrameUser | null;
  readonly quote: QuoteConfig | null;
  /** Which header link is the current page. */
  readonly current?: "models" | "connect" | "settings" | "quote" | "approvals";
  /** A one-line message above the page (after a save, or a problem). */
  readonly flash?: Flash;
  readonly scripts?: readonly string[];
  /** Narrow column for sign-in forms. */
  readonly narrow?: boolean;
}

function NavLink({ href, label, current }: { href: string; label: string; current: boolean }) {
  return (
    <Button asChild variant="ghost" size="sm" className={current ? "bg-(--mutiny-accent-subtle) shadow-[inset_0_-2px_0_var(--mutiny-selection)]" : undefined}>
      <a href={href} aria-current={current ? "page" : undefined}>
        {label}
      </a>
    </Button>
  );
}

const SCHEMES: readonly { readonly value: MutinyColorScheme; readonly label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "Auto" },
];

/** Light / Dark / Auto, saved in the account (the editor reads the same choice). */
export function SchemeToggle({ scheme }: { scheme: MutinyColorScheme }) {
  return (
    <form method="post" action="/settings/scheme" className="inline-flex rounded-(--mutiny-radius) border border-(--mutiny-border) bg-(--mutiny-field) p-0.5" aria-label="Theme">
      {SCHEMES.map((s) => (
        <Button key={s.value} type="submit" name="scheme" value={s.value} size="sm" variant="ghost" aria-pressed={scheme === s.value} className={scheme === s.value ? "bg-(--mutiny-accent-subtle) text-(--mutiny-text) shadow-[inset_0_0_0_1px_var(--mutiny-selection)]" : "text-(--mutiny-muted)"} title={s.value === "system" ? "Match your computer's light or dark setting" : `${s.label} theme`}>
          {s.label}
        </Button>
      ))}
    </form>
  );
}

function Header({ user, quote, current }: Pick<FrameOptions, "user" | "quote" | "current">) {
  return (
    <header className="sticky top-0 z-10 border-b border-(--mutiny-border) bg-(--mutiny-surface)/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-2.5">
        <a href={user ? "/models" : "/"} data-slot="brand" className="mr-2 flex items-center gap-2 text-(--mutiny-text)" aria-label="MutinyBIM home">
          <img src="/assets/bim-ui/mutiny-icon.svg" alt="" width={28} height={28} />
          <MutinyWordmark className="h-5" title="MutinyBIM" />
          <span className="text-xs font-semibold tracking-wide text-(--mutiny-muted)">BIM</span>
        </a>
        {user ? (
          <>
            <nav className="flex flex-wrap items-center gap-1" aria-label="Main">
              <NavLink href="/models" label="My models" current={current === "models"} />
              <NavLink href="/connect" label="Connect an assistant" current={current === "connect"} />
              <NavLink href="/settings" label="Settings" current={current === "settings"} />
              {user.waitingApprovals > 0 || current === "approvals" ? (
                <Button asChild variant="ghost" size="sm" className={current === "approvals" ? "bg-(--mutiny-accent-subtle) shadow-[inset_0_-2px_0_var(--mutiny-selection)]" : undefined}>
                  <a href="/approvals" aria-current={current === "approvals" ? "page" : undefined} data-testid="nav-approvals">
                    Approvals
                    {user.waitingApprovals > 0 ? <Badge variant="destructive">{user.waitingApprovals}</Badge> : null}
                  </a>
                </Button>
              ) : null}
            </nav>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {quote ? (
                <Button asChild size="sm" variant={current === "quote" ? "outline" : "default"}>
                  <a href="/quote">{quote.label}</a>
                </Button>
              ) : null}
              <SchemeToggle scheme={user.scheme} />
              <span className="max-w-[16ch] truncate text-sm text-(--mutiny-muted)" title={user.email}>
                {user.displayName}
              </span>
              <form method="post" action="/logout">
                <Button type="submit" size="sm" variant="outline">
                  Log out
                </Button>
              </form>
            </div>
          </>
        ) : (
          <div className="ml-auto flex items-center gap-2">
            <Button asChild size="sm" variant="ghost">
              <a href="/login">Log in</a>
            </Button>
            <Button asChild size="sm">
              <a href="/signup">Sign up free</a>
            </Button>
          </div>
        )}
      </div>
    </header>
  );
}

export function FlashMessage({ flash }: { flash: Flash }) {
  if (!flash) return null;
  return (
    <Alert variant={flash.kind === "error" ? "destructive" : "default"} role={flash.kind === "error" ? "alert" : "status"} className={flash.kind === "ok" ? "border-(--mutiny-selection) bg-(--mutiny-accent-subtle)" : "border-(--mutiny-danger)"} data-testid="flash">
      {flash.text}
    </Alert>
  );
}

export function page(body: ReactNode, options: FrameOptions): string {
  const scheme = options.user?.scheme ?? "system";
  const markup = renderToStaticMarkup(
    <html lang="en" data-mutiny-scheme={scheme}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${options.title} · MutinyBIM`}</title>
        <link rel="icon" type="image/svg+xml" href="/assets/bim-ui/mutiny-icon.svg" />
        <style dangerouslySetInnerHTML={{ __html: THEME_CSS }} />
        <link rel="stylesheet" href="/static/app.css" />
      </head>
      <body className="flex min-h-dvh flex-col antialiased">
        <Header user={options.user} quote={options.quote} current={options.current} />
        <main className={`mx-auto flex w-full flex-1 flex-col gap-5 px-4 py-8 ${options.narrow ? "max-w-md" : "max-w-4xl"}`}>
          <FlashMessage flash={options.flash ?? null} />
          {body}
        </main>
        <footer className="border-t border-(--mutiny-border) px-4 py-5 text-center text-xs text-(--mutiny-muted)">
          MutinyBIM is open source (Apache-2.0). <a href="https://github.com/permitzip/mutinybim">Source code</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · Bring your own AI: this app pays for none and sees none of your keys.
        </footer>
        {(options.scripts ?? []).map((src) => (
          <script key={src} type="module" src={src} />
        ))}
      </body>
    </html>,
  );
  return `<!doctype html>${markup}`;
}

export function formatWhen(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + " UTC";
}

/** Escapes text for the few places a page still writes raw HTML (the editor page shell). */
export function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
