import { infiniteQueryOptions, keepPreviousData, queryOptions } from '@tanstack/react-query'
import {
  api,
  ApiError,
  type AnalyticsOverview,
  type AnalyticsSeriesRow,
  type ApiKeyRow,
  type CredentialRow,
  type DeploymentVersion,
  type Extension,
  type FleetAnalyticsOverview,
  type FleetExtensionAnalytics,
  type LicenseRow,
  type MatrixExtension,
  type Me,
  type PaymentCredentialRow,
  type Plan,
  type PublishEvent,
  type PublishTarget,
} from './api'

export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: (): Promise<Me | null> =>
    api<Me>('/api/v1/me').catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return null
      throw err
    }),
  staleTime: 5 * 60_000,
  retry: false,
})

// Store review state changes on the stores' clock, not ours — poll gently so
// the dashboard stays current without a manual reload (the cron reconciles
// every 30 minutes; these only re-read our own DB).
const POLL_MS = 30_000

export const matrixQuery = queryOptions({
  queryKey: ['extensions', 'matrix'],
  queryFn: () => api<{ extensions: MatrixExtension[] }>('/api/v1/extensions/matrix').then((r) => r.extensions),
  refetchInterval: POLL_MS,
})

export const extensionQuery = (id: string) =>
  queryOptions({
    queryKey: ['extensions', id],
    queryFn: () => api<{ extension: Extension }>(`/api/v1/extensions/${id}`).then((r) => r.extension),
  })

export const targetsQuery = (id: string) =>
  queryOptions({
    queryKey: ['extensions', id, 'targets'],
    queryFn: () => api<{ targets: PublishTarget[] }>(`/api/v1/extensions/${id}/targets`).then((r) => r.targets),
    refetchInterval: POLL_MS,
  })

export const timelineQuery = (id: string) =>
  queryOptions({
    queryKey: ['extensions', id, 'timeline'],
    queryFn: () => api<{ versions: DeploymentVersion[]; events: PublishEvent[] }>(`/api/v1/extensions/${id}/timeline`),
    refetchInterval: POLL_MS,
  })

export const plansQuery = (extensionId: string) =>
  queryOptions({
    queryKey: ['extensions', extensionId, 'plans'],
    queryFn: () => api<{ plans: Plan[] }>(`/api/v1/plans?extension=${extensionId}`).then((r) => r.plans),
  })

export const licensesInfiniteQuery = (extensionId: string) =>
  infiniteQueryOptions({
    queryKey: ['licenses', extensionId],
    queryFn: ({ pageParam }) =>
      api<{ licenses: LicenseRow[]; nextCursor: string | null }>(
        `/api/v1/licenses?extension=${extensionId}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })

/** The cross-product license list — the support workflow's entry point. */
export const globalLicensesQuery = (search: string) =>
  infiniteQueryOptions({
    queryKey: ['licenses', 'global', search],
    queryFn: ({ pageParam }) =>
      api<{ licenses: LicenseRow[]; nextCursor: string | null }>(
        `/api/v1/licenses?${search ? `search=${encodeURIComponent(search)}&` : ''}${pageParam ? `cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // Search-as-you-type: keep the previous page on screen while the next
    // keystroke's result loads, so the table never flashes empty.
    placeholderData: keepPreviousData,
  })

export interface LicensesSummary {
  licenses: number
  active: number
  revenue: { currency: string; total: number; last30d: number }[]
}

export const licensesSummaryQuery = queryOptions({
  queryKey: ['licenses', 'summary'],
  queryFn: () => api<LicensesSummary>('/api/v1/licenses/summary'),
})

// 30 days is the CWS default too; a range picker joins once there is
// enough history to make one meaningful.
export const analyticsSeriesQuery = (extensionId: string, dim: 'total' | 'version', days = 30) =>
  queryOptions({
    queryKey: ['analytics', extensionId, dim, days],
    queryFn: () =>
      api<{ rows: AnalyticsSeriesRow[] }>(`/api/v1/analytics/series?extension=${extensionId}&dim=${dim}&days=${days}`).then(
        (r) => r.rows,
      ),
  })

export const analyticsOverviewQuery = (extensionId: string) =>
  queryOptions({
    queryKey: ['analytics', extensionId, 'overview'],
    queryFn: () => api<AnalyticsOverview>(`/api/v1/analytics/overview?extension=${extensionId}`),
  })

export const fleetAnalyticsOverviewQuery = queryOptions({
  queryKey: ['analytics', 'fleet', 'overview'],
  queryFn: () => api<FleetAnalyticsOverview>('/api/v1/analytics/fleet/overview'),
})

export const fleetAnalyticsSeriesQuery = (days = 30) =>
  queryOptions({
    queryKey: ['analytics', 'fleet', 'series', days],
    queryFn: () => api<{ rows: AnalyticsSeriesRow[] }>(`/api/v1/analytics/fleet/series?days=${days}`).then((r) => r.rows),
  })

export const fleetAnalyticsExtensionsQuery = queryOptions({
  queryKey: ['analytics', 'fleet', 'extensions'],
  queryFn: () => api<{ extensions: FleetExtensionAnalytics[] }>('/api/v1/analytics/fleet/extensions').then((r) => r.extensions),
})

export const credentialsQuery = queryOptions({
  queryKey: ['credentials'],
  queryFn: () => api<{ credentials: CredentialRow[] }>('/api/v1/credentials').then((r) => r.credentials),
})

export const paymentCredentialsQuery = queryOptions({
  queryKey: ['payment-credentials'],
  queryFn: () =>
    api<{ credentials: PaymentCredentialRow[] }>('/api/v1/payment-credentials').then((r) => r.credentials),
})

export const keysQuery = queryOptions({
  queryKey: ['keys'],
  queryFn: () => api<{ keys: ApiKeyRow[] }>('/api/v1/keys').then((r) => r.keys),
})
