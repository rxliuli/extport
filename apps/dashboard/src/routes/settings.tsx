import { api, ApiError, type ApiKeyRow, type CredentialRow } from '@/api'
import { formatDate } from '@/status'
import { DatePicker } from '@/components/date-picker'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { credentialsQuery, keysQuery, meQuery, paymentCredentialsQuery } from '@/queries'
import { useIsFetching, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { KeyRound, Loader2, MoreHorizontal, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

export const Route = createFileRoute('/settings')({ component: SettingsPage })

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err)
}

function ApiKeysSection() {
  const queryClient = useQueryClient()
  const { data: keys = [] } = useQuery(keysQuery)
  const [name, setName] = useState('')
  const [freshKey, setFreshKey] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: (name: string) => api<{ key: string }>('/api/v1/keys', { method: 'POST', body: JSON.stringify({ name }) }),
    onSuccess: (created) => {
      setFreshKey(created.key)
      setName('')
      void queryClient.invalidateQueries({ queryKey: keysQuery.queryKey })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/v1/keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keysQuery.queryKey }),
    onError: (err) => toast.error(errorMessage(err)),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle id="api-keys">API keys</CardTitle>
        <CardDescription>Used by the CLI and CI (`EXTPORT_API_KEY`) to push artifacts.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) create.mutate(name.trim())
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Key name (e.g. ci)"
            className="h-8 w-full max-w-56"
            required
          />
          <Button type="submit" size="sm" disabled={create.isPending}>
            <Plus /> <span className="hidden sm:inline">Create</span>
          </Button>
        </form>

        {freshKey && (
          <Alert>
            <KeyRound />
            <AlertTitle>Copy now — shown once</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              <code className="rounded bg-muted px-2 py-1 text-xs">{freshKey}</code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void navigator.clipboard.writeText(freshKey)
                  toast.success('Copied')
                }}
              >
                Copy
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setFreshKey(null)}>
                Dismiss
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {keys.length > 0 && (
          <Table>
            <TableBody>
              {keys.map((k: ApiKeyRow) => (
                <TableRow key={k.id}>
                  <TableCell>
                    <code className="text-xs">{k.masked}</code>
                  </TableCell>
                  <TableCell>{k.name}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="outline" size="sm" onClick={() => revoke.mutate(k.id)} disabled={revoke.isPending}>
                      Revoke
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {keys.length === 0 && <p className="text-sm text-muted-foreground">No API keys yet.</p>}
      </CardContent>
    </Card>
  )
}

const CREDENTIAL_FIELDS: Record<CredentialRow['store'], { key: string; label: string; textarea?: boolean }[]> = {
  chrome: [
    { key: 'publisherId', label: 'Publisher ID (Developer Dashboard → Settings → Profile)' },
    { key: 'clientEmail', label: 'Service Account Email' },
    { key: 'privateKey', label: 'Service Account Private Key (.json → private_key)', textarea: true },
  ],
  firefox: [
    { key: 'jwtIssuer', label: 'JWT Issuer' },
    { key: 'jwtSecret', label: 'JWT Secret' },
  ],
  edge: [
    { key: 'clientId', label: 'Client ID' },
    { key: 'apiKey', label: 'API Key' },
  ],
  safari: [
    { key: 'keyId', label: 'Key ID' },
    { key: 'issuerId', label: 'Issuer ID' },
    { key: 'privateKeyP8', label: '.p8 Private Key', textarea: true },
  ],
}

const STORE_OPTION_LABEL: Record<CredentialRow['store'], string> = {
  chrome: 'Chrome Web Store',
  firefox: 'Firefox AMO',
  edge: 'Edge Partner Center',
  safari: 'App Store Connect',
}

const CREDENTIAL_STATUS_CLASS: Record<CredentialRow['status'], string> = {
  active: 'text-green-700 dark:text-green-500',
  expiring: 'text-amber-600 dark:text-amber-400',
  invalid: 'text-red-600 dark:text-red-400',
}

// Shared by the "Add credential" form and the inline "Rotate" form — same
// fields either way, since rotating is just providing a fresh secret for the
// same store, verified the same way a new credential would be.
function CredentialFieldInputs({
  store,
  fields,
  onChange,
}: {
  store: CredentialRow['store']
  fields: Record<string, string>
  onChange: (fields: Record<string, string>) => void
}) {
  return (
    <>
      {CREDENTIAL_FIELDS[store].map((f) =>
        f.textarea ? (
          <Textarea
            key={f.key}
            rows={5}
            placeholder={f.label}
            value={fields[f.key] ?? ''}
            onChange={(e) => onChange({ ...fields, [f.key]: e.target.value })}
            required
          />
        ) : (
          <Input
            key={f.key}
            placeholder={f.label}
            value={fields[f.key] ?? ''}
            onChange={(e) => onChange({ ...fields, [f.key]: e.target.value })}
            required
          />
        ),
      )}
    </>
  )
}

function CredentialsSection() {
  const queryClient = useQueryClient()
  const { data: rows = [] } = useQuery(credentialsQuery)
  const [addOpen, setAddOpen] = useState(false)
  const [store, setStore] = useState<CredentialRow['store']>('chrome')
  const [label, setLabel] = useState('')
  const [expiresAt, setExpiresAt] = useState<Date | undefined>(undefined)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [rotatingId, setRotatingId] = useState<string | null>(null)
  const [rotateFields, setRotateFields] = useState<Record<string, string>>({})
  const [rotateExpiresAt, setRotateExpiresAt] = useState<Date | undefined>(undefined)

  const invalidate = () => queryClient.invalidateQueries({ queryKey: credentialsQuery.queryKey })

  const add = useMutation({
    mutationFn: () =>
      api('/api/v1/credentials', {
        method: 'POST',
        body: JSON.stringify({
          store,
          label: label || undefined,
          expiresAt: expiresAt ? expiresAt.toISOString() : undefined,
          credentials: fields,
        }),
      }),
    onSuccess: () => {
      setFields({})
      setLabel('')
      setExpiresAt(undefined)
      setAddOpen(false)
      void invalidate()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  const verify = useMutation({
    mutationFn: (id: string) => api<{ credential: CredentialRow; reason?: string }>(`/api/v1/credentials/${id}/verify`, { method: 'POST' }),
    onSuccess: ({ credential, reason }) => {
      if (credential.status === 'active') {
        toast.success(`${credential.store} credential verified — active`)
      } else {
        toast.error(`${credential.store} credential is ${credential.status}${reason ? `: ${reason}` : ''}`)
      }
      void invalidate()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/credentials/${id}`, { method: 'DELETE' }),
    onSuccess: () => void invalidate(),
    onError: (err) => toast.error(errorMessage(err)),
  })

  // Same id, fresh secret — any publish target pointing at it keeps working
  // with nothing to re-link, which is the whole point over delete-and-recreate.
  const rotate = useMutation({
    mutationFn: ({ id, credentials, expiresAt }: { id: string; credentials: Record<string, string>; expiresAt?: Date }) =>
      api(`/api/v1/credentials/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ credentials, expiresAt: expiresAt ? expiresAt.toISOString() : undefined }),
      }),
    onSuccess: () => {
      setRotatingId(null)
      setRotateFields({})
      setRotateExpiresAt(undefined)
      void invalidate()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  const rotatingRow = rows.find((r) => r.id === rotatingId)

  return (
    <Card>
      <CardHeader>
        <CardTitle id="store-credentials">Store credentials</CardTitle>
        <CardDescription>
          Verified against the live store API before saving, then envelope-encrypted — only the last four characters
          are ever shown again.
        </CardDescription>
        <CardAction>
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm">
                <Plus /> <span className="hidden sm:inline">Add credential</span>
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add credential</DialogTitle>
              </DialogHeader>
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  add.mutate()
                }}
              >
                <Select
                  value={store}
                  onValueChange={(value: string) => {
                    setStore(value as CredentialRow['store'])
                    setFields({})
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(STORE_OPTION_LABEL) as CredentialRow['store'][]).map((s) => (
                      <SelectItem key={s} value={s}>
                        {STORE_OPTION_LABEL[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional)" />
                <CredentialFieldInputs store={store} fields={fields} onChange={setFields} />
                {store === 'edge' && (
                  <div className="grid gap-1.5">
                    <Label htmlFor="expiry" className="text-xs text-muted-foreground">
                      API key expiry (rotates every ~72 days)
                    </Label>
                    <DatePicker id="expiry" value={expiresAt} onChange={setExpiresAt} />
                  </div>
                )}
                <Button type="submit" disabled={add.isPending} className="justify-self-start">
                  {add.isPending && <Loader2 className="animate-spin" />}
                  {add.isPending ? 'Verifying…' : 'Verify & save'}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-6">
        {rows.length > 0 && (
          <Table>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.store}</TableCell>
                  <TableCell>{row.label}</TableCell>
                  <TableCell>
                    <code className="text-xs">…{row.hint}</code>
                  </TableCell>
                  <TableCell className={`font-semibold ${CREDENTIAL_STATUS_CLASS[row.status]}`}>{row.status}</TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.store} credential`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          disabled={verify.isPending && verify.variables === row.id}
                          onSelect={() => verify.mutate(row.id)}
                        >
                          Verify
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => {
                            setRotateFields({})
                            setRotateExpiresAt(undefined)
                            setRotatingId(row.id)
                          }}
                        >
                          Rotate…
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          disabled={remove.isPending && remove.variables === row.id}
                          onSelect={() => remove.mutate(row.id)}
                        >
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {rows.length === 0 && <p className="text-sm text-muted-foreground">No credentials yet.</p>}
      </CardContent>

      <Dialog open={rotatingId !== null} onOpenChange={(open: boolean) => !open && setRotatingId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Rotate {rotatingRow && (rotatingRow.label || `${STORE_OPTION_LABEL[rotatingRow.store]} …${rotatingRow.hint}`)}
            </DialogTitle>
          </DialogHeader>
          {rotatingRow && (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault()
                rotate.mutate({ id: rotatingRow.id, credentials: rotateFields, expiresAt: rotateExpiresAt })
              }}
            >
              <p className="text-xs text-muted-foreground">
                New {STORE_OPTION_LABEL[rotatingRow.store]} credentials — verified the same way as adding one, kept under
                the same id so nothing referencing it needs to change.
              </p>
              <CredentialFieldInputs store={rotatingRow.store} fields={rotateFields} onChange={setRotateFields} />
              {rotatingRow.store === 'edge' && (
                <div className="grid gap-1.5">
                  <Label htmlFor="rotate-expiry" className="text-xs text-muted-foreground">
                    New API key expiry (rotates every ~72 days)
                  </Label>
                  <DatePicker id="rotate-expiry" value={rotateExpiresAt} onChange={setRotateExpiresAt} />
                </div>
              )}
              <Button type="submit" disabled={rotate.isPending} className="justify-self-start">
                {rotate.isPending && <Loader2 className="animate-spin" />}
                {rotate.isPending ? 'Verifying…' : 'Verify & rotate'}
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function PaymentCredentialsSection() {
  const queryClient = useQueryClient()
  const { data: credentials = [] } = useQuery(paymentCredentialsQuery)
  const stripe = credentials.find((c) => c.provider === 'stripe')
  const [secret, setSecret] = useState('')
  const [editing, setEditing] = useState(false)

  const save = useMutation({
    mutationFn: (webhookSecret: string) =>
      api('/api/v1/payment-credentials', {
        method: 'POST',
        body: JSON.stringify({ provider: 'stripe', webhookSecret }),
      }),
    onSuccess: () => {
      setSecret('')
      setEditing(false)
      void queryClient.invalidateQueries({ queryKey: paymentCredentialsQuery.queryKey })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle id="payment-credentials">Payment credentials</CardTitle>
        <CardDescription>
          Your Stripe webhook signing secret (whsec_…) — used only to verify licensing fulfillment webhooks. The
          secret itself is write-only and never shown again.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {stripe && !editing ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border px-3 py-2 text-sm">
            <span className="font-medium">stripe</span>
            <code className="text-muted-foreground">whsec_…{stripe.hint}</code>
            <div className="ml-auto flex items-center gap-3">
              <span className="text-xs whitespace-nowrap text-muted-foreground">
                updated {formatDate(stripe.updatedAt)}
              </span>
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                Replace
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (secret.trim()) save.mutate(secret.trim())
            }}
          >
            <Input
              type="password"
              placeholder="whsec_…"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              autoComplete="off"
            />
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <Loader2 className="animate-spin" />}
              {stripe ? 'Replace secret' : 'Save secret'}
            </Button>
            {stripe && (
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </form>
        )}
        <p className="text-xs text-muted-foreground">
          Found on your Stripe webhook endpoint's page (Developers → Webhooks → your endpoint → Signing secret). Test
          and live mode have separate secrets — store whichever mode your sales currently run in.
        </p>
        <WebhookUrlRow />
      </CardContent>
    </Card>
  )
}

// The webhook URL embeds the tenant id, which has no other UI surface —
// this row is what the docs point at when Stripe asks for an endpoint.
function WebhookUrlRow() {
  const { data: me } = useQuery(meQuery)
  if (!me) return null
  const url = `https://api.extport.dev/api/v1/licensing/webhooks/stripe/${me.tenant.id}`
  return (
    <div className="space-y-1">
      <Label className="text-xs">Webhook endpoint URL (paste into Stripe)</Label>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded-md border bg-muted px-3 py-2 text-xs">{url}</code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(url)
            toast.success('Copied')
          }}
        >
          Copy
        </Button>
      </div>
    </div>
  )
}

function SettingsPage() {
  // Each section fetches its own data independently, so the page's real
  // height isn't known until all three have loaded — a same-page #anchor
  // link (e.g. from the docs) lands wherever the still-loading skeletons
  // happened to put it, then the browser never re-scrolls once the real
  // content pushes that section further down. Wait for the whole page's
  // fetches to settle, then do it ourselves, once.
  //
  // isFetching reads 0 on the very first render too — before any child has
  // mounted to actually start its query — so "isFetching === 0" alone
  // can't mean "settled", only "not fetching *yet*" is indistinguishable
  // from "not fetching *anymore*". hasFetchedRef disambiguates them: only
  // trust a 0 once a nonzero has been observed first.
  const isFetching = useIsFetching()
  const hasFetchedRef = useRef(false)
  const scrolledToHash = useRef(false)
  useEffect(() => {
    if (isFetching > 0) hasFetchedRef.current = true
    if (scrolledToHash.current || !hasFetchedRef.current || isFetching > 0 || !window.location.hash) return
    scrolledToHash.current = true
    document.getElementById(window.location.hash.slice(1))?.scrollIntoView()
  }, [isFetching])

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold tracking-tight">Settings</h2>
      <ApiKeysSection />
      <CredentialsSection />
      <PaymentCredentialsSection />
    </div>
  )
}
