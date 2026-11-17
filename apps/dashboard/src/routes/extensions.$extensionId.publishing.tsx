import { timelineQuery } from '@/queries'
import { StoreStatusSection } from '@/StoreStatus'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { TargetsSection, VersionMatrixSection } from './extensions.$extensionId'

export const Route = createFileRoute('/extensions/$extensionId/publishing')({ component: PublishingPage })

// Order follows the questions a visit usually answers: where does each store
// stand right now → how did recent versions roll out → (rarely) which listing
// IDs and credentials are wired up.
function PublishingPage() {
  const { extensionId } = Route.useParams()
  // Same query VersionMatrixSection already makes — React Query dedupes by
  // key, so this doesn't add a request. Used only to hide the CI onboarding
  // hint once there's proof the tenant already knows how to push.
  const { data: timeline } = useQuery(timelineQuery(extensionId))
  // Only once the timeline has loaded — while it's in flight, "no versions"
  // just means "not fetched yet", and the hint would flash for every tenant.
  const neverPushed = timeline !== undefined && timeline.versions.length === 0

  return (
    <div className="space-y-8">
      <StoreStatusSection extensionId={extensionId} />
      {neverPushed && (
        <p className="text-sm text-muted-foreground">
          Haven't pushed a build yet?{' '}
          <a
            href="https://docs.extport.dev/getting-started/"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-4 hover:text-foreground"
          >
            See the getting-started guide
          </a>
          .
        </p>
      )}
      <VersionMatrixSection extensionId={extensionId} />
      <TargetsSection extensionId={extensionId} />
    </div>
  )
}
