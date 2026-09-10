import snapshot from './meta-rate-card.json';

export const whatsAppRateCard = {
  source: snapshot.source,
  verifiedAt: snapshot.verifiedAt,
  effectiveFrom: snapshot.effectiveFrom,
  effectiveUntil: snapshot.effectiveUntil,
  currencies: Object.keys(snapshot.cards),
};

const prefixes: Array<[string, string]> = [];
const add = (market: string, codes: string) =>
  codes.split(' ').forEach((code) => prefixes.push([code, market]));
for (const [market, code] of Object.entries({
  Argentina: '54',
  Brazil: '55',
  Chile: '56',
  Colombia: '57',
  Egypt: '20',
  France: '33',
  Germany: '49',
  'Hong Kong': '852',
  Hungary: '36',
  India: '91',
  Indonesia: '62',
  Israel: '972',
  Italy: '39',
  Malaysia: '60',
  Mexico: '52',
  Netherlands: '31',
  Nigeria: '234',
  Pakistan: '92',
  Peru: '51',
  Poland: '48',
  Qatar: '974',
  Romania: '40',
  Russia: '7',
  'Saudi Arabia': '966',
  Singapore: '65',
  'South Africa': '27',
  Spain: '34',
  Turkey: '90',
  'United Arab Emirates': '971',
  'United Kingdom': '44',
  'North America': '1',
}))
  add(market, code);
add(
  'Rest of Africa',
  '213 244 229 267 226 257 237 235 242 291 251 241 220 233 245 225 254 266 231 218 261 265 223 222 212 258 264 227 250 221 232 252 211 249 268 255 228 216 256 260 263',
);
add('Rest of Asia Pacific', '93 61 880 855 86 81 856 976 977 64 675 63 94 886 992 66 993 998 84');
add(
  'Rest of Central & Eastern Europe',
  '355 374 994 375 359 385 420 995 30 371 370 373 389 381 421 386 380',
);
add('Rest of Western Europe', '43 32 45 358 353 47 351 46 41');
add(
  'Rest of Latin America',
  '591 506 1809 1829 1849 593 503 502 509 504 1658 1876 505 507 595 1787 1939 598 58',
);
add('Rest of Middle East', '973 964 962 965 961 968 967');
// Other NANP territories are not the US or Canada. Match before the shared +1 prefix.
add(
  'Other',
  '1242 1246 1264 1268 1284 1340 1345 1441 1473 1649 1664 1670 1671 1684 1721 1758 1767 1784 1868 1869',
);
prefixes.sort((a, b) => b[0].length - a[0].length);

export function whatsAppPricingMarket(phone: string): string | null {
  const normalized = phone.replace(/^\+/, '');
  if (!/^[1-9]\d{6,14}$/.test(normalized)) return null;
  return prefixes.find(([prefix]) => normalized.startsWith(prefix))?.[1] ?? 'Other';
}

export interface WhatsAppPriceRecipient {
  phone: string;
  serviceWindowExpiresAt?: Date | null;
}

/** List-rate budget estimate. Discounts and unobserved free-entry windows may lower the bill. */
export function estimateWhatsAppCost(input: {
  category: string;
  currency: string;
  at: Date;
  recipients: WhatsAppPriceRecipient[];
}) {
  const cards = snapshot.cards as Record<
    string,
    Record<string, { marketing: number; utility: number }>
  >;
  const rates = Object.hasOwn(cards, input.currency) ? cards[input.currency] : undefined;
  // Bound the snapshot to its published period; never silently apply stale prices.
  const date = input.at.toISOString().slice(0, 10);
  const validDate = date >= snapshot.effectiveFrom && date < snapshot.effectiveUntil;
  const category = input.category.toUpperCase();
  const supported = ['MARKETING', 'UTILITY'].includes(category);
  const groups = new Map<
    string,
    {
      market: string;
      recipients: number;
      free: number;
      paid: number;
      unknown: number;
      unitPrice: number | null;
      subtotal: number;
    }
  >();
  for (const recipient of input.recipients) {
    const market = whatsAppPricingMarket(recipient.phone);
    const rate = market
      ? rates?.[market]?.[category === 'UTILITY' ? 'utility' : 'marketing']
      : undefined;
    const group = groups.get(market ?? 'Unrecognized number') ?? {
      market: market ?? 'Unrecognized number',
      recipients: 0,
      free: 0,
      paid: 0,
      unknown: 0,
      unitPrice: validDate && supported && rate !== undefined ? rate : null,
      subtotal: 0,
    };
    group.recipients++;
    if (!validDate || !supported || !market) group.unknown++;
    else if (
      category === 'UTILITY' &&
      recipient.serviceWindowExpiresAt &&
      recipient.serviceWindowExpiresAt > input.at
    )
      group.free++;
    else if (group.unitPrice === null) group.unknown++;
    else {
      group.paid++;
      group.subtotal = (Math.round(group.subtotal * 1e6) + Math.round(group.unitPrice * 1e6)) / 1e6;
    }
    groups.set(group.market, group);
  }
  const rows = [...groups.values()].sort((a, b) => a.market.localeCompare(b.market));
  const unknown = rows.reduce((sum, row) => sum + row.unknown, 0);
  const subtotal = rows.reduce((sum, row) => sum + Math.round(row.subtotal * 1e6), 0) / 1e6;
  return {
    category,
    currency: input.currency,
    estimatedAt: new Date().toISOString(),
    sendAt: input.at.toISOString(),
    eligibleRecipients: input.recipients.length,
    free: rows.reduce((sum, row) => sum + row.free, 0),
    paid: rows.reduce((sum, row) => sum + row.paid, 0),
    unknown,
    breakdown: rows,
    estimatedCost: !unknown && validDate && supported && rates ? subtotal : null,
    knownSubtotal: subtotal,
    unavailableReason: !validDate
      ? 'RATE_CARD_EXPIRED'
      : !rates
        ? 'CURRENCY_UNSUPPORTED'
        : !supported
          ? 'CATEGORY_UNSUPPORTED'
          : unknown
            ? 'RECIPIENT_UNKNOWN'
            : null,
    rateCard: whatsAppRateCard,
  };
}

export function normalizeWhatsAppPricing(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.billable !== 'boolean' || row.pricing_model !== 'PMP') return undefined;
  const category = typeof row.category === 'string' ? row.category.toLowerCase() : '';
  const type = typeof row.type === 'string' ? row.type.toLowerCase() : '';
  if (
    ![
      'marketing',
      'utility',
      'authentication',
      'authentication_international',
      'service',
      'referral_conversion',
      'marketing_lite',
    ].includes(category)
  )
    return undefined;
  if (!['regular', 'free_customer_service', 'free_entry_point'].includes(type)) return undefined;
  return { billable: row.billable, category, type, pricingModel: 'PMP' };
}
