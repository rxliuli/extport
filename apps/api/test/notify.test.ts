import { env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { createEmailNotifier } from '../src/lib/notify'

describe('createEmailNotifier', () => {
  it('sends via the EMAIL binding with the configured from address', async () => {
    const sendSpy = vi.spyOn(env.EMAIL, 'send').mockResolvedValue({ messageId: 'm1' } as never)
    const notifier = createEmailNotifier(env)

    await notifier.send({ to: 'dev@example.com', subject: 'Hello', text: 'World' })

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'dev@example.com',
        subject: 'Hello',
        text: 'World',
        from: { email: env.NOTIFICATION_FROM_EMAIL, name: 'extport' },
      }),
    )
    sendSpy.mockRestore()
  })

  it('swallows send failures — a notification must never break the reconcile tick', async () => {
    const sendSpy = vi.spyOn(env.EMAIL, 'send').mockRejectedValue(new Error('E_SENDER_NOT_VERIFIED'))
    const notifier = createEmailNotifier(env)

    await expect(notifier.send({ to: 'dev@example.com', subject: 'x', text: 'y' })).resolves.toBeUndefined()
    sendSpy.mockRestore()
  })
})
