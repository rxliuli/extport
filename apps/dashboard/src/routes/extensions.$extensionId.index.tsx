import { createFileRoute, redirect } from '@tanstack/react-router'

// /extensions/:id has no content of its own — Publishing is the default half.
export const Route = createFileRoute('/extensions/$extensionId/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/extensions/$extensionId/publishing', params, replace: true })
  },
})
