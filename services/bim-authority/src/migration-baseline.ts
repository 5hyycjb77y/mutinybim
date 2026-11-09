/**
 * Adopting databases that were migrated by hand before the authority applied
 * its own schema (the hosted Virginia and Singapore databases, local stacks).
 *
 * Every file through BASELINE_CUTOFF has a probe: a SQL boolean expression
 * that is true only once that file has run. Each file was applied whole (the
 * Supabase SQL editor and `supabase migration up` run a file as one
 * transaction, as `psql -1` does), so one object unique to the file proves all
 * of it. On a database with no record of a file, a true probe records it as
 * "baselined" without running it; a false probe runs it.
 *
 * Read on Oct 29 2026 (read-only catalog queries): both regions had every file
 * through 20261019150000; neither had 20261022000000 (settings constraint) or
 * 20261029130000 (patches, checkpoints). The first self-migrating deploy
 * therefore baselines eight files and applies two in each region. Virginia
 * also lacks 20261017000100's two realtime.messages policies (Singapore has
 * them); the probe below does not depend on them, and nothing re-adds them.
 *
 * Files after BASELINE_CUTOFF never get a probe: they run once, through the
 * migrator, and bim.schema_migrations is their record. A test enforces that.
 */
export const BASELINE_CUTOFF = "20261029130000";

export const BASELINE_PROBES: Readonly<Record<string, string>> = {
  // Not its realtime.messages policies: Virginia has none (lost in the Oct 24 move; the authority does not use Realtime).
  "20261017000100":
    "to_regclass('bim.command_outcomes') is not null and exists (select 1 from pg_policies where schemaname = 'bim' and tablename = 'command_outcomes' and policyname = 'command_outcomes_select_own')",
  "20261017000200": "to_regprocedure('bim.model_snapshot(text)') is not null",
  // Its only new objects are these two indexes.
  "20261017053241":
    "exists (select 1 from pg_indexes where schemaname = 'bim' and indexname = 'models_project_id_idx') and exists (select 1 from pg_indexes where schemaname = 'bim' and indexname = 'command_outcomes_actor_id_idx')",
  "20261017071500": "to_regprocedure('bim.purge_command_outcomes(interval)') is not null",
  "20261017144534": "to_regprocedure('bim.model_slice(text,text[])') is not null",
  "20261018031244": "exists (select 1 from information_schema.columns where table_schema = 'bim' and table_name = 'models' and column_name = 'host_project_id')",
  "20261018230000": "to_regprocedure('bim.model_lease_holder(text)') is not null",
  "20261019150000": "to_regprocedure('bim.provision_hosted_model(text,uuid,text,jsonb)') is not null",
  "20261022000000": "exists (select 1 from pg_constraint where conname = 'bim_models_settings_is_object' and conrelid = to_regclass('bim.models'))",
  // Idempotent as written; the probe only saves re-running it where it was pasted by hand.
  "20261029130000":
    "to_regprocedure('bim.purge_changesets(text,bigint,interval,integer)') is not null and to_regclass('bim.checkpoints') is not null and exists (select 1 from information_schema.columns where table_schema = 'bim' and table_name = 'changesets' and column_name = 'patch')",
};
