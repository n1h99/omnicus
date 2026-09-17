# Omnicus operator guide

Status reviewed: 2026-09-10.

This guide describes the current deployed workflows. Provider restrictions are
part of the product contract; a queued operation is not delivery evidence.

## Email Inbox — local addition, rollout pending

For the locally implemented Email Inbox, use [EMAIL_INBOX.md](EMAIL_INBOX.md)
for rollout, domain/MX setup, sender assignments, Compose/Drafts and
Send email → Wait for reply examples. This addition is not yet deployed.
The customer pays Resend directly; Omnicus does not collect cards or maintain a balance.

## Manual contacts and CRM state

Open `Contacts` and use the create-contact action to add a person manually. A
successful create persists the project contact first and queues the same
durable Cyber Pulse lead synchronization used by captured or edited contacts.
CRM availability is not allowed to roll back the local contact.

The contact action is `Archive`, not permanent deletion. Archiving preserves
channel history, automation journals and the CRM link. Open an archived contact
and use `Restore` to return it to active status.

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
| Telegram only | Text, multiple validated assets with group/separate delivery, URL buttons and action/reply buttons with graph branches. |
| WhatsApp only | Text with either one validated attachment or up to three quick-reply buttons. |

WhatsApp free-form content and quick-reply buttons require an open customer
service window. Outside the window, use a synced `APPROVED` Meta template.
Attachments and quick-reply buttons cannot be combined in the same WhatsApp
Send Message node. Telegram and WhatsApp validate media independently, so an
asset accepted for one channel is not automatically accepted for the other.

The `Track link clicks per contact` option replaces eligible HTTP(S) links with
Omnicus redirect links. Clicks appear in the contact timeline and are forwarded
to the linked Cyber Pulse lead. Telegram URL buttons are tracked as well.

Each Telegram action/reply button exposes its own output in the scenario graph.
Connect every button output to the intended next node. A disconnected required
branch can remain in a draft, but blocks Test/Publish until it is completed.

For multiple Telegram attachments, choose grouped delivery only for compatible
media. Use separate delivery when every asset must arrive as its own message.
Invalid combinations are reported before a scenario is published or executed.

## Custom field key

`Key` is the project-scoped machine name used by APIs, conditions, variables
and automation nodes. The display label is for operators; changing a label does
not change the intended meaning of the key. Use a short stable value such as
`webinar_date` and do not reuse an existing key for another business concept.

## WhatsApp templates

Open `Project -> Templates -> WhatsApp`, choose an active business channel and
select **New template**. Template management requires channel-management
permission; read-only members can inspect synced templates.

1. Choose the name, language and Marketing/Utility category.
2. Enter message text and fictional examples for each numbered variable.
3. Optionally add a text/image/video/PDF header, footer and supported reply,
   website or phone buttons. Upload a review sample for a media header.
4. Inspect **Message preview**. A newly uploaded image appears in the message;
   video/PDF use a placeholder. The saved **View** dialog is a component
   summary, not a persistent gallery of review samples.
5. Choose **Submit to Meta**. This submits for review; it does not approve the
   template or send it to contacts.
6. Use **Sync from Meta** to refresh review status. A successful sync can leave
   a template pending. Only eligible approved templates can be sent.

**Duplicate** creates a new editable copy. **Edit** is available only for
supported templates/statuses and may require a new review. Editing does not
rename or change the language/category; use Duplicate for that. **Delete**
removes the selected template language from Meta after confirmation and can
affect other numbers in the same WABA. It does not delete message history.

## WhatsApp channel center and payments

Open `Channels -> WhatsApp channel`. The page shows **Connection overview**,
**How WhatsApp works here**, then **WhatsApp channel center**.

- **Status & quality** shows sending availability, number quality, messaging
  limits, access/permissions, webhook subscription and recent activity when
  Meta provides them. Refresh to request a new check.
- Missing setup or invalid Meta access has an explanation and an authorized
  setup/settings action. Repeated failures are grouped in **Diagnostic
  details**; independent provider blocks remain visible. Past delivery errors
  are labeled separately from the current status.
- **Meta payments & costs** opens the selected business account in Meta.
  The authorized account owner adds/manages the payment method there. Omnicus
  has no wallet and does not collect card details or charge for Meta messages.
- Select the last 7, 30 or 90 days and refresh the phone's cost report. Missing
  currency, provider access or a request failure means the report is
  unavailable, not free. A valid connection or zero report does not prove a
  payment method is configured. Meta holds the final invoice.
- WhatsApp broadcasts have an estimated list-rate cost and recipient-market
  breakdown. It is an estimate, not a reservation, charge or final invoice;
  unknown recipients/costs remain explicit. A currency choice selects a rate
  card rather than converting an existing invoice.

Use only authorized customer business assets for live checks. The developer's
personal card is not needed to inspect these features. Do not infer App Review
approval from **Connection verified**, a template sync, or an Omnicus deploy.
Detailed limits and acceptance evidence: [WHATSAPP_MANAGEMENT.md](WHATSAPP_MANAGEMENT.md).

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

Click tracking has no per-campaign checkbox. It is controlled by the verified
Resend sending-domain configuration and is explained by the information banner
at the top of the editor. Enter absolute button destinations such as
`https://www.google.com`; an incomplete value such as `www.google.com` is an
inline validation issue and must not crash the page.

## Broadcasts versus automated sequences

Use `Email & SMS Broadcast` for a one-off or scheduled campaign to an audience.
Use `Automation -> Scenarios` when a user event must start a sequence containing
delays, messages, waits, conditions or channel changes.

The Broadcast editor intentionally does not embed another scenario canvas. A
second editor would duplicate graph rendering, local draft state, validation,
versioning and Test/Publish behavior without adding an execution capability.
The shared Automation runtime is the single source of truth for follow-up
chains; Broadcast remains responsible for campaign composition, audience,
schedule and reporting.

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
