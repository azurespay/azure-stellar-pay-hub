import { formatDateTime, shortKey } from './format';

describe('shortKey', () => {
  it('abbreviates with the explorer defaults (8…6)', () => {
    const key = 'G'.repeat(56);
    expect(shortKey(key)).toBe(`${'G'.repeat(8)}…${'G'.repeat(6)}`);
  });

  it('honours explicit head and tail lengths', () => {
    const key = 'A'.repeat(40);
    expect(shortKey(key, 4, 2)).toBe(`${'A'.repeat(4)}…${'A'.repeat(2)}`);
  });

  it('renders an em dash when the value is missing', () => {
    expect(shortKey(null)).toBe('—');
    expect(shortKey(undefined)).toBe('—');
  });

  it('leaves input that already fits untouched', () => {
    expect(shortKey('GSHORT')).toBe('GSHORT');
  });

  it('starts abbreviating only past head + tail + 1', () => {
    const boundary = 'A'.repeat(8 + 6 + 1);
    expect(shortKey(boundary)).toBe(boundary);
    expect(shortKey('A'.repeat(8 + 6 + 2))).toContain('…');
  });
});

describe('formatDateTime', () => {
  const iso = '2026-03-04T05:06:07.000Z';

  it('accepts an ISO string and a Date interchangeably', () => {
    expect(formatDateTime(iso)).toBe(formatDateTime(new Date(iso)));
  });

  it('renders a time of day', () => {
    expect(formatDateTime(iso)).toMatch(/\d{1,2}:\d{2}/);
  });
});
