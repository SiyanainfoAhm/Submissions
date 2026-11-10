-- "My students" for trainers.
--
-- Trainers had no page that lists students, so they could never reach the "Login as student"
-- button. These two token-checked RPCs back a trainer-only list and a basic details page.
-- A trainer only ever sees students in batches they train (primary trainer or listed in
-- skyline_batch_trainers).

-- Internal: is this staff user a trainer of the batch?
CREATE OR REPLACE FUNCTION public.skyline_staff_trains_batch(p_user_id BIGINT, p_batch_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_batch_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.skyline_batches b
    WHERE b.id = p_batch_id
      AND (
        b.trainer_id = p_user_id
        OR EXISTS (
          SELECT 1 FROM public.skyline_batch_trainers bt
          WHERE bt.batch_id = b.id AND bt.user_id = p_user_id
        )
      )
  );
$$;

REVOKE ALL ON FUNCTION public.skyline_staff_trains_batch(BIGINT, BIGINT) FROM PUBLIC, anon, authenticated;

-- List the students in the batches the caller trains.
CREATE OR REPLACE FUNCTION public.skyline_trainer_list_my_students(
  p_token TEXT,
  p_search TEXT DEFAULT NULL,
  p_limit INT DEFAULT 20,
  p_offset INT DEFAULT 0
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
  v_q TEXT := NULLIF(trim(COALESCE(p_search, '')), '');
BEGIN
  v_caller := public.skyline_staff_from_token(p_token);

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
    public.skyline_staff_may_login_as_student(v_caller.id, s.id),
    count(*) OVER ()
  FROM public.skyline_students s
  JOIN public.skyline_batches b ON b.id = s.batch_id
  LEFT JOIN public.skyline_courses c ON c.id = b.course_id
  WHERE public.skyline_staff_trains_batch(v_caller.id, b.id)
    AND (
      v_q IS NULL
      OR s.name ILIKE '%' || v_q || '%'
      OR concat_ws(' ', s.first_name, s.last_name) ILIKE '%' || v_q || '%'
      OR s.email ILIKE '%' || v_q || '%'
      OR s.student_id::text ILIKE '%' || v_q || '%'
      OR b.name ILIKE '%' || v_q || '%'
    )
  ORDER BY b.name, 3, s.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 200)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$$;

-- Basic details for one student. A trainer gets PT403 for a student outside their batches.
CREATE OR REPLACE FUNCTION public.skyline_trainer_get_student(p_token TEXT, p_student_id BIGINT)
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
  can_login_as_student BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller  public.skyline_users%ROWTYPE;
  v_student public.skyline_students%ROWTYPE;
BEGIN
  v_caller := public.skyline_staff_from_token(p_token);

  SELECT s.* INTO v_student FROM public.skyline_students s WHERE s.id = p_student_id;

  -- Same answer for "no such student" and "not yours" so ids cannot be probed.
  IF v_student.id IS NULL
     OR (
       v_caller.role NOT IN ('admin', 'superadmin')
       AND NOT public.skyline_staff_trains_batch(v_caller.id, v_student.batch_id)
     ) THEN
    RAISE SQLSTATE 'PT403' USING
      MESSAGE = 'You can only view students in the batches you train.',
      DETAIL  = 'STUDENT_NOT_IN_YOUR_BATCHES';
  END IF;

  RETURN QUERY
  SELECT
    v_student.id,
    v_student.student_id::text,
    COALESCE(NULLIF(trim(concat_ws(' ', v_student.first_name, v_student.last_name)), ''), v_student.name),
    v_student.email,
    v_student.phone,
    v_student.status,
    b.id,
    b.name,
    c.name,
    public.skyline_staff_may_login_as_student(v_caller.id, v_student.id)
  FROM (SELECT 1) one
  LEFT JOIN public.skyline_batches b ON b.id = v_student.batch_id
  LEFT JOIN public.skyline_courses c ON c.id = b.course_id;
END;
$$;

REVOKE ALL ON FUNCTION public.skyline_trainer_list_my_students(TEXT, TEXT, INT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.skyline_trainer_get_student(TEXT, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.skyline_trainer_list_my_students(TEXT, TEXT, INT, INT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.skyline_trainer_get_student(TEXT, BIGINT) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
