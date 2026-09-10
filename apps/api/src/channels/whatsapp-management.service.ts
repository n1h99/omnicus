import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WhatsAppApiError, WhatsAppCloudApi, whatsAppRateCard } from '@omnicus/channel-whatsapp';
import type { ApiEnvironment } from '@omnicus/config/server';
import { DatabaseService } from '../database/database.service';
import { WhatsAppChannelsService } from './whatsapp-channels.service';

type Json = Record<string, unknown>;
const object = (v: unknown): Json =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
const text = (v: unknown): string | null => (typeof v === 'string' ? v.slice(0, 1024) : null);
const number = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const state = (v: unknown) =>
  ['AVAILABLE', 'LIMITED', 'BLOCKED'].includes(String(v)) ? String(v) : 'UNKNOWN';

function issue(error: unknown) {
  const code = error instanceof WhatsAppApiError ? (error.providerCode ?? null) : null;
  return {
    code,
    reason:
      code === 190
        ? 'The Meta access token has expired or is invalid. Reconnect this channel.'
        : code === 10 || code === 200
          ? 'Meta has not granted access to this information. Check the app permissions and assigned account.'
          : code === 4 || code === 80007
            ? 'Meta is rate limiting this account. Try again later.'
            : 'Meta did not return this information. Refresh or check WhatsApp Manager.',
  };
}

