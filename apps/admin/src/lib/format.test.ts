import { formatDate, formatDateTime, shortKey } from './format';

describe('shortKey', () => {
  it('abbreviates a long key to head…tail', () => {
    const key = `G${'C'.repeat(55)}`;
    expect(shortKey(key)).toBe(`${key.slice(0, 6)}…${key.slice(-4)}`);
  });

  it('honours explicit head and tail lengths', () => {
    const key = 'A'.repeat(60);
    expect(shortKey(key, 8, 6)).toBe(`${'A'.repeat(8)}…${'A'.repeat(6)}`);
  });

  it('leaves input that already fits untouched', () => {
    expect(shortKey('GSHORT')).toBe('GSHORT');
  });

  it('tolerates the empty key an unset account renders', () => {
    expect(shortKey('')).toBe('');
  });
});

describe('date formatting', () => {
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
