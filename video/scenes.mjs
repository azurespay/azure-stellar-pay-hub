/**
 * Single source of truth for the pitch video: the narration and the visual
 * treatment of every scene.
 *
 * Pipeline (see video/README.md):
 *   1. video/narrate.py       — synthesises the narration per scene and reports
 *                               real sentence timings from the TTS engine.
 *   2. video/synthesize.mjs   — drives narrate.py, writes .work/timing.json.
 *   3. video/render-scenes.mjs— renders each scene to a 3200x1800 PNG with
 *                               headless Chromium (composition lives in HTML/CSS).
 *   4. video/build-video.mjs  — animates each still with a camera move, times it
 *                               to its own narration, and stitches the scenes
 *                               together with crossfades.
 *
 * Scene kinds handled by video/render-scenes.mjs:
 *   statement — kicker + big headline over a branded backdrop
 *   ui        — a real screenshot inside a browser frame, with callouts
 *   gallery   — a hero screenshot plus supporting shots, each labelled
 *   diagram   — architecture built from HTML/CSS boxes
 *   code      — a real source excerpt with line numbers and numbered callouts
 *   stats     — metric cards
 *   compare   — two-column before/after
 *   outro     — closing card with call to action
 *
 * `motion` is a camera move applied by video/build-video.mjs:
 *   kind   — zoom-in | zoom-out | pan-left | pan-right | pan-up | pan-down
 *   amount — how far the move travels (0.06 is subtle, 0.14 is pronounced)
 */
/**
 * Narration engine selection. Two engines, one contract — whichever is chosen,
 * the pipeline gets mp3 files plus sentence timings and nothing downstream has
 * to change (see "The narration voice" in video/README.md).
 *
 *   edge    edge-tts (default; needs no API key). VOICE + RATE apply.
 *   gemini  Google AI Studio TTS — needs GEMINI_API_KEY in the environment or
 *           in video/.work/env. GEMINI_MODEL + GEMINI_VOICE apply; RATE is not
 *           used, pace is steered by the style prompt instead.
 *
 * VOICE_ENGINE=gemini node video/synthesize.mjs overrides the default.
 */
export const VOICE_ENGINE = process.env.VOICE_ENGINE ?? 'edge';

/** The edge-tts voice. */
export const VOICE = 'en-US-AndrewMultilingualNeural';

/** Slightly faster than default so the delivery has momentum. */
export const RATE = '+8%';

/** The Gemini TTS model (used when VOICE_ENGINE=gemini). */
export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash-preview-tts';

/** The Gemini voice: Puck reads as an upbeat, confident product-demo narrator. */
export const GEMINI_VOICE = process.env.GEMINI_VOICE ?? 'Puck';

/**
 * Style steering for Gemini TTS, prepended to every scene in the engine's own
 * natural-language control format. Keep it tight: it is billed as input, and
 * it must describe one consistent narrator for all sixteen scenes so the video
 * sounds like a single take.
 */
export const GEMINI_STYLE =
  'Read this as the narrator of a product launch video: confident, upbeat, ' +
  'clear, and a little brisk. Land the numbers with conviction. Pause only ' +
  'where the punctuation asks for a pause.\n\n';