@Injectable()
export class WhatsAppManagementService {
  private readonly api = new WhatsAppCloudApi();
  constructor(
    @Inject(WhatsAppChannelsService) private readonly channels: WhatsAppChannelsService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ConfigService) private readonly config: ConfigService<ApiEnvironment, true>,
  ) {}

  async health(projectId: string, connectionId: string) {
    const { row, token, version, wabaId, phoneNumberId } = await this.channels.managementContext(
      projectId,
      connectionId,
    );
    const appId = this.config.get('WHATSAPP_META_APP_ID', { infer: true });
    const appSecret = this.config.get('WHATSAPP_META_APP_SECRET', { infer: true });
    const requests = {
      phone: this.api.readFields(
        token,
        version,
        phoneNumberId,
        'id,display_phone_number,verified_name,quality_rating',
      ),
      health: this.api.readFields(token, version, phoneNumberId, 'health_status'),
      limit: this.api.readFields(
        token,
        version,
        phoneNumberId,
        'whatsapp_business_manager_messaging_limit',
      ),
      verification: this.api.readFields(
        token,
        version,
        wabaId,
        'account_review_status,business_verification_status',
      ),
      subscription: this.api.subscribedApps(token, version, wabaId),
      token:
        appId && appSecret
          ? this.api.inspectToken(token, version, appId, appSecret)
          : Promise.reject(new Error('app_configuration_missing')),
    };
    const keys = Object.keys(requests) as Array<keyof typeof requests>;
    const results = await Promise.allSettled(Object.values(requests));
    const data: Record<string, unknown> = {},
      unavailable: Record<string, ReturnType<typeof issue>> = {};
    results.forEach((r, i) => {
      const key = keys[i]!;
      if (r.status === 'fulfilled') data[key] = r.value;
      else unavailable[key] = issue(r.reason);
    });
    const [templateGroups, lastInbound, lastOutbound, lastError] = await Promise.all([
      this.database.client.whatsAppMessageTemplate.groupBy({
        by: ['status'],
        _count: { _all: true },
        where: { projectId, connectionId },
      }),
      this.database.client.message.findFirst({
        select: { createdAt: true },
        orderBy: { createdAt: 'desc' },
        where: { projectId, connectionId, direction: 'INBOUND' },
      }),
      this.database.client.message.findFirst({
        select: { sentAt: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        where: {
          projectId,
          connectionId,
          direction: 'OUTBOUND',
          status: { in: ['SENT', 'DELIVERED', 'READ'] },
        },
      }),
      this.database.client.messageStatusEvent.findFirst({
        select: { errorCode: true, occurredAt: true },
        orderBy: { occurredAt: 'desc' },
        where: { projectId, connectionId, errorCode: { not: null } },
      }),
    ]);
    const phone = object(data.phone),
      health = object(object(data.health).health_status),
      tokenInfo = object(data.token);
    const scopes = Array.isArray(tokenInfo.scopes)
      ? tokenInfo.scopes.filter((v): v is string => typeof v === 'string')
      : [];
    const requiredScopes = ['whatsapp_business_management', 'whatsapp_business_messaging'];
    const expiresAt = number(tokenInfo.expires_at);
    const dataExpiresAt = number(tokenInfo.data_access_expires_at);
    const validToken =
      typeof tokenInfo.is_valid === 'boolean'
        ? tokenInfo.is_valid &&
          tokenInfo.app_id === appId &&
          (!expiresAt || expiresAt * 1000 > Date.now()) &&
          (!dataExpiresAt || dataExpiresAt * 1000 > Date.now())
        : null;
    const subscriptions = Array.isArray(data.subscription) ? data.subscription : null;
    const subscribed =
      subscriptions && appId
        ? subscriptions.some(
            (raw) =>
              object(object(raw).whatsapp_business_api_data).id === appId ||
              object(raw).id === appId,
          )
        : null;
    const entities = Array.isArray(health.entities)
      ? health.entities.slice(0, 20).map((raw) => {
          const e = object(raw);
          return {
            type: text(e.entity_type),
            status: state(e.can_send_message),
            info: Array.isArray(e.additional_info)
              ? e.additional_info.map(text).filter(Boolean)
              : [],
            errors: Array.isArray(e.errors)
              ? e.errors.slice(0, 10).map((raw) => {
                  const error = object(raw);
                  return {
                    code: number(error.error_code),
                    description: text(error.error_description),
                    solution: text(error.possible_solution),
                  };
                })
              : [],
          };
        })
      : [];
    const limit = object(data.limit).whatsapp_business_manager_messaging_limit;
    return {
      checkedAt: new Date().toISOString(),
      localStatus: row.status,
      providerStatus: state(health.can_send_message),
      phone: {
        number: text(phone.display_phone_number),
        verifiedName: text(phone.verified_name),
        quality: text(phone.quality_rating),
      },
      messagingLimit: typeof limit === 'string' || typeof limit === 'number' ? String(limit) : null,
      accountReview: text(object(data.verification).account_review_status),
      businessVerification: text(object(data.verification).business_verification_status),
      token: {
        valid: validToken,
        expiresAt:
          expiresAt && expiresAt < 253402300800 ? new Date(expiresAt * 1000).toISOString() : null,
        missingPermissions: Object.hasOwn(data, 'token')
          ? requiredScopes.filter((scope) => !scopes.includes(scope))
          : null,
      },
      webhook: { subscribed, lastReceivedAt: row.lastWebhookAt },
      templates: Object.fromEntries(
        templateGroups.map((group) => [group.status, group._count._all]),
      ),
      lastInboundAt: lastInbound?.createdAt ?? null,
      lastSuccessfulOutboundAt: lastOutbound?.sentAt ?? lastOutbound?.createdAt ?? null,
      lastError: lastError
        ? {
            code: lastError.errorCode,
            at: lastError.occurredAt,
            guidance: ['131042', 'META_131042'].includes(lastError.errorCode ?? '')
              ? 'Meta reported a payment problem. Check the payment method for this WhatsApp account.'
              : 'Open delivery history for the affected message.',
          }
        : null,
      entities,
      unavailable,
      managerUrl: `https://business.facebook.com/wa/manage/home/?waba_id=${encodeURIComponent(wabaId)}`,
    };
  }

  async billing(projectId: string, connectionId: string, days = 30) {
    const { token, version, wabaId, phoneNumberId } = await this.channels.managementContext(
      projectId,
      connectionId,
    );
    // Verify this exact phone belongs to this WABA before fetching any aggregate costs.
    const phone = await this.api.wabaPhoneNumber(token, version, wabaId, phoneNumberId);
    const phoneDigits = phone.displayPhoneNumber?.replace(/\D/g, '');
    const end = Math.floor(Date.now() / 1000),
      start = end - days * 86400;
    const managerUrl = `https://business.facebook.com/wa/manage/home/?waba_id=${encodeURIComponent(wabaId)}`;
    const base = {
      mode: 'META_DIRECT' as const,
      managerUrl,
      rateCard: whatsAppRateCard,
      checkedAt: new Date().toISOString(),
      start: new Date(start * 1000).toISOString(),
      end: new Date(end * 1000).toISOString(),
      paymentMethodStatus: 'CHECK_IN_META' as const,
    };
    if (!phoneDigits)
      return {
        ...base,
        currency: null,
        reportedCost: null,
        volume: null,
        breakdown: [],
        unavailable: {
          analytics: {
            code: null,
            reason:
              'Meta did not return the business phone number needed to scope the cost report.',
          },
        },
      };
    const fields = `pricing_analytics.start(${start}).end(${end}).granularity(DAILY).phone_numbers(${JSON.stringify([phoneDigits])}).dimensions(["PHONE","PRICING_CATEGORY","PRICING_TYPE","COUNTRY"])`;
    const [currencyResult, analyticsResult] = await Promise.allSettled([
      this.api.readFields(token, version, wabaId, 'currency'),
      this.api.readFields(token, version, wabaId, fields),
    ]);
    const currency =
      currencyResult.status === 'fulfilled' ? text(currencyResult.value.currency) : null;
    const unavailable: Record<string, ReturnType<typeof issue>> = {};
    if (currencyResult.status === 'rejected') unavailable.currency = issue(currencyResult.reason);
    if (!currency) unavailable.currency ??= issue(null);
    if (analyticsResult.status === 'rejected')
      unavailable.analytics = issue(analyticsResult.reason);
    const analytics =
      analyticsResult.status === 'fulfilled' ? object(analyticsResult.value.pricing_analytics) : {};
    if (analyticsResult.status === 'fulfilled' && !Array.isArray(analytics.data))
      unavailable.analytics = issue(null);
    const rows = Array.isArray(analytics.data)
      ? analytics.data.flatMap((raw) => {
          const points = object(raw).data_points;
          return Array.isArray(points)
            ? points.flatMap((raw) => {
                const p = object(raw);
                // Never expose another number's costs if Meta returns an unexpected unfiltered response.
                if (String(p.phone_number ?? '').replace(/\D/g, '') !== phoneDigits) {
                  unavailable.analytics = issue(null);
                  return [];
                }
                return [
                  {
                    start: number(p.start),
                    end: number(p.end),
                    country: text(p.country),
                    category: text(p.pricing_category),
                    pricingType: text(p.pricing_type),
                    volume: number(p.volume),
                    cost: number(p.cost),
                  },
                ];
              })
            : ((unavailable.analytics = issue(null)), []);
        })
      : [];
    const allCosts =
      !unavailable.analytics && !unavailable.currency && rows.every((row) => row.cost !== null);
    return {
      ...base,
      currency,
      unavailable,
      breakdown: rows,
      reportedCost: allCosts
        ? rows.reduce((sum, row) => sum + Math.round(row.cost! * 1e6), 0) / 1e6
        : null,
      volume:
        !unavailable.analytics && rows.every((row) => row.volume !== null)
          ? rows.reduce((sum, row) => sum + row.volume!, 0)
          : null,
    };
  }
}
