// Provider responses are untrusted. Never persist paging.next or provider errors.
export type MetaLeadPayload = {
  leadId: string;
  formId: string;
  pageId: string;
  createdAt: string;
  name?: string;
  email?: string;
  phone?: string;
  countryOfResidence?: string;
};

export class MetaGraphError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeMetaLead(value: unknown, pageId: string, formId: string): MetaLeadPayload {
  const item = record(value);
  if (
    typeof item.id !== 'string' ||
    !/^\d{1,30}$/.test(item.id) ||
    item.form_id !== formId ||
    typeof item.created_time !== 'string' ||
    !Number.isFinite(Date.parse(item.created_time)) ||
    !Array.isArray(item.field_data)
  ) {
    throw new MetaGraphError('META_LEAD_PAYLOAD_INVALID');
  }
  const fields = new Map<string, string>();
  for (const raw of item.field_data) {
    const field = record(raw);
    if (
      typeof field.name === 'string' &&
      Array.isArray(field.values) &&
      typeof field.values[0] === 'string'
    ) {
      fields.set(field.name, field.values[0].trim());
    }
  }
  const result: MetaLeadPayload = {
    leadId: item.id,
    formId,
    pageId,
    createdAt: new Date(item.created_time).toISOString(),
  };
  const mapping = {
    name: ['full_name', 300],
    email: ['email', 320],
    phone: ['phone_number', 80],
    countryOfResidence: ['country_of_residence:', 160],
  } as const;
  for (const [key, [field, limit]] of Object.entries(mapping)) {
    const text = fields.get(field);
    if (text) result[key as keyof typeof mapping] = text.slice(0, limit);
  }
  return result;
}

export class MetaGraphClient {
  constructor(
    private readonly token: string,
    private readonly version: string,
  ) {
    if (!/^v\d{1,3}\.\d{1,2}$/.test(version))
      throw new MetaGraphError('META_GRAPH_VERSION_INVALID');
  }

  async get(path: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
    if (!/^(?:me|\d{1,30}(?:\/leads)?)$/.test(path))
      throw new MetaGraphError('META_GRAPH_PATH_INVALID');
    const url = new URL(`https://graph.facebook.com/${this.version}/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
    } catch {
      throw new MetaGraphError('META_GRAPH_UNAVAILABLE');
    }
    if (!response.ok)
      throw new MetaGraphError(
        response.status === 429 ? 'META_GRAPH_RATE_LIMITED' : 'META_GRAPH_ACCESS_FAILED',
      );
    const text = await response.text();
    if (text.length > 2_000_000) throw new MetaGraphError('META_GRAPH_RESPONSE_TOO_LARGE');
    try {
      const body = record(JSON.parse(text));
      if (body.error) throw new Error();
      return body;
    } catch {
      throw new MetaGraphError('META_GRAPH_RESPONSE_INVALID');
    }
  }

  async lead(id: string, pageId: string, formId: string) {
    return normalizeMetaLead(
      await this.get(id, { fields: 'id,created_time,form_id,field_data' }),
      pageId,
      formId,
    );
  }

  async page(formId: string, after?: string | null) {
    const result = await this.get(`${formId}/leads`, {
      fields: 'id,created_time,form_id,field_data',
      limit: '100',
      ...(after ? { after } : {}),
    });
    if (!Array.isArray(result.data)) throw new MetaGraphError('META_GRAPH_RESPONSE_INVALID');
    const paging = record(result.paging);
    const cursor = record(paging.cursors).after;
    if (paging.next && (typeof cursor !== 'string' || cursor.length > 4096 || cursor === after))
      throw new MetaGraphError('META_GRAPH_CURSOR_INVALID');
    return { items: result.data as unknown[], after: paging.next ? (cursor as string) : null };
  }
}
