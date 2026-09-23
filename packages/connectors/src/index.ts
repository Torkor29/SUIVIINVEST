export * from './connector.ts';
export * from './http.ts';
export * from './csv.ts';

// Connecteurs concrets. Chacun est isolé : l'échec de l'un n'empêche jamais les
// autres de se synchroniser (exigence « une panne DEGIRO ne bloque pas MetaMask »).
export { degiroConnector } from './providers/degiro.ts';
export { tradeRepublicConnector } from './providers/trade-republic.ts';
export { creditAgricoleConnector } from './providers/credit-agricole.ts';
export { revolutConnector } from './providers/revolut.ts';
export { metamaskConnector } from './providers/metamask.ts';
export { manualConnector } from './providers/manual.ts';
export { bitcoinConnector } from './providers/bitcoin.ts';
export { solanaConnector } from './providers/solana.ts';
export { binanceConnector, krakenConnector, coinbaseConnector, bitpandaConnector } from './providers/exchanges.ts';
export {
  enableBankingConnector,
  EnableBankingClient,
  enableBankingCredentials,
  type Aspsp,
  type EnableBankingCredentials,
} from './providers/enable-banking.ts';

import { ConnectorRegistry, type Connector } from './connector.ts';
import { degiroConnector } from './providers/degiro.ts';
import { tradeRepublicConnector } from './providers/trade-republic.ts';
import { creditAgricoleConnector } from './providers/credit-agricole.ts';
import { revolutConnector } from './providers/revolut.ts';
import { metamaskConnector } from './providers/metamask.ts';
import { manualConnector } from './providers/manual.ts';
import { bitcoinConnector } from './providers/bitcoin.ts';
import { solanaConnector } from './providers/solana.ts';
import { binanceConnector, bitpandaConnector, coinbaseConnector, krakenConnector } from './providers/exchanges.ts';
import { enableBankingConnector } from './providers/enable-banking.ts';

/** Connecteurs réellement embarqués dans cette build. */
export const builtInConnectors: readonly Connector[] = [
  degiroConnector,
  tradeRepublicConnector,
  creditAgricoleConnector,
  revolutConnector,
  metamaskConnector,
  enableBankingConnector,
  bitcoinConnector,
  solanaConnector,
  binanceConnector,
  krakenConnector,
  coinbaseConnector,
  bitpandaConnector,
  manualConnector,
];

export function createDefaultRegistry(extra: readonly Connector[] = []): ConnectorRegistry {
  return new ConnectorRegistry([...builtInConnectors, ...extra]);
}
