'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { Badge, Card, CardContent, Skeleton } from '@stellar-pay/ui';
import { adminApi } from '@/lib/api';
import type { DashboardMetrics } from '@stellar-pay/types';

const DashboardCharts = dynamic(() => import('./_dashboard-charts'), { ssr: false });

// -- Inline SVG icons (avoid lucide-react SSR issues with Turbopack) --

function CircleDollarSign({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
      <path d="M12 18V6" />
    </svg>
  );
}

function TrendingUp({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
      <polyline points="16 7 22 7 22 13" />
    </svg>
  );
}

function WalletIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />
      <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
    </svg>
  );
}

function UsersIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function StoreIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7" />
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4" />
      <path d="M2 7h20" />
      <path d="M22 7v3a2 2 0 0 1-2 2v0a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 16 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 12 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 8 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 4 12v0a2 2 0 0 1-2-2V7" />
    </svg>
  );
}

function ShieldAlert({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </svg>
  );
}

function SparklesIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4" />
      <path d="M22 5h-4" />
      <path d="M4 17v2" />
      <path d="M5 18H3" />
    </svg>
  );
}

function Zap({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

function formatCurrency(value: string | undefined): string {
  if (!value || value === '0') return '$0.00';
  const num = Number(value);
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(2)}`;
}

function formatInt(value: number | undefined): string {
  if (value === undefined) return '\u2014';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function AnimatedCounter({ value, duration = 800 }: { value: string; duration?: number }) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    const num = Number(value);
    if (isNaN(num)) {
      setDisplay(0);
      return;
    }
    let start = 0;
    const step = Math.max(1, Math.ceil(num / (duration / 16)));
    const timer = setInterval(() => {
      start += step;
      if (start >= num) {
        setDisplay(num);
        clearInterval(timer);
      } else setDisplay(start);
    }, 16);
    return () => clearInterval(timer);
  }, [value, duration]);
  return <>{display.toLocaleString()}</>;
}

export default function OverviewPage() {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [volume, setVolume] = useState<
    Array<{ date: string; volume: string; transactions: number }>
  >([]);
  const [range, setRange] = useState<'7d' | '30d' | '90d'>('30d');
  const [loading, setLoading] = useState(true);
  const [volumeLoading, setVolumeLoading] = useState(true);

  const fetchMetrics = useCallback(() => {
    setLoading(true);
    void adminApi.admin
      .dashboard()
      .then(setMetrics)
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  const fetchVolume = useCallback((r: '7d' | '30d' | '90d') => {
    setVolumeLoading(true);
    void adminApi.admin
      .volume({ range: r })
      .then(setVolume)
      .catch(() => undefined)
      .finally(() => setVolumeLoading(false));
  }, []);

  useEffect(() => {
    fetchMetrics();
    fetchVolume(range);
  }, [fetchMetrics, fetchVolume, range]);

  const kpiCards = useMemo(
    () => [
      {
        label: 'Daily volume',
        value: metrics?.dailyVolume ?? '0',
        icon: CircleDollarSign,
        tint: 'text-indigo-400',
        bg: 'bg-indigo-500/10',
        format: (v: string) => formatCurrency(v),
      },
      {
        label: 'Monthly volume',
        value: metrics?.monthlyVolume ?? '0',
        icon: TrendingUp,
        tint: 'text-fuchsia-400',
        bg: 'bg-fuchsia-500/10',
        format: (v: string) => formatCurrency(v),
      },
      {
        label: 'Total revenue',
        value: metrics?.revenue ?? '0',
        icon: WalletIcon,
        tint: 'text-emerald-400',
        bg: 'bg-emerald-500/10',
        format: (v: string) => formatCurrency(v),
      },
      {
        label: 'Active users',
        value: String(metrics?.activeUsers ?? 0),
        icon: UsersIcon,
        tint: 'text-sky-400',
        bg: 'bg-sky-500/10',
        format: (v: string) => formatInt(Number(v)),
      },
      {
        label: 'Active merchants',
        value: String(metrics?.activeMerchants ?? 0),
        icon: StoreIcon,
        tint: 'text-amber-400',
        bg: 'bg-amber-500/10',
        format: (v: string) => formatInt(Number(v)),
      },
      {
        label: 'Failed txs',
        value: String(metrics?.failedTransactions ?? 0),
        icon: ShieldAlert,
        tint: 'text-rose-400',
        bg: 'bg-rose-500/10',
        format: (v: string) => String(Number(v)),
      },
    ],
    [metrics],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Analytics Dashboard</h1>
          <p className="text-sm text-muted-foreground">Real-time platform metrics and insights</p>
        </div>
        <div className="flex items-center gap-3">
          {metrics && metrics.paymentSuccessRate != null && (
            <Badge
              variant={metrics.paymentSuccessRate >= 95 ? 'success' : 'warning'}
              className="gap-1.5"
            >
              <Zap className="h-3 w-3" />
              {metrics.paymentSuccessRate}% success
            </Badge>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {kpiCards.map((card) => (
          <Card
            key={card.label}
            className="group relative overflow-hidden transition-all hover:-translate-y-0.5 hover:border-indigo-500/30"
          >
            <div
              className={`absolute -right-3 -top-3 h-16 w-16 rounded-full ${card.bg} blur-xl transition-transform group-hover:scale-125`}
            />
            <CardContent className="relative space-y-2 p-5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <card.icon className={`h-3.5 w-3.5 ${card.tint}`} />
                {card.label}
              </div>
              {loading ? (
                <Skeleton className="h-6 w-20" />
              ) : (
                <p className="font-mono text-lg font-bold tracking-tight">
                  {card.format(card.value)}
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <DashboardCharts
        metrics={metrics}
        volume={volume}
        range={range}
        loading={loading}
        volumeLoading={volumeLoading}
        onRangeChange={setRange}
      />

      <Card className="bg-gradient-to-r from-indigo-500/5 via-purple-500/5 to-fuchsia-500/5">
        <CardContent className="flex flex-wrap items-center justify-between gap-4 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-500/20">
              <SparklesIcon className="h-4 w-4 text-indigo-400" />
            </div>
            <div>
              <p className="text-sm font-medium">Platform is running</p>
              <p className="text-xs text-muted-foreground">
                v0.1.0 · Stellar testnet · demo data · {new Date().toLocaleDateString()}
              </p>
            </div>
          </div>
          <div className="flex gap-6">
            {loading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <>
                <div className="text-center">
                  <p className="text-xs text-muted-foreground">Total volume</p>
                  <p className="font-mono text-sm font-semibold">
                    <AnimatedCounter value={metrics?.revenue ?? '0'} />
                  </p>
                </div>
                <div className="text-center">
                  <p className="text-xs text-muted-foreground">Success</p>
                  {metrics?.paymentSuccessRate != null ? (
                    <p className="font-mono text-sm font-semibold text-emerald-400">
                      {metrics.paymentSuccessRate}%
                    </p>
                  ) : (
                    <p className="font-mono text-sm font-semibold text-muted-foreground">—</p>
                  )}
                </div>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
