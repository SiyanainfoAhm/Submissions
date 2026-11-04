-- Use the effective deadline COALESCE(extension_date, end_date) wherever end_date acts as the deadline in SQL.
-- DRAFT — run by hand AFTER 20261105000001_instance_extension_date.sql. Not applied automatically.
--
-- Generated from the live function definitions (supabase-backup/schema.sql, 2026-09-18), changing ONLY the
-- predicates listed below; RETURNS TABLE shapes, signatures, ownership and grants are unchanged (CREATE OR REPLACE).
-- BEFORE RUNNING: compare each function with the live one (pg_get_functiondef) in case it changed since the backup.
--
--   skyline_sync_no_attempt_rollover        missed-window tests (6x), "has a deadline" tests (6x), +5 days now also moves
--                                           a non-null extension_date, previous-window date (end-5), student link expiry
--   skyline_run_scheduled_no_attempt_rollover  which instances are past their deadline
--   skyline_list_submitted_instances_paged  (2 overloads) "active on" filter; window filters + sanity check (new overload)
--   skyline_admin_dashboard_stats_v2        (2 overloads) end-date range match
--   skyline_admin_dashboard_instances_paged (2 overloads) end-date range match
--   skyline_form_ids_for_course_active_on   "active on" test
-- Not changed (deliberately): skyline_batch_assessment_options / _eligibility (batch assignment windows),
-- ORDER BY / returned end_date columns, course and enrolment dates.

BEGIN;

