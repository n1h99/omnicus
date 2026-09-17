import { DELETE_TABLES, PRESERVE_TABLES } from './postgres.mjs';

const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const sqlArray = (values) => `ARRAY[${values.map(literal).join(',')}]::text[]`;
const configTables = [
  'channel_connections',
  'scenarios',
  'scenario_versions',
  'whatsapp_message_templates',
  'broadcasts',
  'email_templates',
  'email_template_versions',
  'email_campaigns',
  'message_templates',
  'message_template_versions',
  'telegram_bot_interfaces',
  'crm_project_configs',
  'segments',
];

// Explicit operator-requested console variant, not a --writers-stopped bypass.
// Run through psql -X -v ON_ERROR_STOP=1 after the reviewed Railway shell guard.
// A provider operation already in flight cannot be recalled by PostgreSQL locks.
export function consoleResetSql(target, expectedContacts) {
  if (!Number.isSafeInteger(expectedContacts) || expectedContacts < 1)
    throw Error('A positive reviewed contact count is required.');
  const crmUrl = new URL(target.crm.baseUrl);
  if (
    crmUrl.protocol !== 'https:' ||
    crmUrl.username ||
    crmUrl.password ||
    crmUrl.search ||
    crmUrl.hash ||
    /prod/i.test(target.crm.baseUrl + target.crm.crmProjectId) ||
    target.crm.baseUrl.replace(/\/$/, '') !== crmUrl.origin ||
    !/^[0-9a-f-]{36}$/i.test(target.omnicus.projectId)
  )
    throw Error('A pinned non-production CRM origin and Omnicus project UUID are required.');
  const known = [...DELETE_TABLES, ...PRESERVE_TABLES].sort();
  return `BEGIN;
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = pg_catalog, public;
LOCK TABLE ${known.map((name) => `public."${name}"`).join(',')} IN SHARE ROW EXCLUSIVE MODE;
DO $cleanup$
DECLARE
  pid constant text := ${literal(target.omnicus.projectId)};
  deletes constant text[] := ${sqlArray(DELETE_TABLES)};
  configs constant text[] := ${sqlArray(configTables)};
  saved jsonb := '{}'; part jsonb; t text; n bigint; bytes bigint := 0;
  kept text := ''; delivered text := ''; bot_ids text[];
BEGIN
  IF current_database() <> ${literal(target.omnicus.database)} THEN RAISE EXCEPTION 'STOP: wrong database'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.projects WHERE id=pid AND name=${literal(target.omnicus.projectName)} AND status='PAUSED') THEN RAISE EXCEPTION 'STOP: project identity/status mismatch'; END IF;
  IF (SELECT count(*) FROM public.crm_project_configs WHERE "projectId"=pid) <> 1
    OR NOT EXISTS (SELECT 1 FROM public.crm_project_configs WHERE "projectId"=pid AND "crmProjectId"=${literal(target.crm.crmProjectId)} AND rtrim("baseUrl",'/')=${literal(target.crm.baseUrl.replace(/\/$/, ''))} AND enabled=false AND status='DISABLED')
    THEN RAISE EXCEPTION 'STOP: disabled staging pairing required'; END IF;
  IF (SELECT count(*) FROM public.contacts WHERE "projectId"=pid) <> ${expectedContacts} THEN RAISE EXCEPTION 'STOP: contact count changed; inspect before retry'; END IF;
  IF (SELECT array_agg(table_name::text ORDER BY table_name::text COLLATE "C") FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE') IS DISTINCT FROM ${sqlArray(known)} THEN RAISE EXCEPTION 'STOP: unreviewed schema'; END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_class c ON c.oid=g.tgrelid JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname='public' AND NOT g.tgisinternal AND NOT (g.tgname='contacts_normalize_identity' AND c.relname='contacts' AND g.tgtype=23)) THEN RAISE EXCEPTION 'STOP: unreviewed trigger'; END IF;
  IF EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND (c.relrowsecurity OR c.relkind='p')) THEN RAISE EXCEPTION 'STOP: RLS or partition'; END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint f JOIN pg_class c ON c.oid=f.conrelid JOIN pg_class p ON p.oid=f.confrelid WHERE f.contype='f' AND p.relnamespace='public'::regnamespace AND c.relnamespace<>'public'::regnamespace) THEN RAISE EXCEPTION 'STOP: cross-schema FK'; END IF;
  FOREACH t IN ARRAY ARRAY['inbox_records','outbox_records','email_deliveries'] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE "projectId"=$1 AND status::text IN (''PENDING'',''PROCESSING'',''RETRY'')',t) INTO n USING pid;
    IF n<>0 THEN RAISE EXCEPTION 'STOP: unfinished jobs in %',t; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['scheduled_messages','telegram_media_groups','scenario_executions'] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE "projectId"=$1 AND status::text IN (''QUEUED'',''PROCESSING'',''RUNNING'')',t) INTO n USING pid;
    IF n<>0 THEN RAISE EXCEPTION 'STOP: active jobs in %',t; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['delayed_actions','node_executions'] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE "projectId"=$1 AND status::text=''PROCESSING''',t) INTO n USING pid;
    IF n<>0 THEN RAISE EXCEPTION 'STOP: executing job in %',t; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['broadcasts','email_campaigns'] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE "projectId"=$1 AND status::text NOT IN (''DRAFT'',''COMPLETED'',''CANCELLED'',''FAILED'',''ARCHIVED'')',t) INTO n USING pid;
    IF n<>0 THEN RAISE EXCEPTION 'STOP: active campaign in %',t; END IF;
  END LOOP;
  FOR t IN SELECT DISTINCT unnest(deletes || configs) LOOP
    EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(r)),''[]''::jsonb) FROM (SELECT * FROM public.%I WHERE "projectId"=$1 LIMIT 20001) r',t) INTO part USING pid;
    bytes := bytes + octet_length(part::text);
    IF jsonb_array_length(part)>20000 OR bytes>104857600 THEN RAISE EXCEPTION 'STOP: snapshot limit'; END IF;
    saved := saved || jsonb_build_object(t,part);
  END LOOP;
  FOREACH t IN ARRAY configs LOOP kept := kept || (saved->t)::text; END LOOP;
  SELECT coalesce(array_agg(r->>'outboxRecordId') FILTER (WHERE r->>'outboxRecordId' IS NOT NULL),ARRAY[]::text[]) INTO bot_ids FROM jsonb_array_elements(saved->'telegram_bot_interfaces') r;
  SELECT coalesce(jsonb_agg(r),'[]'::jsonb) INTO part FROM jsonb_array_elements(saved->'outbox_records') r WHERE r->>'id'=ANY(bot_ids);
  kept := kept || part::text;
  SELECT coalesce(jsonb_agg(r),'[]'::jsonb) INTO part FROM jsonb_array_elements(saved->'email_asset_references') r WHERE r->>'ownerType'<>'EMAIL_DELIVERY';
  kept := kept || part::text;
  SELECT coalesce(jsonb_agg(r),'[]'::jsonb) INTO part FROM jsonb_array_elements(saved->'outbox_records') r WHERE NOT (r->>'id'=ANY(bot_ids));
  saved := jsonb_set(saved,'{outbox_records}',part);
  SELECT coalesce(jsonb_agg(r),'[]'::jsonb) INTO part FROM jsonb_array_elements(saved->'email_asset_references') r WHERE r->>'ownerType'='EMAIL_DELIVERY';
  saved := jsonb_set(saved,'{email_asset_references}',part);
  FOREACH t IN ARRAY ARRAY['messages','telegram_media_group_items','email_deliveries','email_asset_references','scheduled_messages','outbox_records'] LOOP delivered := delivered || (saved->t)::text; END LOOP;
  SELECT coalesce(jsonb_agg(r),'[]'::jsonb) INTO part FROM jsonb_array_elements(saved->'media_assets') r WHERE (r->>'source' IN ('TELEGRAM','WHATSAPP') OR strpos(delivered,r->>'id')>0) AND strpos(kept,r->>'id')=0;
  saved := jsonb_set(saved,'{media_assets}',part);
  FOREACH t IN ARRAY deletes LOOP
    IF t=ANY(ARRAY['email_asset_references','outbox_records','media_assets']) THEN
      EXECUTE format('DELETE FROM public.%I WHERE "projectId"=$1 AND id IN (SELECT r->>''id'' FROM jsonb_array_elements($2) r)',t) USING pid,saved->t;
    ELSE
      EXECUTE format('DELETE FROM public.%I WHERE "projectId"=$1',t) USING pid;
    END IF;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n<>jsonb_array_length(saved->t) THEN RAISE EXCEPTION 'STOP: delete count mismatch in %',t; END IF;
    RAISE NOTICE '%: deleted %',t,n;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['broadcasts','email_campaigns'] LOOP
    EXECUTE format('UPDATE public.%I SET audience=jsonb_set(audience,''{contactIds}'',''[]''::jsonb),"updatedAt"=now() WHERE "projectId"=$1 AND audience ? ''contactIds'' AND audience->''contactIds''<>''[]''::jsonb',t) USING pid;
  END LOOP;
  FOREACH t IN ARRAY deletes LOOP
    IF t=ANY(ARRAY['email_asset_references','outbox_records','media_assets']) THEN
      EXECUTE format('SELECT count(*) FROM public.%I WHERE "projectId"=$1 AND id IN (SELECT r->>''id'' FROM jsonb_array_elements($2) r)',t) INTO n USING pid,saved->t;
    ELSE
      EXECUTE format('SELECT count(*) FROM public.%I WHERE "projectId"=$1',t) INTO n USING pid;
    END IF;
    IF n<>0 THEN RAISE EXCEPTION 'STOP: remaining records in %',t; END IF;
  END LOOP;
END
$cleanup$;
COMMIT;
SELECT 'OMNICUS_CLEANUP_COMMITTED' AS result, count(*) AS remaining_contacts FROM public.contacts WHERE "projectId"=${literal(target.omnicus.projectId)};
`;
}
