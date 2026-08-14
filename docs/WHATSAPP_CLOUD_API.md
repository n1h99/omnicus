# WhatsApp Business Cloud API

Status: implemented with partial live acceptance. Provider contract reviewed against the
official Meta WhatsApp Business Platform Postman collections on 2026-08-03.
The connected test number has verified open-window automation, interactive
replies and CRM synchronization. The remaining provider gate is an approved
template outside the service window and production-volume acceptance.

Implementation behavior reviewed: 2026-08-14.

## Authoritative Meta references

The implementation is pinned to the following official Meta collections. They
are contract evidence, not copied provider payloads:

- [WhatsApp Business Platform overview](https://www.postman.com/meta/whatsapp-business-platform/overview)
- [WhatsApp Cloud API](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api)
- [Messages](https://www.postman.com/meta/whatsapp-business-platform/folder/o48mro7/messages)
- [Webhook payload reference](https://www.postman.com/meta/whatsapp-business-platform/folder/vzaxn16/webhook-payload-reference)
- [Media](https://www.postman.com/meta/whatsapp-business-platform/folder/ouu8ypo/media)
- [Templates](https://www.postman.com/meta/whatsapp-business-platform/folder/lczy75a/templates)
- [Embedded Signup](https://www.postman.com/meta/whatsapp-business-platform/collection/du6gzjv/embedded-signup)
- [Register Phone](https://www.postman.com/meta/whatsapp-business-platform/request/77hl2kg/register-phone)

Meta's collection uses a `{{Version}}` variable. Omnicus therefore requires a
configured Graph API version and never turns the version observed in an example
or test fixture into a product default.

## Provider boundary

Omnicus integrates with the official Meta-hosted WhatsApp Business Cloud API.
It does not automate WhatsApp Web, a personal WhatsApp client or an unofficial
gateway. The Graph API version is an explicit environment value and is never
silently upgraded by application code.

Meta credentials are owned by Omnicus. Cyber Pulse CRM receives only normalized
project/contact/connection/message identifiers, safe capabilities and safe
operation results. Access tokens, app secrets, raw webhooks and provider error
bodies never cross the CRM contract.

## Application-level configuration

The following values are supplied only after a Meta Developer app exists:

```text
WHATSAPP_META_APP_ID
WHATSAPP_META_APP_SECRET
WHATSAPP_META_CONFIGURATION_ID
WHATSAPP_GRAPH_API_VERSION
WHATSAPP_META_WEBHOOK_VERIFY_TOKEN
```

The app secret and webhook verification token are server-only. The app ID and
Embedded Signup configuration ID may be returned by the authenticated setup
endpoint because the Meta JavaScript SDK requires them in the browser. Missing
configuration is a normal capability state with actionable UI; it must not make
Telegram or existing project tools unhealthy.

Each connected business phone keeps its own encrypted access token and safe
WABA/phone-number identifiers. Tokens are never returned after onboarding.

## Embedded Signup

The authenticated Omnicus setup screen starts Meta Embedded Signup only when
the global configuration is complete. The browser returns the short-lived
authorization result and selected WABA/phone identifiers to Omnicus. The API
then validates that the phone belongs to that WABA, registers the number with a
write-only six-digit two-step-verification PIN, subscribes the app to the WABA
and stores the resulting connection credentials encrypted. The PIN is used only
for the registration request and is never persisted, logged or returned.

WABA webhook subscription is account-level rather than phone-level. Disabling
one Omnicus phone connection therefore cannot blindly unsubscribe the complete
WABA when another active phone connection depends on it.

Released multi-customer Embedded Signup also depends on Meta App Review and the
permissions required by the current Meta flow. The UI must explain this external
gate without requesting secrets from a CRM manager.

## Webhook trust and routing

Meta uses one application callback:

```text
GET|POST /webhooks/whatsapp
```

`GET` performs the `hub.verify_token` challenge. `POST` first validates the
exact request bytes with `X-Hub-Signature-256` and the Meta app secret. Invalid
or oversized bodies are rejected without persistence.

Only after signature verification may the handler resolve
`value.metadata.phone_number_id` and the WABA entry to a project-owned
connection. Multi-entry payloads are split into connection-owned slices before
persistence so one tenant row cannot contain another tenant's provider data.
Unknown phone IDs are acknowledged safely and are not persisted as a guessed
project event.

Provider notifications are at-least-once. Stable provider message IDs and
canonical event fingerprints deduplicate inbound messages, reactions and
status updates before normalized side effects run.

## Supported normalized messages

The initial Cloud API adapter covers the current official surface needed by
Omnicus and Cyber Pulse CRM:

- text and same-conversation replies;
- image, document, video, audio and OGG/Opus voice messages;
- static WebP stickers;
- reactions and reaction removal;
- shared contacts and static locations;
- interactive reply buttons and list replies;
- approved message templates with typed parameters;
- inbound unsupported/system/order content as safe normalized placeholders;
- outbound and inbound media through Omnicus-owned storage/provider IDs only.

Arbitrary remote media URLs are not accepted from CRM or Automation Studio.
Media is uploaded from a validated Omnicus asset to Meta and only the durable
provider media ID is reused.

The provider-specific media limits and MIME allowlists are enforced before a
request is queued. The CRM transport may keep a smaller limit than Meta's
maximum. This is a conservative product limit, not a claim about the provider.

## Customer service window and templates

A WhatsApp free-form response is allowed only while the conversation has an
open customer service window derived from the last authoritative inbound user
message. The window expiry is stored on the conversation, is not extended by an
outbound message or delivery receipt, and is checked again immediately before
the provider request.

Outside that window, a send requires an approved template fetched for the same
project, connection and WABA. Omnicus enforces this boundary even if a CRM or
automation client sends stale UI state. A template rejection is a safe failed
operation, never an uncertain provider outcome.

Templates are exposed through a normalized contract. Raw Meta template payloads
are mapped to an allowlisted name, language, category, status and component
preview. Sending uses typed text/currency/date-time/media/button parameters.

## Application-owned scheduling

Cyber Pulse may create, inspect, update and cancel one future WhatsApp text
message through the shared scheduled-message contract. The schedule must be
inside the currently open customer-service window. Omnicus validates that
constraint at create/update time and repeats it when the WhatsApp worker claims
the due outbox record.

WhatsApp schedules are one-shot: `recurrence` is absent, count is one and no
frequency is advertised. Scheduled media, interactive payloads and templates
are outside this bounded flow. Closing or expiring the service window before
delivery produces a safe failed result without a Meta call; it is not converted
silently into a template send.

## Delivery states

An HTTP success containing a `wamid` proves only that Meta accepted the
message. It maps to `SENT`, not `DELIVERED` or `READ`.

Webhook evidence advances the same message monotonically:

```text
QUEUED -> PROCESSING -> SENT -> DELIVERED -> READ
                         \-> FAILED
                         \-> DELETED (only with explicit provider evidence)
```

Duplicate and out-of-order notifications cannot downgrade `READ` to
`DELIVERED` or `SENT`. A transport timeout after a request may have reached
Meta becomes `UNKNOWN` and is not retried blindly.

Opening an authorized WhatsApp conversation in CRM can queue Meta's supported
mark-as-read operation for inbound `wamid` values. This is an external side
effect with project/connection/conversation scope and an idempotency key.

## Explicit provider differences

The WhatsApp capability response keeps unsupported Telegram controls hidden.
The first release does not claim Telegram-style pinning, silent delivery,
message effects, video notes, albums, bot commands, Telegram reply keyboards,
streaming drafts or recurring schedules for WhatsApp. One-time text scheduling
is the only advertised WhatsApp schedule capability.

WhatsApp interactive buttons/lists and approved templates have their own typed
composer controls. Telegram entities and rich-message payloads are not sent to
WhatsApp.

## Live acceptance gate

Completed live checks on the connected test route include website-triggered
contact creation, open-window text, quick-reply buttons, inbound button/text
responses, branch continuation and bidirectional CRM history. The closed-window
guard also rejects free-form or incomplete template configuration as expected.

The remaining combined acceptance run must verify:

1. Embedded Signup and encrypted credential persistence.
2. WABA subscription and signed webhook challenge/delivery.
3. Inbound text, media, voice, contact, location, reply and reaction.
4. Free-form send inside the customer service window.
5. Approved template send outside the window and rejection of free-form text.
6. Interactive reply button and list callbacks.
7. `SENT -> DELIVERED -> READ` plus safe `FAILED` handling.
8. CRM mark-as-read behavior and unread counters.
9. Duplicate webhook delivery and out-of-order status handling.
10. Project/connection/contact isolation using two deliberately different
    routes.
11. Automation response and template-based WhatsApp broadcast.
12. Disconnect/reconnect UI updates without page reload.

Items already evidenced above remain live-verified. Approved-template delivery
outside the window, production-scale broadcast/rate behavior and any untested
multi-account route remain explicitly unverified until real customer Meta
assets are supplied.
