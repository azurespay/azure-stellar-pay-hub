import { describe, expect, it, jest } from '@jest/globals';
import { NotificationChannel, NotificationType } from '@stellar-pay/types';
import {
  ConsoleChannelProvider,
  FcmPushProvider,
  SmtpChannelProvider,
  TwilioSmsProvider,
  VonageSmsProvider,
  WebhookChannelProvider,
  type NotificationMessage,
} from './providers';

type FetchArgs = Parameters<typeof fetch>;

/** A fetch stub that records its calls and returns the given status. */
function fakeFetch(status = 200) {
  const fn = jest.fn<(...args: FetchArgs) => Promise<Response>>(async () => {
    return { ok: status >= 200 && status < 300, status } as Response;
  });
  return { fn, asFetch: fn as unknown as typeof fetch };
}

function message(overrides: Partial<NotificationMessage> = {}): NotificationMessage {
  return {
    channel: NotificationChannel.EMAIL,
    type: NotificationType.PAYMENT_RECEIVED,
    title: 'Payment received',
    ...overrides,
  };
}

describe('ConsoleChannelProvider', () => {
  it('advertises the channel it was constructed with', () => {
    expect(new ConsoleChannelProvider(NotificationChannel.IN_APP).channel).toBe(
      NotificationChannel.IN_APP,
    );
  });

  it('sends without contacting anything', async () => {
    const provider = new ConsoleChannelProvider(NotificationChannel.EMAIL);

    await expect(provider.send(message({ body: 'hello' }))).resolves.toBeUndefined();
  });
});

describe('WebhookChannelProvider', () => {
  it('rejects a message with no target URL', async () => {
    const provider = new WebhookChannelProvider(undefined, fakeFetch().asFetch);

    await expect(provider.send(message({ channel: NotificationChannel.WEBHOOK }))).rejects.toThrow(
      'Webhook notifications require a target URL (message.to)',
    );
  });

  it('POSTs the documented payload shape as JSON', async () => {
    const stub = fakeFetch(200);
    const provider = new WebhookChannelProvider(undefined, stub.asFetch);

    await provider.send(
      message({
        channel: NotificationChannel.WEBHOOK,
        type: NotificationType.INVOICE_PAID,
        to: 'https://merchant.example/webhooks',
        title: 'Invoice paid',
        body: 'INV-7 was paid',
        payload: { invoiceNumber: 'INV-7' },
      }),
    );

    expect(stub.fn).toHaveBeenCalledTimes(1);
    const [url, init] = stub.fn.mock.calls[0];
    expect(url).toBe('https://merchant.example/webhooks');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');

    // `event` is the lowercased notification type; the body carries the rest.
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.event).toBe('invoice_paid');
    expect(body.title).toBe('Invoice paid');
    expect(body.body).toBe('INV-7 was paid');
    expect(body.payload).toEqual({ invoiceNumber: 'INV-7' });
    expect(typeof body.timestamp).toBe('string');
  });

  it('omits the signature header when no signer is configured', async () => {
    const stub = fakeFetch(200);
    const provider = new WebhookChannelProvider(undefined, stub.asFetch);

    await provider.send(
      message({ channel: NotificationChannel.WEBHOOK, to: 'https://merchant.example/webhooks' }),
    );

    const [, init] = stub.fn.mock.calls[0];
    expect((init?.headers as Record<string, string>)['x-stellar-pay-signature']).toBeUndefined();
  });

  it('signs the exact serialized body when a signer is configured', async () => {
    const stub = fakeFetch(200);
    const sign = jest.fn<(payload: string) => string>(() => 'sig-123');
    const provider = new WebhookChannelProvider(sign, stub.asFetch);

    await provider.send(
      message({ channel: NotificationChannel.WEBHOOK, to: 'https://merchant.example/webhooks' }),
    );

    const [, init] = stub.fn.mock.calls[0];
    // The signature must cover the bytes that are actually sent.
    expect(sign).toHaveBeenCalledWith(String(init?.body));
    expect((init?.headers as Record<string, string>)['x-stellar-pay-signature']).toBe('sig-123');
  });

  it('throws when the endpoint responds with a non-2xx status', async () => {
    const stub = fakeFetch(500);
    const provider = new WebhookChannelProvider(undefined, stub.asFetch);

    await expect(
      provider.send(
        message({ channel: NotificationChannel.WEBHOOK, to: 'https://merchant.example/webhooks' }),
      ),
    ).rejects.toThrow('Webhook delivery failed with status 500');
  });
});

