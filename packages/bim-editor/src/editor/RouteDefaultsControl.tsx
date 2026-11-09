'use client'

import { useState } from 'react'
import { Save } from 'lucide-react'
import { Button } from '../ui/button'
import { Field, FieldDescription, FieldLabel } from '../ui/field'
import { Spinner } from '../ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { defaultsFromChoices } from './route-defaults'
import type { RouteChoices } from './RoutePanel'
import type { RouteDefaultsApi } from './use-route-defaults'

/**
 * "My defaults" in the Route panel: what the panel opened with, saving the
 * current choices for this project or every project, and forgetting them.
 * Saved in the database per person, so they follow the person anywhere.
 */
export function RouteDefaultsControl({ choices, api }: { choices: RouteChoices; api: RouteDefaultsApi }) {
  const [scope, setScope] = useState<'project' | 'all'>('all')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)
  const { domain, settings } = defaultsFromChoices(choices)
  const row = api.state.status === 'ready' ? api.state.rows.find((r) => r.domain === domain) : undefined
  const saved = scope === 'project' ? row?.thisProject : row?.allProjects
  const where = scope === 'project' ? 'this project' : 'every project'

  const status =
    api.state.status === 'loading'
      ? 'Loading your defaults…'
      : api.state.status === 'error'
        ? `Couldn't load your saved defaults: ${api.state.message}. Saving still works.`
        : row?.thisProject
          ? `Opened on your ${domain} defaults for this project.`
          : row?.allProjects
            ? `Opened on your ${domain} defaults for every project.`
            : `No ${domain} defaults saved yet; the panel starts on the standard choices.`

  const run = async (next: typeof settings | null, done: string) => {
    setBusy(true)
    const err = await api.save(domain, scope, next)
    setBusy(false)
    setMessage(err ? { error: true, text: err } : { error: false, text: done })
  }

  return (
    <Field data-testid="route-defaults">
      <FieldLabel htmlFor="bm-route-defaults-scope">My defaults</FieldLabel>
      <FieldDescription className={api.state.status === 'error' ? 'text-danger-600' : undefined} data-testid="route-defaults-status">
        {api.state.status === 'loading' && <Spinner data-icon="inline-start" />}
        {status}
      </FieldDescription>
      <ToggleGroup id="bm-route-defaults-scope" type="single" variant="outline" size="sm" value={scope} onValueChange={(v) => (v === 'project' || v === 'all') && setScope(v)} aria-label="Save my defaults for">
        <ToggleGroupItem value="all">Every project</ToggleGroupItem>
        <ToggleGroupItem value="project">This project</ToggleGroupItem>
      </ToggleGroup>
      <div className="grid grid-cols-2 gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => run(settings, `Saved: new ${domain} routes on ${where} start like this.`)} data-testid="route-defaults-save">
          {busy ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
          Save as my default
        </Button>
        <Button size="sm" variant="ghost" disabled={busy || !saved} title={saved ? undefined : `Nothing is saved for ${where}`} onClick={() => run(null, `Forgot your ${domain} defaults for ${where}.`)} data-testid="route-defaults-clear">
          Forget
        </Button>
      </div>
      {message && (
        <FieldDescription className={message.error ? 'text-danger-600' : 'text-success-700'} role={message.error ? 'alert' : 'status'} data-testid="route-defaults-message">
          {message.text}
        </FieldDescription>
      )}
      <FieldDescription>Saves the shape, size, insulation, elbows, takeoffs and rises shown above, for you only. This project&apos;s defaults win over every-project ones.</FieldDescription>
    </Field>
  )
}
