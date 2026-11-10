-- Lock-down phase 1, step 1 of 2 (ADDITIVE - safe to apply before the new frontend ships).
--
-- Adds token-checked RPCs for creating and updating staff users. Nothing the deployed
-- frontend uses is changed or removed here; the old paths are closed in
-- supabase/pending/20261110000006_revoke_client_writes_on_users.sql once the new frontend is live.
--
-- The one removal: skyline_admin_set_password has no caller in any app and password login
-- is gone, so clients lose EXECUTE now.
--
-- Status codes: PT400 bad input, PT401 no/expired session, PT403 not allowed,
-- PT404 not found, PT409 email already used.

-- ---------------------------------------------------------------------------
-- Create a staff user. Caller must be admin or superadmin; only a superadmin may create
-- admin or superadmin accounts. No password is stored (OTP login only).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.skyline_admin_create_user(
  p_token TEXT,
  p_full_name TEXT,
  p_email TEXT,
  p_phone TEXT DEFAULT NULL,
  p_status TEXT DEFAULT 'active',
  p_role TEXT DEFAULT 'trainer'
)
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
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller public.skyline_users%ROWTYPE;
  v_id BIGINT;
BEGIN
  v_caller := public.skyline_staff_from_token(p_token);
  IF v_caller.role NOT IN ('admin', 'superadmin') THEN
    RAISE SQLSTATE 'PT403' USING MESSAGE = 'Only an admin can add users.', DETAIL = 'ADMIN_REQUIRED';
  END IF;

  IF p_full_name IS NULL OR length(trim(p_full_name)) = 0 THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'Full name is required.', DETAIL = 'INVALID_INPUT';
  END IF;
  IF p_email IS NULL OR length(trim(p_email)) = 0 THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'Email is required.', DETAIL = 'INVALID_INPUT';
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('superadmin', 'admin', 'trainer', 'office') THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'Role must be super admin, admin, trainer or office.', DETAIL = 'INVALID_INPUT';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('active', 'inactive') THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'Status must be active or inactive.', DETAIL = 'INVALID_INPUT';
  END IF;

  IF p_role IN ('admin', 'superadmin') AND v_caller.role <> 'superadmin' THEN
    RAISE SQLSTATE 'PT403' USING
      MESSAGE = 'Only a super admin can add admin or super admin accounts.',
      DETAIL  = 'SUPERADMIN_REQUIRED';
  END IF;

  BEGIN
    INSERT INTO public.skyline_users AS u (full_name, email, phone, status, role, updated_by)
    VALUES (trim(p_full_name), lower(trim(p_email)), NULLIF(trim(p_phone), ''), p_status, p_role, v_caller.id)
    RETURNING u.id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE = 'A user with this email already exists.', DETAIL = 'EMAIL_TAKEN';
  END;

  RETURN QUERY
  SELECT u.id, u.full_name, u.email, u.phone, u.status, u.role,
         u.can_login_as_student, u.can_login_as_trainer, u.can_view_finance_reports, u.created_at
  FROM public.skyline_users u
  WHERE u.id = v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Update a staff user. p_changes is a JSON object; only the keys present are changed.
-- Allowed keys: full_name, email, phone, status, role, can_login_as_student,
-- can_login_as_trainer, can_view_finance_reports.
--
-- Rules
--   * Caller must be admin or superadmin.
--   * Changing role or any can_* right needs a superadmin. (Sending the current value is
--     not a change.)
--   * An admin may edit trainer and office accounts, and their own name / email / phone.
--     Editing another admin or a superadmin needs a superadmin - otherwise an admin could
--     change another admin's email and sign in as them through OTP.
--   * Nobody can change their own role or status (prevents locking yourself out).
--   * is_master and password_hash cannot be changed here.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.skyline_admin_update_user(
  p_token TEXT,
  p_user_id BIGINT,
  p_changes JSONB
)
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
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller public.skyline_users%ROWTYPE;
  v_target public.skyline_users%ROWTYPE;
  v_key TEXT;
  v_full_name TEXT;
  v_email TEXT;
  v_phone TEXT;
  v_status TEXT;
  v_role TEXT;
  v_can_student BOOLEAN;
  v_can_trainer BOOLEAN;
  v_can_finance BOOLEAN;
  v_privileged BOOLEAN;
