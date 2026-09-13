import type {
  ApiResponse,
  Asset,
  AssetBalance,
  Contact,
  Invoice,
  Merchant,
  PaymentCreateResponse,
  PaymentLink,
  Product,
  Settlement,
  TransactionRecord,
  User,
  UserPreference,
  Beneficiary,
  DashboardMetrics,
} from '@stellar-pay/types';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

export interface ApiClientConfig {
  baseUrl: string;
  /** Token provider - called per request so refresh/rotation stays transparent. */
  getToken?: () => string | null;
  fetchImpl?: typeof fetch;
  onUnauthorized?: () => void;
}

/**
 * Typed HTTP client for the Stellar Pay API. Browser + Node compatible.
 */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly getToken: () => string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly onUnauthorized?: () => void;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.getToken = config.getToken ?? (() => null);
    this.fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
    this.onUnauthorized = config.onUnauthorized;
  }

  async request<T>(options: RequestOptions): Promise<T> {
    const url = new URL(`${this.baseUrl}${options.path}`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = this.getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      if ((err as Error).name === 'TimeoutError') {
        throw new ApiClientError(0, `Request timed out — API at ${this.baseUrl} is not responding`);
      }
      if (err instanceof TypeError) {
        throw new ApiClientError(0, `Cannot reach API at ${this.baseUrl} — is the server running?`);
      }
      throw err;
    }

    if (response.status === 401) {
      this.onUnauthorized?.();
    }
    if (!response.ok) {
      let message = `Request failed with status ${response.status}`;
      try {
        const errorBody = (await response.json()) as { message?: string };
        message = errorBody.message ?? message;
      } catch {
        /* non-JSON error body */
      }
      throw new ApiClientError(response.status, message);
    }
    return (await response.json()) as T;
  }

  // ------------------------------------------------------------------ Auth

  auth = {
    challenge: (publicKey: string) =>
      this.request<{ nonce: string; message: string; expiresAt: string }>({
        method: 'POST',
        path: '/auth/challenge',
        body: { publicKey },
      }),

    verify: (body: {
      publicKey: string;
      signature: string;
      message: string;
      nonce: string;
      provider: 'FREIGHTER' | 'XBULL' | 'ALBEDO';
      deviceName?: string;
    }) =>
      this.request<{ accessToken: string; refreshToken: string; user: User }>({
        method: 'POST',
        path: '/auth/verify',
        body,
      }),

    refresh: (refreshToken: string) =>
      this.request<{ accessToken: string; refreshToken: string }>({
        method: 'POST',
        path: '/auth/refresh',
        body: { refreshToken },
      }),

    logout: () => this.request<{ ok: true }>({ method: 'POST', path: '/auth/logout' }),

    sessions: () =>
      this.request<
        ApiResponse<
          Array<{
            id: string;
            deviceName: string | null;
            ipAddress: string | null;
            userAgent: string | null;
            expiresAt: string;
            status: string;
            createdAt: string;
          }>
        >
      >({ path: '/auth/sessions' }),

    revokeSession: (sessionId: string) =>
      this.request<{ ok: true }>({ method: 'DELETE', path: `/auth/sessions/${sessionId}` }),
  };

  // ----------------------------------------------------------------- Users

  users = {
    me: () => this.request<User>({ path: '/users/me' }),

    updateProfile: (body: Record<string, unknown>) =>
      this.request<User>({ method: 'PATCH', path: '/users/me', body }),

    preferences: () => this.request<UserPreference>({ path: '/users/me/preferences' }),

    updatePreferences: (body: Record<string, unknown>) =>
      this.request<UserPreference>({ method: 'PUT', path: '/users/me/preferences', body }),

    contacts: (query?: { page?: number; pageSize?: number }) =>
      this.request<ApiResponse<Contact[]>>({ path: '/users/me/contacts', query }),

    createContact: (body: Record<string, unknown>) =>
      this.request<Contact>({ method: 'POST', path: '/users/me/contacts', body }),

    deleteContact: (id: string) =>
      this.request<{ ok: true }>({ method: 'DELETE', path: `/users/me/contacts/${id}` }),

    beneficiaries: () =>
      this.request<ApiResponse<Beneficiary[]>>({ path: '/users/me/beneficiaries' }),

    createBeneficiary: (body: Record<string, unknown>) =>
      this.request<Beneficiary>({ method: 'POST', path: '/users/me/beneficiaries', body }),

    devices: () =>
      this.request<ApiResponse<Array<{ id: string; name: string; lastActiveAt: string }>>>({
        // Devices are served by the auth module (GET /auth/devices); the old
        // '/users/me/devices' path did not exist and returned 404.
        path: '/auth/devices',
      }),

    revokeDevice: (id: string) =>
      this.request<{ ok: true }>({ method: 'DELETE', path: `/auth/devices/${id}` }),
  };

  // ---------------------------------------------------------------- Wallets

  wallet = {
    balances: (publicKey: string) =>
      this.request<AssetBalance[]>({ path: `/wallet/${publicKey}/balances` }),

    trustlines: (publicKey: string) =>
      this.request<ApiResponse<Array<{ assetCode: string; balance: string; status: string }>>>({
        path: `/wallet/${publicKey}/trustlines`,
      }),

    addTrustline: (body: { assetCode: string; assetIssuer: string; limit?: string }) =>
      this.request<{ transactionXdr: string; message: string }>({
        method: 'POST',
        path: `/wallet/trustlines`,
        body,
      }),

    removeTrustline: (body: { assetCode: string; assetIssuer: string }) =>
      this.request<{ transactionXdr: string; message: string }>({
        method: 'DELETE',
        path: '/wallet/trustlines',
        body,
      }),
  };

  // -------------------------------------------------------------- Payments

  payments = {
    create: (body: Record<string, unknown>) =>
      this.request<PaymentCreateResponse>({ method: 'POST', path: '/payments', body }),

    list: (query?: {
      page?: number;
      pageSize?: number;
      status?: string;
      direction?: string;
      assetCode?: string;
    }) => this.request<ApiResponse<TransactionRecord[]>>({ path: '/payments/history', query }),

    get: (id: string) => this.request<TransactionRecord>({ path: `/payments/${id}` }),

    receipt: (id: string) =>
      this.request<{ ipfsCid: string | null; url: string | null }>({
        path: `/payments/${id}/receipt`,
      }),

    request: (body: Record<string, unknown>) =>
      this.request<{ uri: string; qrPayload: string }>({
        method: 'POST',
        path: '/payments/request',
        body,
      }),

    simulate: (body: Record<string, unknown>) =>
      this.request<{
        fee: string;
        expectedHash: string | null;
        warnings: string[];
        assetCode?: string;
      }>({
        method: 'POST',
        path: '/payments/simulate',
        body,
      }),

    scheduled: () =>
      this.request<
        ApiResponse<
          Array<{
            id: string;
            toPublicKey: string;
            amount: string;
            nextRunAt: string;
            status: string;
          }>
        >
      >({ path: '/payments/scheduled' }),

    cancelScheduled: (id: string) =>
      this.request<{ ok: true }>({ method: 'DELETE', path: `/payments/scheduled/${id}` }),
  };

  // ---------------------------------------------------------------- Assets

  assets = {
    list: (query?: { search?: string; type?: string; page?: number; pageSize?: number }) =>
      this.request<ApiResponse<Asset[]>>({ path: '/assets', query }),

    get: (code: string) => this.request<Asset>({ path: `/assets/${code}` }),
  };

  // -------------------------------------------------------------- Merchants

  merchants = {
    register: (body: Record<string, unknown>) =>
      this.request<Merchant>({ method: 'POST', path: '/merchants', body }),

    me: () => this.request<Merchant>({ path: '/merchants/me' }),

    update: (body: Record<string, unknown>) =>
      this.request<Merchant>({ method: 'PATCH', path: '/merchants/me', body }),

    products: () => this.request<ApiResponse<Product[]>>({ path: '/merchants/me/products' }),

    createProduct: (body: Record<string, unknown>) =>
      this.request<Product>({ method: 'POST', path: '/merchants/me/products', body }),

    deleteProduct: (id: string) =>
      this.request<{ ok: true }>({ method: 'DELETE', path: `/merchants/me/products/${id}` }),

    invoices: () => this.request<ApiResponse<Invoice[]>>({ path: '/merchants/me/invoices' }),

    createInvoice: (body: Record<string, unknown>) =>
      this.request<Invoice>({ method: 'POST', path: '/merchants/me/invoices', body }),

    paymentLinks: () =>
      this.request<ApiResponse<PaymentLink[]>>({ path: '/merchants/me/payment-links' }),

    createPaymentLink: (body: Record<string, unknown>) =>
      this.request<PaymentLink>({ method: 'POST', path: '/merchants/me/payment-links', body }),

    settlements: () =>
      this.request<ApiResponse<Settlement[]>>({ path: '/merchants/me/settlements' }),

    customers: () =>
      this.request<
        ApiResponse<
          Array<{ id: string; publicKey: string; totalSpent: string; transactionCount: number }>
        >
      >({ path: '/merchants/me/customers' }),

    posCheckout: (body: {
      productIds?: string[];
      customerPublicKey?: string;
      amount?: string;
      assetCode?: string;
    }) =>
      this.request<{ uri: string; qrPayload: string; amount: string; assetCode: string }>({
        method: 'POST',
        path: '/merchants/me/pos-checkout',
        body,
      }),
  };

  // --------------------------------------------------------------- Checkout

  checkout = {
    paymentLink: (code: string) =>
      this.request<{
        id: string;
        title: string;
        description: string | null;
        amount: string | null;
        assetCode: string;
        assetIssuer: string | null;
        fixedAmount: boolean;
        merchantName: string;
        merchantLogo: string | null;
        destination: string;
        totalPayments: number;
        checkoutUrl: string;
      }>({ path: `/checkout/payment-link/${code}` }),

    invoice: (number: string) =>
      this.request<{
        id: string;
        number: string;
        title: string;
        description: string | null;
        items: unknown[];
        amount: string;
        assetCode: string;
        assetIssuer: string | null;
        status: string;
        merchantName: string;
        destination: string;
        checkoutUrl: string;
      }>({ path: `/checkout/invoice/${number}` }),

    payLink: (code: string, publicKey: string, amount?: string) =>
      this.request<{ id: string; unsignedXdr: string; amount: string }>({
        method: 'POST',
        path: `/checkout/payment-link/${code}/pay`,
        body: { publicKey, amount },
      }),

    payInvoice: (number: string, publicKey: string) =>
      this.request<{ id: string; unsignedXdr: string; amount: string }>({
        method: 'POST',
        path: `/checkout/invoice/${number}/pay`,
        body: { publicKey },
      }),
  };

  // --------------------------------------------------------------- Admin

  admin = {
    dashboard: () => this.request<DashboardMetrics>({ path: '/admin/analytics/dashboard' }),

    volume: (query?: { range?: '7d' | '30d' | '90d' }) =>
      this.request<Array<{ date: string; volume: string; transactions: number }>>({
        path: '/admin/analytics/volume',
        query,
      }),

    users: (query?: { page?: number; pageSize?: number; search?: string }) =>
      this.request<ApiResponse<Array<Record<string, unknown>>>>({ path: '/admin/users', query }),

    merchants: (query?: { page?: number; pageSize?: number }) =>
      this.request<ApiResponse<Array<Record<string, unknown>>>>({
        path: '/admin/merchants',
        query,
      }),

    transactions: (query?: { page?: number; pageSize?: number; status?: string }) =>
      this.request<ApiResponse<Array<Record<string, unknown>>>>({
        path: '/admin/transactions',
        query,
      }),

    auditLogs: (query?: { page?: number; pageSize?: number }) =>
      this.request<ApiResponse<Array<Record<string, unknown>>>>({
        path: '/admin/audit-logs',
        query,
      }),

    assets: () => this.request<ApiResponse<Asset[]>>({ path: '/admin/assets' }),

    createAsset: (body: Record<string, unknown>) =>
      this.request<Asset>({ method: 'POST', path: '/admin/assets', body }),

    notifications: (query?: { page?: number; pageSize?: number }) =>
      this.request<ApiResponse<Array<Record<string, unknown>>>>({
        path: '/admin/notifications',
        query,
      }),

    settings: () =>
      this.request<Array<{ key: string; value: unknown }>>({ path: '/admin/settings' }),

    updateSetting: (body: { key: string; value: unknown }) =>
      this.request<{ ok: true }>({ method: 'PUT', path: '/admin/settings', body }),

    updateUserStatus: (userId: string, body: { status: string; reason?: string }) =>
      this.request<{ ok: true }>({ method: 'PATCH', path: `/admin/users/${userId}/status`, body }),

    updateMerchantStatus: (merchantId: string, body: { status: string; reason?: string }) =>
      this.request<{ ok: true }>({
        method: 'PATCH',
        path: `/admin/merchants/${merchantId}/status`,
        body,
      }),

    assignRole: (body: { userId: string; role: string }) =>
      this.request<{ ok: true }>({ method: 'POST', path: '/admin/roles', body }),
  };

  // --------------------------------------------------------- On-chain escrows

  escrows = {
    list: () => this.request<Array<Record<string, unknown>>>({ path: '/escrows' }),

    get: (id: string) => this.request<Record<string, unknown>>({ path: `/escrows/${id}` }),

    create: (body: {
      initiatorPublicKey: string;
      counterpartyPublicKey: string;
      arbiterPublicKey?: string;
      assetCode?: string;
      assetIssuer?: string | null;
      amount: string;
      releaseTime: string;
      expiry?: string;
    }) =>
      this.request<{ id: string; unsignedXdr: string; message: string }>({
        method: 'POST',
        path: '/escrows',
        body,
      }),

    submit: (id: string, signedXdr: string) =>
      this.request<Record<string, unknown>>({
        method: 'POST',
        path: `/escrows/${id}/submit`,
        body: { signedXdr },
      }),

    release: (id: string, callerPublicKey: string) =>
      this.request<{ id: string; unsignedXdr: string; message: string }>({
        method: 'POST',
        path: `/escrows/${id}/release`,
        body: { callerPublicKey },
      }),

    refund: (id: string, callerPublicKey: string) =>
      this.request<{ id: string; unsignedXdr: string; message: string }>({
        method: 'POST',
        path: `/escrows/${id}/refund`,
        body: { callerPublicKey },
      }),

    confirmRelease: (id: string, signedXdr: string) =>
      this.request<Record<string, unknown>>({
        method: 'POST',
        path: `/escrows/${id}/release/confirm`,
        body: { signedXdr },
      }),

    confirmRefund: (id: string, signedXdr: string) =>
      this.request<Record<string, unknown>>({
        method: 'POST',
        path: `/escrows/${id}/refund/confirm`,
        body: { signedXdr },
      }),
  };

  // ------------------------------------------------------- On-chain contracts

  subscriptionPlans = {
    list: () => this.request<Array<Record<string, unknown>>>({ path: '/subscription-plans' }),

    create: (body: {
      name: string;
      description?: string;
      assetCode?: string;
      assetIssuer?: string | null;
      amount: string;
      intervalSeconds: number;
    }) =>
      this.request<{ id: string; unsignedXdr: string; message: string }>({
        method: 'POST',
        path: '/subscription-plans',
        body,
      }),

    submit: (id: string, signedXdr: string) =>
      this.request<Record<string, unknown>>({
        method: 'POST',
        path: `/subscription-plans/${id}/submit`,
        body: { signedXdr },
      }),

    subscribe: (planId: string, subscriberPublicKey: string) =>
      this.request<{ id: string; unsignedXdr: string; message: string }>({
        method: 'POST',
        path: `/subscription-plans/${planId}/subscribe`,
        body: { subscriberPublicKey },
      }),
  };

  subscriptions = {
    list: () => this.request<Array<Record<string, unknown>>>({ path: '/subscriptions' }),

    submit: (id: string, signedXdr: string) =>
      this.request<Record<string, unknown>>({
        method: 'POST',
        path: `/subscriptions/${id}/submit`,
        body: { signedXdr },
      }),

    renew: (id: string, callerPublicKey: string) =>
      this.request<{ id: string; unsignedXdr: string; message: string }>({
        method: 'POST',
        path: `/subscriptions/${id}/renew`,
        body: { callerPublicKey },
      }),

    confirmRenew: (id: string, signedXdr: string) =>
      this.request<Record<string, unknown>>({
        method: 'POST',
        path: `/subscriptions/${id}/renew/confirm`,
        body: { signedXdr },
      }),

    cancel: (id: string, callerPublicKey: string) =>
      this.request<{ id: string; unsignedXdr: string; message: string }>({
        method: 'POST',
        path: `/subscriptions/${id}/cancel`,
        body: { callerPublicKey },
      }),

    confirmCancel: (id: string, signedXdr: string) =>
      this.request<Record<string, unknown>>({
        method: 'POST',
        path: `/subscriptions/${id}/cancel/confirm`,
        body: { signedXdr },
      }),
  };

  treasury = {
    operations: () =>
      this.request<Array<Record<string, unknown>>>({ path: '/treasury/operations' }),

    withdrawals: () =>
      this.request<Array<Record<string, unknown>>>({ path: '/treasury/withdrawals' }),

    deposit: (body: {
      fromPublicKey: string;
      assetCode?: string;
      assetIssuer?: string | null;
      amount: string;
    }) =>
      this.request<{ id: string; unsignedXdr: string; message: string }>({
        method: 'POST',
        path: '/treasury/deposits',
        body,
      }),

    submitDeposit: (id: string, signedXdr: string) =>
      this.request<Record<string, unknown>>({
        method: 'POST',
        path: `/treasury/deposits/${id}/submit`,
        body: { signedXdr },
      }),

    proposeWithdrawal: (body: {
      proposerPublicKey: string;
      toPublicKey: string;
      assetCode?: string;
      assetIssuer?: string | null;
      amount: string;
    }) =>
      this.request<{ id: string; unsignedXdr: string; message: string }>({
        method: 'POST',
        path: '/treasury/withdrawals',
        body,
      }),

    submitProposal: (id: string, signedXdr: string) =>
      this.request<Record<string, unknown>>({
        method: 'POST',
        path: `/treasury/withdrawals/${id}/submit`,
        body: { signedXdr },
      }),
  };

  // ------------------------------------------------- On-chain invoice actions

  invoiceOnChain = {
    issue: (invoiceId: string) =>
      this.request<{ invoiceId: string; unsignedXdr: string; message: string }>({
        method: 'POST',
        path: `/merchants/me/invoices/${invoiceId}/issue-onchain`,
      }),

    submitIssue: (invoiceId: string, signedXdr: string) =>
      this.request<Record<string, unknown>>({
        method: 'POST',
        path: `/merchants/me/invoices/${invoiceId}/issue-onchain/submit`,
        body: { signedXdr },
      }),

    cancel: (invoiceId: string) =>
      this.request<{ invoiceId: string; unsignedXdr: string; message: string }>({
        method: 'POST',
        path: `/merchants/me/invoices/${invoiceId}/cancel-onchain`,
      }),

    submitCancel: (invoiceId: string, signedXdr: string) =>
      this.request<Record<string, unknown>>({
        method: 'POST',
        path: `/merchants/me/invoices/${invoiceId}/cancel-onchain/submit`,
        body: { signedXdr },
      }),

    pay: (invoiceId: string, payerPublicKey: string) =>
      this.request<{ invoiceId: string; unsignedXdr: string; message: string }>({
        method: 'POST',
        path: `/invoices/${invoiceId}/pay-onchain`,
        body: { payerPublicKey },
      }),

    submitPay: (invoiceId: string, signedXdr: string) =>
      this.request<Record<string, unknown>>({
        method: 'POST',
        path: `/invoices/${invoiceId}/pay-onchain/confirm`,
        body: { signedXdr },
      }),
  };

  // ------------------------------------------------------------ Notifications

  notifications = {
    list: (query?: { page?: number; pageSize?: number }) =>
      this.request<
        ApiResponse<
          Array<{
            id: string;
            type: string;
            title: string;
            body: string | null;
            readAt: string | null;
            createdAt: string;
          }>
        >
      >({ path: '/notifications', query }),

    markRead: (id: string) =>
      this.request<{ ok: true }>({ method: 'POST', path: `/notifications/${id}/read` }),

    markAllRead: () =>
      this.request<{ ok: true }>({ method: 'POST', path: '/notifications/read-all' }),
  };
}

export class ApiClientError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}
