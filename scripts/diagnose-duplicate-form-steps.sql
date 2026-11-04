-- READ-ONLY diagnostics for duplicate steps (same form_id + title). Safe to run in the SQL editor.
-- Project: qoylrmorezlqdvufonmx

-- 1. Every duplicated (form_id, title) across ALL forms
SELECT s.form_id, f.name, f.version, s.title, count(*) AS copies,
       array_agg(s.id ORDER BY s.id) AS step_ids, array_agg(s.sort_order ORDER BY s.id) AS sort_orders
FROM skyline_form_steps s JOIN skyline_forms f ON f.id = s.form_id
GROUP BY s.form_id, f.name, f.version, s.title
HAVING count(*) > 1
ORDER BY s.form_id, s.title;

-- 2. CPCCPD2012 step list in order (expect 6 after cleanup)
SELECT s.id, s.sort_order, s.title, s.created_at
FROM skyline_form_steps s JOIN skyline_forms f ON f.id = s.form_id
WHERE f.unit_code = 'CPCCPD2012' ORDER BY s.form_id, s.sort_order, s.id;

-- 3. Student data hanging off each duplicate step (answers / trainer marks / results)
WITH dup AS (
  SELECT s.id, s.form_id, s.title,
         row_number() OVER (PARTITION BY s.form_id, s.title ORDER BY s.id) AS rn
  FROM skyline_form_steps s
)
SELECT d.form_id, d.title, d.id AS step_id, d.rn,
  (SELECT count(*) FROM skyline_form_answers a JOIN skyline_form_questions q ON q.id=a.question_id
     JOIN skyline_form_sections sec ON sec.id=q.section_id WHERE sec.step_id=d.id) AS answers,
  (SELECT count(*) FROM skyline_form_trainer_assessments t JOIN skyline_form_questions q ON q.id=t.question_id
     JOIN skyline_form_sections sec ON sec.id=q.section_id WHERE sec.step_id=d.id) AS trainer_marks,
  (SELECT count(*) FROM skyline_form_trainer_row_assessments t JOIN skyline_form_questions q ON q.id=t.question_id
     JOIN skyline_form_sections sec ON sec.id=q.section_id WHERE sec.step_id=d.id) AS trainer_row_marks,
  (SELECT count(*) FROM skyline_form_results_data r JOIN skyline_form_sections sec ON sec.id=r.section_id WHERE sec.step_id=d.id) AS results_data,
  (SELECT count(*) FROM skyline_form_results_office r JOIN skyline_form_sections sec ON sec.id=r.section_id WHERE sec.step_id=d.id) AS results_office
FROM dup d
WHERE EXISTS (SELECT 1 FROM dup x WHERE x.form_id=d.form_id AND x.title=d.title AND x.id<>d.id)
ORDER BY d.form_id, d.title, d.id;

-- 4. Same title, different case/whitespace (would slip past a plain unique index)
SELECT form_id, lower(btrim(title)) AS t, count(*) FROM skyline_form_steps
GROUP BY 1,2 HAVING count(*) > 1 AND count(DISTINCT title) > 1;