-- Rollover: missed-window tests and link expiry use the effective deadline; a real extension moves with the +5 days
CREATE OR REPLACE FUNCTION public.skyline_sync_no_attempt_rollover(p_instance_ids bigint[])
 RETURNS TABLE(id bigint, end_date date, no_attempt_rollovers integer, did_not_attempt boolean, role_context text, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  today_mel date := (now() AT TIME ZONE 'Australia/Melbourne')::date;
BEGIN
  -- First and second missed windows retain the existing five-day extension.
  UPDATE public.skyline_form_instances sfi
  SET
    end_date = sfi.end_date + 5,
    extension_date = sfi.extension_date + 5,
    no_attempt_rollovers = sfi.no_attempt_rollovers + 1
  WHERE sfi.id = ANY(p_instance_ids)
    AND NOT COALESCE(sfi.did_not_attempt, false)
    AND COALESCE(sfi.submission_count, 0) = 0
    AND sfi.status = 'draft'
    AND sfi.role_context = 'student'
    AND COALESCE(sfi.extension_date, sfi.end_date) IS NOT NULL
    AND today_mel > COALESCE(sfi.extension_date, sfi.end_date)
    AND COALESCE(sfi.no_attempt_rollovers, 0) < 2;

  -- Preserve existing NYC attempt-window behavior for assessments that have
  -- already recorded one or more final submissions.
  WITH moved AS (
    UPDATE public.skyline_form_instances sfi
    SET
      end_date = sfi.end_date + 5,
      extension_date = sfi.extension_date + 5,
      no_attempt_rollovers = sfi.no_attempt_rollovers + 1,
      role_context = 'student',
      status = 'draft',
      workflow_status = 'draft'
    WHERE sfi.id = ANY(p_instance_ids)
      AND NOT COALESCE(sfi.did_not_attempt, false)
      AND COALESCE(sfi.extension_date, sfi.end_date) IS NOT NULL
      AND today_mel > COALESCE(sfi.extension_date, sfi.end_date)
      AND COALESCE(sfi.no_attempt_rollovers, 0) < 2
      AND (
        (
          sfi.role_context = 'student'
          AND sfi.status = 'draft'
          AND COALESCE(sfi.submission_count, 0) IN (1, 2)
        )
        OR (
          sfi.role_context = 'trainer'
          AND sfi.status = 'submitted'
          AND COALESCE(sfi.submission_count, 0) = 1
        )
      )
      AND EXISTS (
        SELECT 1
        FROM public.skyline_form_assessment_summary_data s
        WHERE s.instance_id = sfi.id
          AND s.final_attempt_1_result = 'not_yet_competent'
          AND s.final_attempt_2_result IS NULL
      )
    RETURNING sfi.id, sfi.end_date, sfi.trainer_nyc_assessed_on_1
  )
  UPDATE public.skyline_form_assessment_summary_data s
  SET final_attempt_2_result = 'not_yet_competent'
  FROM moved m
  WHERE s.instance_id = m.id
    AND s.final_attempt_2_result IS NULL;

  UPDATE public.skyline_form_results_data rd
  SET
    second_attempt_satisfactory = 'ns',
    second_attempt_date = COALESCE(
      NULLIF(btrim(COALESCE(rd.second_attempt_date, '')), ''),
      to_char(
        COALESCE(
          (
            SELECT i.trainer_nyc_assessed_on_1
            FROM public.skyline_form_instances i
            WHERE i.id = rd.instance_id
          ),
          (
            SELECT COALESCE(i.extension_date, i.end_date) - 5
            FROM public.skyline_form_instances i
            WHERE i.id = rd.instance_id
          )
        ),
        'YYYY-MM-DD'
      )
    )
  WHERE rd.instance_id = ANY(p_instance_ids)
    AND rd.second_attempt_satisfactory IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.skyline_form_assessment_summary_data s
      WHERE s.instance_id = rd.instance_id
        AND s.final_attempt_2_result = 'not_yet_competent'
    );

  UPDATE public.skyline_form_instances sfi
  SET
    end_date = sfi.end_date + 5,
    extension_date = sfi.extension_date + 5,
    no_attempt_rollovers = sfi.no_attempt_rollovers + 1,
    role_context = 'student',
    status = 'draft',
    workflow_status = 'draft'
  WHERE sfi.id = ANY(p_instance_ids)
    AND NOT COALESCE(sfi.did_not_attempt, false)
    AND COALESCE(sfi.extension_date, sfi.end_date) IS NOT NULL
    AND today_mel > COALESCE(sfi.extension_date, sfi.end_date)
    AND COALESCE(sfi.no_attempt_rollovers, 0) < 2
    AND sfi.role_context = 'student'
    AND sfi.status = 'draft'
    AND COALESCE(sfi.submission_count, 0) IN (2, 3)
    AND EXISTS (
      SELECT 1
      FROM public.skyline_form_assessment_summary_data s
      WHERE s.instance_id = sfi.id
        AND s.final_attempt_1_result = 'not_yet_competent'
        AND s.final_attempt_2_result = 'not_yet_competent'
        AND s.final_attempt_3_result IS NULL
    );

  UPDATE public.skyline_instance_access_tokens t
  SET
    expires_at = (
      ((COALESCE(sfi.extension_date, sfi.end_date) + 1)::timestamp - interval '1 millisecond')
      AT TIME ZONE 'Australia/Melbourne'
    ),
    revoked_at = NULL
  FROM public.skyline_form_instances sfi
  WHERE sfi.id = ANY(p_instance_ids)
    AND t.instance_id = sfi.id
    AND t.role_context = 'student'
    AND t.consumed_at IS NULL;

  -- A draft with saved work is not "did not attempt". It is incomplete and
  -- awaiting an explicit submission/admin decision.
  UPDATE public.skyline_form_instances sfi
  SET
    status = 'incomplete',
    workflow_status = 'awaiting_submission',
    did_not_attempt = false
  WHERE sfi.id = ANY(p_instance_ids)
    AND NOT COALESCE(sfi.did_not_attempt, false)
    AND COALESCE(sfi.submission_count, 0) = 0
    AND sfi.status = 'draft'
    AND sfi.role_context = 'student'
    AND COALESCE(sfi.extension_date, sfi.end_date) IS NOT NULL
    AND today_mel > COALESCE(sfi.extension_date, sfi.end_date)
    AND COALESCE(sfi.no_attempt_rollovers, 0) >= 2
    AND EXISTS (
      SELECT 1
      FROM public.skyline_form_answers a
      WHERE a.instance_id = sfi.id
    );

  -- Only a genuinely untouched instance becomes terminal "did not attempt".
  UPDATE public.skyline_form_instances sfi
  SET
    did_not_attempt = true,
    role_context = 'office',
    status = 'locked',
    workflow_status = 'failed'
  WHERE sfi.id = ANY(p_instance_ids)
    AND NOT COALESCE(sfi.did_not_attempt, false)
    AND COALESCE(sfi.submission_count, 0) = 0
    AND sfi.status = 'draft'
    AND sfi.role_context = 'student'
    AND COALESCE(sfi.extension_date, sfi.end_date) IS NOT NULL
    AND today_mel > COALESCE(sfi.extension_date, sfi.end_date)
    AND COALESCE(sfi.no_attempt_rollovers, 0) >= 2
    AND NOT EXISTS (
      SELECT 1
      FROM public.skyline_form_answers a
      WHERE a.instance_id = sfi.id
    );

  -- Existing submitted/NYC workflows still terminate when the next required
  -- submission window is missed. Saved answers from prior attempts do not
  -- count as a new final submission.
  UPDATE public.skyline_form_instances sfi
  SET
    did_not_attempt = true,
    role_context = 'office',
    status = 'locked',
    workflow_status = 'failed'
  WHERE sfi.id = ANY(p_instance_ids)
    AND NOT COALESCE(sfi.did_not_attempt, false)
    AND COALESCE(sfi.extension_date, sfi.end_date) IS NOT NULL
    AND today_mel > COALESCE(sfi.extension_date, sfi.end_date)
    AND COALESCE(sfi.no_attempt_rollovers, 0) >= 2
    AND (
      (sfi.role_context = 'student' AND sfi.status = 'draft')
      OR (sfi.role_context = 'trainer' AND sfi.status = 'submitted')
    )
    AND (
      EXISTS (
        SELECT 1
        FROM public.skyline_form_assessment_summary_data s
        WHERE s.instance_id = sfi.id
          AND s.final_attempt_1_result = 'not_yet_competent'
          AND s.final_attempt_2_result IS NULL
          AND COALESCE(sfi.submission_count, 0) IN (1, 2)
      )
      OR EXISTS (
        SELECT 1
        FROM public.skyline_form_assessment_summary_data s
        WHERE s.instance_id = sfi.id
          AND s.final_attempt_1_result = 'not_yet_competent'
          AND s.final_attempt_2_result = 'not_yet_competent'
          AND s.final_attempt_3_result IS NULL
          AND COALESCE(sfi.submission_count, 0) IN (2, 3)
      )
    );

  RETURN QUERY
  SELECT
    sfi.id,
    sfi.end_date,
    COALESCE(sfi.no_attempt_rollovers, 0),
    COALESCE(sfi.did_not_attempt, false),
    sfi.role_context,
    sfi.status
  FROM public.skyline_form_instances sfi
  WHERE sfi.id = ANY(p_instance_ids);
END;
$function$;

