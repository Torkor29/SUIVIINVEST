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

import { ConnectorRegistry, type Connector } from './connector.ts';
import { degiroConnector } from './providers/degiro.ts';
import { tradeRepublicConnector } from './providers/trade-republic.ts';
import { creditAgricoleConnector } from './providers/credit-agricole.ts';
import { revolutConnector } from './providers/revolut.ts';
import { metamaskConnector } from './providers/metamask.ts';
import { manualConnector } from './providers/manual.ts';

/** Connecteurs réellement embarqués dans cette build. */
export const builtInConnectors: readonly Connector[] = [
  degiroConnector,
  tradeRepublicConnector,
  creditAgricoleConnector,
  revolutConnector,
  metamaskConnector,
  manualConnector,
];

export function createDefaultRegistry(extra: readonly Connector[] = []): ConnectorRegistry {
  return new ConnectorRegistry([...builtInConnectors, ...extra]);
}
