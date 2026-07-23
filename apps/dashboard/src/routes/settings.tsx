import { api, ApiError, type ApiKeyRow, type CredentialRow } from '@/api'
import { DatePicker } from '@/components/date-picker'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { credentialsQuery, keysQuery } from '@/queries'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { KeyRound, Loader2, Plus } from 'lucide-react'
import { Fragment, useState } from 'react'
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
        <CardTitle>API keys</CardTitle>
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
            className="h-8 w-56"
            required
          />
          <Button type="submit" size="sm" disabled={create.isPending}>
            <Plus /> Create
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
  const [store, setStore] = useState<CredentialRow['store']>('chrome')
  const [label, setLabel] = useState('')
  const [expiresAt, setExpiresAt] = useState<Date | undefined>(undefined)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [rotatingId, setRotatingId] = useState<string | null>(null)
  const [rotateFields, setRotateFields] = useState<Record<string, string>>({})

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
    mutationFn: ({ id, credentials }: { id: string; credentials: Record<string, string> }) =>
      api(`/api/v1/credentials/${id}`, { method: 'PATCH', body: JSON.stringify({ credentials }) }),
    onSuccess: () => {
      setRotatingId(null)
      setRotateFields({})
      void invalidate()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Store credentials</CardTitle>
        <CardDescription>
          Verified against the live store API before saving, then envelope-encrypted — only the last four characters are
          ever shown again.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {rows.length > 0 && (
          <Table>
            <TableBody>
              {rows.map((row) => (
                <Fragment key={row.id}>
                  <TableRow>
                    <TableCell className="font-medium">{row.store}</TableCell>
                    <TableCell>{row.label}</TableCell>
                    <TableCell>
                      <code className="text-xs">…{row.hint}</code>
                    </TableCell>
                    <TableCell className={`font-semibold ${CREDENTIAL_STATUS_CLASS[row.status]}`}>{row.status}</TableCell>
                    <TableCell className="space-x-2 text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => verify.mutate(row.id)}
                        disabled={verify.isPending && verify.variables === row.id}
                      >
                        Verify
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setRotateFields({})
                          setRotatingId(rotatingId === row.id ? null : row.id)
                        }}
                      >
                        Rotate
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => remove.mutate(row.id)}
                        disabled={remove.isPending && remove.variables === row.id}
                      >
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                  {rotatingId === row.id && (
                    <TableRow key={`${row.id}-rotate`}>
                      <TableCell colSpan={5}>
                        <form
                          className="grid max-w-md gap-3 py-2"
                          onSubmit={(e) => {
                            e.preventDefault()
                            rotate.mutate({ id: row.id, credentials: rotateFields })
                          }}
                        >
                          <p className="text-xs text-muted-foreground">
                            New {STORE_OPTION_LABEL[row.store]} credentials — verified the same way as adding one, kept under
                            the same id so nothing referencing it needs to change.
                          </p>
                          <CredentialFieldInputs store={row.store} fields={rotateFields} onChange={setRotateFields} />
                          <div className="flex gap-2">
                            <Button type="submit" size="sm" disabled={rotate.isPending}>
                              {rotate.isPending && <Loader2 className="animate-spin" />}
                              {rotate.isPending ? 'Verifying…' : 'Verify & rotate'}
                            </Button>
                            <Button type="button" variant="ghost" size="sm" onClick={() => setRotatingId(null)}>
                              Cancel
                            </Button>
                          </div>
                        </form>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        )}
        {rows.length === 0 && <p className="text-sm text-muted-foreground">No credentials yet.</p>}

        <div className="space-y-3 border-t pt-4">
          <h4 className="text-sm font-medium">Add credential</h4>
          <form
            className="grid max-w-md gap-3"
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
              <SelectTrigger>
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
        </div>
      </CardContent>
    </Card>
  )
}

function SettingsPage() {
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold tracking-tight">Settings</h2>
      <ApiKeysSection />
      <CredentialsSection />
    </div>
  )
}
