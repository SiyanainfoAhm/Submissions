-- Per-batch "trainers may log in as students" switch, server-side authorisation,
-- staff session tokens and an impersonation audit log.
--
-- The app does not use Supabase Auth: every client request runs as the `anon` role.
-- Staff identity is therefore proven with a server-issued session token (returned by the
-- login RPCs, stored hashed) and every privileged action goes through a SECURITY DEFINER
-- RPC that resolves the caller from that token.
--
-- HTTP status codes: PostgREST turns SQLSTATE 'PTxxx' into HTTP xxx, so
-- PT401 = session missing/expired, PT403 = not allowed, PT404 = not found.

-- ---------------------------------------------------------------------------
-- 1. Batch flag
-- ---------------------------------------------------------------------------
ALTER TABLE public.skyline_batches
  ADD COLUMN IF NOT EXISTS allow_trainer_student_login BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.skyline_batches.allow_trainer_student_login IS
  'When true, trainers assigned to this batch may use "Login as student" for students in this batch. Admin-only; change via skyline_set_batch_trainer_student_login().';

-- ---------------------------------------------------------------------------
-- 2. Staff sessions (token is stored as a SHA-256 hash only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.skyline_staff_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES public.skyline_users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '12 hours')
);

CREATE INDEX IF NOT EXISTS idx_skyline_staff_sessions_user_id ON public.skyline_staff_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_skyline_staff_sessions_expires_at ON public.skyline_staff_sessions(expires_at);