describe('FcmPushProvider', () => {
  it('rejects a message with no device token', async () => {
    const provider = new FcmPushProvider('server-key', fakeFetch().asFetch);

    await expect(provider.send(message({ channel: NotificationChannel.PUSH }))).rejects.toThrow(
      'Push notifications require a device token (message.to)',
    );
  });

  it('POSTs the device payload with the server key and serialized data', async () => {
    const stub = fakeFetch(200);
    const provider = new FcmPushProvider('server-key', stub.asFetch);

    await provider.send(
      message({
        channel: NotificationChannel.PUSH,
        to: 'device-token-1',
        title: 'Invoice paid',
        body: 'INV-7 was paid',
        payload: { invoiceNumber: 'INV-7' },
      }),
    );

    const [url, init] = stub.fn.mock.calls[0];
    expect(url).toBe('https://fcm.googleapis.com/fcm/send');
    expect((init?.headers as Record<string, string>).Authorization).toBe('key=server-key');

    const body = JSON.parse(String(init?.body)) as {
      to: string;
      notification: { title: string; body: string };
      data: { type: string; payload: string };
    };
    expect(body.to).toBe('device-token-1');
    expect(body.notification).toEqual({ title: 'Invoice paid', body: 'INV-7 was paid' });
    expect(body.data.type).toBe(NotificationType.PAYMENT_RECEIVED);
    expect(body.data.payload).toBe('{"invoiceNumber":"INV-7"}');
  });

  it('throws when FCM responds with a non-2xx status', async () => {
    const provider = new FcmPushProvider('server-key', fakeFetch(401).asFetch);

    await expect(
      provider.send(message({ channel: NotificationChannel.PUSH, to: 'device-token-1' })),
    ).rejects.toThrow('FCM push failed with status 401');
  });
});

describe('SmtpChannelProvider', () => {
  it('logs instead of sending while the host is the placeholder', async () => {
    const provider = new SmtpChannelProvider({
      host: 'smtp.example.com',
      port: 587,
      from: 'noreply@example.com',
    });

    await expect(provider.send(message({ to: 'user@example.com' }))).resolves.toBeUndefined();
  });

  it('degrades gracefully when nodemailer is not installed', async () => {
    // The package intentionally ships no mail dependency: without it the
    // provider logs a fallback rather than failing the caller's dispatch.
    const provider = new SmtpChannelProvider({
      host: 'smtp.sendgrid.net',
      port: 587,
      user: 'apikey',
      password: 'secret',
      from: 'noreply@example.com',
    });

    await expect(provider.send(message({ to: 'user@example.com' }))).resolves.toBeUndefined();
  });
});

describe('SMS providers', () => {
  it('require a destination number', async () => {
    const twilio = new TwilioSmsProvider({
      accountSid: 'sid',
      authToken: 'token',
      fromNumber: '+15550000000',
    });
    const vonage = new VonageSmsProvider({
      apiKey: 'key',
      apiSecret: 'secret',
      fromNumber: 'StellarPay',
    });

    await expect(twilio.send(message({ channel: NotificationChannel.SMS }))).rejects.toThrow(
      'SMS notifications require a phone number (message.to)',
    );
    await expect(vonage.send(message({ channel: NotificationChannel.SMS }))).rejects.toThrow(
      'SMS notifications require a phone number (message.to)',
    );
  });

  it('degrade gracefully when the vendor SDK is not installed', async () => {
    const twilio = new TwilioSmsProvider({
      accountSid: 'sid',
      authToken: 'token',
      fromNumber: '+15550000000',
    });

    await expect(
      twilio.send(message({ channel: NotificationChannel.SMS, to: '+15551111111' })),
    ).resolves.toBeUndefined();
  });
});
