'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { QRCodeSVG } from 'qrcode.react';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  Loader2,
  QrCode,
  RefreshCw,
  ShieldCheck,
  ShoppingCart,
  Store,
  Wallet,
  X,
  Zap,
} from 'lucide-react';
import { Badge, Button, Card, CardContent, Input, Label } from '@stellar-pay/ui';
import { SUPPORTED_WALLETS, useWallet, type WalletProviderId } from '@stellar-pay/wallet';
import { api } from '@/lib/api';
import { shortKey } from '@/lib/format';

// ------------------------------------------------------------------ Types

type CheckoutData = Awaited<ReturnType<typeof api.checkout.paymentLink>>;
type CheckoutStatus = 'loading' | 'ready' | 'connecting' | 'paying' | 'success' | 'error';

// ------------------------------------------------------------------ Wallet connect popover

function WalletConnectPopover({
  onSelect,
  connecting,
  error,
  onDismissError,
}: {
  onSelect: (id: WalletProviderId) => void;
  connecting: boolean;
  error: string;
  onDismissError: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <Button
        variant="gradient"
        size="lg"
        className="w-full"
        onClick={() => setOpen((v) => !v)}
        disabled={connecting}
      >
        {connecting ? <Loader2 className="h-5 w-5 animate-spin" /> : <Wallet className="h-5 w-5" />}
        Connect wallet to pay
      </Button>

      {open && (
        <div className="absolute left-0 right-0 z-50 mt-2 rounded-xl border border-border bg-popover p-2 shadow-2xl animate-in fade-in-0 zoom-in-95">
          {error && (
            <div className="mb-2 rounded-lg border border-rose-500/20 bg-rose-500/5 px-3 py-2">
              <div className="flex items-center justify-between">
                <p className="text-xs text-rose-400">{error}</p>
                <button
                  onClick={onDismissError}
                  className="ml-2 shrink-0 rounded p-0.5 text-rose-400/60 hover:text-rose-400"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            </div>
          )}
          <div className="mb-1.5 px-2 py-1 text-xs font-medium text-muted-foreground">
            Choose a wallet
          </div>
          {SUPPORTED_WALLETS.map((w) => (
            <button
              key={w.id}
              onClick={() => {
                onSelect(w.id);
              }}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500/30 to-purple-500/30 text-xs font-bold">
                {w.name[0]}
              </span>
              <div>
                <p className="font-medium">{w.name}</p>
                <p className="text-xs text-muted-foreground">{w.description}</p>
              </div>
              <ArrowRight className="ml-auto h-4 w-4 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ QR modal

function QrModal({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-xs rounded-2xl border border-border bg-card p-6 shadow-2xl animate-in fade-in-0 zoom-in-95"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="mb-4 text-center">
          <p className="text-sm font-medium">Scan to pay</p>
          <p className="text-xs text-muted-foreground">Open this page on your mobile wallet</p>
        </div>
        <div className="flex justify-center rounded-2xl bg-white p-4 shadow-lg">
          <QRCodeSVG value={url} size={180} level="M" />
        </div>
        <p className="mt-4 text-center font-mono text-[10px] text-muted-foreground break-all">
          {url}
        </p>
      </div>
    </div>
  );
}

// ================================================================== Main

export default function PayLinkPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const { publicKey, signTx, connected, connect, disconnect } = useWallet();

  const [checkout, setCheckout] = useState<CheckoutData | null>(null);
  const [status, setStatus] = useState<CheckoutStatus>('loading');
  const [error, setError] = useState('');
  const [payErrorKind, setPayErrorKind] = useState<'rejected' | 'insufficient' | 'failed'>(
    'failed',
  );
  const [connectError, setConnectError] = useState('');
  const [amount, setAmount] = useState('');
  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState(false);

  const checkoutUrlRef = useRef('');
  if (typeof window !== 'undefined') checkoutUrlRef.current = window.location.href;
  const checkoutUrl = checkoutUrlRef.current;

  // Load checkout data (with cleanup to prevent setState after unmount)
  useEffect(() => {
    let cancelled = false;
    void api.checkout
      .paymentLink(code)
      .then((data) => {
        if (cancelled) return;
        setCheckout(data);
        setAmount(data.amount ?? '');
        setStatus('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setError((err as Error).message);
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  // Handle wallet connect
  const handleConnect = useCallback(
    async (providerId: WalletProviderId) => {
      setConnectError('');
      setStatus('connecting');
      try {
        await connect(providerId);
        setStatus('ready');
      } catch (err) {
        setStatus('ready');
        setConnectError((err as Error).message);
      }
    },
    [connect],
  );

  // Pay
  const handlePay = useCallback(async () => {
    if (!checkout || !publicKey) return;
    setStatus('paying');
    try {
      const intent = await api.checkout.payLink(code, publicKey, amount || undefined);
      const signedXdr = await signTx(intent.unsignedXdr);
      const result = await api.request<{ status: string; hash?: string; errorMessage?: string }>({
        method: 'POST',
        path: `/checkout/transactions/${intent.id}/submit`,
        body: { signedXdr },
      });
      if (result.status === 'SUCCEEDED') {
        // Success is only shown after the server confirms the on-chain
        // transaction succeeded — never on mere submission.
        setStatus('success');
      } else {
        setStatus('error');
        setPayErrorKind('failed');
        setError(result.errorMessage ?? 'Transaction was not successful');
      }
    } catch (err) {
      setStatus('error');
      const msg = (err as Error).message ?? String(err);
      const name = (err as Error).name ?? '';
      // A wallet rejection or a connection abort means the payment was never
      // submitted — it must not be shown as a failed blockchain payment, and
      // the customer should be able to retry.
      if (/insufficient|not enough|low balance/i.test(msg)) {
        setPayErrorKind('insufficient');
      } else if (/reject|declined?|denied|cancel/i.test(msg) || name === 'AbortError') {
        setPayErrorKind('rejected');
      } else {
        setPayErrorKind('failed');
      }
      setError(msg);
    }
  }, [checkout, publicKey, amount, code, signTx]);

  // Copy link
  const copyLink = useCallback(async () => {
    await navigator.clipboard.writeText(checkoutUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [checkoutUrl]);

  // ================================================================ LOADING

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-10 w-10 animate-spin text-indigo-400" />
          <p className="text-sm text-muted-foreground">Loading payment…</p>
        </div>
      </div>
    );
  }

  // ================================================================ ERROR

  if (status === 'error' && !checkout) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-sm text-center">
          <CardContent className="space-y-4 py-10">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-500/10">
              <X className="h-7 w-7 text-rose-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold">
                {/expired/i.test(error)
                  ? 'This payment request has expired'
                  : 'Payment unavailable'}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">{error}</p>
            </div>
            <Button asChild variant="outline" className="mt-4">
              <Link href="/">Return home</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ================================================================ SUCCESS

  if (status === 'success') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-sm text-center overflow-hidden">
          <div className="bg-gradient-to-br from-emerald-600 via-emerald-500 to-teal-600 p-8">
            <CheckCircle2 className="mx-auto h-16 w-16 text-white drop-shadow-lg animate-in zoom-in-50 duration-500" />
          </div>
          <CardContent className="space-y-4 py-8">
            <div>
              <h1 className="text-2xl font-bold">Payment successful!</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {amount} {checkout?.assetCode} sent to {checkout?.merchantName}
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Button asChild variant="gradient" size="lg" className="w-full">
                <Link href="/dashboard">
                  <Zap className="h-4 w-4" /> View in dashboard
                </Link>
              </Button>
              <Button asChild variant="outline" size="lg" className="w-full">
                <Link href="/">Return home</Link>
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Transaction settled on Stellar in ~5 seconds
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ================================================================ CHECKOUT

  const isFixed = checkout?.fixedAmount ?? true;
  const merchantName = checkout?.merchantName ?? 'Merchant';
  const canPay = connected && publicKey && (isFixed || Number(amount) > 0);
  const isPaying = status === 'paying';

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10">
      {/* Ambient orbs */}
      <div className="orb left-[-15%] top-[-10%] h-[300px] w-[300px] bg-indigo-600/30" />
      <div className="orb right-[-10%] bottom-[-5%] h-[250px] w-[250px] bg-fuchsia-600/30" />

      <div className="relative w-full max-w-md space-y-5">
        {/* Merchant header */}
        <div className="text-center">
          {checkout?.merchantLogo ? (
            <img
              src={checkout.merchantLogo}
              alt={merchantName}
              className="mx-auto h-12 w-12 rounded-xl object-cover shadow-lg"
            />
          ) : (
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 via-purple-500 to-fuchsia-500 shadow-lg shadow-purple-500/30">
              <Store className="h-6 w-6 text-white" />
            </span>
          )}
          <p className="mt-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {merchantName}
          </p>
        </div>

        {/* Main card */}
        <Card className="overflow-hidden shadow-2xl shadow-indigo-500/10">
          {/* Gradient banner */}
          <div className="bg-gradient-to-br from-indigo-600 via-purple-600 to-fuchsia-600 p-6 text-white">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShoppingCart className="h-4 w-4 opacity-80" />
                <span className="text-xs font-medium opacity-80">Checkout</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowQr(true)}
                  className="rounded-md p-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                  title="Show QR code"
                >
                  <QrCode className="h-4 w-4" />
                </button>
                <button
                  onClick={copyLink}
                  className="rounded-md p-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                  title="Copy link"
                >
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <h1 className="mt-3 text-2xl font-bold tracking-tight">{checkout?.title}</h1>
            {checkout?.description && (
              <p className="mt-1.5 text-sm text-white/80">{checkout.description}</p>
            )}
          </div>

          <CardContent className="space-y-5 p-6">
            {/* Amount */}
            {!isFixed ? (
              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                  Amount ({checkout?.assetCode})
                </Label>
                <div className="relative">
                  <Input
                    type="number"
                    min="0"
                    step="any"
                    placeholder="0.00"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="pr-16 font-mono text-lg"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    {checkout?.assetCode}
                  </span>
                </div>
              </div>
            ) : (
              <div className="text-center">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Amount due</p>
                <p className="mt-1 font-mono text-5xl font-bold tracking-tight">{amount}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">{checkout?.assetCode}</p>
              </div>
            )}

            {/* Wallet connection */}
            {!connected || !publicKey ? (
              <WalletConnectPopover
                onSelect={handleConnect}
                connecting={status === 'connecting'}
                error={connectError}
                onDismissError={() => setConnectError('')}
              />
            ) : (
              <div className="space-y-3">
                {/* Connected wallet info */}
                <div className="flex items-center justify-between rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500/20">
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                    </span>
                    <div>
                      <p className="text-xs font-medium text-emerald-400">Wallet connected</p>
                      <p className="font-mono text-[11px] text-muted-foreground">
                        {shortKey(publicKey, 8, 4)}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      void disconnect();
                    }}
                    className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    title="Disconnect"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>

                {/* Pay button */}
                <Button
                  variant="gradient"
                  size="lg"
                  className="w-full"
                  onClick={() => void handlePay()}
                  disabled={isPaying || !canPay}
                >
                  {isPaying ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <ShieldCheck className="h-5 w-5" />
                  )}
                  {isPaying ? 'Processing payment…' : `Pay ${amount} ${checkout?.assetCode}`}
                </Button>
              </div>
            )}

            {/* Error with retry */}
            {status === 'error' && error && (
              <div
                className={`rounded-xl border px-4 py-3 ${
                  payErrorKind === 'rejected'
                    ? 'border-amber-500/20 bg-amber-500/5'
                    : 'border-rose-500/20 bg-rose-500/5'
                }`}
              >
                <div className="flex items-start gap-2">
                  <X
                    className={`mt-0.5 h-4 w-4 shrink-0 ${
                      payErrorKind === 'rejected' ? 'text-amber-400' : 'text-rose-400'
                    }`}
                  />
                  <div className="flex-1">
                    <p
                      className={`text-sm font-medium ${
                        payErrorKind === 'rejected' ? 'text-amber-400' : 'text-rose-400'
                      }`}
                    >
                      {payErrorKind === 'rejected' &&
                        'Payment not completed — you cancelled it in your wallet'}
                      {payErrorKind === 'insufficient' && 'Insufficient balance'}
                      {payErrorKind === 'failed' && 'Payment failed'}
                    </p>
                    <p className="mt-0.5 text-xs text-rose-300/80">
                      {payErrorKind === 'rejected'
                        ? 'No payment was sent. You can try again whenever you are ready.'
                        : error}
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3 w-full"
                  onClick={() => {
                    setStatus('ready');
                    setError('');
                    setPayErrorKind('failed');
                  }}
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Try again
                </Button>
              </div>
            )}

            {/* Footer info */}
            <div className="space-y-2 pt-2">
              {/* Payment count */}
              {checkout && (checkout.totalPayments ?? 0) > 0 && (
                <div className="flex items-center justify-between rounded-lg border border-border/60 bg-background/40 px-3 py-2">
                  <span className="text-xs text-muted-foreground">Times paid</span>
                  <Badge variant="outline" className="font-mono text-xs">
                    {checkout.totalPayments}
                  </Badge>
                </div>
              )}

              {/* Stellar badge */}
              <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                <ShieldCheck className="h-3 w-3 text-indigo-400" />
                Secured by Stellar · settles in ~5 seconds
              </div>

              <div className="text-center">
                <Link
                  href="/"
                  className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground transition-colors"
                >
                  Powered by StellarPay Hub
                </Link>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* QR Modal */}
      {showQr && <QrModal url={checkoutUrl} onClose={() => setShowQr(false)} />}
    </div>
  );
}
