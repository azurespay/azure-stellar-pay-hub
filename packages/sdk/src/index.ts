import { StellarNetwork } from './stellar';
import type { StellarNetworkConfig } from './stellar';

export { ApiClient } from './client';
export type { ApiClientConfig, ApiClientError, RequestOptions } from './client';
export {
  DEFAULT_STELLAR_REQUEST_TIMEOUT_MS,
  SorobanSubmissionError,
  StellarNetwork,
} from './stellar';
export type {
  ContractCallInput,
  PaymentTxInput,
  SorobanSendInput,
  StellarNetworkConfig,
  SubmitResult,
} from './stellar';
// The retry policy is configurable per network (StellarNetworkConfig.retry).
export { DEFAULT_STELLAR_RETRY, isRetryableStellarError, withRetry } from './retry';
export type { RetryConfig } from './retry';

export function createStellarNetwork(config: StellarNetworkConfig): StellarNetwork {
  return new StellarNetwork(config);
}
