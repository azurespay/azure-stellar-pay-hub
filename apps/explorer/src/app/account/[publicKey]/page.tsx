'use client';

import { use, useEffect, useState } from 'react';
import { Wallet } from 'lucide-react';
import { Badge, Card, CardContent } from '@stellar-pay/ui';
import { explorerApi } from '@/lib/api';
import { formatDateTime, shortKey } from '@/lib/format';
import type { AssetBalance } from '@stellar-pay/types';

interface AccountTx {
  id: string;
  hash: string | null;
  fromPublicKey: string | null;
  toPublicKey: string | null;
  amount: string;
  assetCode: string;
  status: string;
  createdAt: string;
}

export default function AccountPage({ params }: { params: Promise<{ publicKey: string }> }) {
  const { publicKey } = use(params);
  const [balances, setBalances] = useState<AssetBalance[]>([]);
  const [transactions, setTransactions] = useState<AccountTx[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    void Promise.all([
      explorerApi.request<AssetBalance[]>({ path: `/wallet/${publicKey}/balances` }),
      explorerApi.request<{ data: AccountTx[] }>({
        path: '/transactions',
        query: { search: publicKey },
      }),
    ])
      .then(([b, t]) => {
        setBalances(b);
        setTransactions(t.data);
      })
      .catch((err) => setError((err as Error).message));
  }, [publicKey]);

  return (
    <div className="space-y-6">
      <div>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Wallet className="h-4 w-4" /> Account
        </p>
        <h1 className="break-all font-mono text-xl font-bold">{publicKey}</h1>
      </div>

      {error ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{error}</p>
      ) : (
        <>
          <Card>
            <CardContent className="space-y-3 p-6">
              <p className="text-sm font-semibold text-muted-foreground">Balances</p>
              {balances.length === 0 ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : (
                balances.map((balance) => (
                  <div
                    key={`${balance.assetCode}-${balance.assetIssuer ?? 'native'}`}
                    className="flex items-center justify-between"
                  >
                    <span className="font-mono text-sm">{balance.assetCode}</span>
                    <span className="font-mono">{Number(balance.balance).toLocaleString()}</span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              <div className="border-b border-border px-6 py-4 text-sm font-semibold">
                Transactions
              </div>
              {transactions.length === 0 ? (
                <p className="p-8 text-center text-sm text-muted-foreground">
                  No transactions found
                </p>
              ) : (
                <div className="divide-y divide-border/60">
                  {transactions.map((tx) => (
                    <a
                      key={tx.id}
                      href={`/tx/${tx.id}`}
                      className="flex items-center justify-between gap-4 px-6 py-4 hover:bg-muted/30"
                    >
                      <div>
                        <p className="font-mono text-sm">
                          {shortKey(tx.hash ?? tx.id)} · {tx.amount} {tx.assetCode}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatDateTime(tx.createdAt)}
                        </p>
                      </div>
                      <Badge
                        variant={
                          tx.status === 'SUCCEEDED' || tx.status === 'CONFIRMED'
                            ? 'success'
                            : 'warning'
                        }
                      >
                        {tx.status}
                      </Badge>
                    </a>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
