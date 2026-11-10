-- "My students": batch filter, per-batch student counts, 25 per page.
--
-- * skyline_trainer_list_my_batches: the batches the caller (or the previewed user) trains,
--   with the number of students in each. Feeds the batch dropdown.
-- * skyline_trainer_list_my_students: gains p_batch_id. Search, batch filter and paging are
--   all done here; total_count is the number of matching students across all pages.
--   Asking for a batch the caller does not train answers PT403.
--
-- Security is unchanged: only batches the caller trains, and p_as_user_id is accepted only
-- from a super admin (preview).
--
-- (Number 0006 is the pending skyline_users revoke in supabase/pending/.)

CREATE OR REPLACE FUNCTION public.skyline_trainer_list_my_batches(
  p_token TEXT,
  p_as_user_id BIGINT DEFAULT NULL
)
RETURNS TABLE (
  id BIGINT,
  name TEXT,
  course_name TEXT,
  student_count BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller public.skyline_users%ROWTYPE;
  v_actor  public.skyline_users%ROWTYPE;
BEGIN
  v_caller := public.skyline_staff_from_token(p_token);
  v_actor  := public.skyline_staff_acting_as(v_caller, p_as_user_id);

  RETURN QUERY
  SELECT
    b.id,
    b.name,
    c.name,
    (SELECT count(*) FROM public.skyline_students s WHERE s.batch_id = b.id)
  FROM public.skyline_batches b
  LEFT JOIN public.skyline_courses c ON c.id = b.course_id
  WHERE public.skyline_staff_trains_batch(v_actor.id, b.id)
  ORDER BY b.name, b.id;
END;
$$;

-- The signature changes (new p_batch_id), so drop the old version first; keeping both would
-- leave PostgREST unable to choose between the overloads.
DROP FUNCTION IF EXISTS public.skyline_trainer_list_my_students(TEXT, TEXT, INT, INT, BIGINT);
CREATE FUNCTION public.skyline_trainer_list_my_students(
  p_token TEXT,
  p_search TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25,
  p_offset INT DEFAULT 0,
  p_as_user_id BIGINT DEFAULT NULL,
  p_batch_id BIGINT DEFAULT NULL
)
RETURNS TABLE (
  id BIGINT,
  student_code TEXT,
  full_name TEXT,
  email TEXT,
  phone TEXT,
  status TEXT,
  batch_id BIGINT,
  batch_name TEXT,
  course_name TEXT,
  can_login_as_student BOOLEAN,
  total_count BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller public.skyline_users%ROWTYPE;
  v_actor  public.skyline_users%ROWTYPE;
  v_q TEXT := NULLIF(trim(COALESCE(p_search, '')), '');
BEGIN
  v_caller := public.skyline_staff_from_token(p_token);
  v_actor  := public.skyline_staff_acting_as(v_caller, p_as_user_id);

  IF p_batch_id IS NOT NULL AND NOT public.skyline_staff_trains_batch(v_actor.id, p_batch_id) THEN
    RAISE SQLSTATE 'PT403' USING
      MESSAGE = 'You can only view the batches you train.',
      DETAIL  = 'BATCH_NOT_YOURS';
  END IF;

  RETURN QUERY
  SELECT
    s.id,
    s.student_id::text,
    COALESCE(NULLIF(trim(concat_ws(' ', s.first_name, s.last_name)), ''), s.name),
    s.email,
    s.phone,
    s.status,
    b.id,
    b.name,
    c.name,
    public.skyline_staff_may_login_as_student(v_actor.id, s.id),
    count(*) OVER ()
  FROM public.skyline_students s
  JOIN public.skyline_batches b ON b.id = s.batch_id
  LEFT JOIN public.skyline_courses c ON c.id = b.course_id
  WHERE (
      -- One batch (already checked above) or every batch the actor trains.
      CASE WHEN p_batch_id IS NOT NULL
           THEN b.id = p_batch_id
           ELSE public.skyline_staff_trains_batch(v_actor.id, b.id)
      END
    )
    AND (
      v_q IS NULL
      OR s.name ILIKE '%' || v_q || '%'
      OR concat_ws(' ', s.first_name, s.last_name) ILIKE '%' || v_q || '%'
      OR s.email ILIKE '%' || v_q || '%'
      OR s.student_id::text ILIKE '%' || v_q || '%'
      OR b.name ILIKE '%' || v_q || '%'
    )
  ORDER BY b.name, 3, s.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 200)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$$;

REVOKE ALL ON FUNCTION public.skyline_trainer_list_my_batches(TEXT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.skyline_trainer_list_my_students(TEXT, TEXT, INT, INT, BIGINT, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.skyline_trainer_list_my_batches(TEXT, BIGINT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.skyline_trainer_list_my_students(TEXT, TEXT, INT, INT, BIGINT, BIGINT) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
