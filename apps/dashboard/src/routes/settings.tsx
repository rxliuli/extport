import { api, ApiError, type ApiKeyRow, type CredentialRow } from '@/api'
import { formatDate } from '@/status'
import { DatePicker } from '@/components/date-picker'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeader, Section, sectionBodyClass, sectionEmptyClass, sectionToolbarClass } from '@/components/Section'
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
import {
  credentialsQuery,
  keysQuery,
  meQuery,
  paymentCredentialsQuery,
  paymentCredentialsStatusQuery,
  tenantSettingsQuery,
} from '@/queries'
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
    mutationFn: (name: string) =>
      api<{ key: string }>('/api/v1/keys', { method: 'POST', body: JSON.stringify({ name }) }),
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
    <Section id="api-keys" title="API keys" description="Used by the CLI and CI (`EXTPORT_API_KEY`) to push artifacts.">
      <form
        className={sectionToolbarClass}
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
        <Button type="submit" size="sm" aria-label="Create API key" disabled={create.isPending}>
          <Plus /> <span className="hidden sm:inline">Create</span>
        </Button>
      </form>

      {freshKey && (
        <div className="border-b border-border/60 p-5">
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
        </div>
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
      {keys.length === 0 && <p className={sectionEmptyClass}>No API keys yet.</p>}
    </Section>
  )
}

// `rotates` marks what a routine rotation actually replaces; the rest are
// account identifiers that stay put, so the Rotate dialog keeps them (the
// API merges omitted fields from the stored credential) behind a "Change".
const CREDENTIAL_FIELDS: Record<
  CredentialRow['store'],
  { key: string; label: string; textarea?: boolean; rotates?: boolean }[]
> = {
  chrome: [
    { key: 'publisherId', label: 'Publisher ID' },
    { key: 'clientEmail', label: 'Service Account Email' },
    { key: 'privateKey', label: 'Service Account Private Key', textarea: true, rotates: true },
  ],
  firefox: [
    { key: 'jwtIssuer', label: 'JWT Issuer', rotates: true },
    { key: 'jwtSecret', label: 'JWT Secret', rotates: true },
  ],
  edge: [
    { key: 'clientId', label: 'Client ID' },
    { key: 'apiKey', label: 'API Key', rotates: true },
  ],
  safari: [
    // Issuer ID first: it's account-wide and sits above the key list in App
    // Store Connect; Key ID and .p8 are a pair that always rotate together.
    { key: 'issuerId', label: 'Issuer ID' },
    { key: 'keyId', label: 'Key ID', rotates: true },
    { key: 'privateKeyP8', label: '.p8 Private Key', textarea: true, rotates: true },
  ],
}

/** Edge Partner Center API keys expire exactly 72 days after creation — prefilled so the tenant only confirms. */
function defaultEdgeExpiry(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 72)
  return d
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

