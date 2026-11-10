-- Super admin "Previewing as <user>": trainer RPCs act for the previewed user.
--
-- The preview keeps the super admin's own session token, so the server used to answer for the
-- super admin (e.g. an empty "My students"). These RPCs now take an optional p_as_user_id:
--   * accepted only when the token belongs to a super admin; anyone else passing it gets PT403;
--   * when given, the answer is what the previewed user would get.
-- Login-as-student from a preview is still logged with the super admin as the actor, and the
-- previewed user is recorded alongside.
--
-- Adding a parameter changes the signature, so the old versions are dropped first (keeping
-- both would make PostgREST unable to choose between the overloads). Calls that do not send
-- p_as_user_id keep working unchanged.

ALTER TABLE public.impersonation_logs
  ADD COLUMN IF NOT EXISTS acting_as_user_id BIGINT,
  ADD COLUMN IF NOT EXISTS acting_as_email   TEXT;

COMMENT ON COLUMN public.impersonation_logs.acting_as_user_id IS
  'Set when a super admin did this while previewing as another staff user. actor_user_id is always the real person.';

-- Internal: who is the caller acting for?
CREATE OR REPLACE FUNCTION public.skyline_staff_acting_as(p_caller public.skyline_users, p_as_user_id BIGINT)
RETURNS public.skyline_users
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user public.skyline_users%ROWTYPE;
BEGIN
  IF p_as_user_id IS NULL THEN
    RETURN p_caller;
  END IF;
  IF p_caller.role IS DISTINCT FROM 'superadmin' THEN
    RAISE SQLSTATE 'PT403' USING
      MESSAGE = 'Only a super admin can preview as another user.',
      DETAIL  = 'PREVIEW_NOT_ALLOWED';
  END IF;
  SELECT u.* INTO v_user FROM public.skyline_users u WHERE u.id = p_as_user_id;
  IF v_user.id IS NULL THEN
    RAISE SQLSTATE 'PT404' USING MESSAGE = 'User not found.', DETAIL = 'USER_NOT_FOUND';
  END IF;
  RETURN v_user;
END;
$$;

