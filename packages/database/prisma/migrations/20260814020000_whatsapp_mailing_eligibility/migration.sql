CREATE TYPE "MarketingConsentStatus" AS ENUM ('UNKNOWN', 'GRANTED', 'REVOKED');
CREATE TYPE "WhatsAppReachabilityStatus" AS ENUM ('UNKNOWN', 'PENDING', 'AVAILABLE', 'UNAVAILABLE', 'BLOCKED');

ALTER TABLE "contacts"
  ADD COLUMN "whatsAppConsentStatus" "MarketingConsentStatus" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "whatsAppConsentSource" TEXT,
  ADD COLUMN "whatsAppConsentAt" TIMESTAMPTZ(3),
  ADD COLUMN "whatsAppOptOutAt" TIMESTAMPTZ(3);

ALTER TABLE "channel_identities"
  ADD COLUMN "whatsAppReachability" "WhatsAppReachabilityStatus",
  ADD COLUMN "whatsAppReachabilityCheckedAt" TIMESTAMPTZ(3),
  ADD COLUMN "whatsAppLastErrorCode" TEXT;

UPDATE "channel_identities"
SET
  "whatsAppReachability" = 'AVAILABLE',
  "whatsAppReachabilityCheckedAt" = "updatedAt"
WHERE "channel" = 'WHATSAPP';

UPDATE "contacts" AS contact
SET
  "whatsAppConsentStatus" = 'GRANTED',
  "whatsAppConsentSource" = 'legacy_whatsapp_identity',
  "whatsAppConsentAt" = COALESCE(contact."firstInteractionAt", contact."createdAt")
WHERE EXISTS (
  SELECT 1
  FROM "channel_identities" AS identity
  WHERE identity."projectId" = contact."projectId"
    AND identity."contactId" = contact."id"
    AND identity."channel" = 'WHATSAPP'
    AND identity."status" = 'ACTIVE'
);

UPDATE "contacts"
SET
  "whatsAppConsentStatus" = CASE
    WHEN "customFields" #>> '{leadRegistration,consents,whatsApp}' = 'true'
      THEN 'GRANTED'::"MarketingConsentStatus"
    ELSE 'REVOKED'::"MarketingConsentStatus"
  END,
  "whatsAppConsentSource" = 'legacy_website_registration',
  "whatsAppConsentAt" = CASE
    WHEN "customFields" #>> '{leadRegistration,consents,whatsApp}' = 'true'
      THEN "updatedAt"
    ELSE NULL
  END,
  "whatsAppOptOutAt" = CASE
    WHEN "customFields" #>> '{leadRegistration,consents,whatsApp}' = 'false'
      THEN "updatedAt"
    ELSE NULL
  END
WHERE "customFields" #>> '{leadRegistration,consents,whatsApp}' IN ('true', 'false');

CREATE INDEX "contacts_projectId_whatsAppConsentStatus_idx"
  ON "contacts"("projectId", "whatsAppConsentStatus");
CREATE INDEX "channel_identities_projectId_channel_whatsAppReachability_idx"
  ON "channel_identities"("projectId", "channel", "whatsAppReachability");
