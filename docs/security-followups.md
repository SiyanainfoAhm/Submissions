# Security follow-ups

Written 2026-11-10, after the trainer login-as-student change
(`20261110000001_trainer_login_as_student.sql`) and the password-login clean-up
(`20261110000002_close_password_login_holes.sql`).

Background: the app does not use Supabase Auth. Every browser request runs as the `anon`
database role, and most tables have no RLS. Staff identity is now provable on the server
through the session token returned by `skyline_verify_otp_login` (12-hour expiry, resolved
with `skyline_staff_from_token`). The items below use that token to close what is still open.

## 1. Open student dashboard

- `/student/dashboard` trusts `sessionStorage['signflow_student_dashboard_auth_v1']`. Anyone can
  set a `studentId` there by hand and open that student's dashboard, with no row in
  `impersonation_logs`.
- The student tables (`skyline_students`, `skyline_form_instances`, `skyline_form_answers`, …)
  are readable and writable with the public anon key.
- Fix: issue student session tokens from `skyline_verify_student_otp` (and from
  `skyline_login_as_student`, marked as impersonated), then move student reads/writes behind
  token-checked RPCs or RLS.

## 0. Pending: the `skyline_users` revoke (do this first)

`supabase/pending/20261110000006_revoke_client_writes_on_users.sql` is written but **not applied**.
It revokes client INSERT / UPDATE / DELETE on `skyline_users` and EXECUTE on the old
`skyline_create_user`. Until it runs, a trainer can still make themselves an admin with one
direct table write.

Apply it only after the build that uses `skyline_admin_create_user` / `skyline_admin_update_user`
is live on https://submissions.slit.edu.au and open tabs have refreshed. Then test: direct
insert / update / delete on `skyline_users` denied, `skyline_create_user` denied, OTP login still
works, and adding / editing a user from the Users page still works. Roll back by re-granting.

## 2. Lock-down phase 1 — `skyline_users`

Done except for the revoke above: token-checked `skyline_admin_create_user` and
`skyline_admin_update_user` exist and the frontend uses them; `skyline_admin_set_password` is no
longer callable by clients. The notes below are kept for reference.

- Replace the direct insert/update in `src/lib/formEngine.ts` (`createTrainer`, `updateUser`)
  with `skyline_admin_create_user(p_token, …)` and `skyline_admin_update_user(p_token, …)`.
  Changing `role` or any `can_*` flag should need a superadmin token.
- `skyline_create_user` and `skyline_admin_set_password` are callable by `anon` with no caller
  check. Add a token parameter, or revoke them if password login stays unused.
- Then: `REVOKE INSERT, UPDATE, DELETE ON skyline_users FROM anon, authenticated`.
- Already done: clients can no longer read `password_hash` (column-level SELECT), and
  `skyline_login` / `skyline_change_password` are no longer executable by clients.
- Consider clearing the 24 stored `password_hash` values, since nothing uses them.

## 3. Lock-down phase 2 — batch membership

Each of these lets a trainer put themselves and a student into a batch that has
"allow trainers to log in as students" switched on:

- `skyline_batch_trainers` is client-writable (`syncBatchTrainers` in `formEngine.ts`).
- `skyline_batches` is client-writable (`trainer_id`, `course_id`; the flag itself is protected
  by a trigger).
- `skyline_students.batch_id` is client-writable, and `skyline_update_batch_student_assignments`
  is callable by `anon` with no caller check.

Fix: one `skyline_admin_save_batch(p_token, …)` RPC for name, course, trainers and the flag; add
a token to `skyline_update_batch_student_assignments` and the batch delete RPCs; then revoke
client writes on `skyline_batches` and `skyline_batch_trainers`, and block client changes to
`skyline_students.batch_id`.

## 4. Lock-down phase 3 — edge functions

`skyline-record-student-payment`, `skyline-upload-payment-receipt` and `send-notification` trust a
`staffUserId` sent in the request body. They should read the session token from a header,
resolve the caller with `skyline_staff_from_token` (service role), and ignore any user id in
the body.

## 4b. Trainer pages still read student data directly

"My students" (`/admin/my-students`) lists and shows students through token-checked RPCs, but the
underlying tables are still readable with the anon key (see item 1), and the trainer dashboard and
course-unit pages still query them directly. The RPCs set the pattern; the table access is closed
in the student-data lock-down.

## 5. Impersonation log viewer

`impersonation_logs` is written on every successful login-as-student, and
`skyline_list_impersonation_logs(p_token, p_limit, p_offset)` returns it to admins, but there
is no screen for it yet. Add an admin page (actor, student, batch, time, IP).

## Rollout rule for every revoke

Ship the frontend that uses the new RPC first, wait until open browser tabs have refreshed,
then revoke the direct table access. Revoking first breaks whatever is deployed at that moment.

## Smaller notes

- New columns on `skyline_users` are not readable by clients until granted:
  `GRANT SELECT (new_col) ON public.skyline_users TO anon, authenticated;` and add the column to
  `STAFF_USER_COLUMNS` in `src/lib/formEngine.ts`.
- `src/pages/AdminAssessmentsPage.tsx:404` embeds `skyline_users(full_name, email)` from
  `skyline_batches`. PostgREST rejects it as ambiguous (three foreign keys to `skyline_users`), so
  the trainer name there always falls back to "trainer". This predates these changes; name the
  relationship (`skyline_users!skyline_batches_trainer_id_fkey(...)`) to fix it.
- Staff sessions last 12 hours. The rest of the app still relies on the user stored in
  `localStorage`, so after 12 hours only the token-checked actions ask the person to sign in again.
