-- READ-ONLY (single SELECT, CTEs only). Project: qoylrmorezlqdvufonmx
-- Per form: how many (instance, question/section[, row]) groups have rows on BOTH the keeper and a duplicate step,
-- and who the cleanup migration's rule (real content > latest updated_at > keeper > lowest id) would pick.
-- Mirrors steps 1-3 of supabase/migrations/20261104000001_cleanup_duplicate_form_steps.sql.

WITH scored AS (
  SELECT s.id, s.form_id, s.title,
    (SELECT count(*) FROM skyline_form_answers a JOIN skyline_form_questions q ON q.id=a.question_id JOIN skyline_form_sections sec ON sec.id=q.section_id WHERE sec.step_id=s.id)
  + (SELECT count(*) FROM skyline_form_trainer_assessments t JOIN skyline_form_questions q ON q.id=t.question_id JOIN skyline_form_sections sec ON sec.id=q.section_id WHERE sec.step_id=s.id)
  + (SELECT count(*) FROM skyline_form_trainer_row_assessments t JOIN skyline_form_questions q ON q.id=t.question_id JOIN skyline_form_sections sec ON sec.id=q.section_id WHERE sec.step_id=s.id)
  + (SELECT count(*) FROM skyline_form_results_data r JOIN skyline_form_sections sec ON sec.id=r.section_id WHERE sec.step_id=s.id)
  + (SELECT count(*) FROM skyline_form_results_office r JOIN skyline_form_sections sec ON sec.id=r.section_id WHERE sec.step_id=s.id) AS data_rows
  FROM skyline_form_steps s
  WHERE EXISTS (SELECT 1 FROM skyline_form_steps x WHERE x.form_id=s.form_id AND x.title=s.title AND x.id<>s.id)
), ranked AS (
  SELECT *, first_value(id) OVER (PARTITION BY form_id, title ORDER BY data_rows DESC, id) AS keeper_id FROM scored
), step_map AS (SELECT id AS dup_id, keeper_id, form_id FROM ranked WHERE id <> keeper_id),
section_map AS (
  SELECT ds.id AS dup_section, ks.id AS keeper_section, m.form_id
  FROM step_map m JOIN skyline_form_sections ds ON ds.step_id=m.dup_id
  JOIN skyline_form_sections ks ON ks.step_id=m.keeper_id AND ks.pdf_render_mode IS NOT DISTINCT FROM ds.pdf_render_mode AND ks.title=ds.title
), question_map AS (
  SELECT dq.id AS dup_q, kq.id AS keeper_q, sm.form_id
  FROM section_map sm JOIN skyline_form_questions dq ON dq.section_id=sm.dup_section
  JOIN skyline_form_questions kq ON kq.section_id=sm.keeper_section AND kq.code IS NOT DISTINCT FROM dq.code AND kq.sort_order=dq.sort_order AND kq.type=dq.type
),
ans AS (
  SELECT 'answers' AS kind, COALESCE(qm.form_id, km.form_id) AS form_id, (qm.dup_q IS NOT NULL) AS is_dup,
    row_number() OVER w AS rk, count(*) OVER (PARTITION BY a.instance_id, COALESCE(qm.keeper_q,a.question_id), a.row_id) AS grp
  FROM skyline_form_answers a
  LEFT JOIN question_map qm ON qm.dup_q=a.question_id
  LEFT JOIN (SELECT DISTINCT keeper_q, form_id FROM question_map) km ON km.keeper_q=a.question_id
  WHERE qm.dup_q IS NOT NULL OR km.keeper_q IS NOT NULL
  WINDOW w AS (PARTITION BY a.instance_id, COALESCE(qm.keeper_q,a.question_id), a.row_id
    ORDER BY (btrim(coalesce(a.value_text,''))<>'' OR a.value_number IS NOT NULL OR (a.value_json IS NOT NULL AND a.value_json::text NOT IN ('null','""','[]','{}'))) DESC,
             a.updated_at DESC NULLS LAST, (qm.dup_q IS NULL) DESC, a.id)
), ta AS (
  SELECT 'trainer_assessments' AS kind, COALESCE(qm.form_id, km.form_id) AS form_id, (qm.dup_q IS NOT NULL) AS is_dup,
    row_number() OVER w AS rk, count(*) OVER (PARTITION BY t.instance_id, COALESCE(qm.keeper_q,t.question_id)) AS grp
  FROM skyline_form_trainer_assessments t
  LEFT JOIN question_map qm ON qm.dup_q=t.question_id
  LEFT JOIN (SELECT DISTINCT keeper_q, form_id FROM question_map) km ON km.keeper_q=t.question_id
  WHERE qm.dup_q IS NOT NULL OR km.keeper_q IS NOT NULL
  WINDOW w AS (PARTITION BY t.instance_id, COALESCE(qm.keeper_q,t.question_id)
    ORDER BY (btrim(coalesce(t.satisfactory,''))<>'') DESC, t.updated_at DESC NULLS LAST, (qm.dup_q IS NULL) DESC, t.id)
), tra AS (
  SELECT 'trainer_row_assessments' AS kind, COALESCE(qm.form_id, km.form_id) AS form_id, (qm.dup_q IS NOT NULL) AS is_dup,
    row_number() OVER w AS rk, count(*) OVER (PARTITION BY t.instance_id, COALESCE(qm.keeper_q,t.question_id), t.row_id) AS grp
  FROM skyline_form_trainer_row_assessments t
  LEFT JOIN question_map qm ON qm.dup_q=t.question_id
  LEFT JOIN (SELECT DISTINCT keeper_q, form_id FROM question_map) km ON km.keeper_q=t.question_id
  WHERE qm.dup_q IS NOT NULL OR km.keeper_q IS NOT NULL
  WINDOW w AS (PARTITION BY t.instance_id, COALESCE(qm.keeper_q,t.question_id), t.row_id
    ORDER BY (btrim(coalesce(t.satisfactory,''))<>'') DESC, t.updated_at DESC NULLS LAST, (qm.dup_q IS NULL) DESC, t.id)
), rd AS (
  SELECT 'results_data' AS kind, COALESCE(sm.form_id, km.form_id) AS form_id, (sm.dup_section IS NOT NULL) AS is_dup,
    row_number() OVER w AS rk, count(*) OVER (PARTITION BY x.instance_id, COALESCE(sm.keeper_section,x.section_id)) AS grp
  FROM skyline_form_results_data x
  LEFT JOIN section_map sm ON sm.dup_section=x.section_id
  LEFT JOIN (SELECT DISTINCT keeper_section, form_id FROM section_map) km ON km.keeper_section=x.section_id
  WHERE sm.dup_section IS NOT NULL OR km.keeper_section IS NOT NULL
  WINDOW w AS (PARTITION BY x.instance_id, COALESCE(sm.keeper_section,x.section_id)
    ORDER BY (btrim(concat_ws('', x.first_attempt_satisfactory, x.first_attempt_date, x.first_attempt_feedback, x.second_attempt_satisfactory, x.second_attempt_date, x.second_attempt_feedback, x.third_attempt_satisfactory, x.third_attempt_date, x.third_attempt_feedback, x.trainer_name, x.trainer_signature, x.trainer_date, x.student_name, x.student_signature))<>'') DESC,
             x.updated_at DESC NULLS LAST, (sm.dup_section IS NULL) DESC, x.id)
), ro AS (
  SELECT 'results_office' AS kind, COALESCE(sm.form_id, km.form_id) AS form_id, (sm.dup_section IS NOT NULL) AS is_dup,
    row_number() OVER w AS rk, count(*) OVER (PARTITION BY x.instance_id, COALESCE(sm.keeper_section,x.section_id)) AS grp
  FROM skyline_form_results_office x
  LEFT JOIN section_map sm ON sm.dup_section=x.section_id
  LEFT JOIN (SELECT DISTINCT keeper_section, form_id FROM section_map) km ON km.keeper_section=x.section_id
  WHERE sm.dup_section IS NOT NULL OR km.keeper_section IS NOT NULL
  WINDOW w AS (PARTITION BY x.instance_id, COALESCE(sm.keeper_section,x.section_id)
    ORDER BY (x.entered_date IS NOT NULL OR btrim(coalesce(x.entered_by,''))<>'' OR x.initial_checked OR x.updated_checked) DESC,
             x.updated_at DESC NULLS LAST, (sm.dup_section IS NULL) DESC, x.id)
), allr AS (
  SELECT * FROM ans UNION ALL SELECT * FROM ta UNION ALL SELECT * FROM tra UNION ALL SELECT * FROM rd UNION ALL SELECT * FROM ro
)
SELECT a.form_id, f.name, f.version, a.kind,
       count(*) FILTER (WHERE a.rk = 1 AND a.grp > 1)                    AS conflicts,
       count(*) FILTER (WHERE a.rk = 1 AND a.grp > 1 AND a.is_dup)       AS duplicate_row_wins,
       count(*) FILTER (WHERE a.rk = 1 AND a.grp > 1 AND NOT a.is_dup)   AS keeper_row_wins,
       count(*) FILTER (WHERE a.rk = 1 AND a.grp = 1 AND a.is_dup)       AS no_conflict_moved_from_dup
FROM allr a JOIN skyline_forms f ON f.id = a.form_id
GROUP BY a.form_id, f.name, f.version, a.kind
HAVING count(*) FILTER (WHERE a.rk = 1 AND (a.grp > 1 OR a.is_dup)) > 0
ORDER BY conflicts DESC, a.form_id, a.kind;
