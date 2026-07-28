import { LicensingSection } from '@/LicensingSection'
import { extensionQuery } from '@/queries'
import { Skeleton } from '@/components/ui/skeleton'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/extensions/$extensionId/licensing')({ component: LicensingPage })

function LicensingPage() {
  const { extensionId } = Route.useParams()
  const { data: extension } = useQuery(extensionQuery(extensionId))
  if (!extension) return <Skeleton className="h-48 w-full" />
  return <LicensingSection extension={extension} />
}