-- Scheduled rollover: instances past their effective deadline
CREATE OR REPLACE FUNCTION public.skyline_run_scheduled_no_attempt_rollover()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ids bigint[];
BEGIN
  SELECT COALESCE(array_agg(i.id ORDER BY i.id), ARRAY[]::bigint[])
  INTO v_ids
  FROM public.skyline_form_instances i
  WHERE NOT COALESCE(i.did_not_attempt, false)
    AND COALESCE(i.extension_date, i.end_date) IS NOT NULL
    AND (now() AT TIME ZONE 'Australia/Melbourne')::date > COALESCE(i.extension_date, i.end_date)
    AND (
      (i.status = 'draft' AND i.role_context = 'student')
      OR (i.status = 'submitted' AND i.role_context = 'trainer')
    );

  IF cardinality(v_ids) = 0 THEN
    RETURN 0;
  END IF;

  PERFORM *
  FROM public.skyline_sync_no_attempt_rollover(v_ids);

  RETURN cardinality(v_ids);
END;
$function$;

-- Assessment directory: "active on" and date-window filters use the effective deadline
CREATE OR REPLACE FUNCTION public.skyline_list_submitted_instances_paged(p_page integer DEFAULT 1, p_page_size integer DEFAULT 20, p_search text DEFAULT NULL::text, p_course_id bigint DEFAULT NULL::bigint, p_form_id bigint DEFAULT NULL::bigint, p_student_id bigint DEFAULT NULL::bigint, p_active_on date DEFAULT NULL::date, p_workflow_status text DEFAULT NULL::text, p_start_from date DEFAULT NULL::date, p_start_to date DEFAULT NULL::date, p_sort_key text DEFAULT 'created'::text, p_sort_dir text DEFAULT 'desc'::text)
 RETURNS TABLE(id bigint, form_id bigint, form_name text, form_version text, student_id bigint, student_name text, student_email text, status text, role_context text, created_at timestamp with time zone, submitted_at timestamp with time zone, submission_count integer, start_date date, end_date date, total_count bigint)
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  v_from integer := GREATEST(0, (COALESCE(p_page, 1) - 1) * COALESCE(p_page_size, 20));
  v_limit integer := GREATEST(1, COALESCE(p_page_size, 20));
  v_dir text := CASE WHEN lower(COALESCE(p_sort_dir, 'desc')) = 'asc' THEN 'asc' ELSE 'desc' END;
  v_key text := lower(COALESCE(p_sort_key, 'created'));
  v_sql text;
BEGIN
  v_sql := $q$
    WITH base AS (
      SELECT
        i.id,
        i.form_id,
        f.name AS form_name,
        f.version AS form_version,
        i.student_id,
        COALESCE(
          NULLIF(trim(concat_ws(' ', NULLIF(s.first_name,''), NULLIF(s.last_name,''))), ''),
          NULLIF(s.name,''),
          s.email,
          'Unknown student'
        ) AS student_name,
        COALESCE(s.email, '') AS student_email,
        i.status,
        i.role_context,
        i.created_at,
        i.submitted_at,
        COALESCE(i.submission_count, 0)::int AS submission_count,
        i.start_date,
        i.end_date
      FROM public.skyline_form_instances i
      JOIN public.skyline_forms f ON f.id = i.form_id
      JOIN public.skyline_students s ON s.id = i.student_id
      WHERE i.student_id IS NOT NULL
        AND (s.status IS NULL OR s.status = 'active')
        AND ($1::bigint IS NULL OR i.form_id = $1::bigint)
        AND ($2::bigint IS NULL OR i.student_id = $2::bigint)
        AND (
          $3::bigint IS NULL
          OR EXISTS (
            SELECT 1
            FROM public.skyline_course_forms cf
            WHERE cf.course_id = $3::bigint
              AND cf.form_id = i.form_id
          )
        )
        AND (
          COALESCE($4::text, '') = ''
          OR (
            i.status ILIKE ('%' || $4::text || '%')
            OR i.role_context ILIKE ('%' || $4::text || '%')
            OR f.name ILIKE ('%' || $4::text || '%')
            OR COALESCE(f.version,'') ILIKE ('%' || $4::text || '%')
            OR COALESCE(s.student_id,'') ILIKE ('%' || $4::text || '%')
            OR COALESCE(s.name,'') ILIKE ('%' || $4::text || '%')
            OR COALESCE(s.first_name,'') ILIKE ('%' || $4::text || '%')
            OR COALESCE(s.last_name,'') ILIKE ('%' || $4::text || '%')
            OR COALESCE(s.email,'') ILIKE ('%' || $4::text || '%')
          )
        )
        AND (
          $5::date IS NULL
          OR (
            i.start_date IS NOT NULL
            AND i.start_date <= $5::date
            AND (COALESCE(i.extension_date, i.end_date) IS NULL OR COALESCE(i.extension_date, i.end_date) >= $5::date)
          )
        )
        AND (
          $6::text IS NULL
          OR trim(BOTH FROM $6::text) = ''
          OR lower(trim(BOTH FROM $6::text)) = 'all'
          OR (
            lower(trim(BOTH FROM $6::text)) = 'awaiting_student'
            AND i.status = 'draft'
            AND NOT COALESCE(i.did_not_attempt, false)
          )
          OR (
            lower(trim(BOTH FROM $6::text)) = 'awaiting_trainer'
            AND i.role_context = 'trainer'
            AND i.status <> 'locked'
          )
          OR (
            lower(trim(BOTH FROM $6::text)) = 'awaiting_office'
            AND i.role_context = 'office'
            AND i.status <> 'locked'
            AND NOT COALESCE(i.did_not_attempt, false)
          )
          OR (
            lower(trim(BOTH FROM $6::text)) = 'did_not_attempt'
            AND COALESCE(i.did_not_attempt, false) = true
          )
          OR (
            lower(trim(BOTH FROM $6::text)) = 'completed'
            AND i.status = 'locked'
            AND NOT COALESCE(i.did_not_attempt, false)
          )
        )
        AND (
          $7::date IS NULL
          OR (i.start_date IS NOT NULL AND i.start_date >= $7::date)
        )
        AND (
          $8::date IS NULL
          OR (i.start_date IS NOT NULL AND i.start_date <= $8::date)
        )
    )
    SELECT
      b.*,
      COUNT(*) OVER() AS total_count
    FROM base b
  $q$;

  IF v_key = 'student' THEN
    v_sql := v_sql || format(' ORDER BY b.student_name %s, b.student_email %s, b.id %s ', v_dir, v_dir, v_dir);
  ELSIF v_key = 'form' THEN
    v_sql := v_sql || format(' ORDER BY b.form_name %s, b.form_version %s, b.id %s ', v_dir, v_dir, v_dir);
  ELSIF v_key = 'start' THEN
    v_sql := v_sql || format(' ORDER BY b.start_date %s NULLS LAST, b.id %s ', v_dir, v_dir);
  ELSIF v_key = 'end' THEN
    v_sql := v_sql || format(' ORDER BY b.end_date %s NULLS LAST, b.id %s ', v_dir, v_dir);
  ELSIF v_key = 'workflow' THEN
    v_sql := v_sql || format(' ORDER BY b.role_context %s, b.status %s, b.id %s ', v_dir, v_dir, v_dir);
  ELSE
    v_sql := v_sql || format(' ORDER BY b.created_at %s, b.id %s ', v_dir, v_dir);
  END IF;

  v_sql := v_sql || ' LIMIT $9 OFFSET $10 ';

  RETURN QUERY EXECUTE v_sql
    USING
      p_form_id,
      p_student_id,
      p_course_id,
      NULLIF(trim(COALESCE(p_search,'')), ''),
      p_active_on,
      p_workflow_status,
      p_start_from,
      p_start_to,
      v_limit,
      v_from;
