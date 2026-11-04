-- READ-ONLY preview of the FIELD-LEVEL MERGE for form 141 (two SELECTs, CTEs only). Project: qoylrmorezlqdvufonmx.
-- Rule (same as migration 3d/3e): per column keep the keeper's value if non-blank, else take the duplicate's;
-- checkboxes true if either side is true; signatures keeper-first. Change the form id in `params`.
--
-- Columns:
--   filled_from_dup   fields that were blank on the keeper and get the duplicate's value
--   conflicts         fields where BOTH sides are non-blank but DIFFERENT -> keeper's value is kept and the duplicate's
--                     value is discarded (it stays in the backup tables). REVIEW EVERY ROW WHERE THIS IS NOT NULL.
--   dup_copies        >1 means 3+ copies of the step; the merge then folds all of them, this preview shows one pair per dup
--   keeper_before / merged_after   jsonb of the fields (signatures shown as 'present' / '' rather than the image data)

-- ===== A. results_data =====
WITH params AS (SELECT 141::bigint AS form_id),
scored AS (
  SELECT s.id, s.form_id, s.title,
    (SELECT count(*) FROM skyline_form_answers a JOIN skyline_form_questions q ON q.id=a.question_id JOIN skyline_form_sections sec ON sec.id=q.section_id WHERE sec.step_id=s.id)
  + (SELECT count(*) FROM skyline_form_trainer_assessments t JOIN skyline_form_questions q ON q.id=t.question_id JOIN skyline_form_sections sec ON sec.id=q.section_id WHERE sec.step_id=s.id)
  + (SELECT count(*) FROM skyline_form_trainer_row_assessments t JOIN skyline_form_questions q ON q.id=t.question_id JOIN skyline_form_sections sec ON sec.id=q.section_id WHERE sec.step_id=s.id)
  + (SELECT count(*) FROM skyline_form_results_data r JOIN skyline_form_sections sec ON sec.id=r.section_id WHERE sec.step_id=s.id)
  + (SELECT count(*) FROM skyline_form_results_office r JOIN skyline_form_sections sec ON sec.id=r.section_id WHERE sec.step_id=s.id) AS data_rows
  FROM skyline_form_steps s
  WHERE s.form_id = (SELECT form_id FROM params)
    AND EXISTS (SELECT 1 FROM skyline_form_steps x WHERE x.form_id=s.form_id AND x.title=s.title AND x.id<>s.id)
), ranked AS (SELECT *, first_value(id) OVER (PARTITION BY form_id, title ORDER BY data_rows DESC, id) AS keeper_id FROM scored),
step_map AS (SELECT id AS dup_id, keeper_id, title AS step_title FROM ranked WHERE id <> keeper_id),
section_map AS (
  SELECT ds.id AS dup_section, ks.id AS keeper_section, m.dup_id, m.keeper_id, m.step_title, ds.title AS section_title
  FROM step_map m JOIN skyline_form_sections ds ON ds.step_id=m.dup_id
  JOIN skyline_form_sections ks ON ks.step_id=m.keeper_id AND ks.pdf_render_mode IS NOT DISTINCT FROM ds.pdf_render_mode AND ks.title=ds.title
),
pairs AS (
  SELECT sm.step_title, sm.section_title, sm.keeper_id AS keeper_step, sm.dup_id AS dup_step, k.instance_id,
         k.id AS keeper_row, d.id AS dup_row, k.updated_at AS keeper_updated, d.updated_at AS dup_updated,
         count(*) OVER (PARTITION BY k.id) AS dup_copies, to_jsonb(k) AS kj, to_jsonb(d) AS dj
  FROM section_map sm
  JOIN skyline_form_results_data k ON k.section_id = sm.keeper_section
  JOIN skyline_form_results_data d ON d.section_id = sm.dup_section AND d.instance_id = k.instance_id
),
f AS (
  SELECT p.keeper_row, p.dup_row, kv.key,
         CASE WHEN kv.key LIKE '%signature' THEN CASE WHEN btrim(coalesce(kv.value,''))<>'' THEN 'present' ELSE '' END ELSE coalesce(kv.value,'') END AS kshow,
         CASE WHEN kv.key LIKE '%signature' THEN CASE WHEN btrim(coalesce(dv.value,''))<>'' THEN 'present' ELSE '' END ELSE coalesce(dv.value,'') END AS dshow,
         btrim(coalesce(kv.value,'')) AS kval, btrim(coalesce(dv.value,'')) AS dval
  FROM pairs p
  CROSS JOIN LATERAL jsonb_each_text(p.kj) kv
  JOIN LATERAL jsonb_each_text(p.dj) dv ON dv.key = kv.key
  WHERE kv.key IN ('first_attempt_satisfactory','first_attempt_date','first_attempt_feedback',
                   'second_attempt_satisfactory','second_attempt_date','second_attempt_feedback',
                   'third_attempt_satisfactory','third_attempt_date','third_attempt_feedback',
                   'trainer_name','trainer_signature','trainer_date','student_name','student_signature')
)
SELECT p.instance_id, p.step_title, p.section_title, p.keeper_step, p.dup_step, p.keeper_row, p.dup_row,
       p.keeper_updated, p.dup_updated, p.dup_copies,
       string_agg(f.key, ', ' ORDER BY f.key) FILTER (WHERE f.kval = '' AND f.dval <> '') AS filled_from_dup,
       string_agg(f.key || ': keeper=[' || left(f.kshow,60) || '] dup=[' || left(f.dshow,60) || ']', '; ' ORDER BY f.key)
         FILTER (WHERE f.kval <> '' AND f.dval <> '' AND f.kval <> f.dval AND f.key NOT LIKE '%signature') AS conflicts,
       jsonb_object_agg(f.key, f.kshow ORDER BY f.key) FILTER (WHERE f.kshow <> '') AS keeper_before,
       jsonb_object_agg(f.key, CASE WHEN f.kval <> '' THEN f.kshow ELSE f.dshow END ORDER BY f.key)
         FILTER (WHERE (CASE WHEN f.kval <> '' THEN f.kshow ELSE f.dshow END) <> '') AS merged_after,
       count(*) FILTER (WHERE f.kval = '' AND f.dval <> '') AS n_filled
