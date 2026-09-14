import { describe, expect, it } from '@jest/globals';
import { NotificationChannel, NotificationType } from '@stellar-pay/types';
import type { ChannelProvider, NotificationMessage } from './providers';
import { NotificationService } from './service';

/** Provider that records the messages it is handed. */
function recordingProvider(channel: NotificationChannel): ChannelProvider & {
  sent: NotificationMessage[];
} {
  const sent: NotificationMessage[] = [];
  return {
    channel,
    sent,
    async send(message) {
      sent.push(message);
    },
  };
}

function baseMessage(overrides: Partial<NotificationMessage> = {}): NotificationMessage {
  return {
    channel: NotificationChannel.EMAIL,
    type: NotificationType.PAYMENT_RECEIVED,
    title: 'original title',
    ...overrides,
  };
}

describe('NotificationService.dispatch', () => {
  it('routes a message to the provider for its channel only', async () => {
    const email = recordingProvider(NotificationChannel.EMAIL);
    const sms = recordingProvider(NotificationChannel.SMS);
    const service = new NotificationService().addProvider(email).addProvider(sms);

    await service.dispatch(baseMessage());

    expect(email.sent).toHaveLength(1);
    expect(sms.sent).toHaveLength(0);
  });

  it('resolves silently when no provider is registered for the channel', async () => {
    const service = new NotificationService();

    await expect(service.dispatch(baseMessage())).resolves.toBeUndefined();
  });

  it('fills in the default title and body for the message type', async () => {
    const email = recordingProvider(NotificationChannel.EMAIL);
    const service = new NotificationService().addProvider(email);

    await service.dispatch(
      baseMessage({
        payload: { amount: '25.5', assetCode: 'USDC' },
      }),
    );

    expect(email.sent[0].title).toBe('Payment received');
    expect(email.sent[0].body).toBe('You received 25.5 USDC.');
  });

  it('renders the invoice and failure bodies from the payload', async () => {
    const email = recordingProvider(NotificationChannel.EMAIL);
    const service = new NotificationService().addProvider(email);

    await service.dispatch(
      baseMessage({
        type: NotificationType.INVOICE_PAID,
        payload: { invoiceNumber: 'INV-7' },
      }),
    );
    expect(email.sent[0].body).toBe('Invoice INV-7 was paid.');

    await service.dispatch(
      baseMessage({
        type: NotificationType.FAILED_TRANSACTION,
        payload: { reason: 'insufficient funds' },
      }),
    );
    expect(email.sent[1].body).toBe('insufficient funds');
  });

  it('falls back to a generic failure reason when the payload omits one', async () => {
    const email = recordingProvider(NotificationChannel.EMAIL);
    const service = new NotificationService().addProvider(email);

    await service.dispatch(baseMessage({ type: NotificationType.FAILED_TRANSACTION }));

    expect(email.sent[0].body).toBe('Your transaction could not be completed.');
  });

  it('lets a registered template override the defaults', async () => {
    const email = recordingProvider(NotificationChannel.EMAIL);
    const service = new NotificationService()
      .addProvider(email)
      .setTemplate(NotificationType.PAYMENT_RECEIVED, {
        title: (m) => `Custom for ${m.userId}`,
        body: () => 'Custom body',
      });

    await service.dispatch(baseMessage({ userId: 'user-1' }));

    expect(email.sent[0].title).toBe('Custom for user-1');
    expect(email.sent[0].body).toBe('Custom body');
  });

  it('keeps the original title and body for a type with no default', async () => {
    const email = recordingProvider(NotificationChannel.EMAIL);
    const service = new NotificationService().addProvider(email);

    // Cast: the platform's union has defaults for every member today, so this
    // asserts the defensive branch rather than a reachable state.
    await service.dispatch(
      baseMessage({
        type: 'SOMETHING_ELSE' as NotificationType,
        title: 'kept title',
        body: 'kept body',
      }),
    );

    expect(email.sent[0].title).toBe('kept title');
    expect(email.sent[0].body).toBe('kept body');
  });
});

describe('NotificationService.dispatchAll', () => {
  it('reports per-message success and failure instead of throwing', async () => {
    const failing: ChannelProvider = {
      channel: NotificationChannel.EMAIL,
      async send() {
        throw new Error('smtp down');
      },
    };
    const service = new NotificationService().addProvider(failing);

    const results = await service.dispatchAll([
      baseMessage(),
      baseMessage({ channel: NotificationChannel.WEBHOOK }),
    ]);

    expect(results).toEqual([{ ok: false, error: 'smtp down' }, { ok: true }]);
  });

  it('dispatches every message when each channel has a provider', async () => {
    const email = recordingProvider(NotificationChannel.EMAIL);
    const sms = recordingProvider(NotificationChannel.SMS);
    const service = new NotificationService().addProvider(email).addProvider(sms);

    const results = await service.dispatchAll([
      baseMessage(),
      baseMessage({ channel: NotificationChannel.SMS, type: NotificationType.ACCOUNT_ACTIVITY }),
    ]);

    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(email.sent).toHaveLength(1);
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0].title).toBe('Account activity');
  });
});