ALTER TABLE public.skyline_staff_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.skyline_staff_sessions FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Audit log
--    No foreign keys on purpose: an FK would either block the existing
--    delete-student / delete-user / delete-batch flows or erase audit history.
--    Emails are snapshotted so rows stay readable after a delete.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.impersonation_logs (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id        BIGINT NOT NULL,
  actor_role           TEXT   NOT NULL,
  actor_email          TEXT,
  target_student_id    BIGINT NOT NULL,
  target_student_email TEXT,
  batch_id             BIGINT,
  ip                   TEXT,
  user_agent           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_impersonation_logs_created_at ON public.impersonation_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_impersonation_logs_actor ON public.impersonation_logs(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_impersonation_logs_target ON public.impersonation_logs(target_student_id);

-- RLS on, no policies, no client grants: only SECURITY DEFINER functions / service role can touch it.
ALTER TABLE public.impersonation_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.impersonation_logs FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Internal helpers (NOT callable by clients)
-- ---------------------------------------------------------------------------

-- Create a session for a user and return the raw token (only ever returned once).
CREATE OR REPLACE FUNCTION public.skyline_issue_staff_session(p_user_id BIGINT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_token TEXT;
BEGIN
  -- 64 hex chars, 244 random bits (gen_random_uuid is cryptographically strong).
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  DELETE FROM public.skyline_staff_sessions WHERE expires_at <= now();
  INSERT INTO public.skyline_staff_sessions (token_hash, user_id, expires_at)
  VALUES (encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), p_user_id, now() + interval '12 hours');
  RETURN v_token;
END;
$$;

-- Resolve the caller from a token. Raises PT401 when missing, unknown, expired,
-- or when the user is no longer active.
CREATE OR REPLACE FUNCTION public.skyline_staff_from_token(p_token TEXT)
RETURNS public.skyline_users
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user public.skyline_users%ROWTYPE;
BEGIN
  IF p_token IS NOT NULL AND length(p_token) > 0 THEN
    SELECT u.* INTO v_user
    FROM public.skyline_staff_sessions s
    JOIN public.skyline_users u ON u.id = s.user_id
    WHERE s.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
      AND s.expires_at > now()
      AND u.status = 'active';
  END IF;
  IF v_user.id IS NULL THEN
    RAISE SQLSTATE 'PT401' USING
      MESSAGE = 'Your session has expired. Please sign in again.',
      DETAIL  = 'SESSION_INVALID';
  END IF;
  RETURN v_user;
END;
$$;

-- The authorisation rule. Returns true when the staff user may open the student's account.
-- The target is always a row in skyline_students, so a staff account (admin / trainer /
-- office) can never be the target.
CREATE OR REPLACE FUNCTION public.skyline_staff_may_login_as_student(p_user_id BIGINT, p_student_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.skyline_users u
    JOIN public.skyline_students s ON s.id = p_student_id
    WHERE u.id = p_user_id
      AND u.status = 'active'
      AND (
        -- Existing behaviour: superadmin, or admin granted can_login_as_student.
        u.role = 'superadmin'
        OR (u.role = 'admin' AND COALESCE(u.can_login_as_student, false))
        -- New: trainer of the student's batch, when the batch flag is on.
        OR (
          u.role = 'trainer'
          AND EXISTS (
            SELECT 1
            FROM public.skyline_batches b
            WHERE b.id = s.batch_id
              AND b.allow_trainer_student_login = true
              AND (
                b.trainer_id = u.id
                OR EXISTS (
                  SELECT 1 FROM public.skyline_batch_trainers bt
                  WHERE bt.batch_id = b.id AND bt.user_id = u.id
                )
              )
          )
        )
      )
  );
$$;

REVOKE ALL ON FUNCTION public.skyline_issue_staff_session(BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.skyline_staff_from_token(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.skyline_staff_may_login_as_student(BIGINT, BIGINT) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Login RPCs: same logic as the live versions, plus a session_token column.
--    (Return type changes, so they must be dropped and recreated.)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.skyline_login(TEXT, TEXT);
CREATE FUNCTION public.skyline_login(p_email TEXT, p_password TEXT DEFAULT NULL)
RETURNS TABLE (
  id BIGINT,
  full_name TEXT,
  email TEXT,
  phone TEXT,
  status TEXT,
  role TEXT,
  can_login_as_student BOOLEAN,
  can_login_as_trainer BOOLEAN,
  can_view_finance_reports BOOLEAN,
  session_token TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_user public.skyline_users%ROWTYPE;
BEGIN
  -- Master user: bypass password check when p_password is empty or null (unchanged).
  IF p_password IS NULL OR length(trim(p_password)) = 0 THEN
    SELECT u.* INTO v_user
    FROM public.skyline_users u
    WHERE lower(u.email) = lower(trim(p_email))
      AND u.status = 'active'
      AND u.is_master = true
    LIMIT 1;
  END IF;

  -- Regular login: require password (unchanged).
  IF v_user.id IS NULL THEN
    SELECT u.* INTO v_user
    FROM public.skyline_users u
    WHERE u.email = trim(p_email)
      AND u.password_hash IS NOT NULL
      AND u.password_hash = crypt(p_password, u.password_hash)
      AND u.status = 'active'
    LIMIT 1;
  END IF;

  IF v_user.id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    v_user.id,
    v_user.full_name,
    v_user.email,
    v_user.phone,
    v_user.status,
    v_user.role,
    COALESCE(v_user.can_login_as_student, false),
    COALESCE(v_user.can_login_as_trainer, false),
    COALESCE(v_user.can_view_finance_reports, false) OR v_user.role = 'superadmin',
    public.skyline_issue_staff_session(v_user.id);
END;
$$;

DROP FUNCTION IF EXISTS public.skyline_verify_otp_login(TEXT, TEXT);
CREATE FUNCTION public.skyline_verify_otp_login(p_email TEXT, p_otp TEXT)
RETURNS TABLE (
  id BIGINT,
  full_name TEXT,
  email TEXT,
  phone TEXT,
  status TEXT,
  role TEXT,
  can_login_as_student BOOLEAN,
  can_login_as_trainer BOOLEAN,
  can_view_finance_reports BOOLEAN,
  session_token TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_user public.skyline_users%ROWTYPE;
BEGIN
  SELECT u.* INTO v_user
  FROM public.skyline_users u
  WHERE lower(u.email) = lower(trim(p_email))
    AND u.status = 'active'
    AND EXISTS (
      SELECT 1 FROM public.skyline_otps o
      WHERE lower(o.email) = lower(trim(p_email))
        AND o.otp_code = trim(p_otp)
        AND o.expires_at > now()
    )
  LIMIT 1;

  -- Delete used OTP (unchanged).
  DELETE FROM public.skyline_otps o
  WHERE lower(o.email) = lower(trim(p_email))
    AND o.otp_code = trim(p_otp);

  IF v_user.id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    v_user.id,
    v_user.full_name,
    v_user.email,
    v_user.phone,
    v_user.status,
    v_user.role,
    COALESCE(v_user.can_login_as_student, false),
    COALESCE(v_user.can_login_as_trainer, false),
    COALESCE(v_user.can_view_finance_reports, false) OR v_user.role = 'superadmin',
    public.skyline_issue_staff_session(v_user.id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.skyline_login(TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.skyline_verify_otp_login(TEXT, TEXT) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Client-callable RPCs
-- ---------------------------------------------------------------------------

-- Logout: delete the session row. Silent when the token is unknown.
CREATE OR REPLACE FUNCTION public.skyline_logout(p_token TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  DELETE FROM public.skyline_staff_sessions
  WHERE token_hash = encode(sha256(convert_to(COALESCE(p_token, ''), 'UTF8')), 'hex');
$$;

-- UI helper: should the "Login as student" button be shown? No log row is written.
CREATE OR REPLACE FUNCTION public.skyline_can_login_as_student(p_token TEXT, p_student_id BIGINT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller public.skyline_users%ROWTYPE;
BEGIN
  v_caller := public.skyline_staff_from_token(p_token);
  RETURN public.skyline_staff_may_login_as_student(v_caller.id, p_student_id);
END;
$$;

-- The real gate: authorise, write the audit row, return the student to open.
CREATE OR REPLACE FUNCTION public.skyline_login_as_student(p_token TEXT, p_student_id BIGINT)
RETURNS TABLE (student_id BIGINT, student_email TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller  public.skyline_users%ROWTYPE;
  v_student public.skyline_students%ROWTYPE;
  v_headers JSON;
BEGIN
  v_caller := public.skyline_staff_from_token(p_token);

  SELECT s.* INTO v_student FROM public.skyline_students s WHERE s.id = p_student_id;

  IF v_student.id IS NULL
     OR NOT public.skyline_staff_may_login_as_student(v_caller.id, v_student.id) THEN
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
    (actor_user_id, actor_role, actor_email, target_student_id, target_student_email, batch_id, ip, user_agent)
  VALUES (
    v_caller.id,
    v_caller.role,
    v_caller.email,
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

-- Admin-only: switch the batch flag.
CREATE OR REPLACE FUNCTION public.skyline_set_batch_trainer_student_login(
  p_token TEXT,
  p_batch_id BIGINT,
  p_allow BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller public.skyline_users%ROWTYPE;
  v_value  BOOLEAN;
BEGIN
  v_caller := public.skyline_staff_from_token(p_token);
  IF v_caller.role NOT IN ('admin', 'superadmin') THEN
    RAISE SQLSTATE 'PT403' USING
      MESSAGE = 'Only an admin can change this setting.',
      DETAIL  = 'ADMIN_REQUIRED';
  END IF;

  UPDATE public.skyline_batches b
  SET allow_trainer_student_login = COALESCE(p_allow, false),
      updated_by = v_caller.id
  WHERE b.id = p_batch_id
  RETURNING b.allow_trainer_student_login INTO v_value;

  IF NOT FOUND THEN
    RAISE SQLSTATE 'PT404' USING MESSAGE = 'Batch not found.', DETAIL = 'BATCH_NOT_FOUND';
  END IF;
  RETURN v_value;
END;
$$;

-- Admin-only: read the audit log.
CREATE OR REPLACE FUNCTION public.skyline_list_impersonation_logs(
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
         l.target_student_id, l.target_student_email, l.batch_id, b.name, l.ip, l.user_agent
  FROM public.impersonation_logs l
  LEFT JOIN public.skyline_batches b ON b.id = l.batch_id
  ORDER BY l.created_at DESC, l.id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$$;

REVOKE ALL ON FUNCTION public.skyline_logout(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.skyline_can_login_as_student(TEXT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.skyline_login_as_student(TEXT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.skyline_set_batch_trainer_student_login(TEXT, BIGINT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.skyline_list_impersonation_logs(TEXT, INT, INT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.skyline_logout(TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.skyline_can_login_as_student(TEXT, BIGINT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.skyline_login_as_student(TEXT, BIGINT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.skyline_set_batch_trainer_student_login(TEXT, BIGINT, BOOLEAN) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.skyline_list_impersonation_logs(TEXT, INT, INT) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Triggers
-- ---------------------------------------------------------------------------

-- Clients (anon / authenticated) cannot set or change the flag with a direct table write.
-- SECURITY INVOKER on purpose: inside the SECURITY DEFINER RPC above, current_user is the
-- function owner, so the RPC passes; a direct PostgREST write runs as anon and is rejected.
CREATE OR REPLACE FUNCTION public.skyline_guard_batch_login_flag()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') AND (
       (TG_OP = 'INSERT' AND NEW.allow_trainer_student_login IS DISTINCT FROM false)
    OR (TG_OP = 'UPDATE' AND NEW.allow_trainer_student_login IS DISTINCT FROM OLD.allow_trainer_student_login)
  ) THEN
    RAISE SQLSTATE 'PT403' USING
      MESSAGE = 'Only an admin can change whether trainers may log in as students.',
      DETAIL  = 'ADMIN_REQUIRED';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS skyline_batches_guard_login_flag ON public.skyline_batches;
CREATE TRIGGER skyline_batches_guard_login_flag
  BEFORE INSERT OR UPDATE ON public.skyline_batches
  FOR EACH ROW EXECUTE FUNCTION public.skyline_guard_batch_login_flag();

-- Changing a user's role or can_login_as_student, or changing their status
-- (e.g. deactivating them), ends all of their sessions.
CREATE OR REPLACE FUNCTION public.skyline_revoke_staff_sessions_on_user_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM public.skyline_staff_sessions WHERE user_id = NEW.id;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.skyline_revoke_staff_sessions_on_user_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS skyline_users_revoke_sessions ON public.skyline_users;
CREATE TRIGGER skyline_users_revoke_sessions
  AFTER UPDATE ON public.skyline_users
  FOR EACH ROW
  WHEN (
       OLD.role IS DISTINCT FROM NEW.role
    OR OLD.can_login_as_student IS DISTINCT FROM NEW.can_login_as_student
    OR OLD.status IS DISTINCT FROM NEW.status
  )
  EXECUTE FUNCTION public.skyline_revoke_staff_sessions_on_user_change();

-- Make PostgREST pick up the new/changed functions immediately.
NOTIFY pgrst, 'reload schema';
