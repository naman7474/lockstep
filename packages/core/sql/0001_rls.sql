-- Row-Level Security: every table is isolated by org. Applied after Drizzle
-- migrations create the tables. Idempotent.
--
-- Two contexts (set via SET LOCAL by the app, see rls.ts):
--   withOrg(orgId)  -> set lockstep.org_id ; sees only that org's rows
--   withSystem()    -> set lockstep.system='on' ; trusted auth/login ops that must
--                      cross orgs (token validation, member/invite matching). Never
--                      set from user-influenced paths.

-- 1) The app role the API SET ROLEs into per request so RLS is enforced.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lockstep_app') THEN
    CREATE ROLE lockstep_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO lockstep_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO lockstep_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO lockstep_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lockstep_app;

DO $$ BEGIN
  EXECUTE format('GRANT lockstep_app TO %I', current_user);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- 2) Org-isolation policy (org match OR trusted system context) on every org-scoped table.
DO $$
DECLARE t text;
DECLARE org_clause text :=
  '(org_id = nullif(current_setting(''lockstep.org_id'', true), '''')::uuid '
  || 'OR current_setting(''lockstep.system'', true) = ''on'')';
DECLARE child_tables text[] := ARRAY[
  'members','projects','project_members','repos','github_installations',
  'ownership_snapshots','ownership_rules','ownership_rule_owners',
  'decisions','decision_versions','decision_required_reviewers','decision_approvals',
  'contracts','dependency_edges','questions','answers','change_feed_entries',
  'tasks','inboxes','inbox_items','sessions','audit_events',
  'source_connections','ingest_allowlist','ingest_watermarks','ingest_artifacts',
  'decision_provenances','graph_nodes','graph_edges',
  'source_documents','document_state_mappings','conflicts','writebacks',
  'decision_embeddings','ingest_events'
];
-- scheduled_jobs is cross-org by design: every job runs withSystem and iterates orgs itself
-- (exactly like the expiry/digest endpoints it schedules) — so it takes the system-only policy.
DECLARE system_tables text[] := ARRAY['principals','access_tokens','github_credentials','scheduled_jobs'];
BEGIN
  -- tenant root: scope on id
  EXECUTE 'ALTER TABLE orgs ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE orgs FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS org_isolation ON orgs';
  EXECUTE 'CREATE POLICY org_isolation ON orgs '
       || 'USING (id = nullif(current_setting(''lockstep.org_id'', true), '''')::uuid '
       || 'OR current_setting(''lockstep.system'', true) = ''on'') '
       || 'WITH CHECK (id = nullif(current_setting(''lockstep.org_id'', true), '''')::uuid '
       || 'OR current_setting(''lockstep.system'', true) = ''on'')';

  FOREACH t IN ARRAY child_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS org_isolation ON %I', t);
    EXECUTE format('CREATE POLICY org_isolation ON %I USING %s WITH CHECK %s', t, org_clause, org_clause);
  END LOOP;

  -- system tables: readable/writable only under the trusted system context.
  FOREACH t IN ARRAY system_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS system_only ON %I', t);
    EXECUTE format(
      'CREATE POLICY system_only ON %I '
      || 'USING (current_setting(''lockstep.system'', true) = ''on'') '
      || 'WITH CHECK (current_setting(''lockstep.system'', true) = ''on'')', t);
  END LOOP;
END $$;
