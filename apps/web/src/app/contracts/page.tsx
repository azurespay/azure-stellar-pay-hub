'use client';

import { useEffect, useState } from 'react';
import { Landmark, Lock, Repeat, ShieldCheck } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@stellar-pay/ui';
import { useWallet } from '@stellar-pay/wallet';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, shortKey, STATUS_STYLES } from '@/lib/format';

type Escrow = Record<string, unknown>;
type Plan = Record<string, unknown>;
type Subscription = Record<string, unknown>;
type TreasuryOp = Record<string, unknown>;

/**
 * On-chain contract integrations: escrow, subscriptions, treasury.
 *
 * Every status shown here is driven by the platform's event indexer (on-chain
 * evidence), never an optimistic database write. Creation follows the same
 * lifecycle as the contract payment route: the API simulates + assembles the
 * call, the wallet signs the envelope (incl. Soroban auth entries), and the
 * server submits via Soroban RPC; the row then advances as the indexer
 * observes the contract's event.
 */
export default function ContractsPage() {
  const { connected, publicKey, signTx } = useWallet();
  const { authenticated, loginWithWallet, loading } = useAuth();

  const [escrows, setEscrows] = useState<Escrow[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [ops, setOps] = useState<TreasuryOp[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // ── Escrow create form ─────────────────────────────────────────────────
  const [counterparty, setCounterparty] = useState('');
  const [amount, setAmount] = useState('10');
  const [releaseMinutes, setReleaseMinutes] = useState('10');

  // ── Plan create form ───────────────────────────────────────────────────
  const [planName, setPlanName] = useState('');
  const [planAmount, setPlanAmount] = useState('1');
  const [planInterval, setPlanInterval] = useState('2592000'); // 30 days

  // ── Treasury deposit form ──────────────────────────────────────────────
  const [depositAmount, setDepositAmount] = useState('10');

  useEffect(() => {
    if (!authenticated || !publicKey) {
      setLoadingData(false);
      return;
    }
    setLoadingData(true);
    void Promise.all([
      api.escrows.list().catch(() => [] as Escrow[]),
      api.subscriptionPlans.list().catch(() => [] as Plan[]),
      api.subscriptions.list().catch(() => [] as Subscription[]),
      api.treasury.operations().catch(() => [] as TreasuryOp[]),
    ])
      .then(([e, p, s, o]) => {
        setEscrows(e);
        setPlans(p);
        setSubscriptions(s);
        setOps(o);
      })
      .finally(() => setLoadingData(false));
  }, [authenticated, publicKey]);

  const refresh = async () => {
    const [e, p, s, o] = await Promise.all([
      api.escrows.list().catch(() => [] as Escrow[]),
      api.subscriptionPlans.list().catch(() => [] as Plan[]),
      api.subscriptions.list().catch(() => [] as Subscription[]),
      api.treasury.operations().catch(() => [] as TreasuryOp[]),
    ]);
    setEscrows(e);
    setPlans(p);
    setSubscriptions(s);
    setOps(o);
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    setError('');
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(`${label}: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const prepareSignSubmit = async (prepare: () => Promise<{ id: string; unsignedXdr: string }>, submit: (id: string, signedXdr: string) => Promise<unknown>) => {
    const intent = await prepare();
    const signedXdr = await signTx(intent.unsignedXdr);
    return submit(intent.id, signedXdr);
  };

  if (!connected || !publicKey) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-20">
        <Card className="mx-auto max-w-xl">
          <CardContent className="flex flex-col items-center gap-6 p-10 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 shadow-xl shadow-purple-500/30">
              <ShieldCheck className="h-8 w-8 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">On-chain contracts</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Escrow, subscriptions and treasury run on Soroban smart contracts. Connect your wallet to get started.
              </p>
            </div>
            <Button variant="gradient" size="lg" onClick={() => void loginWithWallet()} disabled={loading}>
              Sign in with wallet
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-10">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">On-chain contracts</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Statuses are confirmed by the event indexer from on-chain evidence — the Soroban contracts run on Stellar testnet.
        </p>
      </div>

      {error && (
        <Card className="border-red-500/40 bg-red-500/5">
          <CardContent className="py-3 text-sm text-red-400">{error}</CardContent>
        </Card>
      )}

      <Tabs defaultValue="escrow">
        <TabsList>
          <TabsTrigger value="escrow"><Lock className="mr-1 h-4 w-4" /> Escrow</TabsTrigger>
          <TabsTrigger value="subscriptions"><Repeat className="mr-1 h-4 w-4" /> Subscriptions</TabsTrigger>
          <TabsTrigger value="treasury"><Landmark className="mr-1 h-4 w-4" /> Treasury</TabsTrigger>
        </TabsList>

        {/* ── Escrow ─────────────────────────────────────────────────────── */}
        <TabsContent value="escrow" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Create escrow</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="counterparty">Counterparty (G…)</Label>
                <Input id="counterparty" placeholder="G…" value={counterparty} onChange={(e) => setCounterparty(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="amount">Amount (XLM)</Label>
                <Input id="amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="release">Release in (minutes)</Label>
                <Input id="release" value={releaseMinutes} onChange={(e) => setReleaseMinutes(e.target.value)} />
              </div>
              <div className="md:col-span-3">
                <Button
                  variant="gradient"
                  disabled={busy || !counterparty || !amount}
                  onClick={() =>
                    void run('Escrow', async () => {
                      const releaseTime = new Date(Date.now() + Number(releaseMinutes) * 60_000).toISOString();
                      await prepareSignSubmit(
                        () =>
                          api.escrows.create({
                            initiatorPublicKey: publicKey,
                            counterpartyPublicKey: counterparty,
                            assetCode: 'XLM',
                            amount,
                            releaseTime,
                          }),
                        (id, xdr) => api.escrows.submit(id, xdr),
                      );
                    })
                  }
                >
                  Create &amp; fund escrow
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Your escrows</CardTitle>
            </CardHeader>
            <CardContent>
              {loadingData ? (
                <Skeleton className="h-24 w-full" />
              ) : escrows.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">No escrows yet.</p>
              ) : (
                <div className="divide-y divide-border/60">
                  {escrows.map((escrow) => (
                    <div key={escrow.id as string} className="flex flex-wrap items-center justify-between gap-3 py-3">
                      <div>
                        <p className="text-sm font-medium">
                          {shortKey(escrow.counterpartyPublicKey as string)} ·{' '}
                          <span className="font-mono">{String(escrow.amount)}</span> XLM
                          {escrow.contractId != null && (
                            <span className="ml-2 text-xs text-muted-foreground">on-chain #{String(escrow.contractId)}</span>
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatDateTime(escrow.createdAt as string)} · release {formatDateTime(escrow.releaseTime as string)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className={STATUS_STYLES[escrow.status as string] ?? ''}>
                          {escrow.status as string}
                        </Badge>
                        {escrow.status === 'FUNDED' && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() =>
                              void run('Release', async () => {
                                await prepareSignSubmit(
                                  () => api.escrows.release(escrow.id as string, publicKey),
                                  (id, xdr) => api.escrows.confirmRelease(id, xdr),
                                );
                              })
                            }
                          >
                            Release
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Subscriptions ──────────────────────────────────────────────── */}
        <TabsContent value="subscriptions" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Create subscription plan</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="plan-name">Name</Label>
                <Input id="plan-name" placeholder="Pro plan" value={planName} onChange={(e) => setPlanName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="plan-amount">Amount (XLM / period)</Label>
                <Input id="plan-amount" value={planAmount} onChange={(e) => setPlanAmount(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="plan-interval">Interval (seconds)</Label>
                <Input id="plan-interval" value={planInterval} onChange={(e) => setPlanInterval(e.target.value)} />
              </div>
              <div className="md:col-span-3">
                <Button
                  variant="gradient"
                  disabled={busy || !planName || !planAmount}
                  onClick={() =>
                    void run('Plan', async () => {
                      await prepareSignSubmit(
                        () =>
                          api.subscriptionPlans.create({
                            name: planName,
                            assetCode: 'XLM',
                            amount: planAmount,
                            intervalSeconds: Number(planInterval),
                          }),
                        (id, xdr) => api.subscriptionPlans.submit(id, xdr),
                      );
                    })
                  }
                >
                  Create plan (on-chain)
                </Button>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Plans</CardTitle>
              </CardHeader>
              <CardContent>
                {loadingData ? (
                  <Skeleton className="h-24 w-full" />
                ) : plans.length === 0 ? (
                  <p className="py-4 text-sm text-muted-foreground">No plans yet.</p>
                ) : (
                  <div className="divide-y divide-border/60">
                    {plans.map((plan) => (
                      <div key={plan.id as string} className="flex flex-wrap items-center justify-between gap-3 py-3">
                        <div>
                          <p className="text-sm font-medium">
                            {plan.name as string} · <span className="font-mono">{String(plan.amount)}</span> XLM / {String(plan.intervalSeconds)}s
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {plan.contractPlanId != null && `on-chain #${plan.contractPlanId}`}
                          </p>
                        </div>
                        <Badge variant="outline" className={STATUS_STYLES[plan.status as string] ?? ''}>
                          {plan.status as string}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Your subscriptions</CardTitle>
              </CardHeader>
              <CardContent>
                {loadingData ? (
                  <Skeleton className="h-24 w-full" />
                ) : subscriptions.length === 0 ? (
                  <p className="py-4 text-sm text-muted-foreground">No subscriptions yet.</p>
                ) : (
                  <div className="divide-y divide-border/60">
                    {subscriptions.map((sub) => (
                      <div key={sub.id as string} className="flex flex-wrap items-center justify-between gap-3 py-3">
                        <div>
                          <p className="text-sm font-medium">{String((sub.plan as Plan | undefined)?.name ?? 'Subscription')}</p>
                          <p className="text-xs text-muted-foreground">
                            {sub.nextPaymentAt ? `next payment ${formatDateTime(String(sub.nextPaymentAt))}` : ''}
                          </p>
                        </div>
                        <Badge variant="outline" className={STATUS_STYLES[sub.status as string] ?? ''}>
                          {sub.status as string}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ── Treasury ───────────────────────────────────────────────────── */}
        <TabsContent value="treasury" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Treasury deposit</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap items-end gap-4">
              <div className="w-48 space-y-1.5">
                <Label htmlFor="deposit-amount">Amount (XLM)</Label>
                <Input id="deposit-amount" value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} />
              </div>
              <Button
                variant="gradient"
                disabled={busy || !depositAmount}
                onClick={() =>
                  void run('Deposit', async () => {
                    await prepareSignSubmit(
                      () => api.treasury.deposit({ fromPublicKey: publicKey, assetCode: 'XLM', amount: depositAmount }),
                      (id, xdr) => api.treasury.submitDeposit(id, xdr),
                    );
                  })
                }
              >
                Deposit to treasury
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Treasury operations</CardTitle>
            </CardHeader>
            <CardContent>
              {loadingData ? (
                <Skeleton className="h-24 w-full" />
              ) : ops.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">
                  No treasury operations yet. Deposits require the asset to be allowlisted on the treasury contract.
                </p>
              ) : (
                <div className="divide-y divide-border/60">
                  {ops.map((op) => (
                    <div key={op.id as string} className="flex flex-wrap items-center justify-between gap-3 py-3">
                      <div>
                        <p className="text-sm font-medium">
                          {op.type as string} · <span className="font-mono">{String(op.amount)}</span> {String(op.assetCode)}
                        </p>
                        <p className="text-xs text-muted-foreground">{formatDateTime(op.createdAt as string)}</p>
                      </div>
                      <Badge variant="outline" className={STATUS_STYLES[op.status as string] ?? ''}>
                        {op.status as string}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}