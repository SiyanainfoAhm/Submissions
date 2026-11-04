-- Assessment "extension date" on instances. DRAFT — run by hand in the Supabase SQL editor (not applied automatically).
--
--   * extension_date (nullable date): an admin-granted later deadline. The effective deadline everywhere is
--     COALESCE(extension_date, end_date). Setting an extension NEVER changes end_date.
--   * Existing rows are backfilled with extension_date = end_date (rows with no end_date stay NULL).
--     New instances get NULL (= no extension, deadline is end_date).
--   * CHECK: extension_date is never earlier than end_date.
--   * Trigger keeps the two in step whenever end_date moves (rollover, imports, RPCs, any client):
--       - extension_date equal to the OLD end_date mirrors the new end_date            (an "inactive" extension)
--       - an extension that would end up earlier than the NEW end_date is raised to it  (end moved past the extension)
--     Neither rule fires when the same statement sets extension_date explicitly.
--
-- Re-running is blocked on purpose: the backup table below is created WITHOUT "IF NOT EXISTS", so a second run
-- aborts (a re-backfill would wrongly give every new instance extension_date = end_date).

BEGIN;

-- 0. Snapshot, so you can prove end_date was not changed: see supabase/queries/extension_date_verify.sql
CREATE SCHEMA IF NOT EXISTS backup;
CREATE TABLE backup.instance_end_dates_before_extension_20261105 AS
  SELECT id, end_date FROM public.skyline_form_instances;

-- 1. Column
ALTER TABLE public.skyline_form_instances ADD COLUMN IF NOT EXISTS extension_date date;
COMMENT ON COLUMN public.skyline_form_instances.extension_date IS
  'Optional admin-granted later deadline. Effective deadline = COALESCE(extension_date, end_date). Never earlier than end_date.';

-- 2. Backfill. The instances table has row triggers that must not fire for this bulk change
--    (skyline_set_updated_at would bump updated_at on every row; auto-assign-trainer runs on any UPDATE).
ALTER TABLE public.skyline_form_instances DISABLE TRIGGER skyline_form_instances_updated_at;
ALTER TABLE public.skyline_form_instances DISABLE TRIGGER skyline_auto_assign_trainer_on_student_submit;

UPDATE public.skyline_form_instances
SET extension_date = end_date
WHERE end_date IS NOT NULL AND extension_date IS NULL;

ALTER TABLE public.skyline_form_instances ENABLE TRIGGER skyline_form_instances_updated_at;
ALTER TABLE public.skyline_form_instances ENABLE TRIGGER skyline_auto_assign_trainer_on_student_submit;

-- 3. Guard (after the backfill, which satisfies it)
ALTER TABLE public.skyline_form_instances
  ADD CONSTRAINT skyline_form_instances_extension_not_before_end
  CHECK (extension_date IS NULL OR end_date IS NULL OR extension_date >= end_date);

-- 4. Keep extension_date in step when end_date changes
CREATE OR REPLACE FUNCTION public.skyline_form_instances_sync_extension_date()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only when this statement did not set extension_date itself.
  IF NEW.extension_date IS NOT DISTINCT FROM OLD.extension_date THEN
    IF OLD.extension_date IS NOT NULL AND OLD.extension_date IS NOT DISTINCT FROM OLD.end_date THEN
      -- Extension was just a copy of the old end date: follow the new end date (also when it becomes NULL).
      NEW.extension_date := NEW.end_date;
    ELSIF NEW.extension_date IS NOT NULL AND NEW.end_date IS NOT NULL AND NEW.extension_date < NEW.end_date THEN
      -- end_date moved past a real extension: the deadline must not go backwards.
      NEW.extension_date := NEW.end_date;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS skyline_form_instances_extension_mirror ON public.skyline_form_instances;
CREATE TRIGGER skyline_form_instances_extension_mirror
  BEFORE UPDATE OF end_date ON public.skyline_form_instances
  FOR EACH ROW
  WHEN (NEW.end_date IS DISTINCT FROM OLD.end_date)
  EXECUTE FUNCTION public.skyline_form_instances_sync_extension_date();

COMMIT;
