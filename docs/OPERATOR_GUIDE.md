# Omnicus operator guide

Status reviewed: 2026-08-14.

This guide describes the current deployed workflows. Provider restrictions are
part of the product contract; a queued operation is not delivery evidence.

## Website registration and automatic follow-up

1. Open a project and create an Automation Studio scenario.
2. Configure the trigger node as `Website registration` and choose a stable
   `sourceKey` for the website/form integration.
3. Copy the generated endpoint and `X-Omnicus-Ingest-Key` header from Node
   settings. Never place the ingest key in browser source or public analytics.
4. Publish the scenario. A saved draft does not receive production traffic.
5. The website backend sends `POST` with a unique `Idempotency-Key`. At least
   one valid email address or phone number is required.

The public request creates or updates one project contact, records a durable
`LeadCaptureEvent`, queues the Cyber Pulse lead upsert and starts every
published `WEBSITE_REGISTRATION` scenario with the same `sourceKey`. Repeating
the same idempotency key and payload returns the original result; reusing the
key for a different payload is rejected.

## Telegram start link

Configure the trigger as `Telegram link`, select the Telegram connection and
set the start payload. Node settings generates a `t.me/<bot>?start=<payload>`
link with a copy action. Publish the scenario before testing the link. The
scenario starts only after Telegram delivers the matching `/start` update to
the selected connected bot.

## Message content in automations

| Channel mode | Current content |
| --- | --- |
| Automatic | Universal text. Omnicus chooses an available conversation route. |
| Telegram only | Text, one validated Omnicus media asset and up to eight URL buttons. |
| WhatsApp only | Text with either one validated attachment or up to three quick-reply buttons. |

WhatsApp free-form content and quick-reply buttons require an open customer
service window. Outside the window, use a synced `APPROVED` Meta template.
Attachments and quick-reply buttons cannot be combined in the same WhatsApp
Send Message node. Telegram and WhatsApp validate media independently, so an
asset accepted for one channel is not automatically accepted for the other.

The `Track link clicks per contact` option replaces eligible HTTP(S) links with
Omnicus redirect links. Clicks appear in the contact timeline and are forwarded
to the linked Cyber Pulse lead. Telegram URL buttons are tracked as well.

## Custom field key

`Key` is the project-scoped machine name used by APIs, conditions, variables
and automation nodes. The display label is for operators; changing a label does
not change the intended meaning of the key. Use a short stable value such as
`webinar_date` and do not reuse an existing key for another business concept.

## WhatsApp mailing eligibility

Meta does not provide Omnicus with a safe bulk endpoint that proves arbitrary
phone-number registration before a message is attempted. Omnicus therefore
stores evidence instead of guessing:

- `PENDING` means an eligible send has been queued but not proven;
- `AVAILABLE` follows inbound activity or authoritative delivery/read evidence;
- `UNAVAILABLE` follows Meta recipient error `131026`;
- `UNKNOWN` means no authoritative result is available.

Website registration may store WhatsApp consent separately from reachability.
For a new contact outside the 24-hour window, the first outreach still requires
an approved Meta template. Campaigns use durable recipient snapshots and
provider status callbacks; production volume remains subject to the connected
Meta account's messaging tier, quality rating and template policy.

## Email campaigns

The working email product is in the Omnicus project tool `Email & SMS
Broadcast`, not in Cyber Pulse CRM.

1. Create a campaign or reusable template.
2. Build the message from heading, text, button, image, attachment, divider,
   spacing and social-link blocks. The variable picker inserts supported
   contact variables and fallbacks.
3. Save a campaign draft or use `Save template` for the mutable template draft.
   `Publish version` creates an immutable version that Automation Studio can
   pin from a `Send email` node.
4. Select contacts or audience filters. A tag selected under `Must have tags`
   is unavailable under `Exclude tags`, and vice versa.
5. Use test send, inspect the audience estimate, then launch immediately or
   schedule the campaign.
6. Follow recipient delivery status and the project Analytics table. Resend
   webhook events are also written to the linked CRM lead history.

Campaign eligibility currently requires an active contact, a valid email and
no project suppression. Stored consent metadata is retained for audit but is
not an additional eligibility requirement. Unsubscribe, complaint, bounce and
provider suppression events add the address to the suppression list.

## Where to inspect results

- `Contacts -> Contact details`: registration metadata, WhatsApp mailing state,
  automation activity and tracked link clicks.
- `Email & SMS Broadcast -> Analytics`: email lifecycle events and target URLs.
- `Automation Activity`: execution journeys, current steps and drop-off reasons.
- `Operations & audit`: durable inbox/outbox, automation, broadcast and retry
  diagnostics.
- `System health`: live dependencies, queues and bounded operational alerts.
- Cyber Pulse lead history: linked message, tracked-link and email events.

## Deliberate limits

- SMS has no provider and remains under construction.
- Zoom/webinar attendance is not integrated. Omnicus can prove a tracked link
  click, not attendance inside the external webinar platform.
- The approved-template WhatsApp send outside the customer-service window and
  production-scale mailing must be accepted with the customer's real Meta
  business assets.
- Instagram remains outside the approved scope.

