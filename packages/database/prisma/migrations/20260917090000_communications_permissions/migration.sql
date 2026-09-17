INSERT INTO "permissions" ("id", "code", "description") VALUES
('communications-read-20260917', 'communications:read', 'View project contact communications'),
('communications-send-20260917', 'communications:send', 'Send project contact communications')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "project_role_permissions" ("projectId", "projectRoleId", "permissionId")
SELECT r."projectId", r."id", p."id"
FROM "project_roles" r
CROSS JOIN "permissions" p
WHERE r."system" = true
  AND r."normalizedName" = 'project-admin'
  AND p."code" IN ('communications:read', 'communications:send')
ON CONFLICT DO NOTHING;

INSERT INTO "project_role_permissions" ("projectId", "projectRoleId", "permissionId")
SELECT r."projectId", r."id", p."id"
FROM "project_roles" r
CROSS JOIN "permissions" p
WHERE r."system" = true
  AND r."normalizedName" = 'contact-manager'
  AND p."code" IN ('communications:read', 'communications:send')
ON CONFLICT DO NOTHING;

INSERT INTO "project_role_permissions" ("projectId", "projectRoleId", "permissionId")
SELECT r."projectId", r."id", p."id"
FROM "project_roles" r
CROSS JOIN "permissions" p
WHERE r."system" = true
  AND r."normalizedName" = 'viewer'
  AND p."code" = 'communications:read'
ON CONFLICT DO NOTHING;
