import { z } from 'zod';

/**
 * Hostnames that must never be reachable by an outbound webhook delivery.
 *
 * A merchant controls its webhook URL, and the API POSTs to it from inside the
 * deployment network — so an unrestricted URL turns webhooks into a
 * server-side request forgery primitive against the cluster network, the
 * cloud metadata endpoints (`169.254.169.254`) and any admin-only service
 * bound to localhost. These are the literal-name cases; hostnames that resolve
 * to a private address are additionally rejected at delivery time, where the
 * DNS answer is known.
 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

const BLOCKED_HOSTNAME_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.home.arpa',
  '.svc', // Kubernetes service DNS (*.svc, *.svc.cluster.local)
  '.cluster.local',
];

/** IPv4 ranges that are loopback, private, link-local, CGNAT or reserved. */
const PRIVATE_IPV4 = [
  /^0\./, // "this network"
  /^10\./, // private
  /^127\./, // loopback
  /^169\.254\./, // link-local (incl. cloud metadata 169.254.169.254)
  /^172\.(1[6-9]|2\d|3[01])\./, // private
  /^192\.168\./, // private
  /^192\.0\.0\./, // IETF protocol assignments
  /^198\.1[89]\./, // benchmarking
  /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./, // carrier-grade NAT
  /^22[4-9]\./, // multicast
  /^2[3-5]\d\./, // 230-255 reserved
];

/** Loopback (::1), unspecified (::), ULA (fc00::/7), link-local (fe80::/10). */
function isPrivateIpv6(value: string): boolean {
  const embeddedV4 = value.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (embeddedV4) {
    // IPv4-mapped/compatible form (::ffff:127.0.0.1) — judge it as IPv4.
    return isPrivateNetworkAddress(embeddedV4[1]);
  }
  if (value === '::1' || value === '::' || /^0*:0*:0*:0*:0*:0*:0*:1$/.test(value)) {
    return true;
  }
  return /^f[cd][0-9a-f]{2}:/.test(value) || /^fe[89ab][0-9a-f]:/.test(value);
}

/**
 * True when an IP literal (v4 or v6, brackets optional) or a hostname points at
 * a non-public network.
 *
 * Pure and dependency-free so it can run in the browser (form validation) and
 * in the API (both at registration and after DNS resolution).
 */
export function isPrivateNetworkAddress(hostname: string): boolean {
  let value = hostname.trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) {
    value = value.slice(1, -1);
  }
  if (!value) {
    return true; // fail closed
  }
  if (value.includes(':')) {
    return isPrivateIpv6(value);
  }
  if (PRIVATE_IPV4.some((range) => range.test(value))) {
    return true;
  }
  // A dotted-quad-shaped value that is not a valid address is not "private",
  // it is simply unusable — let the resolver reject it later.
  return false;
}

/**
 * A webhook endpoint URL: absolute http(s), a public (multi-label) hostname,
 * and no credentials embedded in the URL.
 */
export const webhookUrlSchema = z
  .string()
  .url('Webhook URL must be a valid absolute URL')
  .superRefine((raw, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Webhook URL must be a valid URL' });
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Webhook URL must use http:// or https://',
      });
    }
    if (parsed.username || parsed.password) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Webhook URL must not embed credentials',
      });
    }
    const hostname = parsed.hostname.toLowerCase();
    if (
      BLOCKED_HOSTNAMES.has(hostname) ||
      BLOCKED_HOSTNAME_SUFFIXES.some((s) => hostname.endsWith(s))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Webhook URL must point at a publicly reachable host',
      });
      return;
    }
    if (isPrivateNetworkAddress(hostname)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Webhook URL must not target a private or loopback address',
      });
      return;
    }
    // Single-label hostnames resolve through the pod's search domains
    // (cluster-internal services), so they are never a valid merchant endpoint.
    if (!hostname.includes('.') && !hostname.includes(':')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Webhook URL must use a fully-qualified domain name',
      });
    }
  });

export const registerWebhookSchema = z
  .object({
    url: webhookUrlSchema,
    events: z
      .array(
        z.enum([
          'payment.received',
          'payment.failed',
          'invoice.paid',
          'settlement.completed',
          'customer.created',
        ]),
      )
      .min(1),
    secret: z.string().min(16).optional(),
  })
  .strict();

export type RegisterWebhook = z.infer<typeof registerWebhookSchema>;

export const notificationPrefsSchema = z.object({
  email: z.boolean().optional(),
  sms: z.boolean().optional(),
  push: z.boolean().optional(),
  inApp: z.boolean().optional(),
  webhook: z.boolean().optional(),
});

export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;
