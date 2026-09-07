import { StrKey, xdr } from '@stellar/stellar-sdk';

/**
 * Decoded `payment` event payload from the payment contract. The contract
 * publishes the event as:
 *
 *   env.events().publish((symbol_short!("payment"),), PaymentEventData {
 *     from, to, token, amount: i128 (stroops), memo: String,
 *   });
 *
 * so the topic carries only the event name and the full payload lives in the
 * event data value. Amounts are raw i128 stroops; convert with
 * `stroopsToUnits` (XLM has 7 decimals).
 */
export interface SorobanPaymentEvent {
  from: string; // G… (ed25519 account)
  to: string; // G…
  token: string; // C… (SAC contract id)
  amountStroops: bigint;
  memo: string;
}

/** True when an event's topic names the payment contract's `payment` event. */
export function topicIsPayment(topic: unknown): boolean {
  const first = Array.isArray(topic) ? topic[0] : undefined;
  if (first == null) {
    return false;
  }
  // RPC returns topic entries either as XDR base64 strings or decoded objects.
  const raw = typeof first === 'string' ? first : (first as { xdr?: string }).xdr;
  if (!raw) {
    return false;
  }
  try {
    const scVal = xdr.ScVal.fromXDR(Buffer.from(raw, 'base64'));
    if (scVal.switch().name !== 'scvSymbol') {
      return false;
    }
    return Buffer.from(symBytes(scVal)).toString('utf8') === 'payment';
  } catch {
    return false;
  }
}

/**
 * Decode the event data value (XDR base64) into typed payment fields.
 * The layout of a #[contracttype] struct is encoding-version dependent, so we
 * accept both a map keyed by field name (symbol or string keys) and a
 * positional vec in declaration order (from, to, token, amount, memo).
 * Returns null when the payload does not describe a valid payment.
 */
export function parsePaymentEventData(
  valueXdr: string | undefined | null,
): SorobanPaymentEvent | null {
  if (!valueXdr) {
    return null;
  }
  let scVal: xdr.ScVal;
  try {
    scVal = xdr.ScVal.fromXDR(Buffer.from(valueXdr, 'base64'));
  } catch {
    return null;
  }

  const layout = collectFields(scVal);
  const byName = new Map<string, xdr.ScVal>();
  const positional: xdr.ScVal[] = [];
  for (const entry of layout) {
    if (entry.name) {
      byName.set(entry.name, entry.scVal);
    }
    positional.push(entry.scVal);
  }
  const get = (name: string, index: number): xdr.ScVal | undefined =>
    byName.has(name) ? byName.get(name) : positional[index];

  const fromVal = get('from', 0);
  const toVal = get('to', 1);
  const tokenVal = get('token', 2);
  const amountVal = get('amount', 3);
  const memoVal = get('memo', 4);

  const from = addressToStr(fromVal);
  const to = addressToStr(toVal);
  const token = addressToStr(tokenVal);
  const amount = amountVal ? i128ToBigInt(amountVal) : null;
  const memo = memoVal ? stringOf(memoVal) : '';

  // Reconciliation requires all three addresses and a positive amount.
  if (!from || !to || !token || amount == null || amount <= 0n) {
    return null;
  }
  return { from, to, token, amountStroops: amount, memo: memo ?? '' };
}

interface FieldEntry {
  name?: string;
  scVal: xdr.ScVal;
}

/** Flatten a data ScVal into ordered fields with optional map-key names. */
function collectFields(scVal: xdr.ScVal): FieldEntry[] {
  try {
    switch (scVal.switch().name) {
      case 'scvVec': {
        return (scVal.vec() ?? []).map((item) => ({ scVal: item }));
      }
      case 'scvMap': {
        const entries: FieldEntry[] = [];
        for (const entry of scVal.map() ?? []) {
          entries.push({ name: keyName(entry.key()), scVal: entry.val() });
        }
        return entries;
      }
      default:
        return [];
    }
  } catch {
    return [];
  }
}

function keyName(key: xdr.ScVal): string | undefined {
  try {
    switch (key.switch().name) {
      case 'scvSymbol':
        return Buffer.from(symBytes(key)).toString('utf8');
      case 'scvString':
        return Buffer.from(key.str() ?? Buffer.alloc(0)).toString('utf8');
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/** Decode an xdr.ScVal address (scvAddress) to a G…/C… string, or null. */
function addressToStr(scVal: xdr.ScVal | undefined): string | null {
  if (!scVal || scVal.switch().name !== 'scvAddress') {
    return null;
  }
  const address = scVal.address() as unknown as {
    switch: () => { name: string };
    accountId?: () => unknown;
    contractId?: () => unknown;
  };
  try {
    const type = address.switch().name;
    if (type === 'scAddressTypeAccount') {
      // accountId() returns the nested PublicKey union; its ed25519() arm
      // carries the raw 32-byte public key.
      const publicKey = address.accountId?.() as unknown as
        | {
            switch: () => { name: string };
            ed25519?: () => Uint8Array;
          }
        | undefined;
      const bytes = publicKey?.ed25519?.();
      if (!bytes) {
        return null;
      }
      return StrKey.encodeEd25519PublicKey(Buffer.from(bytes));
    }
    if (type === 'scAddressTypeContract') {
      const contractId = address.contractId?.() as Uint8Array | undefined;
      if (!contractId) {
        return null;
      }
      return StrKey.encodeContract(Buffer.from(contractId));
    }
    return null;
  } catch {
    return null;
  }
}

/** Read the integer out of an scvI128 ScVal. */
function i128ToBigInt(scVal: xdr.ScVal): bigint | null {
  try {
    if (scVal.switch().name !== 'scvI128') {
      return null;
    }
    const parts = scVal.i128();
    const readPart = (name: 'lo' | 'hi'): bigint | null => {
      const holder = parts as unknown as Record<string, unknown>;
      const attr = holder[name];
      let value: unknown;
      if (typeof attr === 'function') {
        // js-xdr accessors are prototype methods that need `this` bound to the
        // parts instance.
        value = (attr as (this: unknown) => unknown).call(parts);
      } else {
        value = attr;
      }
      if (typeof value === 'bigint') {
        return value;
      }
      if (value && typeof (value as { toBigInt?: unknown }).toBigInt === 'function') {
        return (value as { toBigInt: () => bigint }).toBigInt();
      }
      return BigInt(String(value));
    };
    const hi = readPart('hi');
    const lo = readPart('lo');
    if (hi == null || lo == null) {
      return null;
    }
    return (hi << 64n) | lo;
  } catch {
    return null;
  }
}

/** Read a string out of an scvString ScVal (empty string when not a string). */
function stringOf(scVal: xdr.ScVal): string | null {
  try {
    if (scVal.switch().name !== 'scvString') {
      return null;
    }
    return Buffer.from(scVal.str() ?? Buffer.alloc(0)).toString('utf8');
  } catch {
    return null;
  }
}

function symBytes(scVal: xdr.ScVal): Uint8Array {
  return (scVal.sym() ?? Buffer.alloc(0)) as Uint8Array;
}

/** Convert stroops to a decimal units string (e.g. XLM 7 decimals). */
export function stroopsToUnits(stroops: bigint, decimals: number): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const factor = 10n ** BigInt(decimals);
  const whole = abs / factor;
  let fraction = (abs % factor).toString().padStart(decimals, '0').replace(/0+$/, '');
  if (fraction.length === 0 && whole === 0n && negative) {
    return '0';
  }
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}
