'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Boxes, CheckCircle2, XCircle } from 'lucide-react';
import { Badge, Card, CardContent, Skeleton } from '@stellar-pay/ui';
import { explorerApi } from '@/lib/api';
import { formatDateTime, shortKey } from '@/lib/format';

interface TxRow {
  id: string;
  hash: string | null;
  fromPublicKey: string | null;
  toPublicKey: string | null;
  amount: string;
  assetCode: string;
  status: string;
  createdAt: string;
}

export default function ExplorerHome() {
  const [transactions, setTransactions] = useState<TxRow[]>([]);
  const [stats, setStats] = useState<{
    transactions: number;
    succeeded: number;
    failed: number;
    successRate: number | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void Promise.all([
      explorerApi.request<{ data: TxRow[] }>({ path: '/transactions' }),
      explorerApi.request<{
        transactions: number;
        succeeded: number;
        failed: number;
        successRate: number | null;
      }>({ path: '/transactions/stats' }),
    ])
      .then(([txs, statsData]) => {
        setTransactions(txs.data);
        setStats(statsData);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-8">
      <section className="text-center">
        <h1 className="text-4xl font-bold tracking-tight">
          StellarPay <span className="text-gradient">Explorer</span>
        </h1>
        <p className="mx-auto mt-3 max-w-lg text-muted-foreground">
          Search transactions and accounts across the platform. Data mirrors on-chain settlement
          recorded by the API.
        </p>
      </section>

      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { icon: Boxes, label: 'Transactions', value: stats?.transactions },
          { icon: CheckCircle2, label: 'Succeeded', value: stats?.succeeded },
          { icon: XCircle, label: 'Failed', value: stats?.failed },
        ].map((stat) => (
          <Card key={stat.label}>
            <CardContent className="flex items-center gap-4 p-5">
              <stat.icon className="h-5 w-5 text-indigo-400" />
              <div>
                <p className="text-2xl font-bold">
                  {stats ? (stat.value ?? '—') : <Skeleton className="h-7 w-16" />}
                </p>
                <p className="text-xs text-muted-foreground">
                  {stat.label} ·{' '}
                  {stats?.successRate == null ? 'no data yet' : `${stats.successRate}% success`}
                </p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="border-b border-border px-6 py-4 text-sm font-semibold">
            Recent transactions
          </div>
          {loading ? (
            <div className="space-y-3 p-6">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : transactions.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              No transactions recorded yet
            </p>
          ) : (
            <div className="divide-y divide-border/60">
              {transactions.map((tx) => (
                <Link
                  key={tx.id}
                  href={`/tx/${tx.id}`}
                  className="flex items-center justify-between gap-4 px-6 py-4 transition-colors hover:bg-muted/30"
                >
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-medium">
                      {shortKey(tx.hash ?? tx.id)} · {tx.amount} {tx.assetCode}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {shortKey(tx.fromPublicKey)} → {shortKey(tx.toPublicKey)} ·{' '}
                      {formatDateTime(tx.createdAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge
                      variant={
                        tx.status === 'SUCCEEDED'
                          ? 'success'
                          : tx.status === 'FAILED'
                            ? 'destructive'
                            : 'warning'
                      }
                    >
                      {tx.status}
                    </Badge>
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
