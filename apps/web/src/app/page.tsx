import Link from 'next/link';
import {
  ArrowRight,
  Globe2,
  QrCode,
  Receipt,
  Repeat,
  ShieldCheck,
  Wallet,
  Users,
  Zap,
} from 'lucide-react';
import { Button, Card, CardContent } from '@stellar-pay/ui';

// Force dynamic rendering — lucide-react + radix-ui Slot don't play nice with SSR
export const dynamic = 'force-dynamic';

const FEATURES = [
  {
    icon: Wallet,
    title: 'Multi-wallet',
    body: 'Connect Freighter, xBull or Albedo. Switch freely, auto-reconnect on return.',
  },
  {
    icon: Globe2,
    title: 'Cross-border',
    body: 'USDC, EURT and custom assets settle in seconds on Stellar — no bank rails needed.',
  },
  {
    icon: QrCode,
    title: 'QR & links',
    body: 'Request payments with QR codes and shareable web+stellar:pay links.',
  },
  {
    icon: Repeat,
    title: 'Scheduled & recurring',
    body: 'One-off schedules, subscriptions and batch/split payouts from one screen.',
  },
  {
    icon: Receipt,
    title: 'Invoices & receipts',
    body: 'Generate invoices, hosted checkout pages and IPFS-backed receipts.',
  },
  {
    icon: ShieldCheck,
    title: 'Soroban secured',
    body: 'Escrow, multisig and treasury contracts auditable and upgradeable.',
  },
];

export default function LandingPage() {
  return (
    <div className="relative">
      <div className="orb left-[-10%] top-[-5%] h-[420px] w-[420px] bg-indigo-600" />
      <div className="orb right-[-8%] top-[10%] h-[380px] w-[380px] bg-fuchsia-600" />
      <div className="orb bottom-[-10%] left-[30%] h-[360px] w-[360px] bg-purple-600" />

      {/* Hero */}
      <section className="relative mx-auto max-w-6xl px-4 pb-20 pt-24 text-center">
        <div className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-background/60 px-4 py-1.5 text-xs text-muted-foreground backdrop-blur">
          <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
          Powered by Stellar & Soroban smart contracts
        </div>
        <h1 className="mx-auto max-w-3xl text-5xl font-bold leading-tight tracking-tight md:text-6xl">
          Payments on Stellar, <span className="text-gradient">beautifully simple</span>
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-lg text-muted-foreground">
          Send XLM and Stellar assets, collect with payment links and invoices, and move money
          across borders — with wallet-first authentication and on-chain settlement.
        </p>
        <div className="mt-10 flex items-center justify-center gap-4">
          <Button asChild size="lg">
            <Link href="/dashboard">
              Get started <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button asChild variant="outline" size="lg">
            <Link href="/docs">Read the docs</Link>
          </Button>
        </div>

        <div className="mx-auto mt-16 grid max-w-4xl grid-cols-2 gap-4 md:grid-cols-4">
          {[
            ['< 5s', 'Settlement time'],
            ['3', 'Wallet providers'],
            ['8', 'Soroban contracts'],
            ['1', 'Unified SDK'],
          ].map(([value, label]) => (
            <div key={label} className="glass rounded-2xl p-5">
              <div className="text-2xl font-bold text-gradient">{value}</div>
              <div className="mt-1 text-xs text-muted-foreground">{label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="relative mx-auto max-w-6xl px-4 pb-24">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <Card
              key={feature.title}
              className="group transition-all hover:-translate-y-1 hover:border-indigo-500/40"
            >
              <CardContent className="p-6">
                <feature.icon className="h-6 w-6 text-indigo-400 transition-transform group-hover:scale-110" />
                <h3 className="mt-4 font-semibold">{feature.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{feature.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Wallets */}
      <section className="relative mx-auto max-w-6xl px-4 pb-24">
        <div className="glass mx-auto flex max-w-3xl flex-col items-center gap-6 rounded-3xl p-10 text-center">
          <Users className="h-8 w-8 text-fuchsia-400" />
          <h2 className="text-3xl font-bold">Bring your favorite wallet</h2>
          <p className="max-w-md text-muted-foreground">
            One adapter interface, three providers. Sign transactions with Freighter, xBull or
            Albedo — your keys stay with you.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            {['Freighter', 'xBull', 'Albedo'].map((name) => (
              <span
                key={name}
                className="rounded-full border border-border bg-background/60 px-4 py-2 text-sm"
              >
                {name}
              </span>
            ))}
          </div>
          <Button asChild variant="gradient">
            <Link href="/dashboard">
              <Zap className="h-4 w-4" /> Launch app
            </Link>
          </Button>
        </div>
      </section>
    </div>
  );
}
