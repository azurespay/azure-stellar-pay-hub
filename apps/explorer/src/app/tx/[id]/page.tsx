'use client';

import { use, useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Hash, Loader2 } from 'lucide-react';
import { Badge, Card, CardContent } from '@stellar-pay/ui';
import { explorerApi } from '@/lib/api';
import { formatDateTime, shortKey } from '@/lib/format';

interface TxDetail {
  id: string;
  hash: string | null;
  fromPublicKey: string | null;
  toPublicKey: string | null;
  amount: string;
  assetCode: string;
  assetIssuer: string | null;
  memo: string | null;
  memoType: string;
  status: string;
  direction: string;
  kind: string;
  fee: string | null;
  sourceNetwork: string;
  errorMessage: string | null;
  createdAt: string;
}

export default function TxDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [tx, setTx] = useState<TxDetail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void explorerApi
      .request<TxDetail>({ path: `/transactions/${id}` })
      .then(setTx)
      .catch((err) => setError((err as Error).message));
  }, [id]);

  if (error) {
    return <p className="py-20 text-center text-sm text-muted-foreground">{error}</p>;
  }
  if (!tx) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-indigo-400" />
      </div>
    );
  }

  const rows: Array<[string, React.ReactNode]> = [
    [
      'Transaction ID',
      <span key="id" className="font-mono">
        {tx.id}
      </span>,
    ],
    [
      'Hash',
      <span key="hash" className="font-mono">
        {tx.hash ? shortKey(tx.hash, 20, 10) : '—'}
      </span>,
    ],
    [
      'Status',
      <Badge
        key="status"
        variant={
          tx.status === 'SUCCEEDED' || tx.status === 'CONFIRMED'
            ? 'success'
            : tx.status === 'FAILED'
              ? 'destructive'
              : 'warning'
        }
      >
        {tx.status}
      </Badge>,
    ],
    ['Kind', tx.kind],
    ['Direction', tx.direction],
    ['Network', tx.sourceNetwork],
    ['Fee', tx.fee ?? '—'],
    ['Memo', tx.memo ? `${tx.memo} (${tx.memoType})` : '—'],
    ['Created', formatDateTime(tx.createdAt)],
    ['Error', tx.errorMessage ?? '—'],
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Transaction</h1>
        <p className="font-mono text-sm text-muted-foreground">
          {shortKey(tx.hash ?? tx.id, 16, 10)}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardContent className="flex items-center gap-4 p-6">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-rose-500/10 text-rose-400">
              <ArrowUpRight className="h-6 w-6" />
            </span>
            <div>
              <p className="text-xs text-muted-foreground">From</p>
              <p className="font-mono text-sm">{shortKey(tx.fromPublicKey)}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-4 p-6">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400">
              <ArrowDownLeft className="h-6 w-6" />
            </span>
            <div>
              <p className="text-xs text-muted-foreground">To</p>
              <p className="font-mono text-sm">{shortKey(tx.toPublicKey)}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-6">
          <p className="font-mono text-4xl font-bold">
            {tx.amount} <span className="text-lg text-muted-foreground">{tx.assetCode}</span>
          </p>
          {tx.assetIssuer && (
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              issued by {shortKey(tx.assetIssuer)}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="divide-y divide-border/60">
            {rows.map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-4 px-6 py-3">
                <span className="text-sm text-muted-foreground">{label}</span>
                <span className="text-sm">{value}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Hash className="h-3 w-3" /> View the authoritative record on Stellar Expert / Horizon using
        the hash.
      </p>
    </div>
  );
}
