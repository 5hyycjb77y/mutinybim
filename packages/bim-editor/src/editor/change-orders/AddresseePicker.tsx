'use client'

import { useEffect, useState } from 'react'
import { Building2Icon, UserIcon } from 'lucide-react'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '../../ui/item'
import { Spinner } from '../../ui/spinner'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { searchAddresseesFrom } from '../../contracts/bim/change-orders/client'
import type { AddresseeOption } from '../../contracts/bim/change-orders/model'

type Search = { readonly state: 'loading' } | { readonly state: 'error'; readonly message: string } | { readonly state: 'ready'; readonly options: readonly AddresseeOption[]; readonly note: string | null }

/**
 * Address to: a contact or a company from the integrated contact list, as
 * the person sees it on the Contacts page. Picking one shows it with a
 * Change button; the list explains when it is empty.
 */
export function AddresseePicker({ projectId, value, onChange }: { readonly projectId: string; readonly value: AddresseeOption | null; readonly onChange: (next: AddresseeOption | null) => void }) {
  const changeOrders = useEditorHost().data.changeOrders
  const [q, setQ] = useState('')
  const [attempt, setAttempt] = useState(0)
  const key = `${q}|${attempt}`
  const [answer, setAnswer] = useState<{ readonly key: string; readonly search: Search } | null>(null)

  useEffect(() => {
    if (value) return
    const controller = new AbortController()
    // A short pause so each keystroke doesn't search.
    const timer = setTimeout(() => {
      searchAddresseesFrom(changeOrders, projectId, q, controller.signal)
        .then((r) => setAnswer({ key, search: { state: 'ready', options: r.options, note: r.note } }))
        .catch((err: unknown) => {
          if (controller.signal.aborted) return
          console.error('[AddresseePicker] search failed', err)
          setAnswer({ key, search: { state: 'error', message: err instanceof Error ? err.message : "The contact list didn't load." } })
        })
    }, 200)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [changeOrders, projectId, q, key, value])

  if (value) {
    return (
      <Item variant="outline" size="sm">
        <ItemMedia>{value.kind === 'organization' ? <Building2Icon aria-hidden /> : <UserIcon aria-hidden />}</ItemMedia>
        <ItemContent>
          <ItemTitle>{value.label}</ItemTitle>
          {value.detail ? <ItemDescription>{value.detail}</ItemDescription> : null}
        </ItemContent>
        <Button size="sm" variant="outline" onClick={() => onChange(null)}>
          Change
        </Button>
      </Item>
    )
  }

  const search: Search = answer && answer.key === key ? answer.search : { state: 'loading' }
  return (
    <div className="flex flex-col gap-2">
      <Input aria-label="Search contacts and companies" placeholder="Search a name, an email or a company" value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} />
      {search.state === 'loading' ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner aria-hidden /> Searching the contact list…
        </p>
      ) : search.state === 'error' ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          {search.message}
          <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </Button>
        </p>
      ) : search.options.length === 0 ? (
        <p className="text-sm text-muted-foreground">{search.note ?? 'Nothing matches.'}</p>
      ) : (
        <ItemGroup aria-label="Contacts and companies" className="max-h-56 overflow-y-auto">
          {search.options.map((o) => (
            <Item key={`${o.kind}:${o.id}`} size="sm">
              <ItemMedia>{o.kind === 'organization' ? <Building2Icon aria-hidden /> : <UserIcon aria-hidden />}</ItemMedia>
              <ItemContent>
                <ItemTitle>{o.label}</ItemTitle>
                {o.detail ? <ItemDescription>{o.detail}</ItemDescription> : null}
              </ItemContent>
              <ItemActions>
                <Button size="sm" variant="outline" aria-label={`Address to ${o.label}`} onClick={() => onChange(o)}>
                  Pick
                </Button>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}
    </div>
  )
}
