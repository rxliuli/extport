export interface Notification {
  to: string
  subject: string
  text: string
}

/**
 * Abstracted so a Slack/Discord channel can be added later (spec §3.5)
 * without touching any call site — only this file and its construction
 * point in reconcile/run.ts would change.
 */
export interface Notifier {
  send(notification: Notification): Promise<void>
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function toHtml(text: string): string {
  return `<pre style="font:14px system-ui,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>`
}

export function createEmailNotifier(env: Env): Notifier {
  return {
    async send(notification) {
      try {
        await env.EMAIL.send({
          to: notification.to,
          from: { email: env.NOTIFICATION_FROM_EMAIL, name: 'extport' },
          subject: notification.subject,
          text: notification.text,
          html: toHtml(notification.text),
        })
      } catch (err) {
        // A notification failure must never break the reconcile tick that triggered it.
        console.error(
          JSON.stringify({
            level: 'error',
            message: 'notification send failed',
            to: notification.to,
            error: err instanceof Error ? err.message : String(err),
          }),
        )
      }
    },
  }
}
