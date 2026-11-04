-- READ-ONLY. Run AFTER 20261105000001 (and 000002). Project: qoylrmorezlqdvufonmx.

-- V1. Column exists as nullable date. Expect: extension_date | date | YES
SELECT column_name, data_type, is_nullable FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'skyline_form_instances' AND column_name = 'extension_date';

-- V2. Backfill: rows whose extension_date differs from end_date. Expect 0 immediately after the migration
--     (later, real extensions legitimately differ). Rows with no end_date keep NULL.
SELECT count(*) AS mismatched FROM public.skyline_form_instances
WHERE end_date IS NOT NULL AND extension_date IS DISTINCT FROM end_date;

-- V3. end_date was NOT changed: compare to the snapshot taken by the migration. Expect 0.
SELECT count(*) AS end_date_changed
FROM public.skyline_form_instances i JOIN backup.instance_end_dates_before_extension_20261105 b USING (id)
WHERE i.end_date IS DISTINCT FROM b.end_date;

-- V4. Same row count as the snapshot (no rows lost). Expect equal numbers.
SELECT (SELECT count(*) FROM public.skyline_form_instances) AS now_rows,
       (SELECT count(*) FROM backup.instance_end_dates_before_extension_20261105) AS snapshot_rows;

-- V5. CHECK constraint present and valid; no violations (expect 0 rows from the second query).
SELECT conname, convalidated FROM pg_constraint WHERE conname = 'skyline_form_instances_extension_not_before_end';
SELECT id, end_date, extension_date FROM public.skyline_form_instances WHERE extension_date < end_date;

-- V6. Triggers: the mirror trigger exists; the two paused triggers are enabled again (tgenabled = 'O').
SELECT tgname, tgenabled FROM pg_trigger
WHERE tgrelid = 'public.skyline_form_instances'::regclass AND NOT tgisinternal ORDER BY tgname;

-- V7. updated_at was not bumped by the backfill: rows updated after the migration started should only be real activity.
--     Replace the timestamp with the time you ran the migration; expect ~0 unless users were active.
SELECT count(*) AS rows_updated_since FROM public.skyline_form_instances WHERE updated_at >= TIMESTAMPTZ '2026-11-05 00:00:00+11';

-- V8. Migration 2: all six functions now reference extension_date (expect 9 rows, uses_extension = true everywhere).
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, (pg_get_functiondef(p.oid) LIKE '%extension_date%') AS uses_extension
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN
  ('skyline_sync_no_attempt_rollover','skyline_run_scheduled_no_attempt_rollover','skyline_list_submitted_instances_paged',
   'skyline_admin_dashboard_stats_v2','skyline_admin_dashboard_instances_paged','skyline_form_ids_for_course_active_on')
ORDER BY 1, 2;