export const scenes = [
  {
    id: '01-hook',
    kind: 'statement',
    kicker: 'Stellar Pay Hub',
    headline: 'Cross-border payments,\nsettled in seconds.',
    sub: 'Built on Stellar and Soroban smart contracts',
    accent: 'violet',
    motion: { kind: 'zoom-in', amount: 0.1 },
    narration:
      'Every day, businesses move money across borders over rails built for a different era. It takes days. It costs a fortune. And everyone stares at the same word: pending. We think that problem is solved. This is Stellar Pay Hub.',
  },
  {
    id: '02-problem',
    kind: 'compare',
    kicker: 'The problem',
    headline: 'The rails are fast. Everything above them is not.',
    left: {
      title: 'Cross-border payments today',
      items: [
        '1–5 business days to settle',
        '2–7% in fees, before FX spread',
        'Merchants wait days to be paid',
        'Payers cannot see where money went',
      ],
    },
    right: {
      title: 'What developers inherit',
      items: [
        'Wallet integration, hand-rolled',
        'On-chain state nobody reconciles',
        'Webhooks, retries and idempotency',
        'Audit and compliance logging',
      ],
    },
    motion: { kind: 'zoom-in', amount: 0.06 },
    narration:
      'The average cross-border payment takes one to five business days, and eats two to seven percent in fees — before the spread. Merchants wait days to be paid. Payers cannot see where the money went. And developers inherit the rest: wallets, on-chain state, reconciliation, webhooks, retries, audit logs. Stellar made settlement fast and cheap. It did not ship the product.',
  },
  {
    id: '03-solution',
    kind: 'statement',
    kicker: 'The solution',
    headline: 'One platform.\nPayers, merchants, and the chain.',
    sub: 'Checkout, escrow, invoicing, subscriptions, treasury and settlement',
    accent: 'mint',
    motion: { kind: 'zoom-in', amount: 0.1 },
    narration:
      'So here is the fix. Stellar Pay Hub is one platform on Stellar and Soroban. Payers check out with a link or an invoice, and sign in their own wallet. Merchants get a real workspace: revenue, settlement, reconciliation. And six smart contracts run escrow, invoicing, subscriptions, treasury, and settlement on-chain. Everything you would normally bolt on afterwards? Already here.',
  },
  {
    id: '04-payer-link',
    kind: 'ui',
    asset: 'web-checkout-link.png',
    kicker: 'Payer experience',
    caption: 'Payment link checkout — no wallet needed to look, wallet-signed to pay',
    url: 'stellar-pay.app/pay/demo-coffee',
    callouts: [
      { label: 'Merchant + amount', x: 26, y: 30 },
      { label: 'Asset and network, explicit', x: 60, y: 48 },
      { label: 'Signed by the payer', x: 26, y: 72 },
    ],
    motion: { kind: 'pan-right', amount: 0.08 },
    narration:
      'Let us start with the payer. A merchant shares a payment link or an invoice. The checkout shows the merchant, the amount, the asset, and the network — no surprises. The payer connects Freighter or xBull, and signs. No card numbers. No bank details. No redirects.',
  },
  {
    id: '05-payer-invoice',
    kind: 'ui',
    asset: 'web-checkout-invoice.png',
    kicker: 'Payer experience',
    caption: 'Invoice checkout — line items and due date straight from the merchant',
    url: 'stellar-pay.app/checkout/invoice/INV-2026-1002',
    callouts: [{ label: 'Server-issued invoice number', x: 30, y: 32 }],
    motion: { kind: 'zoom-in', amount: 0.13 },
    narration:
      'Invoices work the same way — line items, amount, and due date straight from the merchant. Every intent is signed with the payer key, and carries an idempotency key, so a retried request can never charge twice.',
  },
  {
    id: '06-merchant',
    kind: 'ui',
    asset: 'web-merchant.png',
    kicker: 'Merchant workspace',
    caption: 'Products, customers, invoices and settlement in one place',
    url: 'stellar-pay.app/merchant',
    callouts: [
      { label: 'On-chain registration', x: 24, y: 26 },
      { label: 'Settlement asset', x: 58, y: 44 },
    ],
    motion: { kind: 'pan-left', amount: 0.07 },
    narration:
      'On the merchant side: the workspace. Products, customers, invoices, payment links, and settlements in one place — with the settlement asset and the on-chain registration right up front.',
  },
  {
    id: '07-history',
    kind: 'ui',
    asset: 'web-history.png',
    kicker: 'Operations',
    caption: 'Transaction history — a row is confirmed only when the chain confirms it',
    url: 'stellar-pay.app/history',
    callouts: [
      { label: 'Amount, asset, direction', x: 26, y: 34 },
      { label: 'Chain hash and status', x: 60, y: 52 },
    ],
    motion: { kind: 'pan-down', amount: 0.1 },
    narration:
      'The transaction history is the operational view: amount, asset, direction, counterparty, hash, and status. And a row only reads confirmed when the chain says so — never on an optimistic write.',
  },
  {
    id: '08-admin',
    kind: 'gallery',
    kicker: 'Operator console',
    headline: 'The back office ships with it.',
    hero: { asset: 'admin-dashboard.png', label: 'Analytics & volume' },
    cards: [
      { asset: 'admin-transactions.png', label: 'Transaction monitoring' },
      { asset: 'admin-audit.png', label: 'Audit log & assets' },
    ],
    motion: { kind: 'zoom-in', amount: 0.09 },
    narration:
      'Operators get a console of their own. Platform analytics. Transaction monitoring. Merchant and user management. The asset registry. Notification broadcasts. And an audit log written by the API itself. That is the layer payment products usually grow into painfully — here, it ships.',
  },
  {
    id: '09-contracts',
    kind: 'diagram',
    variant: 'contracts',
    kicker: 'On-chain layer',
    headline: 'Six Soroban contracts, deployed on testnet',
    cards: [
      { name: 'payment', detail: 'Route payments, emit events' },
      { name: 'escrow', detail: 'Lock, release, refund, arbiter' },
      { name: 'invoices', detail: 'Issue and pay on-chain' },
      { name: 'subscriptions', detail: 'Interval billing by contract' },
      { name: 'treasury', detail: 'Deposits, approvals, threshold' },
      { name: 'merchant', detail: 'Registration and settlement' },
    ],
    motion: { kind: 'zoom-in', amount: 0.07 },
    narration:
      'Underneath, six Soroban contracts are live on testnet. Escrow locks funds, and releases them on a schedule — with an optional arbiter. Invoices are issued and paid on-chain. Subscriptions bill by interval, executed by the contract — not a cron job. Treasury runs withdrawals as threshold approvals — governance, not one admin key. And settlement closes a period, and pays out.',
  },
  {
    id: '10-escrow',
    kind: 'code',
    kicker: 'On-chain escrow',
    headline: 'The money is held by the contract.',
    file: 'contracts/escrow/src/lib.rs',
    lang: 'Rust',
    // A faithful excerpt of contracts/escrow/src/lib.rs: only the
    // already-released guard is elided, and the two over-long lines are reflowed
    // to fit the frame. Nothing here is rewritten for the camera.
    lines: [
      'pub fn release(env: Env, id: u64, caller: Address) -> Result<(), EscrowError> {',
      '    let mut escrows: Map<u64, Escrow> = env.storage().instance()',
      '        .get(&DataKey::Escrows).unwrap_or_else(|| Map::new(&env));',
      '    let mut escrow = escrows.get(id).ok_or(EscrowError::EscrowNotFound)?;',
      '',
      '    let is_arbiter = escrow.arbiter.as_ref().map_or(false, |a| a == &caller);',
      '    if caller != escrow.counterparty && caller != escrow.initiator && !is_arbiter {',
      '        return Err(EscrowError::Unauthorized);',
      '    }',
      '    caller.require_auth();',
      '',
      '    if env.ledger().timestamp() < escrow.release_time { return Err(EscrowError::TooEarly); }',
      '',
      '    let to = escrow.counterparty.clone();',
      '    token::Client::new(&env, &escrow.token).transfer(',
      '        &env.current_contract_address(), &to, &escrow.amount);',
      '    escrow.released = true; escrows.set(id, escrow.clone());',
      '    env.events().publish((symbol_short!("released"),),',
      '        EscrowReleased { id, to: to.clone(), amount: escrow.amount });',
      '    Ok(())',
      '}',
    ],
    notes: [
      { line: 7, title: 'Authorization', detail: 'Payer, payee, or an appointed arbiter' },
      { line: 12, title: 'Ledger clock', detail: 'TooEarly until release_time passes' },
      { line: 18, title: 'Event published', detail: 'The indexer consumes exactly this' },
    ],
    motion: { kind: 'zoom-in', amount: 0.1 },
    narration:
      'And here is the escrow contract itself, in Rust. Funds are held by the contract — never by an admin wallet. Release needs the payer, the payee, or an appointed arbiter, and the ledger clock must have passed the release time. Every state change publishes an event. That event is exactly what the indexer consumes.',
  },
  {
    id: '11-indexer',
    kind: 'statement',
    kicker: 'No optimistic state',
    headline: 'A status is a fact,\nnot a hope.',
    sub: 'The event indexer advances lifecycle state only on observed on-chain evidence',
    accent: 'violet',
    motion: { kind: 'zoom-out', amount: 0.1 },
    narration:
      'That is the decision behind the whole platform: the API never invents a status. A dedicated indexer watches Horizon and Soroban RPC, deduplicates every event, and only then advances an escrow to funded, a subscription to active. If the chain did not say it happened, the product does not claim it did.',
  },
  {
    id: '12-architecture',
    kind: 'diagram',
    variant: 'architecture',
    kicker: 'Architecture',
    headline: 'A typed monorepo, end to end',
    layers: [
      { label: 'Clients', nodes: ['Web app', 'Admin console', 'Chrome extension', 'Typed SDK'] },
      { label: 'API', nodes: ['NestJS', 'REST + Socket.IO', 'Zod validation', 'RBAC + audit'] },
      { label: 'Data', nodes: ['Postgres + Prisma', 'Redis sessions & queues', 'Event indexer'] },
      { label: 'Chain', nodes: ['Horizon', 'Soroban RPC', '6 contracts'] },
    ],
    motion: { kind: 'zoom-in', amount: 0.07 },
    narration:
      'The architecture is a typed monorepo, end to end: a NestJS API on Postgres and Prisma, Redis for sessions and rate limits, Socket.IO for realtime, and an event indexer in front of the chain. One typed SDK is the single client contract — shared by the web app, the admin console, and the Chrome extension. And one Zod schema validates the API and its clients alike, so a shape change breaks the build, not production.',
  },
  {
    id: '13-security',
    kind: 'stats',
    kicker: 'Trust and operations',
    headline: 'Security that holds up to review',
    stats: [
      { value: 'Ed25519', label: 'Wallet-native auth, not passwords' },
      { value: 'Revocable', label: 'Sessions enforced on sockets too' },
      { value: 'SSRF', label: 'Webhook targets blocked + timeout' },
      { value: 'Redacted', label: 'Audit logs never store credentials' },
    ],
    motion: { kind: 'zoom-in', amount: 0.08 },
    narration:
      'Security is first class. Authentication is wallet-native, with Ed25519 challenges. Sessions can be revoked — and realtime sockets re-check them, so revocation actually bites. Webhook delivery refuses private network targets, and applies a timeout. And the audit log records what happened, without ever writing a credential into it.',
  },
  {
    id: '14-verification',
    kind: 'stats',
    kicker: 'Verification',
    headline: 'Verified, not slideware',
    stats: [
      { value: '446', label: 'Unit and integration tests' },
      { value: '76', label: 'Soroban contract tests' },
      { value: '2', label: 'Live testnet E2E suites in CI' },
      { value: '17', label: 'Projects built and type-checked' },
    ],
    motion: { kind: 'zoom-in', amount: 0.08 },
    narration:
      'And it is verified — not slideware. Four hundred forty six unit and integration tests. Seventy six across the six contracts. CI runs type checks, lint, the full suite, and a Postgres and Redis integration spec — plus two live testnet suites that drive a real payment from challenge to on-chain confirmation, then assert the persisted state and the realtime update.',
  },
  {
    id: '15-value',
    kind: 'compare',
    kicker: 'Why it matters',
    headline: 'What that buys you',
    left: {
      title: 'The old way',
      items: [
        'Days to settle',
        'Percentage fees',
        'Escrow as a separate vendor',
        'Subscriptions as another one',
        'Treasury controls that do not exist',
      ],
    },
    right: {
      title: 'With Stellar Pay Hub',
      items: [
        'About five seconds to settle',
        'A fraction of a cent',
        'Escrow as a product feature',
        'Interval billing in the contract',
        'Threshold approvals, on-chain',
      ],
    },
    motion: { kind: 'zoom-in', amount: 0.06 },
    narration:
      'So what does that buy you? Settlement in about five seconds, not days. Fees at a fraction of a cent, not percentages. Escrow, subscriptions, and treasury as product features — not three separate vendors. Plus a working reference implementation: auth, indexer, reconciliation, admin console, tests. Against a card processor, you own the money movement. Against a wallet and a hope, you get the whole operational layer.',
  },
  {
    id: '16-close',
    kind: 'outro',
    kicker: 'Get started',
    headline: 'Clone it. Run it. Watch it settle.',
    sub: 'pnpm setup && pnpm docker:up && pnpm db:seed && pnpm dev',
    points: [
      'Open source, MIT licensed',
      'Frontends live on Vercel',
      'Six contracts live on testnet',
    ],
    motion: { kind: 'zoom-out', amount: 0.06 },
    narration:
      'Stellar Pay Hub: the rails, the contracts, and the product — already built, and already deployed. The frontends are live on Vercel, and the six contracts are live on Stellar testnet. Clone it, bring the stack up locally, and watch a payment settle in five seconds.',
  },
];
