# Meta WhatsApp App Review runbook

Prepared for Meta App ID `969378529363534` on 2026-09-10. This file contains no
reviewer password, Meta token, app secret, webhook verify token or customer
message data. Keep those values in Meta's protected submission fields only.

## Before changing the pending request

The business verification shown in Meta is approved. The current request for
`whatsapp_business_messaging` and `whatsapp_business_management` has been in
review for almost three weeks. Do not withdraw it solely because it is old:
withdrawing normally loses the current queue position.

First complete the app metadata below, deploy and test the public URLs, check
Meta's notifications and **Required actions**, and open a developer-support case
asking whether the existing submission is stuck. Use **Change App Review** only
if Meta requests a revised submission or the submitted videos/credentials are
known to be unusable.

The current onboarding screen names `whatsapp_business_messaging` and
`whatsapp_business_management`. Meta's official Embedded Signup collection also
states that released apps need Advanced Access to `business_management` and
`whatsapp_business_management`. Because the dashboard flow is the account's
current source of truth, do not add or replace a permission blindly while the
request is pending. Ask support to confirm whether `business_management` is
implicit, separately required, or no longer required for this specific hosted
onboarding route.

## App settings checklist

Open **App settings > Basic** (or **Review your app settings** in the onboarding
use case) and verify all of the following:

- Display name: `Omnicus`.
- App icon: `apps/web/public/meta/omnicus-meta-app-icon-1024.png`. A 512 px
  alternative is beside it.
- App domain: `omnicus.app`.
- Contact email: a monitored mailbox controlled by the verified business.
- Privacy Policy URL: `https://omnicus.app/privacy`.
- Terms of Service URL: `https://omnicus.app/terms`.
- User data deletion instructions URL: `https://omnicus.app/data-deletion`.
- Category: the closest available business/customer-communication category.
- The displayed legal business/developer name must agree with the verified
  Meta business and the public policy.

After deployment, open all three legal URLs in a signed-out/private browser.
Each must return HTTP 200 and show a different page without redirecting to the
Omnicus login screen.

## Reviewer access

Create a dedicated review user and workspace. The account must remain active
for the entire review, have the permissions needed by the instructions, and not
require a one-time code that the reviewer cannot obtain. Put the username and
password only in Meta's reviewer-credentials fields.

Keep these test assets available:

- one connected test WABA and business phone number;
- one recipient phone controlled by the test team;
- one contact identity visible in the **Send test message** selector;
- one approved template if an outside-window send is demonstrated;
- a clean workspace named so the reviewer can recognize it immediately.

## Video 1: `whatsapp_business_messaging`

Record one continuous, readable video in English:

1. Show `https://omnicus.app`, the Omnicus app name and the logged-in review
   account.
2. Open the review project, **Channels**, and the active WhatsApp connection.
3. From the recipient phone, send a unique inbound message to the business
   number so the customer-service window is visibly open.
4. Show the inbound event/contact in Omnicus.
5. In **Send test message**, select that same contact, enter another unique text,
   and click **Queue test message**.
6. Show the success state/status in Omnicus.
7. Show the same unique outbound text arriving in the WhatsApp mobile app or
   WhatsApp Web on the recipient account.

Do not substitute a mock, console log or static screenshot for the received
WhatsApp message. Blur phone numbers and unrelated conversations, but keep the
unique message and relevant Omnicus controls readable.

Suggested permission explanation:

> Omnicus is a B2B customer messaging and automation platform. An authorized
> customer connects its WhatsApp Business Account and business phone through
> Meta Embedded Signup. Omnicus uses whatsapp_business_messaging to send
> messages initiated by authorized workspace users, approved broadcasts and
> customer-configured automations; to receive replies and delivery status by
> signed webhook; and to show the resulting conversation and operation status.
> Omnicus uses the official WhatsApp Business Platform and does not connect
> personal WhatsApp accounts or automate WhatsApp Web.

## Video 2: `whatsapp_business_management`

Use a separate video from the messaging video:

1. Open the review project and start **New channel > WhatsApp > Continue with
   Meta**.
2. Show the Meta-hosted Embedded Signup dialog, select the test business, WABA
   and business phone, grant access, and finish the flow.
3. Back in Omnicus, enter the test number's six-digit two-step verification PIN
   and complete connection. Show that the channel is active. This demonstrates
   the authorization-code exchange, phone validation/registration and WABA
   webhook subscription performed by the server.
4. Create a uniquely named test template with a visible Graph API/Postman call
   to `POST /{WABA-ID}/message_templates`. Keep the bearer token hidden and show
   the returned template ID/status.
5. In Omnicus, open the WhatsApp template workspace, click **Sync from Meta**,
   and show the new template and its Meta status.

The official Meta collection documents the template endpoint at
`https://graph.facebook.com/{Version}/{WABA-ID}/message_templates`. A minimal
review payload is:

```json
{
  "name": "omnicus_review_demo_20260910",
  "language": "en_US",
  "category": "UTILITY",
  "components": [
    {
      "type": "BODY",
      "text": "Your Omnicus review reference is {{1}}.",
      "example": { "body_text": [["OMNICUS-REVIEW-20260910"]] }
    }
  ]
}
```

Use the Graph API version configured in production rather than copying a
version from this document. Delete the review template later only after the
review is complete.

Suggested permission explanation:

> Omnicus uses whatsapp_business_management only for customer-authorized WABA
> onboarding and management: exchanging the Embedded Signup code, validating
> the selected WABA and phone, registering the business phone, subscribing the
> app to WABA webhooks, and reading/synchronizing that WABA's message templates
> and status. These actions are available only to authorized workspace
> administrators and are scoped to the business selected in Meta's flow.

## Support escalation for the existing request

Attach a screenshot of the pending state, the submission date, the app ID and
the permission names. Do not include tokens or passwords in the support case.

Suggested text:

> Subject: WhatsApp App Review pending almost three weeks — App ID
> 969378529363534
>
> Hello Meta Developer Support. Business verification for App ID
> 969378529363534 is approved. Our request for Advanced Access to
> whatsapp_business_messaging and whatsapp_business_management has remained In
> Review since [SUBMISSION DATE], with no reviewer feedback or Required Action.
> The production app and reviewer environment are available at
> https://omnicus.app, and the submission contains working reviewer credentials
> and separate end-to-end recordings for both permissions. Please confirm that
> the request is assigned and not blocked by missing metadata, and escalate or
> reset it if the review is stuck. We have not withdrawn it because we do not
> want to lose the current review queue position without guidance. The current
> onboarding screen requests whatsapp_business_messaging and
> whatsapp_business_management, while Meta's Embedded Signup documentation also
> references business_management. Please confirm the exact Advanced Access set
> required for this onboarding route.

## Final release check

- App settings are complete and saved.
- Public legal URLs are deployed and tested signed out.
- Reviewer credentials work in a private browser.
- Both unique videos match the exact production UI and submitted instructions.
- Meta app ID and Embedded Signup configuration ID in Railway match this app.
- `https://api.omnicus.app/health/ready` is healthy.
- `GET /webhooks/whatsapp` rejects an invalid verify token and succeeds with the
  configured Meta challenge/verify token.
- Meta app webhook uses `https://api.omnicus.app/webhooks/whatsapp` and the
  `messages` field is subscribed.
- A real inbound message and a real outbound message pass end to end.
- The support case is opened before deciding whether to withdraw and resubmit.
