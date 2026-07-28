import { timelineQuery } from '@/queries'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { TargetsSection, VersionMatrixSection } from './extensions.$extensionId'

export const Route = createFileRoute('/extensions/$extensionId/publishing')({ component: PublishingPage })

function PublishingPage() {
  const { extensionId } = Route.useParams()
  // Same query VersionMatrixSection already makes — React Query dedupes by
  // key, so this doesn't add a request. Used only to hide the CI onboarding
  // hint once there's proof the tenant already knows how to push.
  const { data: timeline } = useQuery(timelineQuery(extensionId))
  const hasPushedBefore = (timeline?.versions.length ?? 0) > 0

  return (
    <div className="space-y-6">
      <TargetsSection extensionId={extensionId} />
      {!hasPushedBefore && (
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
    </div>
  )
}