BEGIN
  v_caller := public.skyline_staff_from_token(p_token);
  IF v_caller.role NOT IN ('admin', 'superadmin') THEN
    RAISE SQLSTATE 'PT403' USING MESSAGE = 'Only an admin can edit users.', DETAIL = 'ADMIN_REQUIRED';
  END IF;

  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'Nothing to update.', DETAIL = 'INVALID_INPUT';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_changes) LOOP
    IF v_key NOT IN ('full_name', 'email', 'phone', 'status', 'role',
                     'can_login_as_student', 'can_login_as_trainer', 'can_view_finance_reports') THEN
      RAISE SQLSTATE 'PT400' USING MESSAGE = format('Field "%s" cannot be changed.', v_key), DETAIL = 'INVALID_INPUT';
    END IF;
  END LOOP;

  SELECT u.* INTO v_target FROM public.skyline_users u WHERE u.id = p_user_id FOR UPDATE;
  IF v_target.id IS NULL THEN
    RAISE SQLSTATE 'PT404' USING MESSAGE = 'User not found.', DETAIL = 'USER_NOT_FOUND';
  END IF;

  -- New values: the key's value when present, otherwise the current value.
  v_full_name := CASE WHEN p_changes ? 'full_name' THEN trim(p_changes->>'full_name') ELSE v_target.full_name END;
  v_email     := CASE WHEN p_changes ? 'email' THEN lower(trim(p_changes->>'email')) ELSE v_target.email END;
  v_phone     := CASE WHEN p_changes ? 'phone' THEN NULLIF(trim(p_changes->>'phone'), '') ELSE v_target.phone END;
  v_status    := CASE WHEN p_changes ? 'status' THEN p_changes->>'status' ELSE v_target.status END;
  v_role      := CASE WHEN p_changes ? 'role' THEN p_changes->>'role' ELSE v_target.role END;
  BEGIN
    v_can_student := CASE WHEN p_changes ? 'can_login_as_student'
                          THEN COALESCE((p_changes->>'can_login_as_student')::boolean, false)
                          ELSE v_target.can_login_as_student END;
    v_can_trainer := CASE WHEN p_changes ? 'can_login_as_trainer'
                          THEN COALESCE((p_changes->>'can_login_as_trainer')::boolean, false)
                          ELSE v_target.can_login_as_trainer END;
    v_can_finance := CASE WHEN p_changes ? 'can_view_finance_reports'
                          THEN COALESCE((p_changes->>'can_view_finance_reports')::boolean, false)
                          ELSE v_target.can_view_finance_reports END;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'Rights must be true or false.', DETAIL = 'INVALID_INPUT';
  END;

  IF v_full_name IS NULL OR length(v_full_name) = 0 THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'Full name is required.', DETAIL = 'INVALID_INPUT';
  END IF;
  IF v_email IS NULL OR length(v_email) = 0 THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'Email is required.', DETAIL = 'INVALID_INPUT';
  END IF;
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'trainer', 'office') THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'Role must be super admin, admin, trainer or office.', DETAIL = 'INVALID_INPUT';
  END IF;
  IF v_status IS NULL OR v_status NOT IN ('active', 'inactive') THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'Status must be active or inactive.', DETAIL = 'INVALID_INPUT';
  END IF;

  v_privileged :=
       v_role IS DISTINCT FROM v_target.role
    OR v_can_student IS DISTINCT FROM v_target.can_login_as_student
    OR v_can_trainer IS DISTINCT FROM v_target.can_login_as_trainer
    OR v_can_finance IS DISTINCT FROM v_target.can_view_finance_reports;

  IF v_caller.role <> 'superadmin' THEN
    IF v_privileged THEN
      RAISE SQLSTATE 'PT403' USING
        MESSAGE = 'Only a super admin can change a user''s role or rights.',
        DETAIL  = 'SUPERADMIN_REQUIRED';
    END IF;
    IF v_target.role IN ('admin', 'superadmin') AND v_target.id <> v_caller.id THEN
      RAISE SQLSTATE 'PT403' USING
        MESSAGE = 'Only a super admin can edit admin accounts.',
        DETAIL  = 'SUPERADMIN_REQUIRED';
    END IF;
  END IF;

  IF v_target.id = v_caller.id
     AND (v_role IS DISTINCT FROM v_target.role OR v_status IS DISTINCT FROM v_target.status) THEN
    RAISE SQLSTATE 'PT403' USING
      MESSAGE = 'You cannot change your own role or status.',
      DETAIL  = 'SELF_CHANGE_NOT_ALLOWED';
  END IF;

  BEGIN
    UPDATE public.skyline_users u
    SET full_name = v_full_name,
        email = v_email,
        phone = v_phone,
        status = v_status,
        role = v_role,
        can_login_as_student = v_can_student,
        can_login_as_trainer = v_can_trainer,
        can_view_finance_reports = v_can_finance,
        updated_by = v_caller.id
    WHERE u.id = v_target.id;
  EXCEPTION WHEN unique_violation THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE = 'A user with this email already exists.', DETAIL = 'EMAIL_TAKEN';
  END;

  RETURN QUERY
  SELECT u.id, u.full_name, u.email, u.phone, u.status, u.role,
         u.can_login_as_student, u.can_login_as_trainer, u.can_view_finance_reports, u.created_at
  FROM public.skyline_users u
  WHERE u.id = v_target.id;
END;
$$;

REVOKE ALL ON FUNCTION public.skyline_admin_create_user(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.skyline_admin_update_user(TEXT, BIGINT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.skyline_admin_create_user(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.skyline_admin_update_user(TEXT, BIGINT, JSONB) TO anon, authenticated, service_role;

-- skyline_admin_set_password: no caller anywhere and password login is gone.
REVOKE EXECUTE ON FUNCTION public.skyline_admin_set_password(BIGINT, TEXT) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
