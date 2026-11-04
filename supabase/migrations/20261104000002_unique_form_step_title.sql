-- DRAFT — NOT APPLIED. Run only AFTER 20261104000001 (cleanup), and only if diagnostics show no remaining dups.
-- Guard: a form cannot have two steps with the same title; concurrent "ensure task steps" callers now
-- hit 23505 instead of silently inserting a second copy (handled in formEngine.insertAssessmentTaskStepWithSections).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM skyline_form_steps GROUP BY form_id, title HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate (form_id, title) steps still exist — run the cleanup first';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_skyline_form_steps_form_title
  ON skyline_form_steps (form_id, title);
