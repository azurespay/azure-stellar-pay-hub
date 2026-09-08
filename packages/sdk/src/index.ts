import { StellarNetwork } from './stellar';
import type { StellarNetworkConfig } from './stellar';

export { ApiClient } from './client';
export type { ApiClientConfig, ApiClientError, RequestOptions } from './client';
export { SorobanSubmissionError, StellarNetwork } from './stellar';
export type { PaymentTxInput, SubmitResult, StellarNetworkConfig } from './stellar';

export function createStellarNetwork(config: StellarNetworkConfig): StellarNetwork {
  return new StellarNetwork(config);
}
