-- Gateway: live event ingress + persistent scheduler.
-- Hand-authored, idempotent (db:generate is broken in this repo).
--
-- ingest_events (org-scoped, RLS): Slack Events ingress queue. Core stores only REFS (channel,
-- ts, thread key) — never message text; the worker re-fetches the thread via the connector so the
-- unit granularity (and thus the ingest_artifacts contentHash idempotency barrier) matches sweeps
-- exactly. The partial unique index coalesces N messages in one thread into one pending unit.
--
-- scheduled_jobs (SYSTEM table, system-only RLS policy): cross-org by design — every job kind runs
-- withSystem and iterates orgs itself, exactly like the expiry/digest endpoints it schedules. The
-- worker claims due rows (FOR UPDATE SKIP LOCKED + lease) and executes via the existing /internal
-- endpoints. Mutable — NOT append-only.

CREATE TABLE IF NOT EXISTS "ingest_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "source_ref" text NOT NULL,
  "thread_key" text NOT NULL,
  "latest_event_ts" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "locked_until" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "processed_at" timestamp with time zone
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_ingest_event_open" ON "ingest_events" ("connection_id","thread_key")
  WHERE "status" IN ('queued','processing');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_ingest_events_status" ON "ingest_events" ("status","created_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "scheduled_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "singleton_key" text NOT NULL,
  "run_at" timestamp with time zone DEFAULT now() NOT NULL,
  "interval_seconds" integer,
  "locked_until" timestamp with time zone,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_status" text,
  "last_error" text,
  "last_run_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_scheduled_job_singleton" ON "scheduled_jobs" ("singleton_key");--> statement-breakpoint

-- Webhook tenant resolution: payload.installation.id → org. The existing unique index is
-- orgId-first and cannot serve an installation-only lookup.
CREATE INDEX IF NOT EXISTS "ix_install_installation" ON "github_installations" ("installation_id");--> statement-breakpoint

INSERT INTO "scheduled_jobs" ("kind", "singleton_key", "run_at", "interval_seconds") VALUES
  ('expiry', 'expiry', now(), 3600),
  ('weekly_digest', 'weekly_digest', now(), 21600),
  ('writeback_drain', 'writeback_drain', now(), 300)
ON CONFLICT ("singleton_key") DO NOTHING;
