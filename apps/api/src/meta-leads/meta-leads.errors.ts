const messages = {
  META_LEADS_NOT_CONFIGURED: 'Save the Meta lead-form configuration first.',
  META_LEADS_CREDENTIAL_UNAVAILABLE:
    'The saved Meta credential cannot be read. Stop intake and save a replacement.',
  META_LEADS_STOP_BEFORE_EDIT: 'Stop Meta intake before changing credentials or forms.',
  META_LEADS_PAGE_IMMUTABLE:
    'The configured Page cannot be replaced while its lead history exists.',
  META_LEADS_CREDENTIALS_REQUIRED: 'Page token, App Secret and webhook verify token are required.',
  META_LEADS_PAGE_TOKEN_MISMATCH: 'This Page token belongs to a different Facebook Page.',
  META_LEADS_FORM_PAGE_MISMATCH: 'One of the selected forms does not belong to this Page.',
  META_LEADS_TEST_REQUIRED: 'Test Page access and the CRM connection before starting intake.',
  META_LEADS_LIVE_FROM_INVALID:
    'Use the current time for the first live cutover; older leads require historical preview.',
  META_LEADS_CUTOVER_IMMUTABLE: 'Resume with the original live cutover time.',
  META_LEADS_HISTORY_RANGE_INVALID:
    'Choose a past interval of at most 90 days with the end after the start.',
  META_LEADS_DISABLED: 'Start Meta intake in preview mode before continuing.',
  META_LEAD_NOT_FOUND: 'This Meta submission is not available in the selected project.',
  META_LEADS_HISTORY_CONFIRMATION_REQUIRED:
    'Explicitly confirm importing this historical submission.',
  META_LEAD_NOT_APPROVABLE: 'Only unambiguous preview results can be approved. Refresh the report.',
  META_LEAD_NOT_RETRYABLE: 'This submission is not awaiting review or retry.',
  META_LEAD_UNKNOWN_CONFIRMATION_REQUIRED:
    'Check the CRM and confirm a retry of this uncertain delivery.',
  META_LEAD_BUSY: 'This submission is still being processed. Wait and refresh.',
  META_LEADS_VERIFICATION_FAILED: 'The Meta webhook verification token is invalid.',
  META_LEADS_SIGNATURE_INVALID: 'The Meta webhook signature is invalid.',
  META_LEADS_ENVELOPE_INVALID: 'A valid Page webhook envelope is required.',
  META_LEADS_ENVELOPE_TOO_LARGE: 'The Page webhook contains too many events.',
  META_LEADS_CRM_PAIRING_REQUIRED: 'Pair this project with its CRM before configuring Meta leads.',
} as const;

export function metaError(code: keyof typeof messages) {
  return { code, message: messages[code] };
}
