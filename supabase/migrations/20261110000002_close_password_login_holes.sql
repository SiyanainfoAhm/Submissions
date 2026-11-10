-- Close the password-login holes. All staff sign in with OTP only.
--
-- 1. skyline_login (password login, including the empty-password path for is_master
--    accounts) and skyline_change_password have no callers in any app, so clients can
--    no longer execute them. PUBLIC is revoked too: functions are executable by PUBLIC
--    by default, so revoking only anon/authenticated would change nothing.
--    service_role keeps EXECUTE.
REVOKE EXECUTE ON FUNCTION public.skyline_login(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.skyline_change_password(BIGINT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- 2. Stop clients reading skyline_users.password_hash.
--    Table-level SELECT is replaced by column-level SELECT on every column except
--    password_hash. Consequences:
--      * select('*') on skyline_users now fails for clients - list columns explicitly.
--      * A column added to skyline_users later is NOT readable by clients until it is
--        granted here-style: GRANT SELECT (new_col) ON public.skyline_users TO anon, authenticated;
REVOKE SELECT ON public.skyline_users FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  id,
  full_name,
  email,
  phone,
  status,
  role,
  is_master,
  can_login_as_student,
  can_login_as_trainer,
  can_view_finance_reports,
  created_at,
  updated_at,
  updated_by
) ON public.skyline_users TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
