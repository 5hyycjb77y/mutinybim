/** @jsxRuntime automatic */
/**
 * The app's pages, each a function of what it shows, drawn only with the
 * MutinyBIM primitives (packages/bim-ui). Every list has an empty state;
 * every form says what went wrong in words.
 */
import type { ComponentProps, ReactNode } from "react";
import { Badge, Button, buttonVariants, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, cn, Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle, Field, FieldHint, Input, Label, NativeSelect, Separator } from "@permitzip/bim-ui";
import type { OAuthProviderConfig, QuoteConfig, WebConfig } from "./config";
import { approvalTitle, type PendingApproval } from "./assistant-approvals";
import type { AgentKeyRow, AssistantGrantRow, LinkedModelRow, ModelRow, SharedModelRow, ShareRow, UserRow } from "./db";
import type { LinkedProvider, LinkedView } from "./linked-hosts";
import type { ModelSummary } from "./models";
import { formatWhen, page, waitingApprovalsOf, type Flash, type FrameUser } from "./ui";

function frameUser(user: UserRow): FrameUser {
  return { displayName: user.display_name, email: user.email, scheme: user.color_scheme, waitingApprovals: waitingApprovalsOf(user.id) };
}

function providerName(p: OAuthProviderConfig): string {
  return p.label.replace(/^Log in with /i, "");
}

function PageTitle({ children, lede }: { children: ReactNode; lede?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-3xl leading-tight">{children}</h1>
      {lede ? <p className="max-w-prose text-base/relaxed text-(--mutiny-muted)">{lede}</p> : null}
    </div>
  );
}

function ProviderButtons({ providers, returnTo }: { providers: readonly OAuthProviderConfig[]; returnTo: string }) {
  if (providers.length === 0) return null;
  return (
    <>
      <div className="flex flex-col gap-2">
        {providers.map((p) => (
          <Button key={p.id} asChild size="lg" variant="outline" className="w-full">
            <a href={`/auth/${p.id}/start?return_to=${encodeURIComponent(returnTo)}`}>{p.label}</a>
          </Button>
        ))}
      </div>
      <div className="flex items-center gap-3 text-xs text-(--mutiny-muted)">
        <Separator className="flex-1" />
        or with email
        <Separator className="flex-1" />
      </div>
    </>
  );
}

function TextField({ label, hint, ...input }: { label: string; hint?: string } & ComponentProps<typeof Input>) {
  const id = `f-${input.name ?? label}`;
  return (
    <Field>
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...input} />
      {hint ? <FieldHint>{hint}</FieldHint> : null}
    </Field>
  );
}

function ConfirmForm({ action, question, children, className }: { action: string; question: string; children: ReactNode; className?: string }) {
  return (
    <form method="post" action={action} data-confirm={question} className={className}>
      {children}
    </form>
  );
}

export function landingPage(config: WebConfig): string {
  const points: readonly [string, string][] = [
    ["Your models, saved.", "Open them from any computer, with branches and saved versions kept."],
    ["Work together.", "Share a model with a colleague to view or edit, and see each other's changes live."],
    ["Your AI, your bill.", "Paste your own Claude, ChatGPT or Grok key, or connect your assistant app. This app pays for no AI and never sees your key."],
    ["Open source.", "The same engine runs on your own computer with npm run demo."],
  ];
  return page(
    <div className="flex flex-col gap-8 py-6">
      <div className="flex flex-col items-start gap-5">
        <Badge variant="secondary">Free · open source · every trade</Badge>
        <h1 className="max-w-3xl text-4xl leading-tight sm:text-5xl">A building model you can open in a browser, free.</h1>
        <p className="max-w-2xl text-lg/relaxed text-(--mutiny-muted)">MutinyBIM is an open-source building model for every trade: plans, 3D, sheets and schedules, with several people editing the same model live. Bring your own AI assistant to work beside you.</p>
        <div className="flex flex-wrap gap-2">
          {config.signupOpen ? (
            <Button asChild size="lg">
              <a href="/signup">Create a free account</a>
            </Button>
          ) : null}
          <Button asChild size="lg" variant="outline">
            <a href="/login">Log in</a>
          </Button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {points.map(([title, text]) => (
          <Card key={title} className="gap-1.5 p-4">
            <CardTitle className="text-base">{title}</CardTitle>
            <CardDescription>{text}</CardDescription>
          </Card>
        ))}
      </div>
    </div>,
    { title: "Free building models", user: null, quote: null },
  );
}

export function loginPage(config: WebConfig, options: { email?: string; returnTo: string; flash?: Flash }): string {
  return page(
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">Log in</CardTitle>
        <CardDescription>Open your models and the ones shared with you.</CardDescription>
      </CardHeader>
      <CardContent>
        <ProviderButtons providers={config.providers} returnTo={options.returnTo} />
        <form method="post" action="/login" className="flex flex-col gap-3">
          <input type="hidden" name="return_to" value={options.returnTo} />
          <TextField label="Email" name="email" type="email" autoComplete="email" required defaultValue={options.email ?? ""} />
          <TextField label="Password" name="password" type="password" autoComplete="current-password" required minLength={8} />
          <Button type="submit" size="lg">
            Log in
          </Button>
        </form>
      </CardContent>
      <CardFooter className="justify-between text-sm text-(--mutiny-muted)">
        <a href="/forgot">Forgot your password?</a>
        {config.signupOpen ? <a href="/signup">Create a free account</a> : null}
      </CardFooter>
    </Card>,
    { title: "Log in", user: null, quote: null, flash: options.flash ?? null, narrow: true },
  );
}

