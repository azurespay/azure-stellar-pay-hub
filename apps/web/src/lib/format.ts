/** Shorten a Stellar public key for display. */
export function shortKey(publicKey: string, head = 6, tail = 4): string {
  if (publicKey.length <= head + tail + 1) {
    return publicKey;
  }
  return `${publicKey.slice(0, head)}…${publicKey.slice(-tail)}`;
}

/** Format a date string/Date for display. */
export function formatDate(input: string | Date): string {
  const date = typeof input === 'string' ? new Date(input) : input;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatDateTime(input: string | Date): string {
  const date = typeof input === 'string' ? new Date(input) : input;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const STATUS_STYLES: Record<string, string> = {
  SUCCEEDED: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  // Contract-route settlement confirmed on-chain by the indexer.
  CONFIRMED: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  PENDING: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  SUBMITTED: 'text-sky-400 bg-sky-500/10 border-sky-500/20',
  FAILED: 'text-rose-400 bg-rose-500/10 border-rose-500/20',
  CANCELED: 'text-muted-foreground bg-muted border-border',
  ACTIVE: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  PAID: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  ISSUED: 'text-sky-400 bg-sky-500/10 border-sky-500/20',
};
