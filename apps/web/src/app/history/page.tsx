'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Loader2, Zap } from 'lucide-react';
import { Badge, Button, Card, CardContent, Skeleton, useToast } from '@stellar-pay/ui';
import { useWallet } from '@stellar-pay/wallet';
import { api } from '@/lib/api';
import { formatDateTime, shortKey, STATUS_STYLES } from '@/lib/format';
import type { TransactionRecord } from '@stellar-pay/types';

const APPROVABLE_KINDS = ['scheduled', 'recurring', 'subscription_renewal'];

function isApprovable(tx: TransactionRecord): boolean {
  return APPROVABLE_KINDS.includes(tx.kind) && tx.status === 'PENDING';
}

export default function HistoryPage() {
  const { connected, publicKey, signTx } = useWallet();
  const toast = useToast();
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!connected) {
      setLoading(false);
      return;
    }
    void api.payments
      .list({ page: 1, pageSize: 50 })
      .then((res) => setTransactions(res.data))
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [connected]);

  useEffect(() => {
    load();
  }, [load]);

  // A scheduler-created occurrence is PENDING without a signable XDR (the
  // scheduler has no wallet). Approve → build → sign → submit via the API.
  const approveAndPay = async (tx: TransactionRecord) => {
    if (!publicKey || !connected) {
      toast.error('Connect a wallet first');
      return;
    }
    setApprovingId(tx.id);
    try {
      const intent = await api.request<{ id: string; unsignedXdr: string }>({
        method: 'POST',
        path: `/payments/${tx.id}/approve`,
      });
      const signedXdr = await signTx(intent.unsignedXdr);
      const result = await api.request<{ status: string; hash?: string }>({
        method: 'POST',
        path: `/payments/${intent.id}/submit`,
        body: { signedXdr },
      });
      toast.success(
        result.status === 'SUCCEEDED' ? 'Payment sent' : `Payment ${result.status.toLowerCase()}`,
        result.hash,
      );
      load();
    } catch (err) {
      toast.error('Approval failed', (err as Error).message);
    } finally {
      setApprovingId(null);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-10">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Transaction history</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          All payments sent and received from your linked wallets. Scheduled payments awaiting your
          signature appear here with an Approve action.
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="space-y-4 p-6">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : !connected ? (
            <p className="p-10 text-center text-sm text-muted-foreground">
              Connect a wallet to view your history.
            </p>
          ) : transactions.length === 0 ? (
            <p className="p-10 text-center text-sm text-muted-foreground">No transactions yet.</p>
          ) : (
            <div className="divide-y divide-border/60">
              {transactions.map((tx) => (
                <div key={tx.id} className="flex items-center gap-4 px-6 py-4 hover:bg-muted/30">
                  <span
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
                      tx.direction === 'OUTGOING'
                        ? 'bg-rose-500/10 text-rose-400'
                        : 'bg-emerald-500/10 text-emerald-400'
                    }`}
                  >
                    {tx.direction === 'OUTGOING' ? (
                      <ArrowUpRight className="h-5 w-5" />
                    ) : (
                      <ArrowDownLeft className="h-5 w-5" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {tx.direction === 'OUTGOING' ? 'To' : 'From'}{' '}
                      <span className="font-mono">
                        {shortKey(tx.toPublicKey ?? tx.fromPublicKey ?? '')}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(tx.createdAt)} · {tx.kind}
                      {tx.memo ? ` · memo: ${tx.memo}` : ''}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-sm font-semibold">
                      {tx.direction === 'OUTGOING' ? '−' : '+'}
                      {tx.amount} {tx.assetCode}
                    </p>
                    <Badge variant="outline" className={STATUS_STYLES[tx.status] ?? ''}>
                      {tx.status}
                    </Badge>
                  </div>
                  {isApprovable(tx) && (
                    <Button
                      variant="gradient"
                      size="sm"
                      onClick={() => void approveAndPay(tx)}
                      disabled={approvingId === tx.id}
                    >
                      {approvingId === tx.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Zap className="h-4 w-4" />
                      )}
                      Approve &amp; pay
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
