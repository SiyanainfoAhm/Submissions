-- DRAFT — NOT APPLIED. Review before running. Cleans duplicate steps (same form_id + title).
-- Every FK below the step is ON DELETE CASCADE (steps -> sections -> questions -> answers/marks),
-- so student data is re-pointed to the keeper step BEFORE any delete, and backed up first.
-- Keeper step = copy holding the most student data (ties -> lowest id). Row-level conflicts: see step 3.

BEGIN;

-- ===== SCOPE: edit this list. Only these forms are touched. An empty list aborts (never "all forms"). =====
CREATE TEMP TABLE target_forms(form_id bigint PRIMARY KEY) ON COMMIT DROP;
INSERT INTO target_forms(form_id) VALUES (141);   -- e.g. (141) first; later add the rest, e.g. (141),(152)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM target_forms) THEN RAISE EXCEPTION 'target_forms is empty'; END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='backup' AND tablename='dupstep_steps_20261104') THEN
    RAISE EXCEPTION 'backup.*_20261104 tables already exist (a previous run). Replace the _20261104 suffix with a new one for this run.';
  END IF;
END $$;

-- 0. Backups (full rows of every duplicate step and everything beneath it) — target forms only
CREATE SCHEMA IF NOT EXISTS backup;
CREATE TABLE backup.dupstep_steps_20261104 AS
  SELECT s.* FROM skyline_form_steps s
  WHERE s.form_id IN (SELECT form_id FROM target_forms)
    AND EXISTS (SELECT 1 FROM skyline_form_steps x WHERE x.form_id=s.form_id AND x.title=s.title AND x.id<>s.id);
CREATE TABLE backup.dupstep_sections_20261104 AS
  SELECT * FROM skyline_form_sections WHERE step_id IN (SELECT id FROM backup.dupstep_steps_20261104);
CREATE TABLE backup.dupstep_questions_20261104 AS
  SELECT * FROM skyline_form_questions WHERE section_id IN (SELECT id FROM backup.dupstep_sections_20261104);
CREATE TABLE backup.dupstep_answers_20261104 AS
  SELECT * FROM skyline_form_answers WHERE question_id IN (SELECT id FROM backup.dupstep_questions_20261104);
CREATE TABLE backup.dupstep_trainer_assess_20261104 AS
  SELECT * FROM skyline_form_trainer_assessments WHERE question_id IN (SELECT id FROM backup.dupstep_questions_20261104);
CREATE TABLE backup.dupstep_trainer_row_assess_20261104 AS
  SELECT * FROM skyline_form_trainer_row_assessments WHERE question_id IN (SELECT id FROM backup.dupstep_questions_20261104);
CREATE TABLE backup.dupstep_results_data_20261104 AS
  SELECT * FROM skyline_form_results_data WHERE section_id IN (SELECT id FROM backup.dupstep_sections_20261104);
CREATE TABLE backup.dupstep_results_office_20261104 AS
  SELECT * FROM skyline_form_results_office WHERE section_id IN (SELECT id FROM backup.dupstep_sections_20261104);

-- 1. Choose keeper per (form_id, title)
CREATE TEMP TABLE step_map ON COMMIT DROP AS
WITH scored AS (
  SELECT s.id, s.form_id, s.title,
    (SELECT count(*) FROM skyline_form_answers a JOIN skyline_form_questions q ON q.id=a.question_id
       JOIN skyline_form_sections sec ON sec.id=q.section_id WHERE sec.step_id=s.id)
  + (SELECT count(*) FROM skyline_form_trainer_assessments t JOIN skyline_form_questions q ON q.id=t.question_id
       JOIN skyline_form_sections sec ON sec.id=q.section_id WHERE sec.step_id=s.id)
  + (SELECT count(*) FROM skyline_form_trainer_row_assessments t JOIN skyline_form_questions q ON q.id=t.question_id
       JOIN skyline_form_sections sec ON sec.id=q.section_id WHERE sec.step_id=s.id)
  + (SELECT count(*) FROM skyline_form_results_data r JOIN skyline_form_sections sec ON sec.id=r.section_id WHERE sec.step_id=s.id)
  + (SELECT count(*) FROM skyline_form_results_office r JOIN skyline_form_sections sec ON sec.id=r.section_id WHERE sec.step_id=s.id) AS data_rows
  FROM skyline_form_steps s
  WHERE s.form_id IN (SELECT form_id FROM target_forms)
    AND EXISTS (SELECT 1 FROM skyline_form_steps x WHERE x.form_id=s.form_id AND x.title=s.title AND x.id<>s.id)
), ranked AS (
  SELECT *, first_value(id) OVER (PARTITION BY form_id, title ORDER BY data_rows DESC, id) AS keeper_id FROM scored
)
SELECT id AS dup_id, keeper_id FROM ranked WHERE id <> keeper_id;