END;
$function$;

CREATE OR REPLACE FUNCTION public.skyline_list_submitted_instances_paged(p_page integer DEFAULT 1, p_page_size integer DEFAULT 20, p_search text DEFAULT NULL::text, p_course_id bigint DEFAULT NULL::bigint, p_form_id bigint DEFAULT NULL::bigint, p_student_id bigint DEFAULT NULL::bigint, p_active_on date DEFAULT NULL::date, p_workflow_status text DEFAULT NULL::text, p_start_from date DEFAULT NULL::date, p_end_date_to date DEFAULT NULL::date, p_sort_key text DEFAULT 'created'::text, p_sort_dir text DEFAULT 'desc'::text, p_batch_id bigint DEFAULT NULL::bigint, p_search_student_ext_id text DEFAULT NULL::text, p_search_unit_code text DEFAULT NULL::text)
 RETURNS TABLE(id bigint, form_id bigint, form_name text, form_version text, student_id bigint, student_name text, student_email text, status text, role_context text, created_at timestamp with time zone, submitted_at timestamp with time zone, submission_count integer, start_date date, end_date date, total_count bigint)
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  v_from integer := GREATEST(0, (COALESCE(p_page, 1) - 1) * COALESCE(p_page_size, 20));
  v_limit integer := GREATEST(1, COALESCE(p_page_size, 20));
  v_dir text := CASE WHEN lower(COALESCE(p_sort_dir, 'desc')) = 'asc' THEN 'asc' ELSE 'desc' END;
  v_key text := lower(COALESCE(p_sort_key, 'created'));
  v_sql text;
  v_raw text := NULLIF(trim(COALESCE(p_search, '')), '');
  v_ext_id text := NULLIF(trim(COALESCE(p_search_student_ext_id, '')), '');
  v_unit text := NULLIF(trim(COALESCE(p_search_unit_code, '')), '');
  v_general text := NULL;
  v_tokens text[];
  v_tok text;
  v_rest text[] := ARRAY[]::text[];
