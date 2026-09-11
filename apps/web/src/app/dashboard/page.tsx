'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowDownLeft,
  ArrowUpRight,
  QrCode,
  Receipt,
  ShieldCheck,
  Sparkles,
  Wallet,
} from 'lucide-react';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Skeleton } from '@stellar-pay/ui';
import { useWallet } from '@stellar-pay/wallet';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, shortKey, STATUS_STYLES } from '@/lib/format';
import type { AssetBalance, TransactionRecord } from '@stellar-pay/types';

export default function DashboardPage() {
  const { connected, publicKey } = useWallet();
  const { authenticated, loginWithWallet, loading } = useAuth();
  const [balances, setBalances] = useState<AssetBalance[]>([]);
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [loadingData, setLoadingData] = useState(true);

  useEffect(() => {
    if (!publicKey) {
      setLoadingData(false);
      return;
    }
    setLoadingData(true);
    void Promise.all([
      api.wallet.balances(publicKey).catch(() => [] as AssetBalance[]),
      api.payments
        .list({ page: 1, pageSize: 6 })
        .catch(() => ({ data: [] as TransactionRecord[] })),
    ])
      .then(([b, t]) => {
        setBalances(b);
        setTransactions(t.data);
      })
      .finally(() => setLoadingData(false));
  }, [publicKey]);

  if (!connected || !publicKey) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-20">
        <Card className="mx-auto max-w-xl">
          <CardContent className="flex flex-col items-center gap-6 p-10 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 shadow-xl shadow-purple-500/30">
              <Wallet className="h-8 w-8 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">Connect your wallet to get started</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Use Freighter, xBull or Albedo. Your keys never leave your wallet.
              </p>
            </div>
            <Button
              variant="gradient"
              size="lg"
              onClick={() => void loginWithWallet()}
              disabled={loading}
            >
              Sign in with wallet
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Welcome back</p>
          <h1 className="text-3xl font-bold tracking-tight">
            <span className="font-mono text-xl">{shortKey(publicKey, 10, 6)}</span>
          </h1>
        </div>
        <div className="flex gap-3">
          <Button asChild>
            <Link href="/send">
              <ArrowUpRight className="h-4 w-4" /> Send
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/receive">
              <QrCode className="h-4 w-4" /> Receive
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="relative overflow-hidden lg:col-span-2">
          <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-indigo-500/20 blur-2xl" />
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-indigo-400" /> Balances
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loadingData ? (
              <div className="space-y-3">
                <Skeleton className="h-12 w-1/3" />
                <Skeleton className="h-8 w-1/2" />
              </div>
            ) : balances.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No balances found. Create a trustline or fund your account on testnet.
              </p>
            ) : (
              <div className="space-y-3">
                {balances.map((balance) => (
                  <div
                    key={`${balance.assetCode}-${balance.assetIssuer ?? 'native'}`}
                    className="flex items-center justify-between rounded-xl border border-border/60 bg-background/40 px-4 py-3"
                  >
                    <div className="flex items-center gap-3">
                      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500/30 to-purple-500/30 font-mono text-xs font-bold">
                        {balance.assetCode.slice(0, 3)}
                      </span>
                      <div>
                        <p className="font-medium">{balance.assetCode}</p>
                        <p className="text-xs text-muted-foreground">
                          {balance.isNative
                            ? 'Stellar native'
                            : `Issued by ${shortKey(balance.assetIssuer ?? '')}`}
                        </p>
                      </div>
                    </div>
                    <p className="font-mono text-lg font-semibold">
                      {Number(balance.balance).toLocaleString()}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quick actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button asChild variant="outline" className="w-full justify-start">
              <Link href="/receive">
                <ArrowDownLeft className="h-4 w-4" /> Payment request
              </Link>
            </Button>
            <Button asChild variant="outline" className="w-full justify-start">
              <Link href="/merchant">
                <Receipt className="h-4 w-4" /> Merchant tools
              </Link>
            </Button>
            <Button asChild variant="outline" className="w-full justify-start">
              <Link href="/contracts">
                <ShieldCheck className="h-4 w-4" /> On-chain contracts
              </Link>
            </Button>
            <Button asChild variant="outline" className="w-full justify-start">
              <Link href="/history">
                <ArrowUpRight className="h-4 w-4" /> Transaction history
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Recent activity</CardTitle>
          <Button asChild variant="ghost" size="sm">
            <Link href="/history">View all</Link>
          </Button>
        </CardHeader>
        <CardContent>
          {transactions.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No transactions yet — make your first payment.
            </p>
          ) : (
            <div className="divide-y divide-border/60">
              {transactions.map((tx) => (
                <div key={tx.id} className="flex items-center justify-between py-3">
                  <div>
                    <p className="text-sm font-medium">
                      {tx.direction === 'OUTGOING' ? 'Sent' : 'Received'}{' '}
                      <span className="font-mono">{tx.amount}</span> {tx.assetCode}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(tx.createdAt)} · {tx.kind}
                    </p>
                  </div>
                  <Badge variant="outline" className={STATUS_STYLES[tx.status] ?? ''}>
                    {tx.status}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {authenticated ? null : (
        <Card className="border-indigo-500/30 bg-indigo-500/5">
          <CardContent className="flex flex-wrap items-center justify-between gap-4 py-5">
            <p className="text-sm text-muted-foreground">
              Sign in to sync payments across devices and get email notifications.
            </p>
            <Button onClick={() => void loginWithWallet()}>Sign in</Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