export function signupPage(config: WebConfig, options: { email?: string; name?: string; flash?: Flash }): string {
  if (!config.signupOpen) {
    return page(
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Sign-ups are closed for now</CardTitle>
          <CardDescription>New accounts can't be made on this server right now.</CardDescription>
        </CardHeader>
        <CardFooter>
          <Button asChild>
            <a href="/login">Log in to an existing account</a>
          </Button>
        </CardFooter>
      </Card>,
      { title: "Sign up", user: null, quote: null, narrow: true },
    );
  }
  return page(
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">Create a free account</CardTitle>
        <CardDescription>Free models, shared with whoever you choose.</CardDescription>
      </CardHeader>
      <CardContent>
        <ProviderButtons providers={config.providers} returnTo="/models" />
        <form method="post" action="/signup" className="flex flex-col gap-3">
          <TextField label="Your name" hint="People editing with you see it." name="name" autoComplete="name" required maxLength={80} defaultValue={options.name ?? ""} />
          <TextField label="Email" name="email" type="email" autoComplete="email" required defaultValue={options.email ?? ""} />
          <TextField label="Password" hint="At least 8 characters." name="password" type="password" autoComplete="new-password" required minLength={8} />
          <label className="flex items-start gap-2 text-sm text-(--mutiny-muted)">
            <input type="checkbox" name="agree" value="1" required className="mt-1" />
            <span>
              I agree to the <a href="/terms">Terms of use</a> and the <a href="/privacy">Privacy notice</a>.
            </span>
          </label>
          <Button type="submit" size="lg">
            Create account
          </Button>
        </form>
      </CardContent>
      <CardFooter className="text-sm text-(--mutiny-muted)">
        Already have one?&nbsp;<a href="/login">Log in</a>
      </CardFooter>
    </Card>,
    { title: "Sign up", user: null, quote: null, flash: options.flash ?? null, narrow: true },
  );
}

/** A short legal page: a title and paragraphs, in the same narrow frame as the forms. */
function legalPage(title: string, paragraphs: ReactNode[]): string {
  return page(
    <div className="flex flex-col gap-4 text-sm/relaxed">
      <h1 className="text-2xl">{title}</h1>
      {paragraphs.map((text, i) => (
        <p key={i}>{text}</p>
      ))}
      <p className="text-(--mutiny-muted)">Last updated November 9, 2026.</p>
    </div>,
    { title, user: null, quote: null, narrow: true },
  );
}

/**
 * Terms of use. Short on purpose: the software is Apache-2.0, the hosted
 * service is provided as-is, and the person keeps their models.
 */
export function termsPage(): string {
  return legalPage("Terms of use", [
    "These terms cover the hosted MutinyBIM app at app.mutinybim.com, run by PermitZIP. The MutinyBIM software itself is open source under the Apache License 2.0: you can read, use and change the code from the public repository, and that license governs the code.",
    <>
      <strong>The service is provided as is.</strong> It is free and comes with no warranty of any kind, including that it will be available, error-free or fit for a particular purpose. To the fullest extent the law allows, PermitZIP is not liable for any loss or damage from using the service, including lost models or lost time. Nothing here limits liability the law does not let us limit.
    </>,
    "You own the models you make. You give us permission only to store them and to show them to the people you share them with. Don't upload anything you don't have the right to, and don't use the service to break the law or to attack the service or other people.",
    "You can stop using the service at any time, and you can ask us to delete your account and models. We may suspend or close an account that breaks these terms, and we may change or stop the service. If we change these terms, the date at the bottom changes and the new terms apply from then on.",
  ]);
}

/**
 * Privacy notice. What is stored, what never reaches the server (the AI key),
 * and how to ask for deletion.
 */
export function privacyPage(): string {
  return legalPage("Privacy notice", [
    "This notice covers the hosted MutinyBIM app at app.mutinybim.com, run by PermitZIP.",
    <>
      <strong>What we store:</strong> your name, your email address, a one-way hash of your password (never the password itself), your models, and who you share them with. We also keep a short server log of requests, which includes your IP address, so we can run and protect the service.
    </>,
    <>
      <strong>What we never see:</strong> your AI key. It stays in your browser and goes straight from there to your own AI provider. We don't receive it, store it or pay for your AI use.
    </>,
    "We use this information to run your account and your models, and for nothing else. We don't sell it and we don't use it for advertising. If you sign in with another provider, we receive only the name and email that provider shares.",
    "You can ask us to export or delete your account and models, and to correct your name or email. Email the address on the PermitZIP website and we'll do it. Some records, such as server logs, are kept only as long as we need them to run and secure the service.",
  ]);
}

/** No email is sent by this app, so recovery is a linked sign-in or a reset link from whoever runs the server. */
export function forgotPage(config: WebConfig): string {
  return page(
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">Forgot your password?</CardTitle>
        <CardDescription>This server sends no email, so there are two ways back in.</CardDescription>
      </CardHeader>
      <CardContent>
        {config.providers.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p>
              <strong>If you linked {config.providers.map(providerName).join(" or ")}</strong> to your account, log in with it, then set a new password under Settings → Password. No old password is needed for ten minutes after that sign-in.
            </p>
            {config.providers.map((p) => (
              <Button key={p.id} asChild variant="outline" className="w-full">
                <a href={`/auth/${p.id}/start?return_to=%2Fsettings%23password`}>{p.label}</a>
              </Button>
            ))}
          </div>
        ) : null}
        <p>
          <strong>Otherwise, ask whoever runs this server</strong> for a reset link. They make one with <code>npm run web:reset-password -- you@example.com</code>; it works once, for one hour.
        </p>
      </CardContent>
      <CardFooter>
        <Button asChild variant="ghost">
          <a href="/login">Back to log in</a>
        </Button>
      </CardFooter>
    </Card>,
    { title: "Forgot your password", user: null, quote: null, narrow: true },
  );
}

