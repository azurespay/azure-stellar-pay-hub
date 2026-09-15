import { TransactionStatus } from '@stellar-pay/types';
import { STATUS_STYLES, formatDate, formatDateTime, shortKey } from './format';

const ACCOUNT = `G${'A'.repeat(55)}`;

describe('shortKey', () => {
  it('abbreviates a full account key to head…tail', () => {
    expect(shortKey(ACCOUNT)).toBe(`${ACCOUNT.slice(0, 6)}…${ACCOUNT.slice(-4)}`);
  });

  it('honours explicit head and tail lengths', () => {
    expect(shortKey(ACCOUNT, 4, 2)).toBe(`${ACCOUNT.slice(0, 4)}…${ACCOUNT.slice(-2)}`);
  });

  it('leaves short input untouched', () => {
    expect(shortKey('GSHORT')).toBe('GSHORT');
  });

  it('starts abbreviating only past head + tail + 1', () => {
    const boundary = 'A'.repeat(6 + 4 + 1);
    expect(shortKey(boundary)).toBe(boundary);

    const overBoundary = 'A'.repeat(6 + 4 + 2);
    expect(shortKey(overBoundary)).toBe(`${overBoundary.slice(0, 6)}…${overBoundary.slice(-4)}`);
  });
});

describe('date formatting', () => {
  // 05:06 UTC lands on a different calendar day in some timezones, so the
  // assertions below deliberately avoid pinning an exact day.
  const iso = '2026-03-04T05:06:07.000Z';

  it('accepts an ISO string and a Date interchangeably', () => {
    expect(formatDate(iso)).toBe(formatDate(new Date(iso)));
    expect(formatDateTime(iso)).toBe(formatDateTime(new Date(iso)));
  });

  it('always renders the year on a date', () => {
    expect(formatDate(iso)).toContain('2026');
  });

  it('renders a time of day on a timestamp', () => {
    expect(formatDateTime(iso)).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe('STATUS_STYLES', () => {
  it('covers every status the API can return', () => {
    const statuses = Object.values(TransactionStatus);
    expect(statuses.length).toBeGreaterThan(0);
    for (const status of statuses) {
      expect(STATUS_STYLES[status]).toBeTruthy();
    }
  });

  it('covers the invoice and subscription states the UI renders', () => {
    for (const status of ['ACTIVE', 'PAID', 'ISSUED']) {
      expect(STATUS_STYLES[status]).toBeTruthy();
    }
  });
});
