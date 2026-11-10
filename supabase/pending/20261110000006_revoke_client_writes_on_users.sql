-- Lock-down phase 1, step 2 of 2 (THE REVOKE). NOT APPLIED YET.
--
-- This file lives in supabase/pending/ on purpose so that nothing applies it by accident.
-- Move it into supabase/migrations/ when it is applied.
--
-- DO NOT APPLY until the frontend that calls skyline_admin_create_user /
-- skyline_admin_update_user is deployed and open browser tabs have refreshed. Older builds
-- create users with skyline_create_user (no token) and edit them with a direct UPDATE on
-- skyline_users; both stop working the moment this runs.
--
-- After this, skyline_users can only be written through the token-checked RPCs
-- (or by the service role).

-- Old, unauthenticated create-user RPC (it also stored a default password for every user).
REVOKE EXECUTE ON FUNCTION public.skyline_create_user(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- No direct client writes. TRUNCATE is included because anon/authenticated currently hold it too.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.skyline_users FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
