import { AnalyticsSection } from '@/AnalyticsSection'
import { Skeleton } from '@/components/ui/skeleton'
import { extensionQuery } from '@/queries'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/extensions/$extensionId/analytics')({ component: AnalyticsPage })

function AnalyticsPage() {
  const { extensionId } = Route.useParams()
  const { data: extension } = useQuery(extensionQuery(extensionId))
  if (!extension) return <Skeleton className="h-48 w-full" />
  return <AnalyticsSection extension={extension} />
}
