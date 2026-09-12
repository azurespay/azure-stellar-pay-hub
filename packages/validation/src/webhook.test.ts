import { describe, expect, it } from '@jest/globals';
import { isPrivateNetworkAddress, registerWebhookSchema, webhookUrlSchema } from './webhook';

describe('isPrivateNetworkAddress', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // carrier-grade NAT
    '0.0.0.0',
    '::1',
    '::',
    'fd00::1', // unique local
    'fe80::1', // link local
    '::ffff:127.0.0.1', // IPv4-mapped loopback
  ])('flags %s', (address) => {
    expect(isPrivateNetworkAddress(address)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '2606:4700::1111', 'example.com', ''])(
    'does not flag %s as private',
    (address) => {
      // '' intentionally fails closed (see the dedicated case below).
      if (address === '') {
        return;
      }
      expect(isPrivateNetworkAddress(address)).toBe(false);
    },
  );

  it('fails closed on an empty host', () => {
    expect(isPrivateNetworkAddress('')).toBe(true);
  });
});

describe('webhookUrlSchema', () => {
  it('accepts an https endpoint on a public host', () => {
    expect(webhookUrlSchema.safeParse('https://example.com/hooks/payments').success).toBe(true);
  });

  it.each([
    'http://localhost:4000/hook',
    'http://127.0.0.1/hook',
    'https://169.254.169.254/latest/meta-data',
    'https://10.1.2.3/hook',
    'https://[::1]/hook',
    'https://kubernetes.default.svc/hook',
    'https://payments.internal/hook',
    'https://redis:6379/hook',
    'file:///etc/passwd',
    'ftp://example.com/hook',
    'https://user:pass@example.com/hook',
  ])('rejects %s', (url) => {
    expect(webhookUrlSchema.safeParse(url).success).toBe(false);
  });

  it('is wired into the register-webhook payload schema', () => {
    const result = registerWebhookSchema.safeParse({
      url: 'http://127.0.0.1:4000/hook',
      events: ['payment.received'],
    });
    expect(result.success).toBe(false);
  });
});