// Shared by the "Add credential" form and the "Rotate" dialog. Rotating
// only asks for the fields that actually rotate; the stable identifiers are
// kept server-side unless the tenant explicitly opens them up to change.
function CredentialFieldInputs({
  store,
  fields,
  onChange,
  rotating = false,
}: {
  store: CredentialRow['store']
  fields: Record<string, string>
  onChange: (fields: Record<string, string>) => void
  rotating?: boolean
}) {
  const [unlocked, setUnlocked] = useState<string[]>([])
  return (
    <>
      <p className="text-sm text-muted-foreground">
        <a
          href={`https://docs.extport.dev/stores/${store}/`}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-4 hover:text-foreground"
        >
          How to get these credentials
        </a>
      </p>
      {CREDENTIAL_FIELDS[store].map((f) => {
        const kept = rotating && !f.rotates
        if (kept && !unlocked.includes(f.key)) {
          return (
            <div key={f.key} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">
                {f.label} <span className="text-foreground">· keeps current value</span>
              </span>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0"
                onClick={() => setUnlocked([...unlocked, f.key])}
              >
                Change
              </Button>
            </div>
          )
        }
        const props = {
          placeholder: kept ? `${f.label} (empty keeps current)` : f.label,
          value: fields[f.key] ?? '',
          required: !kept,
          'data-rotates': rotating && f.rotates ? '' : undefined,
        }
        return f.textarea ? (
          <Textarea
            key={f.key}
            rows={5}
            {...props}
            onChange={(e) => onChange({ ...fields, [f.key]: e.target.value })}
          />
        ) : (
          <Input key={f.key} {...props} onChange={(e) => onChange({ ...fields, [f.key]: e.target.value })} />
        )
      })}
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
      setExpiresAt(store === 'edge' ? defaultEdgeExpiry() : undefined)
      setAddOpen(false)
      void invalidate()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  const verify = useMutation({
    mutationFn: (id: string) =>
      api<{ credential: CredentialRow; reason?: string }>(`/api/v1/credentials/${id}/verify`, { method: 'POST' }),
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
    mutationFn: ({
      id,
      credentials,
      expiresAt,
    }: {
      id: string
      credentials: Record<string, string>
      expiresAt?: Date
    }) =>
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
    <Section
      id="store-credentials"
      title="Store credentials"
      description="Verified against the live store API before saving, then envelope-encrypted — only the last four characters are ever shown again."
      action={
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm" aria-label="Add credential">
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
                  setExpiresAt(value === 'edge' ? defaultEdgeExpiry() : undefined)
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
                    API key expiry (keys expire 72 days after creation)
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
      }
    >
      {rows.length > 0 && (
        <Table>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-medium">{STORE_OPTION_LABEL[row.store]}</TableCell>
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
                          setRotateExpiresAt(row.store === 'edge' ? defaultEdgeExpiry() : undefined)
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
      {rows.length === 0 && <p className={sectionEmptyClass}>No credentials yet.</p>}

      <Dialog open={rotatingId !== null} onOpenChange={(open: boolean) => !open && setRotatingId(null)}>
        <DialogContent
          // Radix would focus the first tabbable — a kept field's "Change" — instead of what's being rotated.
          onOpenAutoFocus={(e: Event) => {
            const field = (e.currentTarget as HTMLElement).querySelector<HTMLElement>('[data-rotates]')
            if (field) {
              e.preventDefault()
              field.focus()
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>
              Rotate{' '}
              {rotatingRow && (rotatingRow.label || `${STORE_OPTION_LABEL[rotatingRow.store]} …${rotatingRow.hint}`)}
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
                New {STORE_OPTION_LABEL[rotatingRow.store]} credentials — verified the same way as adding one, kept
                under the same id so nothing referencing it needs to change. Fields you don't fill in keep their current
                value.
              </p>
              <CredentialFieldInputs
                key={rotatingRow.id}
                store={rotatingRow.store}
                fields={rotateFields}
                onChange={setRotateFields}
                rotating
              />
              {rotatingRow.store === 'edge' && (
                <div className="grid gap-1.5">
                  <Label htmlFor="rotate-expiry" className="text-xs text-muted-foreground">
                    New API key expiry (keys expire 72 days after creation)
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
    </Section>
  )
}

const STRIPE_OAUTH_ERROR_MESSAGES: Record<string, string> = {
  cancelled: 'Stripe connection was cancelled.',
  invalid_state: 'Stripe connection expired — please try again.',
  account_in_use: 'That Stripe account is already connected to another extport workspace.',
  not_configured: 'Stripe Connect OAuth is not configured on this server.',
  oauth_failed: 'Failed to complete Stripe connection — please try again.',
}

function PaymentCredentialsSection() {
  const queryClient = useQueryClient()
  const { data } = useQuery(paymentCredentialsStatusQuery)
  const credentials = data?.credentials ?? []
  const connectEnabled = Boolean(data?.connectEnabled)
  const stripe = credentials.find((c) => c.provider === 'stripe')
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)

  const connectedAccountId = stripe?.stripeAccountId ?? null

  useEffect(() => {
    const url = new URL(window.location.href)
    const connectedParam = url.searchParams.get('stripe')
    const errorParam = url.searchParams.get('stripe_error')
    if (!connectedParam && !errorParam) return
    if (connectedParam === 'connected') {
      toast.success('Stripe account connected')
      void queryClient.invalidateQueries({ queryKey: paymentCredentialsQuery.queryKey })
    } else if (errorParam) {
      toast.error(STRIPE_OAUTH_ERROR_MESSAGES[errorParam] ?? `Stripe connection failed (${errorParam})`)
    }
    url.searchParams.delete('stripe')
    url.searchParams.delete('stripe_error')
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
  }, [queryClient])

  const disconnect = useMutation({
    mutationFn: () => api('/api/v1/payment-credentials/stripe/disconnect', { method: 'POST' }),
    onSuccess: () => {
      setConfirmDisconnect(false)
      toast.success('Stripe account disconnected')
      void queryClient.invalidateQueries({ queryKey: paymentCredentialsQuery.queryKey })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  return (
    <Section
      id="payment-credentials"
      title="Stripe"
      description="Connect your Stripe account in one click — no manual API keys or webhook setup required. extport manages Products, Prices, Checkout Sessions, and Invoices on your behalf."
    >
      <div className={sectionBodyClass}>
        {connectedAccountId ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
            <Badge variant="secondary">Connected</Badge>
            <code className="text-muted-foreground">{connectedAccountId}</code>
            <div className="ml-auto flex items-center gap-3">
              <span className="text-xs whitespace-nowrap text-muted-foreground">
                updated {formatDate(stripe!.updatedAt)}
              </span>
              <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
                <AlertDialogTrigger asChild>
                  <Button type="button" variant="outline" size="sm">
                    Disconnect
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Disconnect Stripe account?</AlertDialogTitle>
                    <AlertDialogDescription>
                      New checkouts, plan price syncs, and portal subscription management will pause until you reconnect
                      a Stripe account. Existing licenses and subscriptions remain intact in Stripe.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      disabled={disconnect.isPending}
                      onClick={(e: React.MouseEvent) => {
                        e.preventDefault()
                        disconnect.mutate()
                      }}
                    >
                      {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        ) : connectEnabled ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Authorize your Standard Stripe account via OAuth2. Webhooks and API access are configured automatically.
            </p>
            <Button asChild>
              <a href="/api/v1/payment-credentials/stripe/connect">Connect with Stripe</a>
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Stripe Connect OAuth is not configured on this server yet.
          </p>
        )}
      </div>
    </Section>
  )
}

// Where buyers go for help: shown on each purchase in the buyer portal and
// in the activation-code email. Unset = no link at all.
function BuyerSupportSection() {
  const queryClient = useQueryClient()
  const { data: settings } = useQuery(tenantSettingsQuery)
  const saved = settings?.supportUrl ?? ''
  const [value, setValue] = useState<string | null>(null)
  const current = value ?? saved

  const save = useMutation({
    mutationFn: (supportUrl: string) =>
      api('/api/v1/tenant/settings', { method: 'PATCH', body: JSON.stringify({ supportUrl: supportUrl || null }) }),
    onSuccess: async (_data, supportUrl) => {
      await queryClient.invalidateQueries({ queryKey: tenantSettingsQuery.queryKey })
      setValue(null)
      toast.success(supportUrl ? 'Support link saved' : 'Support link removed')
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  return (
    <Section
      id="buyer-support"
      title="Buyer support"
      description="Where your buyers go for help — linked from every purchase in the buyer portal and from the activation-code email."
    >
      <div className={`space-y-2 ${sectionBodyClass}`}>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate(current.trim())
          }}
        >
          <Input
            type="text"
            inputMode="url"
            placeholder="https://example.com/support or mailto:help@example.com"
            value={current}
            onChange={(e) => setValue(e.target.value)}
            aria-label="Support link"
          />
          <Button type="submit" disabled={save.isPending || current.trim() === saved}>
            {save.isPending && <Loader2 className="animate-spin" />}
            Save
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          A support page or a mailto: address. Leave empty to show no link — extport never falls back to your account
          email.
        </p>
      </div>
    </Section>
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
    <div className="space-y-8">
      <PageHeader title="Settings" />
      <ApiKeysSection />
      <CredentialsSection />
      <PaymentCredentialsSection />
      <BuyerSupportSection />
    </div>
  )
}
