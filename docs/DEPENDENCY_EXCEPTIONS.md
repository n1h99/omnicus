# Dependency audit exceptions

`pnpm audit:production` fails CI for every new high or critical production
advisory. As reviewed on 2026-08-14, the repository has no accepted audit
exceptions.

An exception is allowed only through a new ADR and must record:

- advisory ID and affected dependency path;
- verified runtime exposure;
- compensating control;
- owner and expiry date no later than 30 days;
- upstream remediation issue and removal condition.

The audit command itself is not weakened or filtered by exception IDs. A
temporary exception must use a separate, visible CI review step and may never
hide newly reported high/critical advisories.
