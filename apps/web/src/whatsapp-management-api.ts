import { useQuery } from '@tanstack/react-query';
import { apiRequest } from './api';
import { useAuth } from './auth';

export interface WhatsAppHealth {
  checkedAt: string;
  localStatus: string;
  providerStatus: string;
  phone: { number: string | null; verifiedName: string | null; quality: string | null };
  messagingLimit: string | null;
  accountReview: string | null;
  businessVerification: string | null;
  token: { valid: boolean | null; expiresAt: string | null; missingPermissions: string[] | null };
  webhook: { subscribed: boolean | null; lastReceivedAt: string | null };
  templates: Record<string, number>;
  lastInboundAt: string | null;
  lastSuccessfulOutboundAt: string | null;
  lastError: { code: string | null; at: string; guidance: string } | null;
  entities: Array<{
    type: string | null;
    status: string;
    info: string[];
    errors: Array<{ code: number | null; description: string | null; solution: string | null }>;
  }>;
  unavailable: Record<string, { code: number | null; reason: string }>;
  managerUrl: string;
}
export interface WhatsAppBilling {
  mode: 'META_DIRECT';
  managerUrl: string;
  checkedAt: string;
  start: string;
  end: string;
  paymentMethodStatus: 'CHECK_IN_META';
  currency: string | null;
  reportedCost: number | null;
  volume: number | null;
  unavailable: Record<string, { reason: string; code: number | null }>;
  rateCard: {
    source: string;
    verifiedAt: string;
    effectiveFrom: string;
    effectiveUntil: string;
    currencies: string[];
  };
  breakdown: Array<{
    start: number | null;
    end: number | null;
    country: string | null;
    category: string | null;
    pricingType: string | null;
    volume: number | null;
    cost: number | null;
  }>;
}
export interface WhatsAppCostEstimate {
  category: string;
  currency: string;
  estimatedAt: string;
  sendAt: string;
  eligibleRecipients: number;
  free: number;
  paid: number;
  unknown: number;
  estimatedCost: number | null;
  knownSubtotal: number;
  unavailableReason: string | null;
  rateCard: WhatsAppBilling['rateCard'];
  breakdown: Array<{
    market: string;
    recipients: number;
    free: number;
    paid: number;
    unknown: number;
    unitPrice: number | null;
    subtotal: number;
  }>;
}
export function useWhatsAppHealth(
  projectId: string | undefined,
  connectionId: string,
  enabled = true,
) {
  const { accessToken } = useAuth();
  return useQuery({
    queryKey: ['whatsapp-health', projectId, connectionId],
    enabled: Boolean(projectId && connectionId && enabled),
    queryFn: () =>
      apiRequest<WhatsAppHealth>(
        `/api/v1/projects/${projectId}/channels/${connectionId}/whatsapp/health`,
        {},
        accessToken,
      ),
    staleTime: 60_000,
    retry: false,
  });
}
export function useWhatsAppBilling(
  projectId: string | undefined,
  connectionId: string,
  enabled: boolean,
  days = 30,
) {
  const { accessToken } = useAuth();
  return useQuery({
    queryKey: ['whatsapp-billing', projectId, connectionId, days],
    enabled: Boolean(projectId && connectionId && enabled),
    queryFn: () =>
      apiRequest<WhatsAppBilling>(
        `/api/v1/projects/${projectId}/channels/${connectionId}/whatsapp/billing?days=${days}`,
        {},
        accessToken,
      ),
    staleTime: 60_000,
    retry: false,
  });
}
export function formatWhatsAppMoney(value: number | null, currency: string | null) {
  if (value === null || !currency) return 'Unavailable';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 4,
    }).format(value);
  } catch {
    return `${value.toFixed(4)} ${currency}`;
  }
}