BEGIN
  -- Prefer explicit structured args; otherwise parse whitespace-delimited p_search.
  -- When structured args are provided alongside a full raw string, strip known tokens
  -- so the leftover becomes general (avoid requiring the whole "ID UNIT" phrase in one field).
  IF v_ext_id IS NOT NULL OR v_unit IS NOT NULL THEN
    IF v_raw IS NOT NULL THEN
      v_tokens := regexp_split_to_array(v_raw, '\s+');
      FOREACH v_tok IN ARRAY v_tokens
      LOOP
        IF v_ext_id IS NOT NULL AND lower(v_tok) = lower(v_ext_id) THEN
          CONTINUE;
        END IF;
        IF v_unit IS NOT NULL AND lower(v_tok) = lower(v_unit) THEN
          CONTINUE;
        END IF;
        v_rest := array_append(v_rest, v_tok);
      END LOOP;
      IF coalesce(array_length(v_rest, 1), 0) > 0 THEN
        v_general := array_to_string(v_rest, ' ');
      END IF;
    END IF;
  ELSIF v_raw IS NOT NULL THEN
    v_tokens := regexp_split_to_array(v_raw, '\s+');
    IF coalesce(array_length(v_tokens, 1), 0) = 1 THEN
      v_tok := v_tokens[1];
      IF v_tok ~ '^\d{4,}$' THEN
        v_ext_id := v_tok;
      ELSIF length(v_tok) >= 5
        AND v_tok ~ '[A-Za-z]'
        AND v_tok ~ '[0-9]'
        AND v_tok !~ '\s'
        AND v_tok ~ '^[A-Za-z0-9._-]+$'
        AND v_tok !~ '^\d+$'
      THEN
        v_unit := v_tok;
      ELSE
        v_general := v_tok;
      END IF;
    ELSE
      FOREACH v_tok IN ARRAY v_tokens
      LOOP
        IF v_ext_id IS NULL AND v_tok ~ '^\d{4,}$' THEN
          v_ext_id := v_tok;
        ELSIF v_unit IS NULL
          AND length(v_tok) >= 5
          AND v_tok ~ '[A-Za-z]'
          AND v_tok ~ '[0-9]'
          AND v_tok !~ '\s'
          AND v_tok ~ '^[A-Za-z0-9._-]+$'
          AND v_tok !~ '^\d+$'
        THEN
          v_unit := v_tok;
        ELSE
          v_rest := array_append(v_rest, v_tok);
        END IF;
      END LOOP;
      -- Name phrases like "AARON BINU" — no structured tokens → keep full raw as general.
      IF v_ext_id IS NULL AND v_unit IS NULL THEN
        v_general := v_raw;
      ELSIF coalesce(array_length(v_rest, 1), 0) > 0 THEN
        v_general := array_to_string(v_rest, ' ');
      END IF;
    END IF;
  END IF;

  v_sql := $q$
    WITH base AS (
      SELECT
        i.id,
        i.form_id,
        f.name AS form_name,
        f.version AS form_version,
        i.student_id,
        COALESCE(
          NULLIF(trim(concat_ws(' ', NULLIF(s.first_name,''), NULLIF(s.last_name,''))), ''),
          NULLIF(s.name,''),
          s.email,
          'Unknown student'
        ) AS student_name,
        COALESCE(s.email, '') AS student_email,
        i.status,
        i.role_context,
        i.created_at,
        i.submitted_at,
        COALESCE(i.submission_count, 0)::int AS submission_count,
        i.start_date,
        i.end_date
      FROM public.skyline_form_instances i
      JOIN public.skyline_forms f ON f.id = i.form_id
      JOIN public.skyline_students s ON s.id = i.student_id
      WHERE i.student_id IS NOT NULL
        AND (s.status IS NULL OR s.status = 'active')
        AND ($1::bigint IS NULL OR i.form_id = $1::bigint)
        AND ($2::bigint IS NULL OR i.student_id = $2::bigint)
        AND (
          $3::bigint IS NULL
          OR EXISTS (
            SELECT 1
            FROM public.skyline_course_forms cf
            WHERE cf.course_id = $3::bigint
              AND cf.form_id = i.form_id
          )
        )
        -- Exact external Student ID when detected / provided
        AND (
          COALESCE($12::text, '') = ''
          OR lower(trim(COALESCE(s.student_id, ''))) = lower(trim($12::text))
        )
        -- Unit code (partial, case-insensitive) when detected / provided
        AND (
          COALESCE($13::text, '') = ''
          OR COALESCE(f.unit_code, '') ILIKE ('%' || $13::text || '%')
          OR COALESCE(f.name, '') ILIKE ('%' || $13::text || '%')
        )
        -- Remaining general free-text (OR across fields)
        AND (
          COALESCE($4::text, '') = ''
          OR (
            i.status ILIKE ('%' || $4::text || '%')
            OR i.role_context ILIKE ('%' || $4::text || '%')
            OR f.name ILIKE ('%' || $4::text || '%')
            OR COALESCE(f.version,'') ILIKE ('%' || $4::text || '%')
            OR COALESCE(f.unit_code,'') ILIKE ('%' || $4::text || '%')
            OR COALESCE(f.unit_name,'') ILIKE ('%' || $4::text || '%')
            OR COALESCE(s.student_id,'') ILIKE ('%' || $4::text || '%')
            OR COALESCE(s.name,'') ILIKE ('%' || $4::text || '%')
            OR COALESCE(s.first_name,'') ILIKE ('%' || $4::text || '%')
            OR COALESCE(s.last_name,'') ILIKE ('%' || $4::text || '%')
            OR COALESCE(s.email,'') ILIKE ('%' || $4::text || '%')
          )
        )
        AND (
          $5::date IS NULL
          OR (
            i.start_date IS NOT NULL
            AND i.start_date <= $5::date
            AND (COALESCE(i.extension_date, i.end_date) IS NULL OR COALESCE(i.extension_date, i.end_date) >= $5::date)
          )
        )
        AND (
          $6::text IS NULL
          OR trim(BOTH FROM $6::text) = ''
          OR lower(trim(BOTH FROM $6::text)) = 'all'
          OR (
            lower(trim(BOTH FROM $6::text)) = 'awaiting_student'
            AND i.status = 'draft'
            AND NOT COALESCE(i.did_not_attempt, false)
          )
          OR (
            lower(trim(BOTH FROM $6::text)) = 'awaiting_trainer'
            AND i.role_context = 'trainer'
            AND i.status <> 'locked'
          )
          OR (
            lower(trim(BOTH FROM $6::text)) = 'awaiting_office'
            AND i.role_context = 'office'
            AND i.status <> 'locked'
            AND NOT COALESCE(i.did_not_attempt, false)
          )
          OR (
            lower(trim(BOTH FROM $6::text)) = 'did_not_attempt'
            AND COALESCE(i.did_not_attempt, false) = true
          )
          OR (
            lower(trim(BOTH FROM $6::text)) = 'completed'
            AND i.status = 'locked'
            AND NOT COALESCE(i.did_not_attempt, false)
          )
        )
        AND (
          $7::date IS NULL
          OR COALESCE(i.extension_date, i.end_date, i.start_date) >= $7::date
        )
        AND (
          $8::date IS NULL
          OR COALESCE(i.start_date, i.extension_date, i.end_date) <= $8::date
        )
        AND (
          i.start_date IS NULL
          OR COALESCE(i.extension_date, i.end_date) IS NULL
          OR COALESCE(i.extension_date, i.end_date) >= i.start_date
        )
        AND (
          $9::bigint IS NULL
          OR s.batch_id = $9::bigint
        )
    )
    SELECT
      b.*,
      COUNT(*) OVER() AS total_count
    FROM base b
  $q$;

  IF v_key = 'student' THEN
    v_sql := v_sql || format(' ORDER BY b.student_name %s, b.student_email %s, b.id %s ', v_dir, v_dir, v_dir);
  ELSIF v_key = 'form' THEN
    v_sql := v_sql || format(' ORDER BY b.form_name %s, b.form_version %s, b.id %s ', v_dir, v_dir, v_dir);
  ELSIF v_key = 'start' THEN
    v_sql := v_sql || format(' ORDER BY (b.start_date::date) %s NULLS LAST, b.id %s ', v_dir, v_dir);
  ELSIF v_key = 'end' THEN
    v_sql := v_sql || format(' ORDER BY (b.end_date::date) %s NULLS LAST, b.id %s ', v_dir, v_dir);
  ELSIF v_key = 'workflow' THEN
    v_sql := v_sql || format(' ORDER BY b.role_context %s, b.status %s, b.id %s ', v_dir, v_dir);
  ELSE
    v_sql := v_sql || format(' ORDER BY b.created_at %s, b.id %s ', v_dir, v_dir);
  END IF;

  v_sql := v_sql || ' LIMIT $10 OFFSET $11 ';

  RETURN QUERY EXECUTE v_sql
    USING
      p_form_id,
      p_student_id,
      p_course_id,
      NULLIF(trim(COALESCE(v_general, '')), ''),
      p_active_on,
      p_workflow_status,
      p_start_from,
      p_end_date_to,
      p_batch_id,
      v_limit,
      v_from,
      NULLIF(trim(COALESCE(v_ext_id, '')), ''),
      NULLIF(trim(COALESCE(v_unit, '')), '');
