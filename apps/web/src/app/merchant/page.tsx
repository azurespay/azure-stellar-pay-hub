'use client';

import { useEffect, useState } from 'react';
import { Link2, Package, Plus, Receipt, ScanLine, Store, Trash2, Users } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '@stellar-pay/ui';
import { api } from '@/lib/api';
import { shortKey } from '@/lib/format';
import { useRealtime } from '@/lib/ws';
import type { Invoice, Merchant, PaymentLink, Product, Settlement } from '@stellar-pay/types';
import { OnboardingForm } from './onboarding';

export default function MerchantPage() {
  const [merchant, setMerchant] = useState<Merchant | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [links, setLinks] = useState<PaymentLink[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [loaded, setLoaded] = useState(false);

  const loadAll = async () => {
    try {
      const merchantData = await api.merchants.me().catch(() => null);
      setMerchant(merchantData);
      if (merchantData) {
        const [p, i, l, s] = await Promise.all([
          api.merchants.products(),
          api.merchants.invoices(),
          api.merchants.paymentLinks(),
          api.merchants.settlements(),
        ]);
        setProducts(p.data);
        setInvoices(i.data);
        setLinks(l.data);
        setSettlements(s.data);
      }
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  // Live updates: a checkout/inbound payment for this merchant triggers a
  // `payment.received` realtime event — refresh invoices/links so the
  // dashboard reflects new collections without a manual reload.
  useRealtime((event) => {
    if (event === 'payment.received') {
      void loadAll();
    }
  });

  if (!loaded) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-20 text-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (!merchant) {
    return <OnboardingForm onDone={() => void loadAll()} />;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Store className="h-4 w-4" /> Merchant workspace
          </p>
          <h1 className="text-3xl font-bold tracking-tight">{merchant.name}</h1>
        </div>
        <Badge variant={merchant.status === 'ACTIVE' ? 'success' : 'warning'}>
          {merchant.status}
        </Badge>
      </div>

      <Tabs defaultValue="products">
        <TabsList>
          <TabsTrigger value="products">
            <Package className="mr-1.5 h-4 w-4" /> Products
          </TabsTrigger>
          <TabsTrigger value="links">
            <Link2 className="mr-1.5 h-4 w-4" /> Payment links
          </TabsTrigger>
          <TabsTrigger value="invoices">
            <Receipt className="mr-1.5 h-4 w-4" /> Invoices
          </TabsTrigger>
          <TabsTrigger value="pos">
            <ScanLine className="mr-1.5 h-4 w-4" /> POS
          </TabsTrigger>
          <TabsTrigger value="settlements">
            <Users className="mr-1.5 h-4 w-4" /> Settlements
          </TabsTrigger>
        </TabsList>

        <TabsContent value="products">
          <ProductPanel products={products} onChanged={() => void loadAll()} />
        </TabsContent>

        <TabsContent value="links">
          <PaymentLinkPanel links={links} onChanged={() => void loadAll()} />
        </TabsContent>

        <TabsContent value="invoices">
          <InvoicePanel invoices={invoices} />
        </TabsContent>

        <TabsContent value="pos">
          <PosPanel merchant={merchant} />
        </TabsContent>

        <TabsContent value="settlements">
          <SettlementPanel settlements={settlements} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ProductPanel({ products, onChanged }: { products: Product[]; onChanged: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [open, setOpen] = useState(false);

  const add = async () => {
    try {
      await api.merchants.createProduct({ name, priceAmount: price, assetCode: 'USDC' });
      setOpen(false);
      setName('');
      setPrice('');
      toast.success('Product added');
      onChanged();
    } catch (err) {
      toast.error('Failed to add product', (err as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="h-4 w-4" /> Add product
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New product</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label>Name</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ethiopia Single Origin"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Price (USDC)</Label>
                <Input
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="14.50"
                  className="font-mono"
                />
              </div>
              <Button onClick={() => void add()} className="w-full">
                Save product
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
      {products.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No products yet — add your first product.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((product) => (
            <Card key={product.id}>
              <CardContent className="flex items-center justify-between p-5">
                <div>
                  <p className="font-medium">{product.name}</p>
                  <p className="mt-1 font-mono text-sm text-muted-foreground">
                    {product.priceAmount} {product.assetCode}
                  </p>
                </div>
                <button
                  onClick={() => void api.merchants.deleteProduct(product.id).then(onChanged)}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function PaymentLinkPanel({ links, onChanged }: { links: PaymentLink[]; onChanged: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [open, setOpen] = useState(false);
  const checkoutUrl = `${process.env.NEXT_PUBLIC_WEB_URL ?? 'http://localhost:3000'}`;

  const create = async () => {
    try {
      const link = await api.merchants.createPaymentLink({
        title,
        amount: amount || undefined,
        fixedAmount: Boolean(amount),
      });
      setOpen(false);
      setTitle('');
      setAmount('');
      toast.success('Payment link created', `${checkoutUrl}/pay/${link.code}`);
      onChanged();
    } catch (err) {
      toast.error('Failed to create link', (err as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="h-4 w-4" /> New payment link
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create payment link</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label>Title</Label>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Buy me a coffee"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Amount (USDC, optional)</Label>
                <Input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="5.00"
                  className="font-mono"
                />
              </div>
              <Button onClick={() => void create()} className="w-full">
                Create link
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {links.map((link) => (
          <Card key={link.id}>
            <CardContent className="space-y-2 p-5">
              <div className="flex items-center justify-between">
                <p className="font-medium">{link.title}</p>
                <Badge variant={link.status === 'ACTIVE' ? 'success' : 'outline'}>
                  {link.status}
                </Badge>
              </div>
              <p className="font-mono text-sm">
                {link.amount ? `${link.amount} ${link.assetCode}` : 'Any amount'}
              </p>
              <p className="font-mono text-xs text-muted-foreground">
                {checkoutUrl}/pay/{link.code}
              </p>
              <p className="text-xs text-muted-foreground">
                {link.totalPayments} payments · {link.totalCollected} {link.assetCode} collected
              </p>
            </CardContent>
          </Card>
        ))}
        {links.length === 0 && (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No payment links yet.
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function InvoicePanel({ invoices }: { invoices: Invoice[] }) {
  return (
    <Card>
      <CardContent className="p-0">
        {invoices.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">No invoices yet.</p>
        ) : (
          <div className="divide-y divide-border/60">
            {invoices.map((invoice) => (
              <div key={invoice.id} className="flex items-center justify-between px-6 py-4">
                <div>
                  <p className="font-medium">{invoice.title}</p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {invoice.number} ·{' '}
                    {invoice.customerPublicKey ? shortKey(invoice.customerPublicKey) : 'walk-in'}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-mono text-sm font-semibold">
                    {invoice.amount} {invoice.assetCode}
                  </p>
                  <Badge variant={invoice.status === 'PAID' ? 'success' : 'outline'}>
                    {invoice.status}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PosPanel({ merchant }: { merchant: Merchant }) {
  const [uri, setUri] = useState('');
  return (
    <Card>
      <CardHeader>
        <CardTitle>Point of sale</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Scan to charge <span className="font-medium text-foreground">{merchant.name}</span>{' '}
          customers directly to your settlement address.
        </p>
        <Button
          variant="gradient"
          onClick={async () => {
            const result = await api.merchants.posCheckout({ amount: '5', assetCode: 'USDC' });
            setUri(result.qrPayload);
          }}
        >
          <ScanLine className="h-4 w-4" /> Generate POS QR (USDC 5.00)
        </Button>
        {uri && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-background/40 p-6">
            <span className="font-mono text-xs text-muted-foreground">{uri}</span>
            <p className="text-xs text-muted-foreground">
              Settlement: {shortKey(merchant.settlementPublicKey)}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SettlementPanel({ settlements }: { settlements: Settlement[] }) {
  return (
    <Card>
      <CardContent className="p-0">
        {settlements.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Settlements appear here once payments are received.
          </p>
        ) : (
          <div className="divide-y divide-border/60">
            {settlements.map((settlement) => (
              <div key={settlement.id} className="flex items-center justify-between px-6 py-4">
                <div>
                  <p className="text-sm font-medium">
                    {new Date(settlement.periodStart).toLocaleDateString()} →{' '}
                    {new Date(settlement.periodEnd).toLocaleDateString()}
                  </p>
                  <p className="text-xs text-muted-foreground">{settlement.id}</p>
                </div>
                <div className="text-right">
                  <p className="font-mono text-sm font-semibold">
                    {settlement.amount} {settlement.assetCode}
                  </p>
                  <Badge variant={settlement.status === 'COMPLETED' ? 'success' : 'outline'}>
                    {settlement.status}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
