import { ConfigService } from '@nestjs/config';
import { networkPassphrase } from '@stellar-pay/config';
import { StellarNetwork } from '@stellar-pay/sdk';
import type { EnvConfig } from '@stellar-pay/config';

/** Build the shared StellarNetwork helper from validated environment. */
export function createStellarNetwork(config: ConfigService): StellarNetwork {
  const horizonUrl = config.get<string>('HORIZON_URL') ?? 'https://horizon-testnet.stellar.org';
  const stellarNetwork = config.get<string>('STELLAR_NETWORK') ?? 'testnet';
  const passphrase =
    config.get<string>('NETWORK_PASSPHRASE') ||
    networkPassphrase({
      STELLAR_NETWORK: stellarNetwork as EnvConfig['STELLAR_NETWORK'],
      NETWORK_PASSPHRASE: undefined,
    } as EnvConfig);

  return new StellarNetwork({
    horizonUrl,
    networkPassphrase: passphrase,
    sorobanRpcUrl: config.get<string>('SOROBAN_RPC_URL') ?? undefined,
  });
}
