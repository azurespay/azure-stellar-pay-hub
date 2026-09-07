'use client';

import { useEffect, useState } from 'react';
import { Badge, Card, CardContent } from '@stellar-pay/ui';
import { adminApi } from '@/lib/api';
import { formatDateTime, shortKey } from '@/lib/format';

interface AdminTx {
  id: string;
  hash: string | null;
  fromPublicKey: string | null;
  toPublicKey: string | null;
  amount: string;
  assetCode: string;
  status: string;
  kind: string;
  createdAt: string;
}

const STATUS_STYLES: Record<string, string> = {
  SUCCEEDED: 'text-emerald-400 bg-emerald-500/10',
  CONFIRMED: 'text-emerald-400 bg-emerald-500/10',
  SUBMITTED: 'text-sky-400 bg-sky-500/10',
  PENDING: 'text-amber-400 bg-amber-500/10',
  FAILED: 'text-rose-400 bg-rose-500/10',
};

export default function TransactionsPage() {
  const [transactions, setTransactions] = useState<AdminTx[]>([]);

  useEffect(() => {
    void adminApi.admin
      .transactions()
      .then((res) => setTransactions(res.data as unknown as AdminTx[]));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Transactions</h1>
        <p className="text-sm text-muted-foreground">All payments across the platform</p>
      </div>
      <Card>
        <CardContent className="p-0">
          {transactions.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">No transactions yet</p>
          ) : (
            <div className="divide-y divide-border/60">
              {transactions.map((tx) => (
                <div
                  key={tx.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-6 py-4"
                >
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-medium">
                      {tx.amount} {tx.assetCode}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {shortKey(tx.fromPublicKey ?? '')} → {shortKey(tx.toPublicKey ?? '')} ·{' '}
                      {formatDateTime(tx.createdAt)} · {tx.kind}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {tx.hash && (
                      <span className="font-mono text-xs text-muted-foreground">
                        {shortKey(tx.hash)}
                      </span>
                    )}
                    <Badge variant="outline" className={STATUS_STYLES[tx.status] ?? ''}>
                      {tx.status}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
