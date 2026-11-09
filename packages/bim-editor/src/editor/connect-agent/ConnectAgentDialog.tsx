'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { BIM_TOOL_PACKS, CORE_PACK_ID, bimPackEndpointPath, renderMcpJson } from '@permitzip/bim-plugin'
import { Alert, AlertDescription } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'

export interface ConnectAgentDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /** Where this host app serves MutinyBIM (`https://example.com/api/bim`); defaults to this page's origin. */
  readonly baseUrl?: string
}

type Copied = { readonly what: 'address' | 'file' } | null

/**
 * Building Model › Manage › Connect an agent. Outside agents (Claude, Cursor,
 * ChatGPT, OpenCode) connect the core and only the packs a job needs: each
 * pack is its own connection, with a guide of the same name in the MutinyBIM
 * package. Pick a pack to see its address; the connections file has every
 * pack at once. Signing in once covers them all.
 */
export function ConnectAgentDialog({ open, onOpenChange, baseUrl }: ConnectAgentDialogProps) {
  const [packId, setPackId] = useState<string>(CORE_PACK_ID)
  const [copied, setCopied] = useState<Copied>(null)
  const [copyError, setCopyError] = useState<string | null>(null)
  const base = useMemo(() => baseUrl ?? (typeof window === 'undefined' ? '' : `${window.location.origin}/api/bim`), [baseUrl])
  const pack = BIM_TOOL_PACKS.find((p) => p.id === packId) ?? BIM_TOOL_PACKS[0]
  const address = pack ? `${base}${bimPackEndpointPath(pack)}` : ''

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(null), 2_000)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = useCallback(async (what: 'address' | 'file', value: string) => {
    setCopyError(null)
    try {
      await navigator.clipboard.writeText(value)
      setCopied({ what })
    } catch (err) {
      console.error('[ConnectAgentDialog] copy failed', err)
      setCopyError("Couldn't copy: your browser blocked the clipboard. Select the address and copy it yourself.")
    }
  }, [])

  if (!pack) return null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="connect-agent-dialog">
        <DialogHeader>
          <DialogTitle>Connect an agent</DialogTitle>
          <DialogDescription>
            Claude, Cursor, ChatGPT and other agents connect the core plus only the packs a job needs. Each pack is its own connection and has a guide of the same name. Signing in once covers every pack.
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="connect-agent-pack">Pack</FieldLabel>
          <Select value={pack.id} onValueChange={setPackId}>
            <SelectTrigger id="connect-agent-pack" data-testid="connect-agent-pack">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BIM_TOOL_PACKS.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription data-testid="connect-agent-purpose">
            {pack.purpose}. Guide: <code>{pack.skill}</code>
            {pack.id === CORE_PACK_ID ? '. Connect this one first.' : '. Connect the core too.'}
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="connect-agent-address">Address</FieldLabel>
          <code id="connect-agent-address" data-testid="connect-agent-address" className="block break-all rounded-md bg-muted px-2 py-1.5 text-sm select-all">
            {address}
          </code>
        </Field>
        {copyError ? (
          <Alert variant="destructive">
            <AlertDescription>{copyError}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => void copy('file', `${JSON.stringify(renderMcpJson(base, { perPack: true }), null, 2)}\n`)} data-testid="connect-agent-copy-file">
            {copied?.what === 'file' ? <CheckIcon /> : <CopyIcon />}
            {copied?.what === 'file' ? 'Copied' : 'Copy every connection (mcp.json)'}
          </Button>
          <Button onClick={() => void copy('address', address)} data-testid="connect-agent-copy-address">
            {copied?.what === 'address' ? <CheckIcon /> : <CopyIcon />}
            {copied?.what === 'address' ? 'Copied' : 'Copy address'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
