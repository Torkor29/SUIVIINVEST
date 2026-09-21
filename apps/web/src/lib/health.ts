/** Accès au point /health (hors préfixe /api) utilisé par la barre supérieure. */
import type { HealthResponse } from '@suiviinvest/api-contract';
import { request } from './api.ts';

export function healthResponse(): Promise<HealthResponse> {
  return request<HealthResponse>('/health');
}
