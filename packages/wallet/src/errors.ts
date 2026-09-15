export class WalletError extends Error {
  readonly code: string;

  constructor(message: string, code = 'WALLET_ERROR') {
    super(message);
    this.name = 'WalletError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class UserRejectionError extends WalletError {
  constructor(message = 'Transaction or connection was rejected by the user') {
    super(message, 'USER_REJECTION');
    this.name = 'UserRejectionError';
  }
}

export class WalletTimeoutError extends WalletError {
  constructor(message = 'Wallet request timed out. Please try again') {
    super(message, 'TIMEOUT');
    this.name = 'WalletTimeoutError';
  }
}

export class ProtocolError extends WalletError {
  constructor(message = 'Wallet protocol or transaction format error') {
    super(message, 'PROTOCOL_ERROR');
    this.name = 'ProtocolError';
  }
}
