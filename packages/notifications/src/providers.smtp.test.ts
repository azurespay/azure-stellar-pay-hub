import { describe, expect, it, jest } from '@jest/globals';
import { NotificationChannel, NotificationType } from '@stellar-pay/types';
import { SmtpChannelProvider, type NotificationMessage } from './providers';

/**
 * SMTP transport coverage.
 *
 * The email provider lazily `require`s nodemailer and only builds a transport
 * once a real (non-placeholder) host is configured, so this suite virtual-mocks
 * the module to assert the transport options and the mail envelope the provider
 * builds — without a mail dependency and without touching a network.
 *
 * `providers.test.ts` keeps the real "nodemailer is not installed" fallback
 * path. A mock registered here would make that path unreachable, so the two
 * live in separate files (each Jest file gets its own module registry).
 */
type SendMail = (options: Record<string, unknown>) => Promise<unknown>;
type CreateTransport = (options: Record<string, unknown>) => { sendMail: SendMail };

const mockSendMail = jest.fn<SendMail>(async () => ({ messageId: 'mock-message-id' }));
const mockCreateTransport = jest.fn<CreateTransport>(() => ({ sendMail: mockSendMail }));

jest.mock('nodemailer', () => ({ createTransport: mockCreateTransport }), { virtual: true });

function message(overrides: Partial<NotificationMessage> = {}): NotificationMessage {
  return {
    channel: NotificationChannel.EMAIL,
    type: NotificationType.PAYMENT_RECEIVED,
    title: 'Payment received',
    ...overrides,
  };
}

describe('SmtpChannelProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sends through a transport built from the configured options', async () => {
    const provider = new SmtpChannelProvider({
      host: 'smtp.sendgrid.net',
      port: 465,
      user: 'apikey',
      password: 'secret',
      from: 'noreply@example.com',
    });

    await provider.send(message({ to: 'user@example.com', body: 'You received 5 XLM.' }));

    expect(mockCreateTransport).toHaveBeenCalledWith({
      host: 'smtp.sendgrid.net',
      port: 465,
      secure: true,
      auth: { user: 'apikey', pass: 'secret' },
    });
    expect(mockSendMail).toHaveBeenCalledWith({
      from: 'noreply@example.com',
      to: 'user@example.com',
      subject: 'Payment received',
      text: 'You received 5 XLM.',
    });
  });

  it('uses STARTTLS and no auth on port 587 when no credentials are configured', async () => {
    const provider = new SmtpChannelProvider({
      host: 'smtp.mailgun.org',
      port: 587,
      from: 'noreply@example.com',
    });

    await provider.send(message({ to: 'user@example.com' }));

    expect(mockCreateTransport).toHaveBeenCalledWith({
      host: 'smtp.mailgun.org',
      port: 587,
      secure: false,
      auth: undefined,
    });
  });

  it('propagates a transport failure instead of reporting a delivery', async () => {
    // A non-MODULE_NOT_FOUND error is a real delivery failure: the provider
    // must rethrow so the caller's dispatchAll reports it, not swallow it.
    mockSendMail.mockRejectedValueOnce(
      Object.assign(new Error('550 mailbox unavailable'), { code: 'EENVELOPE' }),
    );
    const provider = new SmtpChannelProvider({
      host: 'smtp.sendgrid.net',
      port: 587,
      from: 'noreply@example.com',
    });

    await expect(provider.send(message({ to: 'user@example.com' }))).rejects.toThrow(
      '550 mailbox unavailable',
    );
  });

  it('never builds a transport while the host is still the placeholder', async () => {
    const provider = new SmtpChannelProvider({
      host: 'smtp.example.com',
      port: 587,
      from: 'noreply@example.com',
    });

    await expect(provider.send(message({ to: 'user@example.com' }))).resolves.toBeUndefined();
    expect(mockCreateTransport).not.toHaveBeenCalled();
  });
});