export function resetPage(options: { token: string; email: string | null; flash?: Flash }): string {
  if (!options.email) {
    return page(
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">That reset link doesn't work</CardTitle>
          <CardDescription>It was already used, or it is more than an hour old. Ask for a new one.</CardDescription>
        </CardHeader>
        <CardFooter>
          <Button asChild>
            <a href="/forgot">Ways back in</a>
          </Button>
        </CardFooter>
      </Card>,
      { title: "Reset your password", user: null, quote: null, flash: options.flash ?? null, narrow: true },
    );
  }
  return page(
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">Set a new password</CardTitle>
        <CardDescription>For {options.email}. You are signed out everywhere else once it is saved.</CardDescription>
      </CardHeader>
      <CardContent>
        <form method="post" action={`/reset/${encodeURIComponent(options.token)}`} className="flex flex-col gap-3">
          <TextField label="New password" hint="At least 8 characters." name="password" type="password" autoComplete="new-password" required minLength={8} />
          <Button type="submit" size="lg">
            Save and log in
          </Button>
        </form>
      </CardContent>
    </Card>,
    { title: "Reset your password", user: null, quote: null, flash: options.flash ?? null, narrow: true },
  );
}

function ModelEmpty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Empty className="rounded-[calc(var(--mutiny-radius)*2)] border border-dashed border-(--mutiny-border) bg-(--mutiny-panel)">
      <EmptyHeader>
        <EmptyMedia>
          <img src="/assets/bim-ui/mutiny-icon.svg" alt="" width={44} height={44} />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function OwnModel({ m }: { m: ModelRow }) {
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-(--mutiny-radius) border border-(--mutiny-border) bg-(--mutiny-field) px-3 py-2.5">
      <div className="flex min-w-0 flex-1 flex-col">
        <a href={`/m/${m.id}?view=plan`} className="truncate font-semibold">
          {m.name}
        </a>
        <span className="text-xs text-(--mutiny-muted)">Changed {formatWhen(m.updated_at)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button asChild size="sm">
          <a href={`/m/${m.id}?view=plan`}>Open</a>
        </Button>
        <Button asChild size="sm" variant="outline">
          <a href={`/models/${m.id}/share`}>Share</a>
        </Button>
        <details className="group relative">
          <summary data-slot="button" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "cursor-pointer list-none")}>
            Rename
          </summary>
          <form method="post" action={`/models/${m.id}/rename`} className="absolute right-0 z-10 mt-1 flex w-72 gap-1.5 rounded-(--mutiny-radius) border border-(--mutiny-border) bg-(--mutiny-panel) p-2 shadow-md">
            <Input name="name" required maxLength={120} defaultValue={m.name} aria-label="New name" className="h-8" />
            <Button type="submit" size="sm">
              Save
            </Button>
          </form>
        </details>
        <ConfirmForm action={`/models/${m.id}/delete`} question={`Delete “${m.name}”? People editing it are disconnected and lose access. This can't be undone from here.`}>
          <Button type="submit" size="sm" variant="ghost" className="text-(--mutiny-danger)">
            Delete
          </Button>
        </ConfirmForm>
      </div>
    </li>
  );
}

/** The models a person may open on their linked hosts, and the state of each host (models page). */
export interface LinkedModelsView {
  readonly sections: readonly LinkedView[];
  /** A provider is a linked host but the server has no link key (shown to people who use that provider). */
  readonly keyMissing: readonly OAuthProviderConfig[];
}

function LinkedRow({ row, host }: { row: LinkedModelRow; host: string }) {
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-(--mutiny-radius) border border-(--mutiny-border) bg-(--mutiny-field) px-3 py-2.5">
      <span className="min-w-0 flex-1 truncate font-semibold">{row.label}</span>
      <Badge variant={row.can_edit ? "default" : "secondary"}>{row.can_edit ? "Can edit" : "View only"}</Badge>
      {row.open_url ? (
        <Button asChild size="sm">
          <a href={row.open_url} target="_blank" rel="noopener noreferrer">
            Open in {host}
          </a>
        </Button>
      ) : (
        <span className="text-xs text-(--mutiny-muted)">Open it from {host}.</span>
      )}
    </li>
  );
}

