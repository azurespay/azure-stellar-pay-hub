'use client';

import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@stellar-pay/ui';
import type { DashboardMetrics } from '@stellar-pay/types';

const ASSET_COLORS = [
  '#818cf8',
  '#c084fc',
  '#34d399',
  '#fbbf24',
  '#f472b6',
  '#38bdf8',
  '#fb923c',
  '#a78bfa',
];

const CHART_THEME = {
  grid: '#26263a',
  axis: '#9b9bb0',
  tooltip: { bg: '#16161f', border: '#26263a' },
};

const RANGE_OPTIONS = ['7d', '30d', '90d'] as const;

// -- Inline SVG icons --

function ActivityIcon({ className }: { className?: string }) {
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
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}

function PercentIcon({ className }: { className?: string }) {
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
      <line x1="19" y1="5" x2="5" y2="19" />
      <circle cx="6.5" cy="6.5" r="2.5" />
      <circle cx="17.5" cy="17.5" r="2.5" />
    </svg>
  );
}

function GlobeIcon({ className }: { className?: string }) {
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
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
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

function ArrowUpIcon({ className }: { className?: string }) {
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
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

function ArrowDownIcon({ className }: { className?: string }) {
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
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="19 12 12 19 5 12" />
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

function SuccessGauge({ rate }: { rate: number | null }) {
  const radius = 44;
  const circumference = 2 * Math.PI * radius;
  const hasData = rate != null;
  // No transactions yet — render a neutral empty gauge instead of a
  // fabricated 100% success rate.
  const offset = hasData ? circumference * (1 - rate! / 100) : circumference;
  const color = !hasData
    ? '#9b9bb0'
    : rate! >= 95
      ? '#34d399'
      : rate! >= 85
        ? '#fbbf24'
        : '#f87171';
  return (
    <div className="flex flex-col items-center">
      <div className="relative">
        <svg width={120} height={120} className="-rotate-90">
          <circle cx={60} cy={60} r={radius} stroke="#26263a" strokeWidth={8} fill="none" />
          <circle
            cx={60}
            cy={60}
            r={radius}
            stroke={color}
            strokeWidth={8}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            className="transition-all duration-1000 ease-out"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold" style={{ color }}>
            {hasData ? `${rate}%` : '—'}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {hasData ? 'success' : 'no data'}
          </span>
        </div>
      </div>
    </div>
  );
}

interface DashboardChartsProps {
  metrics: DashboardMetrics | null;
  volume: Array<{ date: string; volume: string; transactions: number }>;
  range: '7d' | '30d' | '90d';
  loading: boolean;
  volumeLoading: boolean;
  onRangeChange: (range: '7d' | '30d' | '90d') => void;
}

export default function DashboardCharts({
  metrics,
  volume,
  range,
  loading,
  volumeLoading,
  onRangeChange,
}: DashboardChartsProps) {
  const assetPieData = useMemo(() => {
    if (!metrics?.assetUsage) return [];
    return Object.entries(metrics.assetUsage)
      .map(([name, count]) => ({ name, value: Number(count) }))
      .sort((a, b) => b.value - a.value);
  }, [metrics]);

  const volumeTrend = useMemo(() => {
    if (volume.length < 2) return 0;
    const first = Number(volume[0].volume);
    const last = Number(volume[volume.length - 1].volume);
    if (first === 0) return 100;
    return Math.round(((last - first) / first) * 100);
  }, [volume]);

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <ActivityIcon className="h-4 w-4 text-indigo-400" />
              Transaction volume
            </CardTitle>
            <div className="flex items-center gap-2">
              {volume.length > 0 && (
                <span
                  className={`flex items-center gap-0.5 text-xs ${volumeTrend >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}
                >
                  {volumeTrend >= 0 ? (
                    <ArrowUpIcon className="h-3 w-3" />
                  ) : (
                    <ArrowDownIcon className="h-3 w-3" />
                  )}
                  {Math.abs(volumeTrend)}%
                </span>
              )}
              <Tabs value={range} onValueChange={(v) => onRangeChange(v as '7d' | '30d' | '90d')}>
                <TabsList className="h-7">
                  {RANGE_OPTIONS.map((r) => (
                    <TabsTrigger key={r} value={r} className="px-2.5 text-xs">
                      {r}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>
          </CardHeader>
          <CardContent>
            {volumeLoading ? (
              <Skeleton className="h-[280px] w-full rounded-xl" />
            ) : volume.length === 0 ? (
              <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
                <div className="text-center">
                  <ActivityIcon className="mx-auto mb-2 h-6 w-6 text-muted-foreground/40" />
                  No transaction data yet
                </div>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={volume} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
                  <defs>
                    <linearGradient id="volumeGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#818cf8" stopOpacity={0.5} />
                      <stop offset="100%" stopColor="#818cf8" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="countGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#34d399" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} />
                  <XAxis
                    dataKey="date"
                    stroke={CHART_THEME.axis}
                    fontSize={11}
                    tickFormatter={(v: string) => {
                      const d = new Date(v);
                      return `${d.getMonth() + 1}/${d.getDate()}`;
                    }}
                  />
                  <YAxis stroke={CHART_THEME.axis} fontSize={11} />
                  <Tooltip
                    contentStyle={{
                      background: CHART_THEME.tooltip.bg,
                      border: `1px solid ${CHART_THEME.tooltip.border}`,
                      borderRadius: 12,
                      fontSize: 13,
                    }}
                    labelStyle={{ color: '#f4f4f8', fontWeight: 600 }}
                    formatter={(val: any) => [`$${Number(val ?? 0).toLocaleString()}`, 'Volume']}
                  />
                  <Area
                    type="monotone"
                    dataKey="volume"
                    stroke="#818cf8"
                    fill="url(#volumeGrad)"
                    strokeWidth={2}
                    name="Volume"
                  />
                  <Area
                    type="monotone"
                    dataKey="transactions"
                    stroke="#34d399"
                    fill="url(#countGrad)"
                    strokeWidth={2}
                    name="Transactions"
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className="text-center">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-center gap-2 text-sm">
                <PercentIcon className="h-4 w-4 text-emerald-400" />
                Payment success rate
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col items-center pb-6">
              {loading ? (
                <Skeleton className="h-[120px] w-[120px] rounded-full" />
              ) : (
                <SuccessGauge rate={metrics?.paymentSuccessRate ?? null} />
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <GlobeIcon className="h-4 w-4 text-sky-400" />
                Cross-border
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {loading ? (
                <>
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                </>
              ) : (
                <>
                  <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2.5">
                    <span className="text-xs text-muted-foreground">Volume</span>
                    <span className="font-mono text-sm font-semibold">
                      {formatCurrency(metrics?.crossBorder.volume)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2.5">
                    <span className="text-xs text-muted-foreground">Transactions</span>
                    <span className="font-mono text-sm font-semibold">
                      {formatInt(metrics?.crossBorder.transactions)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2.5">
                    <span className="text-xs text-muted-foreground">Countries</span>
                    <span className="font-mono text-sm font-semibold">
                      {metrics?.crossBorder.countries ?? '\u2014'}
                    </span>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <SparklesIcon className="h-4 w-4 text-amber-400" />
              Asset distribution
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-[260px] w-full rounded-xl" />
            ) : assetPieData.length === 0 ? (
              <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
                No asset data available
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <ResponsiveContainer width="55%" height={220}>
                  <PieChart>
                    <Pie
                      data={assetPieData}
                      cx="50%"
                      cy="50%"
                      innerRadius={45}
                      outerRadius={85}
                      paddingAngle={3}
                      dataKey="value"
                      animationBegin={0}
                      animationDuration={800}
                    >
                      {assetPieData.map((_, i) => (
                        <Cell
                          key={i}
                          fill={ASSET_COLORS[i % ASSET_COLORS.length]}
                          stroke="transparent"
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        background: CHART_THEME.tooltip.bg,
                        border: `1px solid ${CHART_THEME.tooltip.border}`,
                        borderRadius: 12,
                        fontSize: 13,
                      }}
                      formatter={(val: any, name: any) => [
                        `${Number(val ?? 0)} txs`,
                        String(name ?? ''),
                      ]}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex-1 space-y-1.5">
                  {assetPieData.slice(0, 8).map((item, i) => (
                    <div key={item.name} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: ASSET_COLORS[i % ASSET_COLORS.length] }}
                        />
                        <span className="font-mono font-medium">{item.name}</span>
                      </div>
                      <span className="tabular-nums text-muted-foreground">{item.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <StoreIcon className="h-4 w-4 text-purple-400" />
              Top merchants
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-3">
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
              </div>
            ) : !metrics?.topMerchants?.length ? (
              <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
                No active merchants yet
              </div>
            ) : (
              <div className="space-y-1">
                {metrics.topMerchants.map((merchant, i) => (
                  <div
                    key={merchant.merchantId}
                    className="flex items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-accent/50"
                  >
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${i === 0 ? 'bg-amber-500/20 text-amber-400' : i === 1 ? 'bg-slate-400/20 text-slate-300' : i === 2 ? 'bg-orange-700/20 text-orange-400' : 'bg-muted text-muted-foreground'}`}
                    >
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{merchant.name}</p>
                      <p className="truncate font-mono text-[10px] text-muted-foreground">
                        {merchant.merchantId.slice(0, 12)}\u2026
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold tabular-nums">
                        {formatCurrency(merchant.volume)}
                      </p>
                    </div>
                    <div className="hidden w-16 sm:block">
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-700"
                          style={{ width: `${Math.max(5, 100 - i * 20 - Math.random() * 15)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