-- 2. Section and question maps (match by render mode+title, then code+sort_order)
CREATE TEMP TABLE section_map ON COMMIT DROP AS
SELECT ds.id AS dup_section, ks.id AS keeper_section
FROM step_map m
JOIN skyline_form_sections ds ON ds.step_id = m.dup_id
JOIN skyline_form_sections ks ON ks.step_id = m.keeper_id
  AND ks.pdf_render_mode IS NOT DISTINCT FROM ds.pdf_render_mode AND ks.title = ds.title;

CREATE TEMP TABLE question_map ON COMMIT DROP AS
SELECT dq.id AS dup_q, kq.id AS keeper_q
FROM section_map sm
JOIN skyline_form_questions dq ON dq.section_id = sm.dup_section
JOIN skyline_form_questions kq ON kq.section_id = sm.keeper_section
  AND kq.code IS NOT DISTINCT FROM dq.code AND kq.sort_order = dq.sort_order AND kq.type = dq.type;

-- 3. Resolve conflicts + re-point student data (3a-3c: pick one winner row; 3d-3e results_*: FIELD-LEVEL MERGE).
--    For each (instance, target question/section[, row]) group we rank ALL candidate rows (keeper's + every
--    duplicate's) and keep ONE winner: real content first, then latest updated_at, then the keeper's row,
--    then lowest id. Losers are backed up (dup-owned losers are already in the backup tables from step 0;
--    keeper-owned losers are copied to backup.dupstep_displaced_*) before being removed.
--    "Real content" = a non-blank value / mark / date / signature, not just an empty placeholder row.

-- 3a. answers
CREATE TEMP TABLE ans_rank ON COMMIT DROP AS
SELECT a.id, COALESCE(qm.keeper_q, a.question_id) AS target_q, (qm.dup_q IS NOT NULL) AS is_dup,
       row_number() OVER w AS rk, count(*) OVER (PARTITION BY a.instance_id, COALESCE(qm.keeper_q, a.question_id), a.row_id) AS grp
FROM skyline_form_answers a
LEFT JOIN question_map qm ON qm.dup_q = a.question_id
WHERE qm.dup_q IS NOT NULL OR a.question_id IN (SELECT keeper_q FROM question_map)
WINDOW w AS (PARTITION BY a.instance_id, COALESCE(qm.keeper_q, a.question_id), a.row_id
  ORDER BY (btrim(coalesce(a.value_text,'')) <> '' OR a.value_number IS NOT NULL
            OR (a.value_json IS NOT NULL AND a.value_json::text NOT IN ('null','""','[]','{}'))) DESC,
           a.updated_at DESC NULLS LAST, (qm.dup_q IS NULL) DESC, a.id);

CREATE TABLE backup.dupstep_displaced_answers_20261104 AS
  SELECT a.* FROM skyline_form_answers a JOIN ans_rank r ON r.id = a.id WHERE r.rk > 1 AND NOT r.is_dup;
DELETE FROM skyline_form_answers WHERE id IN (SELECT id FROM ans_rank WHERE rk > 1 AND NOT is_dup);
UPDATE skyline_form_answers a SET question_id = r.target_q FROM ans_rank r WHERE r.id = a.id AND r.is_dup AND r.rk = 1;

-- 3b. trainer assessments (per question)
CREATE TEMP TABLE ta_rank ON COMMIT DROP AS
SELECT t.id, COALESCE(qm.keeper_q, t.question_id) AS target_q, (qm.dup_q IS NOT NULL) AS is_dup,
       row_number() OVER w AS rk, count(*) OVER (PARTITION BY t.instance_id, COALESCE(qm.keeper_q, t.question_id)) AS grp
FROM skyline_form_trainer_assessments t
LEFT JOIN question_map qm ON qm.dup_q = t.question_id
WHERE qm.dup_q IS NOT NULL OR t.question_id IN (SELECT keeper_q FROM question_map)
WINDOW w AS (PARTITION BY t.instance_id, COALESCE(qm.keeper_q, t.question_id)
  ORDER BY (btrim(coalesce(t.satisfactory,'')) <> '') DESC, t.updated_at DESC NULLS LAST, (qm.dup_q IS NULL) DESC, t.id);

CREATE TABLE backup.dupstep_displaced_trainer_assess_20261104 AS
  SELECT t.* FROM skyline_form_trainer_assessments t JOIN ta_rank r ON r.id = t.id WHERE r.rk > 1 AND NOT r.is_dup;
DELETE FROM skyline_form_trainer_assessments WHERE id IN (SELECT id FROM ta_rank WHERE rk > 1 AND NOT is_dup);
UPDATE skyline_form_trainer_assessments t SET question_id = r.target_q FROM ta_rank r WHERE r.id = t.id AND r.is_dup AND r.rk = 1;

-- 3c. trainer row assessments (per question + row)
CREATE TEMP TABLE tra_rank ON COMMIT DROP AS
SELECT t.id, COALESCE(qm.keeper_q, t.question_id) AS target_q, (qm.dup_q IS NOT NULL) AS is_dup,
       row_number() OVER w AS rk, count(*) OVER (PARTITION BY t.instance_id, COALESCE(qm.keeper_q, t.question_id), t.row_id) AS grp
FROM skyline_form_trainer_row_assessments t
LEFT JOIN question_map qm ON qm.dup_q = t.question_id
WHERE qm.dup_q IS NOT NULL OR t.question_id IN (SELECT keeper_q FROM question_map)
WINDOW w AS (PARTITION BY t.instance_id, COALESCE(qm.keeper_q, t.question_id), t.row_id
  ORDER BY (btrim(coalesce(t.satisfactory,'')) <> '') DESC, t.updated_at DESC NULLS LAST, (qm.dup_q IS NULL) DESC, t.id);

CREATE TABLE backup.dupstep_displaced_trainer_row_assess_20261104 AS
  SELECT t.* FROM skyline_form_trainer_row_assessments t JOIN tra_rank r ON r.id = t.id WHERE r.rk > 1 AND NOT r.is_dup;
DELETE FROM skyline_form_trainer_row_assessments WHERE id IN (SELECT id FROM tra_rank WHERE rk > 1 AND NOT is_dup);
UPDATE skyline_form_trainer_row_assessments t SET question_id = r.target_q FROM tra_rank r WHERE r.id = t.id AND r.is_dup AND r.rk = 1;

-- 3d. results_data — FIELD-LEVEL MERGE per (instance, section).
--     Candidates = keeper's row + every duplicate's row. Priority: keeper first, then newest updated_at, then id.
--     Each column takes the first non-blank value in priority order (so keeper's value wins when present, the
--     duplicate fills the gaps). Signatures follow the same rule. Result is written onto ONE surviving row
--     (the keeper's row if it exists, else the top duplicate row, which is moved to the keeper section).
CREATE TEMP TABLE rd_cand ON COMMIT DROP AS
SELECT x.*, COALESCE(sm.keeper_section, x.section_id) AS target_s, (sm.dup_section IS NOT NULL) AS is_dup,
       row_number() OVER (PARTITION BY x.instance_id, COALESCE(sm.keeper_section, x.section_id)
                          ORDER BY (sm.dup_section IS NOT NULL), x.updated_at DESC NULLS LAST, x.id) AS prio
FROM skyline_form_results_data x
LEFT JOIN section_map sm ON sm.dup_section = x.section_id
WHERE sm.dup_section IS NOT NULL OR x.section_id IN (SELECT keeper_section FROM section_map);

CREATE TEMP TABLE rd_merged ON COMMIT DROP AS
SELECT instance_id, target_s, (array_agg(id ORDER BY prio))[1] AS survivor_id, max(updated_at) AS updated_at,
  (array_agg(first_attempt_satisfactory  ORDER BY prio) FILTER (WHERE btrim(coalesce(first_attempt_satisfactory,''))  <> ''))[1] AS first_attempt_satisfactory,
  (array_agg(first_attempt_date          ORDER BY prio) FILTER (WHERE btrim(coalesce(first_attempt_date,''))          <> ''))[1] AS first_attempt_date,
  (array_agg(first_attempt_feedback      ORDER BY prio) FILTER (WHERE btrim(coalesce(first_attempt_feedback,''))      <> ''))[1] AS first_attempt_feedback,
  (array_agg(second_attempt_satisfactory ORDER BY prio) FILTER (WHERE btrim(coalesce(second_attempt_satisfactory,'')) <> ''))[1] AS second_attempt_satisfactory,
  (array_agg(second_attempt_date         ORDER BY prio) FILTER (WHERE btrim(coalesce(second_attempt_date,''))         <> ''))[1] AS second_attempt_date,
  (array_agg(second_attempt_feedback     ORDER BY prio) FILTER (WHERE btrim(coalesce(second_attempt_feedback,''))     <> ''))[1] AS second_attempt_feedback,
  (array_agg(third_attempt_satisfactory  ORDER BY prio) FILTER (WHERE btrim(coalesce(third_attempt_satisfactory,''))  <> ''))[1] AS third_attempt_satisfactory,
  (array_agg(third_attempt_date          ORDER BY prio) FILTER (WHERE btrim(coalesce(third_attempt_date,''))          <> ''))[1] AS third_attempt_date,
  (array_agg(third_attempt_feedback      ORDER BY prio) FILTER (WHERE btrim(coalesce(third_attempt_feedback,''))      <> ''))[1] AS third_attempt_feedback,
  (array_agg(trainer_name                ORDER BY prio) FILTER (WHERE btrim(coalesce(trainer_name,''))                <> ''))[1] AS trainer_name,
  (array_agg(trainer_signature           ORDER BY prio) FILTER (WHERE btrim(coalesce(trainer_signature,''))           <> ''))[1] AS trainer_signature,
  (array_agg(trainer_date                ORDER BY prio) FILTER (WHERE btrim(coalesce(trainer_date,''))                <> ''))[1] AS trainer_date,
  (array_agg(student_name                ORDER BY prio) FILTER (WHERE btrim(coalesce(student_name,''))                <> ''))[1] AS student_name,
  (array_agg(student_signature           ORDER BY prio) FILTER (WHERE btrim(coalesce(student_signature,''))           <> ''))[1] AS student_signature
FROM rd_cand GROUP BY instance_id, target_s HAVING count(*) > 1;

-- Back up the keeper-owned originals that are about to be overwritten (duplicate originals are in the step 0 backups).
CREATE TABLE backup.dupstep_premerge_results_data_20261104 AS
  SELECT x.* FROM skyline_form_results_data x
  WHERE x.id IN (SELECT c.id FROM rd_cand c JOIN rd_merged m ON m.instance_id=c.instance_id AND m.target_s=c.target_s WHERE NOT c.is_dup);

UPDATE skyline_form_results_data x SET
  first_attempt_satisfactory = m.first_attempt_satisfactory, first_attempt_date = m.first_attempt_date, first_attempt_feedback = m.first_attempt_feedback,
  second_attempt_satisfactory = m.second_attempt_satisfactory, second_attempt_date = m.second_attempt_date, second_attempt_feedback = m.second_attempt_feedback,
  third_attempt_satisfactory = m.third_attempt_satisfactory, third_attempt_date = m.third_attempt_date, third_attempt_feedback = m.third_attempt_feedback,
  trainer_name = m.trainer_name, trainer_signature = m.trainer_signature, trainer_date = m.trainer_date,
  student_name = m.student_name, student_signature = m.student_signature,
  updated_at = m.updated_at, section_id = m.target_s
FROM rd_merged m WHERE x.id = m.survivor_id;

-- delete the non-surviving duplicate rows in merged groups
DELETE FROM skyline_form_results_data
WHERE id IN (SELECT c.id FROM rd_cand c JOIN rd_merged m ON m.instance_id=c.instance_id AND m.target_s=c.target_s
             WHERE c.is_dup AND c.id <> m.survivor_id);
-- duplicate rows with no keeper counterpart simply move across
UPDATE skyline_form_results_data x SET section_id = c.target_s
FROM rd_cand c
WHERE c.id = x.id AND c.is_dup
  AND NOT EXISTS (SELECT 1 FROM rd_merged m WHERE m.instance_id=c.instance_id AND m.target_s=c.target_s);

-- 3e. results_office — same field-level merge. Dates/text: first non-blank by priority. Checkboxes: true if EITHER is true.
CREATE TEMP TABLE ro_cand ON COMMIT DROP AS
SELECT x.*, COALESCE(sm.keeper_section, x.section_id) AS target_s, (sm.dup_section IS NOT NULL) AS is_dup,
       row_number() OVER (PARTITION BY x.instance_id, COALESCE(sm.keeper_section, x.section_id)
                          ORDER BY (sm.dup_section IS NOT NULL), x.updated_at DESC NULLS LAST, x.id) AS prio
FROM skyline_form_results_office x
LEFT JOIN section_map sm ON sm.dup_section = x.section_id
WHERE sm.dup_section IS NOT NULL OR x.section_id IN (SELECT keeper_section FROM section_map);

CREATE TEMP TABLE ro_merged ON COMMIT DROP AS
SELECT instance_id, target_s, (array_agg(id ORDER BY prio))[1] AS survivor_id, max(updated_at) AS updated_at,
  (array_agg(entered_date ORDER BY prio) FILTER (WHERE entered_date IS NOT NULL))[1] AS entered_date,
  (array_agg(entered_by   ORDER BY prio) FILTER (WHERE btrim(coalesce(entered_by,'')) <> ''))[1] AS entered_by,
  bool_or(initial_checked) AS initial_checked, bool_or(updated_checked) AS updated_checked
FROM ro_cand GROUP BY instance_id, target_s HAVING count(*) > 1;

CREATE TABLE backup.dupstep_premerge_results_office_20261104 AS
  SELECT x.* FROM skyline_form_results_office x
  WHERE x.id IN (SELECT c.id FROM ro_cand c JOIN ro_merged m ON m.instance_id=c.instance_id AND m.target_s=c.target_s WHERE NOT c.is_dup);

UPDATE skyline_form_results_office x SET
  entered_date = m.entered_date, entered_by = m.entered_by,
  initial_checked = m.initial_checked, updated_checked = m.updated_checked,
  updated_at = m.updated_at, section_id = m.target_s
FROM ro_merged m WHERE x.id = m.survivor_id;

DELETE FROM skyline_form_results_office
WHERE id IN (SELECT c.id FROM ro_cand c JOIN ro_merged m ON m.instance_id=c.instance_id AND m.target_s=c.target_s
             WHERE c.is_dup AND c.id <> m.survivor_id);
UPDATE skyline_form_results_office x SET section_id = c.target_s
FROM ro_cand c
WHERE c.id = x.id AND c.is_dup
  AND NOT EXISTS (SELECT 1 FROM ro_merged m WHERE m.instance_id=c.instance_id AND m.target_s=c.target_s);

-- 4. Safety gate: abort if a duplicate-step question/section that carries real student data had NO keeper
--    equivalent (so it was never mapped and would be cascade-deleted). Unmapped = custom content only on the dup.
DO $$
DECLARE n bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM skyline_form_answers a
       JOIN skyline_form_questions q ON q.id = a.question_id JOIN skyline_form_sections s ON s.id = q.section_id
       WHERE s.step_id IN (SELECT dup_id FROM step_map) AND a.question_id NOT IN (SELECT dup_q FROM question_map))
  + (SELECT count(*) FROM skyline_form_trainer_assessments t
       JOIN skyline_form_questions q ON q.id = t.question_id JOIN skyline_form_sections s ON s.id = q.section_id
       WHERE s.step_id IN (SELECT dup_id FROM step_map) AND t.question_id NOT IN (SELECT dup_q FROM question_map))
  + (SELECT count(*) FROM skyline_form_trainer_row_assessments t
       JOIN skyline_form_questions q ON q.id = t.question_id JOIN skyline_form_sections s ON s.id = q.section_id
       WHERE s.step_id IN (SELECT dup_id FROM step_map) AND t.question_id NOT IN (SELECT dup_q FROM question_map))
  + (SELECT count(*) FROM skyline_form_results_data r JOIN skyline_form_sections s ON s.id = r.section_id
       WHERE s.step_id IN (SELECT dup_id FROM step_map) AND r.section_id NOT IN (SELECT dup_section FROM section_map))
  + (SELECT count(*) FROM skyline_form_results_office r JOIN skyline_form_sections s ON s.id = r.section_id
       WHERE s.step_id IN (SELECT dup_id FROM step_map) AND r.section_id NOT IN (SELECT dup_section FROM section_map))
  INTO n;
  IF n > 0 THEN RAISE EXCEPTION 'Aborting: % student-data rows sit on duplicate-step questions/sections with no keeper equivalent', n; END IF;
END $$;

-- 5. Delete duplicate steps (cascades only to now-empty / already-backed-up dup sections & questions)
DELETE FROM skyline_form_steps WHERE id IN (SELECT dup_id FROM step_map);

-- 6. Re-pack sort_order per form so the order is contiguous and the originals' relative order is kept
WITH r AS (SELECT id, row_number() OVER (PARTITION BY form_id ORDER BY sort_order, id) - 1 AS n FROM skyline_form_steps WHERE form_id IN (SELECT form_id FROM target_forms))
UPDATE skyline_form_steps s SET sort_order = r.n FROM r WHERE r.id = s.id AND s.sort_order <> r.n;

COMMIT;
