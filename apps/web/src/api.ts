import { readApiBaseUrl } from './env';

export interface ApiEnvelope<T> {
  data: T;
  meta: Record<string, never>;
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly correlationId?: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

const statusReasons: Record<number, string> = {
  400: 'Review the entered values and try again.',
  401: 'Your session has expired. Sign in again.',
  403: 'You do not have permission to perform this action.',
  404: 'The requested record is no longer available.',
  409: 'The data changed in another session. Refresh and try again.',
  413: 'The selected file is too large.',
  429: 'Too many requests. Wait a moment and try again.',
  500: 'The server could not complete the action.',
  502: 'A required service is temporarily unavailable.',
  503: 'A required service is temporarily unavailable.',
};

const codeReasons: Record<string, string> = {
  AUTOMATION_SECRET_IN_USE: 'This secret is still used by a published scenario.',
  BROADCAST_CANNOT_CANCEL: 'This broadcast can no longer be cancelled.',
  BROADCAST_CANNOT_LAUNCH: 'This broadcast is not ready to launch.',
  BROADCAST_CANNOT_PAUSE: 'Only a running broadcast can be paused.',
  BROADCAST_CANNOT_RESUME: 'Only a paused broadcast can be resumed.',
  BROADCAST_CONTACTS_REQUIRED: 'Choose at least one contact for this broadcast.',
  BROADCAST_CONTENT_CHANNEL_MISMATCH:
    'Choose content that matches the selected Telegram or WhatsApp channel.',
  BROADCAST_CONTENT_INVALID: 'Choose exactly one valid message format for this broadcast.',
  BROADCAST_COPY_NAME_UNAVAILABLE: 'Choose a different name for the broadcast copy.',
  BROADCAST_MUST_BE_STOPPED: 'Stop this broadcast before making that change.',
  BROADCAST_NAME_EXISTS: 'A broadcast with this name already exists.',
  BROADCAST_NOT_ARCHIVED: 'Only an archived broadcast can be restored.',
  BROADCAST_NOT_EDITABLE: 'This broadcast can no longer be edited.',
  BROADCAST_NOT_FOUND: 'This broadcast no longer exists or is outside this project.',
  BROADCAST_NOT_RUNNING: 'Only a running broadcast can be paused.',
  BROADCAST_NOT_TERMINAL: 'Wait until the broadcast finishes before archiving it.',
  BROADCAST_SCHEDULE_MUST_BE_FUTURE: 'Choose a future delivery time.',
  BROADCAST_SEGMENT_REQUIRED: 'Choose a saved segment for this audience.',
  BROADCAST_STATE_CHANGED: 'The broadcast changed in another session. Refresh and try again.',
  BROADCAST_TAGS_INVALID: 'Review the selected audience tags.',
  BROADCAST_TEMPLATE_VERSION_INVALID: 'Choose a currently published Telegram template.',
  BROADCAST_WHATSAPP_COMPONENTS_INVALID:
    'Complete every required WhatsApp template value and review its format.',
  BROADCAST_WHATSAPP_TEMPLATE_NOT_APPROVED:
    'Choose a WhatsApp template that is still approved for this business number.',
  BROADCAST_WHATSAPP_TEMPLATE_REQUIRED: 'WhatsApp broadcasts must use an approved Meta template.',
  CHANNEL_NOT_ACTIVE: 'Activate this channel before continuing.',
  CRM_CONNECTION_NOT_PAIRED: 'Pair this CRM project before continuing.',
  CUSTOM_FIELD_KEY_EXISTS: 'A custom field with this key already exists.',
  GLOBAL_ROLE_NOT_FOUND: 'The selected global role is no longer available.',
  MEDIA_ASSET_NOT_FOUND: 'This media file no longer exists in the project library.',
  MEDIA_CANNOT_MATERIALIZE: 'This provider media file cannot be downloaded safely.',
  MEDIA_CHANNEL_INVALID: 'Choose whether this file is for Telegram or WhatsApp.',
  MEDIA_CONNECTION_NOT_FOUND: 'The channel that owns this media file is no longer available.',
  MEDIA_FILE_REQUIRED: 'Choose a file before uploading.',
  MEDIA_IDEMPOTENCY_CONFLICT:
    'This upload request was already used for a different file. Choose the file again.',
  MEDIA_KIND_INVALID: 'Choose a supported media type.',
  MEDIA_NOT_AVAILABLE: 'This media file is not ready yet.',
  MEDIA_STORAGE_NOT_CONFIGURED: 'Private media storage is not configured for this environment.',
  MEDIA_STORAGE_UNAVAILABLE: 'Private media storage is temporarily unavailable. Try again.',
  MEDIA_USED_BY_PUBLISHED_TEMPLATE: 'This file is used by a published template.',
  MESSAGE_TEMPLATE_NAME_EXISTS: 'A template with this name already exists.',
  OPERATION_NOT_FAILED: 'Only a failed operation can be retried.',
  OPERATION_CHANGED_REFRESH_REQUIRED: 'The operation changed. Refresh it before continuing.',
  OPERATION_NOT_RETRYABLE: 'This operation does not support a safe manual retry.',
  OPERATION_RECONCILIATION_UNAVAILABLE:
    'This provider outcome cannot be reconciled from the generic operations screen.',
  INVITATION_ACCOUNT_AUTH_FAILED: 'The password for the invited account is incorrect.',
  INVITATION_ALREADY_ACTIVE: 'An active invitation already exists for this account.',
  INVITATION_INVALID: 'This invitation link is invalid.',
  INVITATION_NOT_ACTIVE: 'This invitation was already used, revoked or expired.',
  INVITATION_PROFILE_REQUIRED: 'Enter a first and last name for the new account.',
  PASSWORD_RESET_INVALID: 'This reset link is invalid, expired or already used.',
  PROJECT_MEMBER_EXISTS: 'This user is already a member of the project.',
  PROJECT_ROLE_NOT_FOUND: 'The selected project role is no longer available.',
  PROJECT_SLUG_EXISTS: 'This slug is already used by another active or archived project.',
  SCENARIO_DRAFT_CONFLICT: 'This draft changed in another session. Reload it before saving.',
  SEGMENT_NAME_EXISTS: 'A segment with this name already exists.',
  TAG_NAME_EXISTS: 'A tag with this name already exists.',
  ROLE_IN_USE: 'Remove this role from assigned users before deleting it.',
  ROLE_NAME_EXISTS: 'A role with this name already exists.',
  ROLE_NAME_INVALID: 'Enter a role name containing letters or numbers.',
  ROLE_PERMISSION_NOT_FOUND: 'One or more selected permissions are unavailable.',
  SYSTEM_ROLE_IMMUTABLE: 'Built-in system roles cannot be changed.',
  TELEGRAM_CONNECTION_TEST_FAILED: 'Telegram did not confirm this connection.',
  TELEGRAM_TOKEN_INVALID: 'Telegram rejected this bot token.',
  TELEGRAM_WEBHOOK_CONNECT_FAILED: 'Telegram could not connect the webhook.',
  WHATSAPP_CONFIGURATION_INCOMPLETE:
    'Finish the Meta app, business account, phone number and access-token setup first.',
  WHATSAPP_CONFIGURATION_INVALID:
    'Review the WhatsApp Business Account ID, Phone Number ID, token and Graph API version.',
  WHATSAPP_META_CONFIGURATION_REQUIRED:
    'The Meta app is not configured on the server yet. You can keep this channel as a draft.',
  WHATSAPP_PHONE_IDENTITY_CONFLICT:
    'This WhatsApp phone number is already connected to another Omnicus project.',
  WHATSAPP_SETUP_STATE_CHANGED:
    'This WhatsApp draft changed while Meta setup was open. Refresh it before trying again.',
  WHATSAPP_SETUP_TARGET_MISMATCH:
    'The WhatsApp number selected in Meta does not match this prepared connection.',
  WHATSAPP_ACCESS_TOKEN_INVALID:
    'Meta rejected the access token. Check the token and its WhatsApp permissions.',
  WHATSAPP_ACCOUNT_VALIDATION_FAILED:
    'Meta could not confirm that this business account owns the selected phone number.',
  WHATSAPP_CONNECTION_TEST_FAILED: 'Meta did not confirm this WhatsApp connection.',
  WHATSAPP_CONNECTION_FAILED: 'Meta could not validate and connect this WhatsApp business number.',
  WHATSAPP_EMBEDDED_SIGNUP_FAILED:
    'Meta signup did not finish. Reopen the setup window and try again.',
  WHATSAPP_SERVICE_WINDOW_CLOSED:
    'This contact is outside the customer service window. Use an approved WhatsApp template.',
  WHATSAPP_TEMPLATE_REQUIRED:
    'Choose an approved WhatsApp template for recipients outside their customer service window.',
  WHATSAPP_TEMPLATE_SYNC_FAILED: 'Check the channel token and try again.',
  WHATSAPP_TEMPLATE_SAVE_FAILED:
    'Meta did not confirm the submission. Sync templates to check the result before trying again.',
  WHATSAPP_TEMPLATE_DELETE_FAILED:
    'Meta did not confirm deletion. Refresh the template list and check its current status.',
  WHATSAPP_TEMPLATE_NOT_FOUND: 'This template is no longer available for this channel.',
  WHATSAPP_TEMPLATE_NOT_EDITABLE:
    'Meta only permits editing approved, rejected or paused templates. Duplicate it to create a new template.',
  WHATSAPP_TEMPLATE_IDENTITY_IMMUTABLE:
    'Use Duplicate to change the template name, language or category.',
  WHATSAPP_TEMPLATE_SAMPLE_INVALID:
    'Use a valid JPG/PNG image (up to 5 MB), MP4 video or PDF (up to 16 MB). Check that the Meta app is configured.',
  WHATSAPP_MEDIA_UNAVAILABLE: 'This WhatsApp media file is no longer available from Meta.',
  WHATSAPP_WEBHOOK_CONNECT_FAILED: 'Meta could not connect this WhatsApp business account.',
  USER_EMAIL_EXISTS: 'A user with this email already exists.',
  USER_NOT_FOUND: 'The selected user is no longer available.',
};

function validationReason(details: unknown): string | undefined {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
  const violations = (details as { violations?: unknown }).violations;
  if (!Array.isArray(violations)) return undefined;
  const fields = violations
    .filter((violation): violation is string => typeof violation === 'string')
    .map((violation) => violation.match(/^([A-Za-z][A-Za-z0-9_.]*)\s/)?.[1])
    .filter((field): field is string => Boolean(field))
    .map((field) => field.split('.').at(-1)!)
    .map((field) => field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase());
  const unique = [...new Set(fields)];
  if (!unique.length) return undefined;
  return `Review ${unique.slice(0, 3).join(', ')}${unique.length > 3 ? ' and the other fields' : ''}.`;
}

function safeApiReason(message: string): string | undefined {
  const normalized = message.trim();
  if (!normalized || ['Request failed', 'Request validation failed'].includes(normalized))
    return undefined;
  return /[.!?]$/.test(normalized) ? normalized : `${normalized}.`;
}

export function getUserErrorMessage(
  error: unknown,
  fallback = 'The action could not be completed.',
): string {
  if (!(error instanceof ApiError)) {
    if (error instanceof TypeError && /fetch|network|load/i.test(error.message))
      return `${fallback} The server is not reachable right now.`;
    return fallback;
  }
  const reason =
    codeReasons[error.code] ??
    (error.code === 'VALIDATION_ERROR' ? validationReason(error.details) : undefined) ??
    (error.status < 500 ? safeApiReason(error.message) : undefined) ??
    statusReasons[error.status];
  const reference =
    error.status >= 500 && error.correlationId && error.correlationId !== 'unavailable'
      ? ` Reference: ${error.correlationId}.`
      : '';
  return `${fallback}${reason ? ` ${reason}` : ''}${reference}`;
}

type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | undefined;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | undefined): void {
  unauthorizedHandler = handler;
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
  accessToken?: string,
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('accept', 'application/json');
  if (options.body && !(options.body instanceof FormData)) {
    headers.set('content-type', 'application/json');
  }
  if (accessToken) {
    headers.set('authorization', `Bearer ${accessToken}`);
  }
  const response = await fetch(`${readApiBaseUrl()}${path}`, {
    ...options,
    credentials: 'omit',
    headers,
  });
  if (response.status === 401 && accessToken) {
    unauthorizedHandler?.();
  }
  if (response.status === 204) {
    return undefined as T;
  }
  const body = (await response.json()) as
    | ApiEnvelope<T>
    | {
        error?: {
          code?: string;
          correlationId?: string;
          details?: unknown;
          message?: string;
        };
      };
  if (!response.ok) {
    const error = 'error' in body ? body.error : undefined;
    throw new ApiError(
      error?.code ?? 'REQUEST_FAILED',
      error?.message ?? 'Request failed',
      response.status,
      error?.correlationId,
      error?.details,
    );
  }
  return (body as ApiEnvelope<T>).data;
}
