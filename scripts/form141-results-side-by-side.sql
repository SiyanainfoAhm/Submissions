-- READ-ONLY (two SELECTs, CTEs only). Project: qoylrmorezlqdvufonmx. Form id = 141 (change in the `params` CTE).
-- Shows keeper vs duplicate side by side for every (instance, section) where BOTH exist, flagging which one the
-- cleanup rule would keep (real content > latest updated_at > keeper > lowest id). Filter to dup_wins = true
-- to see just the rows where the duplicate wins (expected: 10 in results_data, 6 in results_office).

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
  SELECT sm.step_title, sm.section_title, sm.keeper_id AS keeper_step, sm.dup_id AS dup_step,
         k.instance_id, k AS kr, d AS dr
  FROM section_map sm
  JOIN skyline_form_results_data k ON k.section_id = sm.keeper_section
  JOIN skyline_form_results_data d ON d.section_id = sm.dup_section AND d.instance_id = k.instance_id
)
SELECT p.instance_id, p.step_title, p.section_title, p.keeper_step, p.dup_step,
  (p.kr).id AS keeper_row, (p.dr).id AS dup_row,
  (p.kr).updated_at AS keeper_updated, (p.dr).updated_at AS dup_updated,
  concat_ws(' | ', (p.kr).first_attempt_satisfactory, (p.kr).first_attempt_date, (p.kr).first_attempt_feedback,
     (p.kr).second_attempt_satisfactory, (p.kr).second_attempt_date, (p.kr).second_attempt_feedback,
     (p.kr).third_attempt_satisfactory, (p.kr).third_attempt_date, (p.kr).third_attempt_feedback) AS keeper_attempts,
  concat_ws(' | ', (p.dr).first_attempt_satisfactory, (p.dr).first_attempt_date, (p.dr).first_attempt_feedback,
     (p.dr).second_attempt_satisfactory, (p.dr).second_attempt_date, (p.dr).second_attempt_feedback,
     (p.dr).third_attempt_satisfactory, (p.dr).third_attempt_date, (p.dr).third_attempt_feedback) AS dup_attempts,
  concat_ws(' | ', (p.kr).trainer_name, (p.kr).trainer_signature IS NOT NULL AND (p.kr).trainer_signature <> '', (p.kr).trainer_date,
     (p.kr).student_name, (p.kr).student_signature IS NOT NULL AND (p.kr).student_signature <> '') AS keeper_sign,
  concat_ws(' | ', (p.dr).trainer_name, (p.dr).trainer_signature IS NOT NULL AND (p.dr).trainer_signature <> '', (p.dr).trainer_date,
     (p.dr).student_name, (p.dr).student_signature IS NOT NULL AND (p.dr).student_signature <> '') AS dup_sign,
  c.k_has AS keeper_has_content, c.d_has AS dup_has_content,
  (c.d_has AND NOT c.k_has) OR (c.d_has = c.k_has AND (p.dr).updated_at > coalesce((p.kr).updated_at, '-infinity')) AS dup_wins
FROM pairs p
CROSS JOIN LATERAL (SELECT
  btrim(concat_ws('', (p.kr).first_attempt_satisfactory,(p.kr).first_attempt_date,(p.kr).first_attempt_feedback,(p.kr).second_attempt_satisfactory,(p.kr).second_attempt_date,(p.kr).second_attempt_feedback,(p.kr).third_attempt_satisfactory,(p.kr).third_attempt_date,(p.kr).third_attempt_feedback,(p.kr).trainer_name,(p.kr).trainer_signature,(p.kr).trainer_date,(p.kr).student_name,(p.kr).student_signature)) <> '' AS k_has,
  btrim(concat_ws('', (p.dr).first_attempt_satisfactory,(p.dr).first_attempt_date,(p.dr).first_attempt_feedback,(p.dr).second_attempt_satisfactory,(p.dr).second_attempt_date,(p.dr).second_attempt_feedback,(p.dr).third_attempt_satisfactory,(p.dr).third_attempt_date,(p.dr).third_attempt_feedback,(p.dr).trainer_name,(p.dr).trainer_signature,(p.dr).trainer_date,(p.dr).student_name,(p.dr).student_signature)) <> '' AS d_has
) c
ORDER BY dup_wins DESC, p.instance_id, p.section_title;

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
  concat_ws(' | ', k.entered_date, k.entered_by, 'initial=' || k.initial_checked, 'updated=' || k.updated_checked) AS keeper_vals,
  concat_ws(' | ', d.entered_date, d.entered_by, 'initial=' || d.initial_checked, 'updated=' || d.updated_checked) AS dup_vals,
  c.k_has AS keeper_has_content, c.d_has AS dup_has_content,
  (c.d_has AND NOT c.k_has) OR (c.d_has = c.k_has AND d.updated_at > coalesce(k.updated_at, '-infinity')) AS dup_wins
FROM section_map sm
JOIN skyline_form_results_office k ON k.section_id = sm.keeper_section
JOIN skyline_form_results_office d ON d.section_id = sm.dup_section AND d.instance_id = k.instance_id
CROSS JOIN LATERAL (SELECT
  (k.entered_date IS NOT NULL OR btrim(coalesce(k.entered_by,'')) <> '' OR k.initial_checked OR k.updated_checked) AS k_has,
  (d.entered_date IS NOT NULL OR btrim(coalesce(d.entered_by,'')) <> '' OR d.initial_checked OR d.updated_checked) AS d_has) c
ORDER BY dup_wins DESC, k.instance_id, sm.section_title;