REVOKE ALL ON FUNCTION public.skyline_staff_acting_as(public.skyline_users, BIGINT) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- My students list
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.skyline_trainer_list_my_students(TEXT, TEXT, INT, INT);
CREATE FUNCTION public.skyline_trainer_list_my_students(
  p_token TEXT,
  p_search TEXT DEFAULT NULL,
  p_limit INT DEFAULT 20,
  p_offset INT DEFAULT 0,
  p_as_user_id BIGINT DEFAULT NULL
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
  WHERE public.skyline_staff_trains_batch(v_actor.id, b.id)
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

-- ---------------------------------------------------------------------------
-- Trainer student details
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.skyline_trainer_get_student(TEXT, BIGINT);
CREATE FUNCTION public.skyline_trainer_get_student(
  p_token TEXT,
  p_student_id BIGINT,
  p_as_user_id BIGINT DEFAULT NULL
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
  can_login_as_student BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller  public.skyline_users%ROWTYPE;
  v_actor   public.skyline_users%ROWTYPE;
  v_student public.skyline_students%ROWTYPE;
BEGIN
  v_caller := public.skyline_staff_from_token(p_token);
  v_actor  := public.skyline_staff_acting_as(v_caller, p_as_user_id);

  SELECT s.* INTO v_student FROM public.skyline_students s WHERE s.id = p_student_id;

  -- Same answer for "no such student" and "not yours" so ids cannot be probed.
  IF v_student.id IS NULL
     OR (
       v_actor.role NOT IN ('admin', 'superadmin')
       AND NOT public.skyline_staff_trains_batch(v_actor.id, v_student.batch_id)
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
    public.skyline_staff_may_login_as_student(v_actor.id, v_student.id)
  FROM (SELECT 1) one
  LEFT JOIN public.skyline_batches b ON b.id = v_student.batch_id
  LEFT JOIN public.skyline_courses c ON c.id = b.course_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Can-login-as-student check (button visibility)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.skyline_can_login_as_student(TEXT, BIGINT);
CREATE FUNCTION public.skyline_can_login_as_student(
  p_token TEXT,
  p_student_id BIGINT,
  p_as_user_id BIGINT DEFAULT NULL
)
RETURNS BOOLEAN
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
  RETURN public.skyline_staff_may_login_as_student(v_actor.id, p_student_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- Login as student. In a preview the permission is the previewed user's, the log row's
-- actor is the super admin, and the previewed user is recorded in acting_as_*.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.skyline_login_as_student(TEXT, BIGINT);
CREATE FUNCTION public.skyline_login_as_student(
  p_token TEXT,
  p_student_id BIGINT,
  p_as_user_id BIGINT DEFAULT NULL
)
RETURNS TABLE (student_id BIGINT, student_email TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller  public.skyline_users%ROWTYPE;
  v_actor   public.skyline_users%ROWTYPE;
  v_student public.skyline_students%ROWTYPE;
  v_headers JSON;
BEGIN
  v_caller := public.skyline_staff_from_token(p_token);
  v_actor  := public.skyline_staff_acting_as(v_caller, p_as_user_id);

  SELECT s.* INTO v_student FROM public.skyline_students s WHERE s.id = p_student_id;

  IF v_student.id IS NULL
     OR NOT public.skyline_staff_may_login_as_student(v_actor.id, v_student.id) THEN
    -- Same answer for "no such student" and "not allowed" so ids cannot be probed.
    RAISE SQLSTATE 'PT403' USING
      MESSAGE = 'You are not allowed to log in as this student.',
      DETAIL  = 'LOGIN_AS_STUDENT_FORBIDDEN';
  END IF;

  BEGIN
    v_headers := NULLIF(current_setting('request.headers', true), '')::json;
  EXCEPTION WHEN OTHERS THEN
    v_headers := NULL;
  END;

  INSERT INTO public.impersonation_logs
    (actor_user_id, actor_role, actor_email, acting_as_user_id, acting_as_email,
     target_student_id, target_student_email, batch_id, ip, user_agent)
  VALUES (
    v_caller.id,
    v_caller.role,
    v_caller.email,
    CASE WHEN v_actor.id <> v_caller.id THEN v_actor.id END,
    CASE WHEN v_actor.id <> v_caller.id THEN v_actor.email END,
    v_student.id,
    v_student.email,
    v_student.batch_id,
    COALESCE(
      NULLIF(v_headers->>'cf-connecting-ip', ''),
      NULLIF(trim(split_part(COALESCE(v_headers->>'x-forwarded-for', ''), ',', 1)), '')
    ),
    left(v_headers->>'user-agent', 500)
  );

  RETURN QUERY SELECT v_student.id, v_student.email;
END;
$$;

-- ---------------------------------------------------------------------------
-- Audit log reader: also return who the actor was previewing as.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.skyline_list_impersonation_logs(TEXT, INT, INT);
CREATE FUNCTION public.skyline_list_impersonation_logs(
  p_token TEXT,
  p_limit INT DEFAULT 100,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (
  id BIGINT,
  created_at TIMESTAMPTZ,
  actor_user_id BIGINT,
  actor_role TEXT,
  actor_email TEXT,
  acting_as_user_id BIGINT,
  acting_as_email TEXT,
  target_student_id BIGINT,
  target_student_email TEXT,
  batch_id BIGINT,
  batch_name TEXT,
  ip TEXT,
  user_agent TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller public.skyline_users%ROWTYPE;
BEGIN
  v_caller := public.skyline_staff_from_token(p_token);
  IF v_caller.role NOT IN ('admin', 'superadmin') THEN
    RAISE SQLSTATE 'PT403' USING
      MESSAGE = 'Only an admin can view login-as-student history.',
      DETAIL  = 'ADMIN_REQUIRED';
  END IF;

  RETURN QUERY
  SELECT l.id, l.created_at, l.actor_user_id, l.actor_role, l.actor_email,
         l.acting_as_user_id, l.acting_as_email,
         l.target_student_id, l.target_student_email, l.batch_id, b.name, l.ip, l.user_agent
  FROM public.impersonation_logs l
  LEFT JOIN public.skyline_batches b ON b.id = l.batch_id
  ORDER BY l.created_at DESC, l.id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$$;

REVOKE ALL ON FUNCTION public.skyline_trainer_list_my_students(TEXT, TEXT, INT, INT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.skyline_trainer_get_student(TEXT, BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.skyline_can_login_as_student(TEXT, BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.skyline_login_as_student(TEXT, BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.skyline_list_impersonation_logs(TEXT, INT, INT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.skyline_trainer_list_my_students(TEXT, TEXT, INT, INT, BIGINT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.skyline_trainer_get_student(TEXT, BIGINT, BIGINT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.skyline_can_login_as_student(TEXT, BIGINT, BIGINT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.skyline_login_as_student(TEXT, BIGINT, BIGINT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.skyline_list_impersonation_logs(TEXT, INT, INT) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