END;
$function$;

-- Admin dashboard stats: date range matches on the effective deadline
CREATE OR REPLACE FUNCTION public.skyline_admin_dashboard_stats_v2(p_from_date date DEFAULT NULL::date, p_to_date date DEFAULT NULL::date, p_status text DEFAULT 'awaiting_student'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total_assessments int;
  v_total_students int;
  v_total_trainers int;
  v_total_admins int;

  v_awaiting_student int;
  v_awaiting_trainer int;
  v_awaiting_office int;
  v_completed int;
BEGIN
  -- Totals (all-time)
  SELECT COUNT(*)::int
  INTO v_total_students
  FROM skyline_students s
  WHERE s.status IS NULL OR s.status = 'active';

  SELECT COUNT(*)::int INTO v_total_trainers FROM skyline_users WHERE role = 'trainer';
  SELECT COUNT(*)::int INTO v_total_admins FROM skyline_users WHERE role IN ('admin', 'superadmin');

  SELECT COUNT(*)::int
  INTO v_total_assessments
  FROM skyline_form_instances i
  JOIN skyline_students s ON s.id = i.student_id
  WHERE i.student_id IS NOT NULL
    AND (s.status IS NULL OR s.status = 'active');

  -- Workflow counts for the filtered slice.
  WITH filtered AS (
    SELECT i.*
    FROM skyline_form_instances i
    JOIN skyline_students s ON s.id = i.student_id
    WHERE i.student_id IS NOT NULL
      AND (s.status IS NULL OR s.status = 'active')
      AND (
        p_from_date IS NULL OR p_to_date IS NULL
        OR (i.start_date IS NOT NULL AND i.start_date BETWEEN p_from_date AND p_to_date)
        OR (COALESCE(i.extension_date, i.end_date) IS NOT NULL AND COALESCE(i.extension_date, i.end_date) BETWEEN p_from_date AND p_to_date)
      )
      AND (
        p_status = 'all'
        OR (p_status = 'awaiting_student' AND i.status = 'draft')
        OR (p_status = 'awaiting_trainer' AND i.role_context = 'trainer' AND i.status <> 'locked')
        OR (p_status = 'awaiting_office' AND i.role_context = 'office' AND i.status <> 'locked')
        OR (p_status = 'completed' AND i.status = 'locked')
      )
  )
  SELECT
    COUNT(*) FILTER (WHERE status = 'draft')::int,
    COUNT(*) FILTER (WHERE role_context = 'trainer' AND status <> 'locked')::int,
    COUNT(*) FILTER (WHERE role_context = 'office' AND status <> 'locked')::int,
    COUNT(*) FILTER (WHERE status = 'locked')::int
  INTO v_awaiting_student, v_awaiting_trainer, v_awaiting_office, v_completed
  FROM filtered;

  RETURN jsonb_build_object(
    'ok', true,
    'totals', jsonb_build_object(
      'assessments', v_total_assessments,
      'students', v_total_students,
      'trainers', v_total_trainers,
      'admins', v_total_admins
    ),
    'workflow', jsonb_build_object(
      'awaiting_student', COALESCE(v_awaiting_student, 0),
      'awaiting_trainer', COALESCE(v_awaiting_trainer, 0),
      'awaiting_office', COALESCE(v_awaiting_office, 0),
      'completed', COALESCE(v_completed, 0)
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.skyline_admin_dashboard_stats_v2(p_from_date date DEFAULT NULL::date, p_to_date date DEFAULT NULL::date, p_status text DEFAULT 'awaiting_student'::text, p_batch_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total_assessments int;
  v_total_students int;
  v_total_trainers int;
  v_total_admins int;

  v_awaiting_student int;
  v_awaiting_trainer int;
  v_awaiting_office int;
  v_completed int;
BEGIN
  SELECT COUNT(*)::int
  INTO v_total_students
  FROM skyline_students s
  WHERE s.status IS NULL OR s.status = 'active';

  SELECT COUNT(*)::int INTO v_total_trainers FROM skyline_users WHERE role = 'trainer';
  SELECT COUNT(*)::int INTO v_total_admins FROM skyline_users WHERE role IN ('admin', 'superadmin');

  SELECT COUNT(*)::int
  INTO v_total_assessments
  FROM skyline_form_instances i
  JOIN skyline_students s ON s.id = i.student_id
  WHERE i.student_id IS NOT NULL
    AND (s.status IS NULL OR s.status = 'active');

  WITH filtered AS (
    SELECT i.*
    FROM skyline_form_instances i
    JOIN skyline_students s ON s.id = i.student_id
    WHERE i.student_id IS NOT NULL
      AND (s.status IS NULL OR s.status = 'active')
      AND (p_batch_id IS NULL OR s.batch_id = p_batch_id)
      AND (
        p_from_date IS NULL OR p_to_date IS NULL
        OR (i.start_date IS NOT NULL AND i.start_date BETWEEN p_from_date AND p_to_date)
        OR (COALESCE(i.extension_date, i.end_date) IS NOT NULL AND COALESCE(i.extension_date, i.end_date) BETWEEN p_from_date AND p_to_date)
      )
      AND (
        p_status = 'all'
        OR (p_status = 'awaiting_student' AND i.status = 'draft' AND NOT COALESCE(i.did_not_attempt, false))
        OR (p_status = 'awaiting_trainer' AND i.role_context = 'trainer' AND i.status <> 'locked')
        OR (p_status = 'awaiting_office' AND i.role_context = 'office' AND i.status <> 'locked' AND NOT COALESCE(i.did_not_attempt, false))
        OR (p_status = 'did_not_attempt' AND COALESCE(i.did_not_attempt, false) = true)
        OR (p_status = 'completed' AND i.status = 'locked' AND NOT COALESCE(i.did_not_attempt, false))
      )
  )
  SELECT
    COUNT(*) FILTER (WHERE status = 'draft' AND NOT COALESCE(did_not_attempt, false))::int,
    COUNT(*) FILTER (WHERE role_context = 'trainer' AND status <> 'locked')::int,
    COUNT(*) FILTER (WHERE role_context = 'office' AND status <> 'locked' AND NOT COALESCE(did_not_attempt, false))::int,
    COUNT(*) FILTER (WHERE status = 'locked' AND NOT COALESCE(did_not_attempt, false))::int
  INTO v_awaiting_student, v_awaiting_trainer, v_awaiting_office, v_completed
  FROM filtered;

  RETURN jsonb_build_object(
    'ok', true,
    'totals', jsonb_build_object(
      'assessments', v_total_assessments,
      'students', v_total_students,
      'trainers', v_total_trainers,
      'admins', v_total_admins
    ),
    'workflow', jsonb_build_object(
      'awaiting_student', COALESCE(v_awaiting_student, 0),
      'awaiting_trainer', COALESCE(v_awaiting_trainer, 0),
      'awaiting_office', COALESCE(v_awaiting_office, 0),
      'completed', COALESCE(v_completed, 0)
    )
  );
END;
$function$;

-- Admin dashboard list: date range matches on the effective deadline
CREATE OR REPLACE FUNCTION public.skyline_admin_dashboard_instances_paged(p_page integer DEFAULT 1, p_page_size integer DEFAULT 20, p_status text DEFAULT 'awaiting_student'::text, p_from_date date DEFAULT NULL::date, p_to_date date DEFAULT NULL::date)
 RETURNS TABLE(id bigint, form_id bigint, form_name text, form_version text, student_id bigint, student_name text, student_email text, status text, role_context text, start_date date, end_date date, created_at timestamp with time zone, total_count bigint)
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  v_from integer := greatest(0, (coalesce(p_page, 1) - 1) * coalesce(p_page_size, 20));
  v_limit integer := greatest(1, coalesce(p_page_size, 20));
BEGIN
  RETURN QUERY
  WITH base AS (
    SELECT
      i.id,
      i.form_id,
      f.name AS form_name,
      f.version AS form_version,
      i.student_id,
      COALESCE(
        NULLIF(TRIM(CONCAT_WS(' ', NULLIF(s.first_name,''), NULLIF(s.last_name,''))), ''),
        NULLIF(s.name,''),
        s.email,
        'Unknown student'
      ) AS student_name,
      COALESCE(s.email, '') AS student_email,
      i.status,
      i.role_context,
      i.start_date,
      i.end_date,
      i.created_at
    FROM public.skyline_form_instances i
    JOIN public.skyline_forms f ON f.id = i.form_id
    JOIN public.skyline_students s ON s.id = i.student_id
    WHERE i.student_id IS NOT NULL
      AND (s.status IS NULL OR s.status = 'active')
      AND (
        p_from_date IS NULL OR p_to_date IS NULL
        OR (i.start_date IS NOT NULL AND i.start_date BETWEEN p_from_date AND p_to_date)
        OR (COALESCE(i.extension_date, i.end_date) IS NOT NULL AND COALESCE(i.extension_date, i.end_date) BETWEEN p_from_date AND p_to_date)
      )
      AND (
        p_status = 'all'
        OR (p_status = 'awaiting_student' AND i.status = 'draft')
        OR (p_status = 'awaiting_trainer' AND i.role_context = 'trainer' AND i.status <> 'locked')
        OR (p_status = 'awaiting_office' AND i.role_context = 'office' AND i.status <> 'locked')
        OR (p_status = 'completed' AND i.status = 'locked')
      )
  )
  SELECT
    b.*,
    COUNT(*) OVER() AS total_count
  FROM base b
  ORDER BY
    COALESCE(b.start_date, b.end_date, b.created_at::date) DESC,
    b.id DESC
  LIMIT v_limit OFFSET v_from;
END;
$function$;

CREATE OR REPLACE FUNCTION public.skyline_admin_dashboard_instances_paged(p_page integer DEFAULT 1, p_page_size integer DEFAULT 20, p_status text DEFAULT 'awaiting_student'::text, p_from_date date DEFAULT NULL::date, p_to_date date DEFAULT NULL::date, p_batch_id bigint DEFAULT NULL::bigint)
 RETURNS TABLE(id bigint, form_id bigint, form_name text, form_version text, student_id bigint, student_name text, student_email text, status text, role_context text, start_date date, end_date date, created_at timestamp with time zone, batch_id bigint, batch_name text, trainer_name text, total_count bigint)
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  v_from integer := GREATEST(0, (COALESCE(p_page, 1) - 1) * COALESCE(p_page_size, 20));
  v_limit integer := GREATEST(1, COALESCE(p_page_size, 20));
BEGIN
  RETURN QUERY
  WITH base AS (
    SELECT
      i.id,
      i.form_id,
      f.name AS form_name,
      f.version AS form_version,
      i.student_id,
      COALESCE(
        NULLIF(TRIM(CONCAT_WS(' ', NULLIF(s.first_name,''), NULLIF(s.last_name,''))), ''),
        NULLIF(s.name,''),
        s.email,
        'Unknown student'
      ) AS student_name,
      COALESCE(s.email, '') AS student_email,
      i.status,
      i.role_context,
      i.start_date,
      i.end_date,
      i.created_at,
      s.batch_id,
      b.name AS batch_name,
      u.full_name AS trainer_name
    FROM public.skyline_form_instances i
    JOIN public.skyline_forms f ON f.id = i.form_id
    JOIN public.skyline_students s ON s.id = i.student_id
    LEFT JOIN public.skyline_batches b ON b.id = s.batch_id
    LEFT JOIN public.skyline_users u ON u.id = b.trainer_id
    WHERE i.student_id IS NOT NULL
      AND (s.status IS NULL OR s.status = 'active')
      AND (p_batch_id IS NULL OR s.batch_id = p_batch_id)
      AND (
        p_from_date IS NULL OR p_to_date IS NULL
        OR (i.start_date IS NOT NULL AND i.start_date BETWEEN p_from_date AND p_to_date)
        OR (COALESCE(i.extension_date, i.end_date) IS NOT NULL AND COALESCE(i.extension_date, i.end_date) BETWEEN p_from_date AND p_to_date)
      )
      AND (
        p_status = 'all'
        OR (p_status = 'awaiting_student' AND i.status = 'draft' AND NOT COALESCE(i.did_not_attempt, false))
        OR (p_status = 'awaiting_trainer' AND i.role_context = 'trainer' AND i.status <> 'locked')
        OR (p_status = 'awaiting_office' AND i.role_context = 'office' AND i.status <> 'locked' AND NOT COALESCE(i.did_not_attempt, false))
        OR (p_status = 'did_not_attempt' AND COALESCE(i.did_not_attempt, false) = true)
        OR (p_status = 'completed' AND i.status = 'locked' AND NOT COALESCE(i.did_not_attempt, false))
      )
  )
  SELECT
    b.*,
    COUNT(*) OVER() AS total_count
  FROM base b
  ORDER BY
    COALESCE(b.start_date, b.end_date, b.created_at::date) DESC,
    b.id DESC
  LIMIT v_limit OFFSET v_from;
END;
$function$;

-- Course forms active on a date: effective deadline
CREATE OR REPLACE FUNCTION public.skyline_form_ids_for_course_active_on(p_course_id bigint, p_on date)
 RETURNS bigint[]
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce(
    (
      select array_agg(distinct i.form_id order by i.form_id)
      from public.skyline_form_instances i
      join public.skyline_students s on s.id = i.student_id
      join public.skyline_course_forms cf on cf.form_id = i.form_id and cf.course_id = p_course_id
      where i.student_id is not null
        and (s.status is null or s.status = 'active')
        and i.start_date is not null
        and i.start_date <= p_on
        and (COALESCE(i.extension_date, i.end_date) is null or COALESCE(i.extension_date, i.end_date) >= p_on)
    ),
    '{}'::bigint[]
  );
$function$;

COMMIT;