FROM pairs p JOIN f ON f.keeper_row = p.keeper_row AND f.dup_row = p.dup_row
GROUP BY p.instance_id, p.step_title, p.section_title, p.keeper_step, p.dup_step, p.keeper_row, p.dup_row,
         p.keeper_updated, p.dup_updated, p.dup_copies
ORDER BY n_filled DESC, p.instance_id, p.section_title;

-- ===== B. results_office =====
WITH params AS (SELECT 141::bigint AS form_id),
scored AS (
  SELECT s.id, s.form_id, s.title,
    (SELECT count(*) FROM skyline_form_answers a JOIN skyline_form_questions q ON q.id=a.question_id JOIN skyline_form_sections sec ON sec.id=q.section_id WHERE sec.step_id=s.id)
  + (SELECT count(*) FROM skyline_form_trainer_assessments t JOIN skyline_form_questions q ON q.id=t.question_id JOIN skyline_form_sections sec ON sec.id=q.section_id WHERE sec.step_id=s.id)
  + (SELECT count(*) FROM skyline_form_trainer_row_assessments t JOIN skyline_form_questions q ON q.id=t.question_id JOIN skyline_form_sections sec ON sec.id=q.section_id WHERE sec.step_id=s.id)
  + (SELECT count(*) FROM skyline_form_results_data r JOIN skyline_form_sections sec ON sec.id=r.section_id WHERE sec.step_id=s.id)
  + (SELECT count(*) FROM skyline_form_results_office r JOIN skyline_form_sections sec ON sec.id=r.section_id WHERE sec.step_id=s.id) AS data_rows
  FROM skyline_form_steps s
  WHERE s.form_id = (SELECT form_id FROM params)
    AND EXISTS (SELECT 1 FROM skyline_form_steps x WHERE x.form_id=s.form_id AND x.title=s.title AND x.id<>s.id)
), ranked AS (SELECT *, first_value(id) OVER (PARTITION BY form_id, title ORDER BY data_rows DESC, id) AS keeper_id FROM scored),
step_map AS (SELECT id AS dup_id, keeper_id, title AS step_title FROM ranked WHERE id <> keeper_id),
section_map AS (
  SELECT ds.id AS dup_section, ks.id AS keeper_section, m.dup_id, m.keeper_id, m.step_title, ds.title AS section_title
  FROM step_map m JOIN skyline_form_sections ds ON ds.step_id=m.dup_id
  JOIN skyline_form_sections ks ON ks.step_id=m.keeper_id AND ks.pdf_render_mode IS NOT DISTINCT FROM ds.pdf_render_mode AND ks.title=ds.title
)
SELECT k.instance_id, sm.step_title, sm.section_title, sm.keeper_id AS keeper_step, sm.dup_id AS dup_step,
  k.id AS keeper_row, d.id AS dup_row, k.updated_at AS keeper_updated, d.updated_at AS dup_updated,
  count(*) OVER (PARTITION BY k.id) AS dup_copies,
  jsonb_build_object('entered_date', k.entered_date, 'entered_by', k.entered_by,
                     'initial_checked', k.initial_checked, 'updated_checked', k.updated_checked) AS keeper_before,
  jsonb_build_object('entered_date', coalesce(k.entered_date, d.entered_date),
                     'entered_by', CASE WHEN btrim(coalesce(k.entered_by,''))<>'' THEN k.entered_by ELSE d.entered_by END,
                     'initial_checked', k.initial_checked OR d.initial_checked,
                     'updated_checked', k.updated_checked OR d.updated_checked) AS merged_after,
  concat_ws(', ',
    CASE WHEN k.entered_date IS NULL AND d.entered_date IS NOT NULL THEN 'entered_date' END,
    CASE WHEN btrim(coalesce(k.entered_by,''))='' AND btrim(coalesce(d.entered_by,''))<>'' THEN 'entered_by' END,
    CASE WHEN NOT k.initial_checked AND d.initial_checked THEN 'initial_checked' END,
    CASE WHEN NOT k.updated_checked AND d.updated_checked THEN 'updated_checked' END) AS filled_from_dup,
  concat_ws('; ',
    CASE WHEN k.entered_date IS NOT NULL AND d.entered_date IS NOT NULL AND k.entered_date <> d.entered_date
         THEN 'entered_date: keeper=[' || k.entered_date || '] dup=[' || d.entered_date || ']' END,
    CASE WHEN btrim(coalesce(k.entered_by,''))<>'' AND btrim(coalesce(d.entered_by,''))<>'' AND btrim(k.entered_by) <> btrim(d.entered_by)
         THEN 'entered_by: keeper=[' || k.entered_by || '] dup=[' || d.entered_by || ']' END) AS conflicts
FROM section_map sm
JOIN skyline_form_results_office k ON k.section_id = sm.keeper_section
JOIN skyline_form_results_office d ON d.section_id = sm.dup_section AND d.instance_id = k.instance_id
ORDER BY (concat_ws('', k.entered_by) = '') DESC, k.instance_id, sm.section_title;