function LinkedSection({ view }: { view: LinkedView }) {
  const { provider, state, rows } = view;
  const host = providerName(provider);
  const label = provider.models.label;
  const start = `/auth/${provider.id}/models/start?return_to=%2Fmodels`;
  return (
    <Card data-testid={`linked-${provider.id}`}>
      <CardHeader>
        <CardTitle>{label}</CardTitle>
        <CardDescription>Access and sharing are managed in {host}.</CardDescription>
      </CardHeader>
      <CardContent>
        {state === "not_linked" ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="flex-1 text-sm">See your {label} here, beside your own models.</p>
            <Button asChild>
              <a href={start}>Show my {label}</a>
            </Button>
          </div>
        ) : state === "reconnect" ? (
          <div className="flex flex-wrap items-center gap-3" role="status">
            <p className="flex-1 text-sm">{host} needs you to reconnect. Nothing changed in your own models.</p>
            <Button asChild>
              <a href={start}>Reconnect</a>
            </Button>
          </div>
        ) : state === "down" ? (
          <div className="flex flex-wrap items-center gap-3" role="status">
            <p className="flex-1 text-sm">{host} can't be reached right now. Your own models are fine.</p>
            <Button asChild variant="outline">
              <a href="/models?fresh=1">Try again</a>
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <ModelEmpty title={`No ${label} to open`}>{host} lists only projects with a building model that you can open there.</ModelEmpty>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="linked-models">
            {rows.map((row) => (
              <LinkedRow key={row.alias_id} row={row} host={host} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function modelsPage(config: WebConfig, user: UserRow, models: readonly ModelRow[], shared: readonly SharedModelRow[], flash?: Flash, linked: LinkedModelsView = { sections: [], keyMissing: [] }): string {
  const atLimit = models.length >= config.modelLimit;
  return page(
    <>
      <PageTitle>My models</PageTitle>
      <Card>
        <CardHeader>
          <CardTitle>Yours</CardTitle>
          <CardDescription>
            {models.length} of {config.modelLimit} on a free account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {models.length === 0 ? (
            <ModelEmpty title="No models yet">Make your first one below. Start blank (one level), or from the sample mechanical model to look around first.</ModelEmpty>
          ) : (
            <ul className="flex flex-col gap-2" data-testid="own-models">
              {models.map((m) => (
                <OwnModel key={m.id} m={m} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {shared.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Shared with you</CardTitle>
            <CardDescription>Models other people opened to you. Only they can share, rename or delete them.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2" data-testid="shared-models">
              {shared.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-3 rounded-(--mutiny-radius) border border-(--mutiny-border) bg-(--mutiny-field) px-3 py-2.5">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <a href={`/m/${m.id}?view=plan`} className="truncate font-semibold">
                      {m.name}
                    </a>
                    <span className="text-xs text-(--mutiny-muted)">
                      {m.owner_name}'s · changed {formatWhen(m.updated_at)}
                    </span>
                  </div>
                  <Badge variant={m.role === "edit" ? "default" : "secondary"}>{m.role === "edit" ? "Can edit" : "View only"}</Badge>
                  <Button asChild size="sm" variant="outline">
                    <a href={`/m/${m.id}?view=plan`}>Open</a>
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
      {linked.sections.map((view) => (
        <LinkedSection key={view.provider.id} view={view} />
      ))}
      {linked.keyMissing.map((p) => (
        <Card key={p.id}>
          <CardDescription>Projects from {providerName(p)} can't be shown on this server yet: its operator hasn't set the key it keeps those connections under. Your own models are fine.</CardDescription>
        </Card>
      ))}
      {atLimit ? (
        <Card>
          <CardDescription>You have {models.length} models, the most one free account can keep. Delete one to make another.</CardDescription>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>New model</CardTitle>
          </CardHeader>
          <form method="post" action="/models" className="flex flex-col gap-4">
            <TextField label="Name" name="name" required maxLength={120} placeholder="Sample Warehouse" />
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">Start from</legend>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="start" value="blank" defaultChecked className="accent-(--mutiny-selection)" /> A blank model with one level
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="start" value="sample" className="accent-(--mutiny-selection)" /> The sample mechanical model (an air handler with ducts and diffusers)
              </label>
            </fieldset>
            <div>
              <Button type="submit" size="lg">
                Make the model
              </Button>
            </div>
          </form>
        </Card>
      )}
    </>,
    { title: "My models", user: frameUser(user), quote: config.quote, current: "models", flash: flash ?? null, scripts: ["/static/confirm.js"] },
  );
}

export function sharePage(config: WebConfig, user: UserRow, model: ModelRow, shares: readonly ShareRow[], options: { email?: string; flash?: Flash } = {}): string {
  return page(
    <>
      <PageTitle lede="People you share with see it under “Shared with you” on their My models page. They need a MutinyBIM account on this server; this app sends no email, so tell them yourself.">Share “{model.name}”</PageTitle>
      <Card>
        <CardHeader>
          <CardTitle>Who has it</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-2" data-testid="shares">
            <li className="flex items-center gap-3 rounded-(--mutiny-radius) border border-(--mutiny-border) bg-(--mutiny-field) px-3 py-2">
              <span className="flex-1">
                <strong>{user.display_name}</strong> <span className="text-(--mutiny-muted)">({user.email})</span>
              </span>
              <Badge variant="outline">Owner</Badge>
            </li>
            {shares.map((s) => (
              <li key={s.user_id} className="flex flex-wrap items-center gap-3 rounded-(--mutiny-radius) border border-(--mutiny-border) bg-(--mutiny-field) px-3 py-2">
                <span className="min-w-0 flex-1">
                  <strong>{s.display_name}</strong> <span className="text-(--mutiny-muted)">({s.email})</span>
                </span>
                <form method="post" action={`/models/${model.id}/share`} className="flex items-center gap-1.5">
                  <input type="hidden" name="email" value={s.email} />
                  <NativeSelect name="role" defaultValue={s.role} aria-label={`What ${s.display_name} can do`} className="h-8 w-auto">
                    <option value="view">View only</option>
                    <option value="edit">Can edit</option>
                  </NativeSelect>
                  <Button type="submit" size="sm" variant="outline">
                    Change
                  </Button>
                </form>
                <ConfirmForm action={`/models/${model.id}/share/${s.user_id}/delete`} question={`Stop sharing “${model.name}” with ${s.display_name}? They are disconnected at once.`}>
                  <Button type="submit" size="sm" variant="ghost" className="text-(--mutiny-danger)">
                    Remove
                  </Button>
                </ConfirmForm>
              </li>
            ))}
          </ul>
          {shares.length === 0 ? <p className="text-(--mutiny-muted)">Only you have this model so far.</p> : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Add someone</CardTitle>
          <CardDescription>“Can edit” lets them change the model, make branches and save versions. “View only” lets them look and nothing else.</CardDescription>
        </CardHeader>
        <form method="post" action={`/models/${model.id}/share`} className="flex flex-wrap items-end gap-2">
          <Field className="min-w-60 flex-1">
            <Label htmlFor="share-email">Their account email</Label>
            <Input id="share-email" name="email" type="email" required defaultValue={options.email ?? ""} placeholder="colleague@example.com" />
          </Field>
          <Field>
            <Label htmlFor="share-role">Can</Label>
            <NativeSelect id="share-role" name="role" defaultValue="edit">
              <option value="edit">Edit</option>
              <option value="view">View only</option>
            </NativeSelect>
          </Field>
          <Button type="submit" size="lg">
            Share
          </Button>
        </form>
      </Card>
      <div>
        <Button asChild variant="ghost">
          <a href="/models">← Back to my models</a>
        </Button>
      </div>
    </>,
    { title: `Share ${model.name}`, user: frameUser(user), quote: config.quote, current: "models", flash: options.flash ?? null, scripts: ["/static/confirm.js"] },
  );
}

/** Each linked host's switch on the settings page: on, needs reconnecting, or off. */
export type LinkedSwitch = "on" | "reconnect" | "off";

function LinkedModelsSwitch({ provider, state }: { provider: LinkedProvider; state: LinkedSwitch }) {
  const label = provider.models.label;
  const start = `/auth/${provider.id}/models/start?return_to=%2Fsettings`;
  return (
    <div className="flex flex-wrap items-center gap-2 pl-4 text-sm">
      <span>Show {label}:</span>
      {state === "on" ? (
        <>
          <Badge>On</Badge>
          <ConfirmForm action={`/settings/linked/${provider.id}/off`} question={`Stop showing ${label} here? This app and your connected assistants stop seeing them at once. Nothing changes in ${providerName(provider)} or in your own models.`}>
            <Button type="submit" size="sm" variant="ghost" className="text-(--mutiny-danger)">
              Turn off
            </Button>
          </ConfirmForm>
        </>
      ) : state === "reconnect" ? (
        <>
          <Badge variant="destructive">Needs reconnecting</Badge>
          <Button asChild size="sm" variant="outline">
            <a href={start}>Reconnect</a>
          </Button>
        </>
      ) : (
        <>
          <Badge variant="secondary">Off</Badge>
          <Button asChild size="sm" variant="outline">
            <a href={start}>Show them</a>
          </Button>
        </>
      )}
    </div>
  );
}

export function settingsPage(config: WebConfig, user: UserRow, linked: readonly string[], options: { flash?: Flash; passwordFree?: boolean; linkedModels?: readonly { readonly provider: LinkedProvider; readonly state: LinkedSwitch }[] } = {}): string {
  return page(
    <>
      <PageTitle>Settings</PageTitle>
      <Card>
        <CardHeader>
          <CardTitle>Your account</CardTitle>
          <CardDescription>Email: {user.email}</CardDescription>
        </CardHeader>
        <form method="post" action="/settings/profile" className="flex flex-wrap items-end gap-2">
          <Field className="min-w-60 flex-1">
            <Label htmlFor="profile-name">Name</Label>
            <Input id="profile-name" name="name" required maxLength={80} defaultValue={user.display_name} />
          </Field>
          <Button type="submit" variant="outline" size="lg">
            Save name
          </Button>
        </form>
        {config.providers.length > 0 ? (
          <>
            <Separator />
            <div className="flex flex-col gap-2">
              <h3 className="text-sm">Ways to log in</h3>
              <ul className="flex flex-col gap-2">
                {config.providers.map((p) => {
                  const switchFor = linked.includes(p.id) ? options.linkedModels?.find((m) => m.provider.id === p.id) : undefined;
                  return (
                    <li key={p.id} className="flex flex-col gap-1.5">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <strong>{providerName(p)}</strong>
                        {linked.includes(p.id) ? (
                          <Badge>Linked</Badge>
                        ) : (
                          <>
                            <Badge variant="secondary">Not linked</Badge>
                            <Button asChild size="sm" variant="outline">
                              <a href={`/auth/${p.id}/start?link=1&return_to=%2Fsettings`}>Link it</a>
                            </Button>
                          </>
                        )}
                      </div>
                      {switchFor ? <LinkedModelsSwitch provider={switchFor.provider} state={switchFor.state} /> : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          </>
        ) : null}
      </Card>
      <Card id="password">
        <CardHeader>
          <CardTitle>Password</CardTitle>
          <CardDescription>{user.password_hash ? "Changing it signs you out on every other device." : "You sign in through a linked account. Set a password to also log in with your email."}</CardDescription>
        </CardHeader>
        <form method="post" action="/settings/password" className="flex flex-col gap-3">
          {user.password_hash && !options.passwordFree ? <TextField label="Current password" name="current" type="password" autoComplete="current-password" required /> : null}
          {user.password_hash && options.passwordFree ? <FieldHint>You just logged in with a linked account, so no current password is needed for the next few minutes.</FieldHint> : null}
          <TextField label="New password" hint="At least 8 characters." name="password" type="password" autoComplete="new-password" required minLength={8} />
          <div>
            <Button type="submit" variant="outline" size="lg">
              {user.password_hash ? "Change password" : "Set password"}
            </Button>
          </div>
        </form>
      </Card>
      <Card id="ai">
        <CardHeader>
          <CardTitle>Your AI</CardTitle>
          <CardDescription>
            This app pays for no AI. Paste a key from your own AI provider and the <strong>Ask AI</strong> button in the editor uses it. The key is kept <strong>only in this browser</strong>: never sent to this server, never saved in your account, never in our logs. Your browser sends your questions straight to the provider, and the provider bills you.
          </CardDescription>
        </CardHeader>
        <div id="ai-settings" className="group flex flex-col gap-3" data-state="loading">
          <p className="text-sm text-(--mutiny-muted) group-data-[state=ready]:hidden">Loading your AI settings…</p>
          <Field>
            <Label htmlFor="ai-provider">Provider</Label>
            <NativeSelect id="ai-provider" name="provider">
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI (ChatGPT models)</option>
              <option value="xai">xAI (Grok)</option>
              <option value="compatible">Another provider with an OpenAI-style address</option>
            </NativeSelect>
          </Field>
          <Field className="hidden group-data-[provider=compatible]:flex">
            <Label htmlFor="ai-base">Address</Label>
            <Input id="ai-base" name="baseUrl" type="url" placeholder="https://api.example.com/v1" />
            <FieldHint>Ends in /v1.</FieldHint>
          </Field>
          <Field>
            <Label htmlFor="ai-model">Model</Label>
            <Input id="ai-model" name="model" />
            <FieldHint>Leave blank for the provider's usual one.</FieldHint>
          </Field>
          <Field>
            <Label htmlFor="ai-key">API key</Label>
            <Input id="ai-key" name="key" type="password" autoComplete="off" spellCheck={false} placeholder="Paste your key" />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="button" data-action="save">
              Save in this browser
            </Button>
            <Button type="button" variant="outline" data-action="test">
              Test the key
            </Button>
            <Button type="button" variant="ghost" className="text-(--mutiny-danger)" data-action="forget">
              Forget the key
            </Button>
          </div>
          <p className="status text-sm text-(--mutiny-muted) data-[kind=error]:text-(--mutiny-danger) data-[kind=ok]:text-(--mutiny-text)" role="status" aria-live="polite" />
        </div>
        <CardDescription>
          Prefer your own assistant app (Claude Desktop, ChatGPT, Cursor)? <a href="/connect">Connect it to your models</a> instead.
        </CardDescription>
      </Card>
    </>,
    { title: "Settings", user: frameUser(user), quote: config.quote, current: "settings", flash: options.flash ?? null, scripts: ["/static/settings.js", "/static/confirm.js"] },
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded-(--mutiny-radius) bg-(--mutiny-subtle) px-1 py-0.5 text-[0.85em]">{children}</code>;
}

export interface ConnectView {
  readonly models: readonly ModelRow[];
  readonly keys: readonly AgentKeyRow[];
  readonly assistants: readonly AssistantGrantRow[];
  readonly newKey: string | null;
  /** Labels of the linked hosts' models this person has turned on (assistants see those too). */
  readonly linkedLabels?: readonly string[];
}

export function connectPage(config: WebConfig, user: UserRow, view: ConnectView, flash?: Flash): string {
  const { models, keys, assistants, newKey } = view;
  const mcpUrl = `${config.origin}/mcp`;
  const syncUrl = `${config.origin.replace(/^http/, "ws")}/sync`;
  const modelArgs = models.length > 0 ? models.slice(0, 5).map((m) => `--model ${m.id}`).join(" ") : "--model <model id>";
  const command = `node packages/bim-mcp/bin/mutinybim-mcp.mjs --http --model-server "${syncUrl}?key=${newKey ?? "<your agent key>"}" ${modelArgs}`;
  return page(
    <>
      <PageTitle lede="Claude, ChatGPT, Grok, Cursor or any assistant that speaks the Model Context Protocol (MCP) can read and change your models. Every change it proposes asks you first, and models shared with you to view stay view-only. You pay your AI provider; this app pays nothing and sees nothing of your AI account.">Connect your own assistant</PageTitle>
      {newKey ? (
        <Card className="border-(--mutiny-selection) bg-(--mutiny-accent-subtle)" role="status">
          <CardTitle className="text-base">Your new agent key</CardTitle>
          <code className="block overflow-x-auto rounded-(--mutiny-radius) bg-(--mutiny-field) p-2 text-sm" data-testid="new-agent-key">
            {newKey}
          </code>
          <CardDescription>Copy it now. It is shown once and only its fingerprint is kept. Anyone with it can edit your models and the ones shared with you for editing, so treat it like a password.</CardDescription>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Paste this address into your assistant</CardTitle>
          <CardDescription>Add MutinyBIM as a custom connector (an MCP server) and paste:</CardDescription>
        </CardHeader>
        <code className="block overflow-x-auto rounded-(--mutiny-radius) border border-(--mutiny-border) bg-(--mutiny-field) p-3 text-base" data-testid="mcp-url">
          {mcpUrl}
        </code>
        <ul className="flex flex-col gap-2 text-sm">
          <li>
            <strong>Claude</strong> (claude.ai or Claude Desktop): Settings → Connectors → Add custom connector, paste the address, then Connect.
          </li>
          <li>
            <strong>ChatGPT:</strong> Settings → Apps &amp; Connectors → Create (developer mode), paste the address, choose OAuth, then Create.
          </li>
          <li>
            <strong>Grok:</strong> add a custom connector (MCP server) and paste the address.
          </li>
          <li>
            <strong>Claude Code:</strong> <Code>{`claude mcp add --transport http mutinybim ${mcpUrl}`}</Code>
          </li>
          <li>
            <strong>Cursor:</strong> add <Code>{`{ "mcpServers": { "mutinybim": { "url": "${mcpUrl}" } } }`}</Code> to <Code>~/.cursor/mcp.json</Code>
          </li>
        </ul>
        <CardDescription>
          Your assistant opens a MutinyBIM sign-in page: log in and press Allow. No key to copy. It starts with the core tools (ten at most); ask it to turn on a tool family when a job needs one, or connect a family directly at <Code>{`${config.origin}/packs/<family>/mcp`}</Code> (for example <Code>{`${config.origin}/packs/electrical/mcp`}</Code>).
        </CardDescription>
        <CardDescription>
          When your assistant can't ask you itself, its changes wait on <a href="/approvals">Approvals</a> until you press Approve. Its scripts run here in a sealed box with no network; a script only previews until you approve what it does.
        </CardDescription>
        {view.linkedLabels && view.linkedLabels.length > 0 ? <CardDescription>Assistants you connect here also see your {view.linkedLabels.join(" and ")}.</CardDescription> : null}
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Assistants signed in</CardTitle>
        </CardHeader>
        {assistants.length === 0 ? (
          <CardDescription>None yet. After you press Allow in your assistant, it is listed here, and you can sign it out.</CardDescription>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="assistant-list">
            {assistants.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 rounded-(--mutiny-radius) border border-(--mutiny-border) bg-(--mutiny-field) px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <strong>{a.client_name}</strong> <span className="text-(--mutiny-muted)">signed in {formatWhen(a.created_at)} · {a.last_used_at ? `last used ${formatWhen(a.last_used_at)}` : "not used yet"}</span>
                </span>
                <ConfirmForm action={`/connect/assistants/${a.id}/delete`} question={`Sign out “${a.client_name}”? It loses access to your models at once.`}>
                  <Button type="submit" size="sm" variant="ghost" className="text-(--mutiny-danger)">
                    Sign out
                  </Button>
                </ConfirmForm>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Or run the tool server on your own computer</CardTitle>
          <CardDescription>For an assistant that only starts local tools. You need Node 22.13 or newer, the open-source repository and an agent key.</CardDescription>
        </CardHeader>
        {keys.length === 0 ? (
          <CardDescription>No agent keys yet.</CardDescription>
        ) : (
          <ul className="flex flex-col gap-2">
            {keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-2 rounded-(--mutiny-radius) border border-(--mutiny-border) bg-(--mutiny-field) px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <strong>{k.label}</strong> <span className="text-(--mutiny-muted)">ending …{k.last4} · made {formatWhen(k.created_at)} · {k.last_used_at ? `last used ${formatWhen(k.last_used_at)}` : "never used"}</span>
                </span>
                <ConfirmForm action={`/connect/keys/${k.id}/delete`} question={`Turn off “${k.label}”? Assistants using it lose access at once.`}>
                  <Button type="submit" size="sm" variant="ghost" className="text-(--mutiny-danger)">
                    Turn off
                  </Button>
                </ConfirmForm>
              </li>
            ))}
          </ul>
        )}
        <form method="post" action="/connect/keys" className="flex flex-wrap gap-2">
          <Input name="label" required maxLength={60} placeholder="Claude on my laptop" aria-label="What the key is for" className="max-w-xs" />
          <Button type="submit" variant="outline">
            Make a key
          </Button>
        </form>
        <pre className="overflow-x-auto rounded-(--mutiny-radius) border border-(--mutiny-border) bg-(--mutiny-canvas) p-3 text-xs/relaxed">
          <code>{`git clone https://github.com/permitzip/mutinybim.git\ncd mutinybim\nnpm install\n${command}`}</code>
        </pre>
        <CardDescription>
          That serves your assistant at <Code>http://127.0.0.1:3333/mcp</Code>, connected to your models here; leave out <Code>--http</Code> to let your assistant start it itself. Full guide: <a href="https://github.com/permitzip/mutinybim/blob/main/docs/CONNECT-AN-AGENT.md">Connect an AI assistant</a>.
        </CardDescription>
        {models.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm">
            {models.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-40">{m.name}</span>
                <Code>{m.id}</Code>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
    </>,
    { title: "Connect an assistant", user: frameUser(user), quote: config.quote, current: "connect", flash: flash ?? null, scripts: ["/static/confirm.js"] },
  );
}

/** What the sign-in approval for an outside assistant shows. */
export interface AssistantConsent {
  readonly clientName: string;
  /** Where the person goes back to after answering (the assistant's address). */
  readonly backTo: string;
  /** The original request, posted back with the answer. */
  readonly request: string;
  readonly models: number;
  readonly shared: number;
}

export function assistantConsentPage(_config: WebConfig, user: UserRow, consent: AssistantConsent): string {
  return page(
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">Let “{consent.clientName}” use your models?</CardTitle>
        <CardDescription>
          You're signed in as <strong>{user.display_name}</strong> ({user.email}). After you answer you go back to <strong>{consent.backTo}</strong>.
        </CardDescription>
      </CardHeader>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
        <li>
          It can read your {consent.models} model{consent.models === 1 ? "" : "s"}
          {consent.shared > 0 ? ` and the ${consent.shared} shared with you` : ""}.
        </li>
        <li>It can propose changes. Every change asks you first, and models shared with you to view stay view-only.</li>
        <li>It can't see your password, your settings or your AI keys, and it can't share or delete models.</li>
        <li>You can sign it out any time under Connect an assistant.</li>
      </ul>
      <CardDescription>The name above is the one the assistant gave itself. Only allow it if you just asked your assistant to connect to MutinyBIM.</CardDescription>
      <form method="post" action="/oauth/authorize" className="flex flex-wrap gap-2">
        <input type="hidden" name="request" value={consent.request} />
        <Button type="submit" name="decision" value="allow" size="lg">
          Allow
        </Button>
        <Button type="submit" name="decision" value="deny" size="lg" variant="outline">
          Don't allow
        </Button>
      </form>
    </Card>,
    { title: "Connect an assistant", user: frameUser(user), quote: null, narrow: true },
  );
}

const APPROVAL_STATE_WORDS: Record<PendingApproval["state"], string> = {
  waiting: "Waiting for you",
  approved: "Approved, not applied yet",
  declined: "Declined",
  landed: "Applied",
  failed: "Couldn't apply",
  expired: "Dropped",
};

function ApprovalBadge({ state }: { state: PendingApproval["state"] }) {
  return <Badge variant={state === "waiting" ? "default" : state === "failed" || state === "declined" ? "destructive" : "secondary"}>{APPROVAL_STATE_WORDS[state]}</Badge>;
}

function ApprovalButtons({ item }: { item: PendingApproval }) {
  if (item.state !== "waiting") return null;
  return (
    <form method="post" action={`/approvals/${item.id}`} className="flex flex-wrap gap-2">
      <Button type="submit" name="decision" value="approve" data-testid="approve">
        Approve
      </Button>
      <Button type="submit" name="decision" value="decline" variant="outline">
        Decline
      </Button>
    </form>
  );
}

export function approvalsPage(config: WebConfig, user: UserRow, items: readonly PendingApproval[]): string {
  return page(
    <>
      <PageTitle lede="Changes your assistants want to make, when they couldn't ask you themselves. Nothing lands until you approve it; a request waits 30 minutes, then it's dropped.">Approvals</PageTitle>
      {items.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Nothing waiting</EmptyTitle>
            <EmptyDescription>
              When an assistant you <a href="/connect">connected</a> proposes a change and can't ask you itself, it shows up here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={item.id}>
              <Card>
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    <a href={`/approvals/${item.id}`} className="min-w-0 break-words">
                      {approvalTitle(item)}
                    </a>{" "}
                    <ApprovalBadge state={item.state} />
                  </CardTitle>
                  <CardDescription>
                    {item.clientName} · {formatWhen(new Date(item.createdAt).toISOString())}
                  </CardDescription>
                </CardHeader>
                {item.outcome ? <CardDescription>{item.outcome}</CardDescription> : null}
                <ApprovalButtons item={item} />
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>,
    { title: "Approvals", user: frameUser(user), quote: config.quote, current: "approvals" },
  );
}

export function approvalPage(config: WebConfig, user: UserRow, item: PendingApproval): string {
  const title = approvalTitle(item);
  // The request word for word, as the assistant sent it, under the plain title.
  const details = item.summary === title ? item.details : [item.summary, ...item.details];
  return page(
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-2xl">
          <span className="min-w-0 break-words">{title}</span> <ApprovalBadge state={item.state} />
        </CardTitle>
        <CardDescription>
          {item.clientName} wants to make this change in {item.modelId ? <a href={`/m/${encodeURIComponent(item.modelId.split("~")[0] ?? item.modelId)}`}>“{item.modelName}”</a> : item.modelName}, asked {formatWhen(new Date(item.createdAt).toISOString())}.
        </CardDescription>
      </CardHeader>
      {details.length > 0 ? (
        <pre className="max-h-80 overflow-auto rounded-(--mutiny-radius) border border-(--mutiny-border) bg-(--mutiny-canvas) p-3 text-xs/relaxed whitespace-pre-wrap" aria-label="Exactly what changes">
          <code>{details.join("\n")}</code>
        </pre>
      ) : null}
      {item.outcome ? (
        <CardDescription role="status" data-testid="approval-outcome">
          {item.outcome}
        </CardDescription>
      ) : null}
      <ApprovalButtons item={item} />
      <CardFooter>
        <a href="/approvals">All approvals</a>
      </CardFooter>
    </Card>,
    { title: "Approve a change", user: frameUser(user), quote: config.quote, current: "approvals", narrow: true },
  );
}

export function quotePage(config: WebConfig, quote: QuoteConfig, user: UserRow, models: readonly ModelRow[], chosen: ModelRow | null, summary: ModelSummary | null): string {
  const target = new URL(quote.url);
  target.searchParams.set("source", "mutinybim");
  if (chosen) target.searchParams.set("model", chosen.name);
  target.searchParams.set("email", user.email);
  const kinds = summary
    ? Object.entries(summary.byKind)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`)
        .join(", ")
    : "";
  return page(
    <>
      <PageTitle lede={quote.blurb ?? `${quote.provider} can price the engineering for your project.`}>{quote.label}</PageTitle>
      <Card>
        {models.length === 0 ? (
          <CardDescription>You have no models yet; you can still ask for a quote.</CardDescription>
        ) : (
          <form method="get" action="/quote" className="flex flex-wrap items-end gap-2">
            <Field className="min-w-60 flex-1">
              <Label htmlFor="quote-model">Which project?</Label>
              <NativeSelect id="quote-model" name="model" defaultValue={chosen?.id}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Button type="submit" variant="outline" size="lg">
              Use this one
            </Button>
          </form>
        )}
        <Separator />
        <CardHeader>
          <CardTitle>What the quote form asks for</CardTitle>
        </CardHeader>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
          <li>
            Your name and email (yours here: <strong>{user.display_name}</strong>, {user.email})
          </li>
          <li>
            The project{chosen ? <> (<strong>{chosen.name}</strong>)</> : null}, its size and what it needs
          </li>
        </ul>
        {summary ? (
          <CardDescription>
            This model has {summary.elements} elements ({kinds || "none yet"}) on {summary.levels.length} level{summary.levels.length === 1 ? "" : "s"}. Nothing from this model is sent; {quote.provider} asks you for drawings if they need them.
          </CardDescription>
        ) : null}
        <CardFooter>
          <Button asChild size="lg">
            <a href={target.toString()} target="_blank" rel="noopener" data-testid="quote-link">
              Open {quote.provider}'s quote form
            </a>
          </Button>
        </CardFooter>
        <CardDescription>
          The form opens in a new tab on {target.host}. It is told the request came from MutinyBIM, with this project's name and your email filled in, so {quote.provider} knows where it came from. {quote.provider} replies by email.
        </CardDescription>
      </Card>
    </>,
    { title: quote.label, user: frameUser(user), quote: config.quote, current: "quote" },
  );
}

/** Right after a sign-in with a linked host: one question, asked once. */
export function linkedOfferPage(config: WebConfig, user: UserRow, provider: LinkedProvider, returnTo: string): string {
  const host = providerName(provider);
  const label = provider.models.label;
  return page(
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">Show your {label} too?</CardTitle>
        <CardDescription>
          {host} can list the projects you can open there, here under your own models, and your connected assistants can work on them too. {host} asks you to allow it next.
        </CardDescription>
      </CardHeader>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
        <li>It opens building models only: nothing else in your {host} account.</li>
        <li>What you can see and change stays up to your role in {host}, checked every time.</li>
        <li>Nothing is copied here. Turn it off any time under Settings, or in {host}.</li>
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button asChild size="lg">
          <a href={`/auth/${provider.id}/models/start?return_to=${encodeURIComponent(returnTo)}`}>Show them</a>
        </Button>
        <form method="post" action={`/auth/${provider.id}/models/offer`}>
          <input type="hidden" name="return_to" value={returnTo} />
          <Button type="submit" size="lg" variant="outline">
            Not now
          </Button>
        </form>
      </div>
    </Card>,
    { title: `Show your ${label}`, user: frameUser(user), quote: config.quote, narrow: true },
  );
}

export function messagePage(config: WebConfig, user: UserRow | null, title: string, words: string, action?: { href: string; label: string }): string {
  return page(
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">{title}</CardTitle>
        <CardDescription>{words}</CardDescription>
      </CardHeader>
      {action ? (
        <CardFooter>
          <Button asChild>
            <a href={action.href}>{action.label}</a>
          </Button>
        </CardFooter>
      ) : null}
    </Card>,
    { title, user: user ? frameUser(user) : null, quote: user ? config.quote : null, narrow: true },
  );
}
