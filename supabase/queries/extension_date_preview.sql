-- READ-ONLY. Run BEFORE 20261105000001_instance_extension_date.sql. Project: qoylrmorezlqdvufonmx.

-- P1. How many rows the backfill (extension_date = end_date) will touch, and how many stay NULL.
SELECT count(*)                                         AS total_instances,
       count(*) FILTER (WHERE end_date IS NOT NULL)     AS will_be_backfilled,
       count(*) FILTER (WHERE end_date IS NULL)         AS stay_null_no_end_date
FROM public.skyline_form_instances;

-- P2. Same, by status / role (sanity: the backfill ignores status).
SELECT status, role_context, count(*) AS total, count(*) FILTER (WHERE end_date IS NOT NULL) AS will_be_backfilled
FROM public.skyline_form_instances GROUP BY 1, 2 ORDER BY 3 DESC;

-- P3. The column must not exist yet (expect 0 rows), and the two backup objects must not exist.
SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'skyline_form_instances' AND column_name = 'extension_date';
SELECT to_regclass('backup.instance_end_dates_before_extension_20261105') AS backup_table_should_be_null;

-- P4. The row triggers the migration pauses during the backfill (expect both listed and enabled = 'O').
SELECT tgname, tgenabled FROM pg_trigger
WHERE tgrelid = 'public.skyline_form_instances'::regclass AND NOT tgisinternal ORDER BY tgname;

-- P5. Live definitions of the six functions migration 2 replaces (compare with supabase-backup/schema.sql; if any differ, tell me first).
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(pg_get_functiondef(p.oid)) AS def_md5
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN
  ('skyline_sync_no_attempt_rollover','skyline_run_scheduled_no_attempt_rollover','skyline_list_submitted_instances_paged',
   'skyline_admin_dashboard_stats_v2','skyline_admin_dashboard_instances_paged','skyline_form_ids_for_course_active_on')
ORDER BY 1, 2;
