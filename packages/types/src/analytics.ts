export type AnalyticsEventName =
  | 'payment.created'
  | 'payment.succeeded'
  | 'payment.failed'
  | 'invoice.created'
  | 'invoice.paid'
  | 'merchant.onboarded'
  | 'wallet.connected'
  | 'app.page_viewed';

export interface AnalyticsEvent {
  name: AnalyticsEventName;
  userId?: string;
  merchantId?: string;
  properties: Record<string, unknown>;
  timestamp: string;
}

/** Dashboard metrics (aggregated server-side). */
export interface DashboardMetrics {
  dailyVolume: string;
  monthlyVolume: string;
  activeUsers: number;
  activeMerchants: number;
  revenue: string;
  /** Percentage (0-100) of successful transactions; null when there is no data yet. */
  paymentSuccessRate: number | null;
  failedTransactions: number;
  assetUsage: Record<string, string>;
  topMerchants: Array<{ merchantId: string; name: string; volume: string }>;
  crossBorder: {
    volume: string;
    transactions: number;
    countries: number;
  };
}

export interface VolumePoint {
  date: string;
  volume: string;
  transactions: number;
}
