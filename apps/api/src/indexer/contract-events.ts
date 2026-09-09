import { xdr } from '@stellar/stellar-sdk';
import {
  addressToStr,
  collectFields,
  i128ToBigInt,
  stringOf,
  topicName,
  u64ToBigInt,
} from './soroban-event';

/**
 * Typed parsers for the events published by the platform's Soroban contracts
 * (escrow / invoices / subscriptions / treasury / merchant). Each parser is
 * tolerant of the `#[contracttype]` struct encoding (positional vec vs
 * name-keyed map), the same way the payment event parser is, so a contract
 * SDK upgrade does not break reconciliation.
 */

export interface ParsedEvent {
  topic: string;
  [key: string]: unknown;
}

function decodeFields(valueXdr: string | undefined | null): {
  byName: Map<string, xdr.ScVal>;
  positional: xdr.ScVal[];
} {
  const byName = new Map<string, xdr.ScVal>();
  const positional: xdr.ScVal[] = [];
  if (!valueXdr) {
    return { byName, positional };
  }
  let scVal: xdr.ScVal;
  try {
    scVal = xdr.ScVal.fromXDR(Buffer.from(valueXdr, 'base64'));
  } catch {
    return { byName, positional };
  }
  for (const entry of collectFields(scVal)) {
    if (entry.name) {
      byName.set(entry.name, entry.scVal);
    }
    positional.push(entry.scVal);
  }
  return { byName, positional };
}

class FieldReader {
  constructor(
    private readonly byName: Map<string, xdr.ScVal>,
    private readonly positional: xdr.ScVal[],
  ) {}

  get(name: string, index: number): xdr.ScVal | undefined {
    return this.byName.has(name) ? this.byName.get(name) : this.positional[index];
  }

  address(name: string, index: number): string | null {
    return addressToStr(this.get(name, index));
  }

  u64(name: string, index: number): bigint | null {
    return u64ToBigInt(this.get(name, index));
  }

  i128(name: string, index: number): bigint | null {
    return i128ToBigInt(this.get(name, index));
  }

  string(name: string, index: number): string | null {
    const value = this.get(name, index);
    return value ? stringOf(value) : null;
  }
}

export function parseContractEvent(
  topic: unknown,
  valueXdr: string | undefined | null,
): ParsedEvent | null {
  const name = topicName(topic);
  if (!name) {
    return null;
  }
  const { byName, positional } = decodeFields(valueXdr);
  const fields = new FieldReader(byName, positional);

  switch (name) {
    // ── escrow ───────────────────────────────────────────────────────────
    case 'created': {
      const id = fields.u64('id', 0);
      const initiator = fields.address('initiator', 1);
      const counterparty = fields.address('counterparty', 2);
      const amount = fields.i128('amount', 3);
      if (id == null || !initiator || !counterparty || amount == null) return null;
      return { topic: name, id, initiator, counterparty, amountStroops: amount };
    }
    case 'released':
    case 'refund': {
      const id = fields.u64('id', 0);
      const to = fields.address('to', 1);
      const amount = fields.i128('amount', 2);
      if (id == null || !to || amount == null) return null;
      return { topic: name, id, to, amountStroops: amount };
    }
    // ── invoices ─────────────────────────────────────────────────────────
    case 'issued': {
      const id = fields.u64('id', 0);
      const merchant = fields.address('merchant', 1);
      const customer = fields.address('customer', 2);
      const amount = fields.i128('amount', 3);
      if (id == null || !merchant || !customer || amount == null) return null;
      return { topic: name, id, merchant, customer, amountStroops: amount };
    }
    case 'paid': {
      const id = fields.u64('id', 0);
      const payer = fields.address('payer', 1);
      const merchant = fields.address('merchant', 2);
      const amount = fields.i128('amount', 3);
      if (id == null || !payer || !merchant || amount == null) return null;
      return { topic: name, id, payer, merchant, amountStroops: amount };
    }
    case 'cancel': {
      const id = fields.u64('id', 0);
      const merchant = fields.address('merchant', 1);
      if (id == null || !merchant) return null;
      return { topic: name, id, merchant };
    }
    // ── subscriptions ────────────────────────────────────────────────────
    case 'plan': {
      const id = fields.u64('id', 0);
      const merchant = fields.address('merchant', 1);
      const amount = fields.i128('amount', 2);
      if (id == null || !merchant || amount == null) return null;
      return { topic: name, id, merchant, amountStroops: amount };
    }
    case 'sub': {
      const id = fields.u64('id', 0);
      const subscriber = fields.address('subscriber', 1);
      const planId = fields.u64('plan_id', 2);
      if (id == null || !subscriber || planId == null) return null;
      return { topic: name, id, subscriber, planId };
    }
    case 'renew': {
      const id = fields.u64('id', 0);
      const planId = fields.u64('plan_id', 1);
      const amount = fields.i128('amount', 2);
      const merchant = fields.address('merchant', 3);
      if (id == null || planId == null || amount == null || !merchant) return null;
      return { topic: name, id, planId, amountStroops: amount, merchant };
    }
    // ── treasury ─────────────────────────────────────────────────────────
    case 'deposit': {
      const token = fields.address('token', 0);
      const from = fields.address('from', 1);
      const amount = fields.i128('amount', 2);
      if (!token || !from || amount == null) return null;
      return { topic: name, token, from, amountStroops: amount };
    }
    case 'withdraw': {
      const token = fields.address('token', 0);
      const to = fields.address('to', 1);
      const amount = fields.i128('amount', 2);
      const by = fields.address('by', 3);
      if (!token || !to || amount == null || !by) return null;
      return { topic: name, token, to, amountStroops: amount, by };
    }
    case 'wprop': {
      const id = fields.u64('id', 0);
      const token = fields.address('token', 1);
      const to = fields.address('to', 2);
      const amount = fields.i128('amount', 3);
      const by = fields.address('by', 4);
      if (id == null || !token || !to || amount == null || !by) return null;
      return { topic: name, id, token, to, amountStroops: amount, by };
    }
    case 'wappr': {
      const id = fields.u64('id', 0);
      const member = fields.address('member', 1);
      if (id == null || !member) return null;
      return { topic: name, id, member };
    }
    case 'wexec': {
      const id = fields.u64('id', 0);
      const token = fields.address('token', 1);
      const to = fields.address('to', 2);
      const amount = fields.i128('amount', 3);
      if (id == null || !token || !to || amount == null) return null;
      return { topic: name, id, token, to, amountStroops: amount };
    }
    // ── merchant ─────────────────────────────────────────────────────────
    case 'reg': {
      const id = fields.u64('id', 0);
      const owner = fields.address('owner', 1);
      // NOTE: must not shadow the outer `name` (the event topic) — that bug
      // made `topic` carry the merchant name instead of `reg`.
      const merchantName = fields.string('name', 2);
      if (id == null || !owner || merchantName == null) return null;
      return { topic: name, id, owner, name: merchantName };
    }
    case 'sale': {
      const id = fields.u64('id', 0);
      const token = fields.address('token', 1);
      const amount = fields.i128('amount', 2);
      if (id == null || !token || amount == null) return null;
      return { topic: name, id, token, amountStroops: amount };
    }
    case 'settle': {
      const id = fields.u64('id', 0);
      const token = fields.address('token', 1);
      const amount = fields.i128('amount', 2);
      const commission = fields.i128('commission', 3);
      const to = fields.address('to', 4);
      if (id == null || !token || amount == null || commission == null || !to) return null;
      return { topic: name, id, token, amountStroops: amount, commissionStroops: commission, to };
    }
    default:
      return null;
  }
}