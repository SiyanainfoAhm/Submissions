import { supabase } from './supabase';
import {
  dedupeSupabaseRead,
  invalidateSupabaseReadCache,
  recordSupabaseError,
  SupabaseBackoffError,
} from './supabaseRequestGuard';
import { createDefaultSectionsToStep } from './defaultFormSteps';
import {
  isDidNotAttemptAnyFailure,
  shouldAutoResetTerminalAssessmentOnEndDateChange,
  type AttemptResult,
} from '../utils/assessmentRowUi';
import { mergeSaveValuePreservingExisting } from '../utils/formAnswerMerge';
import { getEffectiveEndDate } from '../utils/assessmentDeadline';
import {
  findDuplicateAssessmentTaskStepsByRowId,
  planFormScopedAssessmentTaskLabelRepair,
  type AssessmentTaskStepLink,
} from './assessmentTaskSteps';
import {
  isCourseLifecycleStatus,
  normalizeCourseLifecycleStatus,
  validateCourseDateOrder,
  defaultStatusForNewCourseEnrollment,
  type CourseLifecycleStatus,
} from './courseLifecycle';
import {
  assertStudentInstanceMutationAllowed,
  getStudentAssessmentAccess,
  StudentCourseAccessError,
  studentMayOpenAssessment,
  type StudentAssessmentAccessResult,
} from './studentAssessmentAccess';
import { parseAssessmentSearch } from './assessmentSearch';
import {
  findSharedContentBlockQuestionIds,
  planSharedContentBlockRepairs,
  remapPdfMetaQuestionIds,
  type ContentBlockLike,
  type PdfMetaLike,
} from './contentBlockClone';

export { buildContentBlockGridDiagnostic } from './contentBlockClone';
export {
  nextAssessmentTaskLabel,
  nextAssessmentTaskNumber,
  planFormScopedAssessmentTaskLabelRepair,
} from './assessmentTaskSteps';
import type {
  Form,
  FormStep,
  FormSection,
  FormQuestion,
  FormQuestionOption,
  FormQuestionRow,
  FormInstance,
  FormAnswer,
} from '../types/database';

export interface FormStepWithSections extends FormStep {
  sections: FormSectionWithQuestions[];
}

export interface FormSectionWithQuestions extends FormSection {
  questions: FormQuestionWithOptionsAndRows[];
  taskRow?: FormQuestionRow | null;
}

export interface FormQuestionWithOptionsAndRows extends FormQuestion {
  options: FormQuestionOption[];
  rows: FormQuestionRow[];
}

export interface FormTemplate {
  form: Form;
  steps: FormStepWithSections[];
}

export interface InstanceWithAnswers {
  instance: FormInstance;
  answers: FormAnswer[];
}


export async function fetchForm(
  formId: number,
  options?: { allowInactiveForAdmin?: boolean }
): Promise<Form | null> {
  let query = supabase.from('skyline_forms').select('*').eq('id', formId);
  if (!options?.allowInactiveForAdmin) {
    query = query.eq('active', true);
  }
  const { data, error } = await query.single();
  if (error) {
    console.error('fetchForm error', error);
    return null;
  }
  return data as Form;
}

export async function updateForm(formId: number, updates: Partial<Pick<Form, 'name' | 'version' | 'unit_code' | 'unit_name' | 'qualification_code' | 'qualification_name' | 'header_asset_url' | 'cover_asset_url' | 'start_date' | 'end_date' | 'active' | 'learning_material_urls'>>): Promise<{ error: Error | null }> {
  const { updated_by } = getAuditFields();
  const payload = { ...updates, updated_by };
  const { error } = await supabase.from('skyline_forms').update(payload).eq('id', formId);
  return { error: error ? new Error(error.message) : null };
}

/** Migrate task sections from intro step to their own steps (for forms created with old structure). */
async function migrateTaskSectionsToSteps(formId: number, introStepId: number): Promise<number> {
  const { data: taskSections } = await supabase
    .from('skyline_form_sections')
    .select('id, assessment_task_row_id, pdf_render_mode, sort_order')
    .eq('step_id', introStepId)
    .not('assessment_task_row_id', 'is', null);
  if (!taskSections || taskSections.length === 0) return 0;

  const byRow = new Map<number, { id: number; pdf_render_mode: string; sort_order: number }[]>();
  for (const s of taskSections as { id: number; assessment_task_row_id: number; pdf_render_mode: string; sort_order: number }[]) {
    if (!byRow.has(s.assessment_task_row_id)) byRow.set(s.assessment_task_row_id, []);
    byRow.get(s.assessment_task_row_id)!.push({ id: s.id, pdf_render_mode: s.pdf_render_mode, sort_order: s.sort_order });
  }

  const { data: rows } = await supabase
    .from('skyline_form_question_rows')
    .select('id, row_label')
    .in('id', Array.from(byRow.keys()));
  const rowMap = new Map((rows as { id: number; row_label: string }[])?.map((r) => [r.id, r]) || []);

  const { data: steps } = await supabase.from('skyline_form_steps').select('sort_order').eq('form_id', formId);
  const maxOrder = steps?.length ? Math.max(...(steps as { sort_order: number }[]).map((s) => s.sort_order), 0) : 0;
  let nextOrder = maxOrder + 1;
  let migrated = 0;

  for (const [rowId, secs] of byRow) {
    const row = rowMap.get(rowId);
    if (!row || secs.length < 3) continue;

    const existingStepId = await findStepIdLinkedToTaskRow(formId, rowId);
    if (existingStepId != null) {
      const orderMap: Record<string, number> = {
        task_instructions: 0,
        task_questions: 1,
        task_written_evidence_checklist: 2,
        task_marking_checklist: 3,
        task_results: 4,
      };
      for (const sec of secs) {
        await supabase
          .from('skyline_form_sections')
          .update({ step_id: existingStepId, sort_order: orderMap[sec.pdf_render_mode] ?? sec.sort_order })
          .eq('id', sec.id);
      }
      migrated++;
      continue;
    }

    const { data: taskStep } = await supabase
      .from('skyline_form_steps')
      .insert({ form_id: formId, title: row.row_label, subtitle: 'Instructions, Questions & Results', sort_order: nextOrder++ })
      .select('id')
      .single();
    if (!taskStep) continue;
    const taskStepId = (taskStep as { id: number }).id;
    const orderMap: Record<string, number> = { task_instructions: 0, task_questions: 1, task_written_evidence_checklist: 2, task_marking_checklist: 3, task_results: 4 };
    for (const sec of secs) {
      await supabase.from('skyline_form_sections').update({ step_id: taskStepId, sort_order: orderMap[sec.pdf_render_mode] ?? sec.sort_order }).eq('id', sec.id);
    }
    // Add Written Evidence Checklist section (migrated forms only had 3 sections)
    const { data: wecSection } = await supabase
      .from('skyline_form_sections')
      .insert({ step_id: taskStepId, title: 'Written Evidence Checklist', pdf_render_mode: 'task_written_evidence_checklist', assessment_task_row_id: rowId, sort_order: 2 })
      .select('id')
      .single();
    if (wecSection) {
      const { data: writtenQ } = await supabase
        .from('skyline_form_questions')
        .insert({
          section_id: (wecSection as { id: number }).id,
          type: 'single_choice',
          code: 'written.evidence.checklist',
          label: 'Written Evidence Checklist',
          sort_order: 0,
          role_visibility: TRAINER_OFFICE_VISIBLE,
          role_editability: TRAINER_OFFICE_EDIT,
        })
        .select('id')
        .single();
      if (writtenQ) {
        await supabase.from('skyline_form_question_options').insert([
          { question_id: (writtenQ as { id: number }).id, value: 'yes', label: 'Yes', sort_order: 0 },
          { question_id: (writtenQ as { id: number }).id, value: 'no', label: 'No', sort_order: 1 },
        ]);
      }
    }
    // Add Assessment Marking Checklist section
    const { data: mcSection } = await supabase
      .from('skyline_form_sections')
      .insert({ step_id: taskStepId, title: 'Assessment Marking Checklist', pdf_render_mode: 'task_marking_checklist', assessment_task_row_id: rowId, sort_order: 3 })
      .select('id')
      .single();
    if (mcSection) {
      const mcSecId = (mcSection as { id: number }).id;
      const { data: evidenceQ } = await supabase.from('skyline_form_questions').insert({
        section_id: mcSecId, type: 'single_choice', code: 'assessment.marking.evidence_outcome', label: 'Evidence Outcome', sort_order: 0,
        role_visibility: TRAINER_OFFICE_VISIBLE, role_editability: TRAINER_OFFICE_EDIT,
      }).select('id').single();
      if (evidenceQ) {
        await supabase.from('skyline_form_question_options').insert([
          { question_id: (evidenceQ as { id: number }).id, value: 'yes', label: 'Yes', sort_order: 0 },
          { question_id: (evidenceQ as { id: number }).id, value: 'no', label: 'No', sort_order: 1 },
        ]);
      }
      const { data: perfQ } = await supabase.from('skyline_form_questions').insert({
        section_id: mcSecId, type: 'single_choice', code: 'assessment.marking.performance_outcome', label: 'Performance Outcome', sort_order: 1,
        role_visibility: TRAINER_OFFICE_VISIBLE, role_editability: TRAINER_OFFICE_EDIT,
      }).select('id').single();
      if (perfQ) {
        await supabase.from('skyline_form_question_options').insert([
          { question_id: (perfQ as { id: number }).id, value: 'yes', label: 'Yes', sort_order: 0 },
          { question_id: (perfQ as { id: number }).id, value: 'no', label: 'No', sort_order: 1 },
        ]);
      }
    }
    // Update task_results sort_order to 4
    await supabase.from('skyline_form_sections').update({ sort_order: 4 }).eq('step_id', taskStepId).eq('pdf_render_mode', 'task_results');
    migrated++;
  }
  return migrated;
}

/** Create a separate step (Instructions, Questions, Results) for each assessment task row that doesn't have one. Call for existing forms. */
const ensureTaskSectionsInFlight = new Map<number, Promise<{ created: number }>>();

/**
 * Single-flight per form. This runs on every builder load AND every fetchTemplateForForm; React
 * StrictMode / concurrent callers used to run it in parallel — each passed the "already linked?"
 * check before the other had inserted its sections, so both inserted the same task step.
 */
export function ensureTaskSectionsForForm(formId: number): Promise<{ created: number }> {
  const running = ensureTaskSectionsInFlight.get(formId);
  if (running) return running;
  const p = ensureTaskSectionsForFormImpl(formId).finally(() => ensureTaskSectionsInFlight.delete(formId));
  ensureTaskSectionsInFlight.set(formId, p);
  return p;
}

async function ensureTaskSectionsForFormImpl(formId: number): Promise<{ created: number }> {
  const steps = await fetchFormSteps(formId);
  const introStep = steps.find((s) => s.title === 'Introductory Details' || s.subtitle?.includes('Student'));
  if (!introStep) return { created: 0 };

  const migrated = await migrateTaskSectionsToSteps(formId, introStep.id);
  if (migrated > 0) return { created: migrated };

  const { data: sections } = await supabase
    .from('skyline_form_sections')
    .select('*')
    .eq('step_id', introStep.id)
    .order('sort_order');
  const assessmentTasksSection = (sections as { id: number; pdf_render_mode: string }[])?.find((s) => s.pdf_render_mode === 'assessment_tasks');
  if (!assessmentTasksSection) return { created: 0 };

  const { data: taskQuestion } = await supabase
    .from('skyline_form_questions')
    .select('id')
    .eq('section_id', assessmentTasksSection.id)
    .eq('type', 'grid_table')
    .single();
  if (!taskQuestion) return { created: 0 };

  const { data: rows } = await supabase
    .from('skyline_form_question_rows')
    .select('id, row_label')
    .eq('question_id', (taskQuestion as { id: number }).id)
    .order('sort_order');
  const taskRows = (rows as { id: number; row_label: string }[]) || [];
  if (taskRows.length === 0) return { created: 0 };

  const linkedRowIds = await getLinkedAssessmentTaskRowIdsForForm(formId);

  let created = 0;
  let currentSteps = await fetchFormSteps(formId);
  const maxStepOrder =
    currentSteps.length > 0 ? Math.max(...currentSteps.map((s) => s.sort_order), 0) : 0;
  let nextStepOrder = maxStepOrder + 1;

  for (const row of taskRows) {
    if (linkedRowIds.has(row.id)) continue;
    const stepId = await insertAssessmentTaskStepWithSections(formId, row.id, row.row_label, nextStepOrder++);
    if (stepId != null) {
      linkedRowIds.add(row.id);
      created += 1;
    }
  }

  // Backfill Assessment Marking Checklist for existing task steps that don't have it
  currentSteps = await fetchFormSteps(formId);
  const formStepIds = currentSteps.map((s) => s.id);
  if (formStepIds.length === 0) return { created };
  const { data: allTaskSections } = await supabase
    .from('skyline_form_sections')
    .select('step_id, pdf_render_mode, assessment_task_row_id')
    .in('step_id', formStepIds)
    .in('pdf_render_mode', ['task_written_evidence_checklist', 'task_results', 'task_marking_checklist']);
  const byStep = new Map<number, { hasWritten: boolean; hasResults: boolean; hasMarking: boolean; rowId: number | null }>();
  for (const s of (allTaskSections || []) as { step_id: number; pdf_render_mode: string; assessment_task_row_id: number | null }[]) {
    let entry = byStep.get(s.step_id);
    if (!entry) entry = { hasWritten: false, hasResults: false, hasMarking: false, rowId: s.assessment_task_row_id };
    if (s.pdf_render_mode === 'task_written_evidence_checklist') entry.hasWritten = true;
    if (s.pdf_render_mode === 'task_results') entry.hasResults = true;
    if (s.pdf_render_mode === 'task_marking_checklist') entry.hasMarking = true;
    if (s.assessment_task_row_id) entry.rowId = s.assessment_task_row_id;
    byStep.set(s.step_id, entry);
  }
  for (const [stepId, entry] of byStep.entries()) {
    if (entry.hasWritten && entry.hasResults && !entry.hasMarking && entry.rowId) {
      await supabase.from('skyline_form_sections').update({ sort_order: 4 }).eq('step_id', stepId).eq('pdf_render_mode', 'task_results');
      const { data: mcSection } = await supabase.from('skyline_form_sections').insert({
        step_id: stepId, title: 'Assessment Marking Checklist', pdf_render_mode: 'task_marking_checklist',
        assessment_task_row_id: entry.rowId, sort_order: 3,
      }).select('id').single();
      if (mcSection) {
        const mcSecId = (mcSection as { id: number }).id;
        const { data: evidenceQ } = await supabase.from('skyline_form_questions').insert({
          section_id: mcSecId, type: 'single_choice', code: 'assessment.marking.evidence_outcome', label: 'Evidence Outcome', sort_order: 0,
          role_visibility: TRAINER_OFFICE_VISIBLE, role_editability: TRAINER_OFFICE_EDIT,
        }).select('id').single();
        if (evidenceQ) {
          await supabase.from('skyline_form_question_options').insert([
            { question_id: (evidenceQ as { id: number }).id, value: 'yes', label: 'Yes', sort_order: 0 },
            { question_id: (evidenceQ as { id: number }).id, value: 'no', label: 'No', sort_order: 1 },
          ]);
        }
        const { data: perfQ } = await supabase.from('skyline_form_questions').insert({
          section_id: mcSecId, type: 'single_choice', code: 'assessment.marking.performance_outcome', label: 'Performance Outcome', sort_order: 1,
          role_visibility: TRAINER_OFFICE_VISIBLE, role_editability: TRAINER_OFFICE_EDIT,
        }).select('id').single();
        if (perfQ) {
          await supabase.from('skyline_form_question_options').insert([
            { question_id: (perfQ as { id: number }).id, value: 'yes', label: 'Yes', sort_order: 0 },
            { question_id: (perfQ as { id: number }).id, value: 'no', label: 'No', sort_order: 1 },
          ]);
        }
        created += 1;
      }
    }
  }

  return { created };
}

export async function fetchFormSteps(formId: number): Promise<FormStep[]> {
  const { data, error } = await supabase
    .from('skyline_form_steps')
    .select('*')
    .eq('form_id', formId)
    .order('sort_order', { ascending: true });
  if (error) {
    console.error('fetchFormSteps error', error);
    return [];
  }
  return (data as FormStep[]) || [];
}

/** Step id already linked to an assessment task grid row within this form, if any. */
async function findStepIdLinkedToTaskRow(formId: number, rowId: number): Promise<number | null> {
  const steps = await fetchFormSteps(formId);
  const stepIds = steps.map((s) => s.id);
  if (stepIds.length === 0) return null;
  const { data } = await supabase
    .from('skyline_form_sections')
    .select('step_id')
    .in('step_id', stepIds)
    .eq('assessment_task_row_id', rowId)
    .limit(1);
  const hit = (data as { step_id: number }[] | null)?.[0];
  return hit?.step_id ?? null;
}

/** Assessment task grid row ids that already have a dedicated step on this form. */
async function getLinkedAssessmentTaskRowIdsForForm(formId: number): Promise<Set<number>> {
  const steps = await fetchFormSteps(formId);
  const stepIds = steps.map((s) => s.id);
  if (stepIds.length === 0) return new Set();
  const { data: existingSections } = await supabase
    .from('skyline_form_sections')
    .select('assessment_task_row_id')
    .in('step_id', stepIds)
    .not('assessment_task_row_id', 'is', null);
  return new Set(
    ((existingSections as { assessment_task_row_id: number }[]) || [])
      .map((s) => s.assessment_task_row_id)
      .filter((id) => Number.isFinite(id) && id > 0),
  );
}

/** Distinct step ids whose sections reference the given assessment task grid row. */
export async function getStepIdsLinkedToTaskRow(formId: number, rowId: number): Promise<number[]> {
  const steps = await fetchFormSteps(formId);
  const stepIds = steps.map((s) => s.id);
  if (stepIds.length === 0) return [];
  const { data: sections } = await supabase
    .from('skyline_form_sections')
    .select('step_id')
    .in('step_id', stepIds)
    .eq('assessment_task_row_id', rowId);
  return [...new Set(((sections as { step_id: number }[]) || []).map((s) => s.step_id))];
}

/** Create one assessment task step + linked sections/questions for a grid row. Idempotent by row id. */
export async function insertAssessmentTaskStepWithSections(
  formId: number,
  rowId: number,
  rowLabel: string,
  sortOrder: number,
): Promise<number | null> {
  const existingStepId = await findStepIdLinkedToTaskRow(formId, rowId);
  if (existingStepId != null) return existingStepId;

  // A step with this title may already exist whose sections aren't linked yet (insert in progress elsewhere).
  const { data: sameTitle } = await supabase
    .from('skyline_form_steps')
    .select('id')
    .eq('form_id', formId)
    .eq('title', rowLabel)
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (sameTitle) return (sameTitle as { id: number }).id;

  const { data: taskStep, error: taskStepErr } = await supabase
    .from('skyline_form_steps')
    .insert({
      form_id: formId,
      title: rowLabel,
      subtitle: 'Instructions, Questions & Results',
      sort_order: sortOrder,
    })
    .select('id')
    .single();
  if (taskStepErr?.code === '23505') {
    // DB unique guard (form_id, title) fired: another caller won the race — use their step.
    const { data: winner } = await supabase
      .from('skyline_form_steps').select('id').eq('form_id', formId).eq('title', rowLabel)
      .order('id', { ascending: true }).limit(1).maybeSingle();
    return winner ? (winner as { id: number }).id : null;
  }
  if (!taskStep) return null;
  const taskStepId = (taskStep as { id: number }).id;

  await supabase.from('skyline_form_sections').insert([
    { step_id: taskStepId, title: 'Student Instructions', pdf_render_mode: 'task_instructions', assessment_task_row_id: rowId, sort_order: 0 },
    { step_id: taskStepId, title: 'Questions', pdf_render_mode: 'task_questions', assessment_task_row_id: rowId, sort_order: 1 },
    { step_id: taskStepId, title: 'Written Evidence Checklist', pdf_render_mode: 'task_written_evidence_checklist', assessment_task_row_id: rowId, sort_order: 2 },
    { step_id: taskStepId, title: 'Assessment Marking Checklist', pdf_render_mode: 'task_marking_checklist', assessment_task_row_id: rowId, sort_order: 3 },
    { step_id: taskStepId, title: 'Results', pdf_render_mode: 'task_results', assessment_task_row_id: rowId, sort_order: 4 },
  ]);

  const { data: wecSection } = await supabase
    .from('skyline_form_sections')
    .select('id')
    .eq('step_id', taskStepId)
    .eq('pdf_render_mode', 'task_written_evidence_checklist')
    .single();
  if (wecSection) {
    const { data: writtenQ } = await supabase
      .from('skyline_form_questions')
      .insert({
        section_id: (wecSection as { id: number }).id,
        type: 'single_choice',
        code: 'written.evidence.checklist',
        label: 'Written Evidence Checklist',
        sort_order: 0,
        role_visibility: TRAINER_OFFICE_VISIBLE,
        role_editability: TRAINER_OFFICE_EDIT,
      })
      .select('id')
      .single();
    if (writtenQ) {
      await supabase.from('skyline_form_question_options').insert([
        { question_id: (writtenQ as { id: number }).id, value: 'yes', label: 'Yes', sort_order: 0 },
        { question_id: (writtenQ as { id: number }).id, value: 'no', label: 'No', sort_order: 1 },
      ]);
    }
  }

  const { data: mcSection } = await supabase
    .from('skyline_form_sections')
    .select('id')
    .eq('step_id', taskStepId)
    .eq('pdf_render_mode', 'task_marking_checklist')
    .single();
  if (mcSection) {
    const mcSecId = (mcSection as { id: number }).id;
    const { data: evidenceQ } = await supabase
      .from('skyline_form_questions')
      .insert({
        section_id: mcSecId,
        type: 'single_choice',
        code: 'assessment.marking.evidence_outcome',
        label: 'Evidence Outcome',
        sort_order: 0,
        role_visibility: TRAINER_OFFICE_VISIBLE,
        role_editability: TRAINER_OFFICE_EDIT,
      })
      .select('id')
      .single();
    if (evidenceQ) {
      await supabase.from('skyline_form_question_options').insert([
        { question_id: (evidenceQ as { id: number }).id, value: 'yes', label: 'Yes', sort_order: 0 },
        { question_id: (evidenceQ as { id: number }).id, value: 'no', label: 'No', sort_order: 1 },
      ]);
    }
    const { data: perfQ } = await supabase
      .from('skyline_form_questions')
      .insert({
        section_id: mcSecId,
        type: 'single_choice',
        code: 'assessment.marking.performance_outcome',
        label: 'Performance Outcome',
        sort_order: 1,
        role_visibility: TRAINER_OFFICE_VISIBLE,
        role_editability: TRAINER_OFFICE_EDIT,
      })
      .select('id')
      .single();
    if (perfQ) {
      await supabase.from('skyline_form_question_options').insert([
        { question_id: (perfQ as { id: number }).id, value: 'yes', label: 'Yes', sort_order: 0 },
        { question_id: (perfQ as { id: number }).id, value: 'no', label: 'No', sort_order: 1 },
      ]);
    }
  }

  return taskStepId;
}

/** Log duplicate assessment task steps (same row id linked to multiple step ids). Does not auto-delete. */
export async function logDuplicateAssessmentTaskSteps(formId: number): Promise<void> {
  const steps = await fetchFormSteps(formId);
  const stepIds = steps.map((s) => s.id);
  if (stepIds.length === 0) return;

  const { data: sections } = await supabase
    .from('skyline_form_sections')
    .select('step_id, assessment_task_row_id')
    .in('step_id', stepIds)
    .not('assessment_task_row_id', 'is', null);

  const stepById = new Map(steps.map((s) => [s.id, s]));
  const links: AssessmentTaskStepLink[] = [];
  const seen = new Set<string>();
  for (const sec of (sections as { step_id: number; assessment_task_row_id: number }[]) || []) {
    const key = `${sec.step_id}:${sec.assessment_task_row_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const step = stepById.get(sec.step_id);
    if (!step) continue;
    links.push({
      stepId: sec.step_id,
      rowId: sec.assessment_task_row_id,
      title: step.title,
      sortOrder: step.sort_order,
    });
  }

  for (const dup of findDuplicateAssessmentTaskStepsByRowId(formId, links)) {
    console.warn('[SignFlow] Duplicate assessment task steps detected', {
      form_id: dup.formId,
      step_ids: dup.stepIds,
      assessment_task_row_id: dup.assessmentTaskRowId,
      title: dup.title,
      sort_orders: dup.sortOrders,
    });
  }
}

export async function fetchInstance(instanceId: number): Promise<FormInstance | null> {
  const { data, error } = await supabase.from('skyline_form_instances').select('*').eq('id', instanceId).single();
  if (error) {
    console.error('fetchInstance error', error);
    return null;
  }
  const row = { ...(data as Record<string, unknown>) };
  delete row.admin_reference_note;
  return row as FormInstance;
}

/** Admin student details only — internal notes not exposed to students. */
export async function fetchInstanceAdminReferenceNotes(
  instanceIds: number[]
): Promise<Record<number, string>> {
  const ids = [...new Set(instanceIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))];
  if (ids.length === 0) return {};
  const { data, error } = await supabase
    .from('skyline_form_instances')
    .select('id, admin_reference_note')
    .in('id', ids);
  if (error) {
    console.error('fetchInstanceAdminReferenceNotes error', error);
    return {};
  }
  const out: Record<number, string> = {};
  for (const row of (data as Array<{ id: number; admin_reference_note: string | null }> | null) || []) {
    const id = Number(row.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    out[id] = row.admin_reference_note != null ? String(row.admin_reference_note) : '';
  }
  return out;
}

export async function updateInstanceAdminReferenceNote(
  instanceId: number,
  note: string
): Promise<{ ok: boolean; error?: string }> {
  const iid = Number(instanceId);
  if (!Number.isFinite(iid) || iid <= 0) return { ok: false, error: 'Invalid instance' };
  const trimmed = note.trim();
  const { error } = await supabase
    .from('skyline_form_instances')
    .update({ admin_reference_note: trimmed || null })
    .eq('id', iid);
  if (error) {
    console.error('updateInstanceAdminReferenceNote error', error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

export type FetchTemplateOptions = {
  allowInactiveForAdmin?: boolean;
  /** Skip lazy task-section migration on instance fill (forms are already provisioned). */
  skipEnsureTaskSections?: boolean;
};

const TEMPLATE_IN_CHUNK = 200;

function groupByNumericKey<T>(rows: T[], key: keyof T): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const row of rows) {
    const id = Number(row[key]);
    if (!Number.isFinite(id) || id <= 0) continue;
    const bucket = map.get(id);
    if (bucket) bucket.push(row);
    else map.set(id, [row]);
  }
  return map;
}

async function fetchRowsInNumericChunks<T>(
  table: 'skyline_form_questions' | 'skyline_form_question_options' | 'skyline_form_question_rows',
  column: 'section_id' | 'question_id' | 'id',
  ids: number[],
  orderColumn?: 'sort_order',
): Promise<T[]> {
  if (ids.length === 0) return [];
  const all: T[] = [];
  for (let i = 0; i < ids.length; i += TEMPLATE_IN_CHUNK) {
    const chunk = ids.slice(i, i + TEMPLATE_IN_CHUNK);
    let query = supabase.from(table).select('*').in(column, chunk);
    if (orderColumn) query = query.order(orderColumn, { ascending: true });
    const { data, error } = await query;
    if (error) console.error(`fetchRowsInNumericChunks ${table}.${column} error`, error);
    if (data) all.push(...(data as T[]));
  }
  if (orderColumn) {
    all.sort((a, b) => Number((a as { sort_order?: number }).sort_order ?? 0) - Number((b as { sort_order?: number }).sort_order ?? 0));
  }
  return all;
}

/** Batched template load — a handful of queries instead of per-question round trips. */
export async function fetchTemplateForForm(
  formId: number,
  options?: FetchTemplateOptions,
): Promise<FormTemplate | null> {
  const form = await fetchForm(formId, { allowInactiveForAdmin: options?.allowInactiveForAdmin });
  if (!form) return null;

  if (!options?.skipEnsureTaskSections) {
    await ensureTaskSectionsForForm(formId);
  }

  const steps = await fetchFormSteps(formId);
  if (steps.length === 0) return { form, steps: [] };

  const stepIds = steps.map((s) => s.id);
  const { data: sectionsRaw, error: secErr } = await supabase
    .from('skyline_form_sections')
    .select('*')
    .in('step_id', stepIds)
    .order('sort_order', { ascending: true });
  if (secErr) console.error('fetchTemplateForForm sections error', secErr);
  const sectionsList = (sectionsRaw as FormSection[]) || [];

  const sectionIds = sectionsList.map((s) => s.id);
  const taskRowIds = [
    ...new Set(
      sectionsList
        .map((s) => (s as FormSection & { assessment_task_row_id?: number | null }).assessment_task_row_id)
        .filter((id): id is number => id != null && Number.isFinite(id) && id > 0),
    ),
  ];

  const [questionsList, taskRowsList] = await Promise.all([
    fetchRowsInNumericChunks<FormQuestion>('skyline_form_questions', 'section_id', sectionIds, 'sort_order'),
    fetchRowsInNumericChunks<FormQuestionRow>('skyline_form_question_rows', 'id', taskRowIds),
  ]);

  const questionIds = questionsList.map((q) => q.id);
  const [optionsListResolved, questionRowsListResolved] = await Promise.all([
    fetchRowsInNumericChunks<FormQuestionOption>('skyline_form_question_options', 'question_id', questionIds, 'sort_order'),
    fetchRowsInNumericChunks<FormQuestionRow>('skyline_form_question_rows', 'question_id', questionIds, 'sort_order'),
  ]);

  const sectionsByStep = groupByNumericKey(sectionsList, 'step_id');
  const questionsBySection = groupByNumericKey(questionsList, 'section_id');
  const optionsByQuestion = groupByNumericKey(optionsListResolved, 'question_id');
  const rowsByQuestion = groupByNumericKey(questionRowsListResolved, 'question_id');
  const taskRowById = new Map(taskRowsList.map((r) => [r.id, r]));

  const stepsWithSections: FormStepWithSections[] = steps.map((step) => {
    const stepSections = (sectionsByStep.get(step.id) ?? []).slice().sort((a, b) => a.sort_order - b.sort_order);
    const sectionsWithQuestions: FormSectionWithQuestions[] = stepSections.map((section) => {
      const sec = section as FormSection & { assessment_task_row_id?: number | null };
      const taskRow = sec.assessment_task_row_id ? taskRowById.get(sec.assessment_task_row_id) ?? null : null;
      const sectionQuestions = (questionsBySection.get(section.id) ?? []).slice().sort((a, b) => a.sort_order - b.sort_order);
      const questionsWithExtras: FormQuestionWithOptionsAndRows[] = sectionQuestions.map((q) => ({
        ...q,
        options: (optionsByQuestion.get(q.id) ?? []).slice().sort((a, b) => a.sort_order - b.sort_order),
        rows: (rowsByQuestion.get(q.id) ?? []).slice().sort((a, b) => a.sort_order - b.sort_order),
      }));
      return { ...section, questions: questionsWithExtras, taskRow: taskRow ?? undefined };
    });
    return { ...step, sections: sectionsWithQuestions };
  });

  return { form, steps: stepsWithSections };
}

export async function fetchTemplateForInstance(instanceId: number): Promise<FormTemplate | null> {
  const instance = await fetchInstance(instanceId);
  if (!instance) return null;
  return fetchTemplateForForm(instance.form_id, { skipEnsureTaskSections: true });
}

/** Form builder tree — steps, sections, and questions only (no options/rows). */
export type FormBuilderStep = FormStep & {
  sections: (FormSection & { questions: FormQuestion[] })[];
};

export async function fetchFormBuilderTree(formId: number): Promise<FormBuilderStep[]> {
  const steps = await fetchFormSteps(formId);
  if (steps.length === 0) return [];

  const stepIds = steps.map((s) => s.id);
  const { data: sectionsRaw, error: secErr } = await supabase
    .from('skyline_form_sections')
    .select('*')
    .in('step_id', stepIds)
    .order('sort_order', { ascending: true });
  if (secErr) console.error('fetchFormBuilderTree sections error', secErr);
  const sectionsList = (sectionsRaw as FormSection[]) || [];

  const sectionIds = sectionsList.map((s) => s.id);
  const questionsList = await fetchRowsInNumericChunks<FormQuestion>(
    'skyline_form_questions',
    'section_id',
    sectionIds,
    'sort_order',
  );

  const sectionsByStep = groupByNumericKey(sectionsList, 'step_id');
  const questionsBySection = groupByNumericKey(questionsList, 'section_id');

  return steps.map((step) => {
    const stepSections = (sectionsByStep.get(step.id) ?? []).slice().sort((a, b) => a.sort_order - b.sort_order);
    const sectionsWithQuestions = stepSections.map((section) => ({
      ...section,
      questions: (questionsBySection.get(section.id) ?? []).slice().sort((a, b) => a.sort_order - b.sort_order),
    }));
    return { ...step, sections: sectionsWithQuestions };
  });
}

/** Load one builder section with options and rows (batched). */
export async function fetchSectionQuestionsForBuilder(
  sectionId: number,
): Promise<(FormQuestion & { options: FormQuestionOption[]; rows: FormQuestionRow[] })[]> {
  const { data: qs, error } = await supabase
    .from('skyline_form_questions')
    .select('*')
    .eq('section_id', sectionId)
    .order('sort_order', { ascending: true });
  if (error) console.error('fetchSectionQuestionsForBuilder error', error);
  if (!qs || qs.length === 0) return [];

  const questionIds = (qs as FormQuestion[]).map((q) => q.id);
  const [optionsList, rowsList] = await Promise.all([
    fetchRowsInNumericChunks<FormQuestionOption>('skyline_form_question_options', 'question_id', questionIds, 'sort_order'),
    fetchRowsInNumericChunks<FormQuestionRow>('skyline_form_question_rows', 'question_id', questionIds, 'sort_order'),
  ]);

  const optionsByQuestion = groupByNumericKey(optionsList, 'question_id');
  const rowsByQuestion = groupByNumericKey(rowsList, 'question_id');

  return (qs as FormQuestion[]).map((q) => ({
    ...q,
    options: optionsByQuestion.get(q.id) ?? [],
    rows: rowsByQuestion.get(q.id) ?? [],
  }));
}

export async function fetchAnswersForInstance(instanceId: number): Promise<FormAnswer[]> {
  const { data, error } = await supabase
    .from('skyline_form_answers')
    .select('*')
    .eq('instance_id', instanceId);
  if (error) {
    console.error('fetchAnswersForInstance error', error);
    return [];
  }
  return (data as FormAnswer[]) || [];
}

export type InstanceIdentitySources = {
  studentFullName: string | null;
  studentId: string | null;
  studentEmail: string | null;
  trainerFullName: string | null;
  resultsStudentName: string | null;
  resultsTrainerName: string | null;
};

/** Profile/enrolment/batch trainer values used to hydrate missing identity fields. */
export async function fetchInstanceIdentitySources(instanceId: number): Promise<InstanceIdentitySources | null> {
  const { data: inst, error: instErr } = await supabase
    .from('skyline_form_instances')
    .select('student_id')
    .eq('id', instanceId)
    .maybeSingle();
  if (instErr || !inst?.student_id) return null;

  const studentId = Number((inst as { student_id: number }).student_id);
  const { data: student } = await supabase
    .from('skyline_students')
    .select('name, first_name, last_name, email, student_id, batch_id')
    .eq('id', studentId)
    .maybeSingle();

  let trainerFullName: string | null = null;
  const batchId = Number((student as { batch_id?: number | null } | null)?.batch_id ?? 0);
  if (Number.isFinite(batchId) && batchId > 0) {
    const { data: batch } = await supabase.from('skyline_batches').select('trainer_id').eq('id', batchId).maybeSingle();
    const trainerId = Number((batch as { trainer_id?: number | null } | null)?.trainer_id ?? 0);
    if (Number.isFinite(trainerId) && trainerId > 0) {
      const { data: trainer } = await supabase.from('skyline_users').select('full_name').eq('id', trainerId).maybeSingle();
      trainerFullName = String((trainer as { full_name?: string | null } | null)?.full_name ?? '').trim() || null;
    }
  }

  const { data: resultsRows } = await supabase
    .from('skyline_form_results_data')
    .select('student_name, trainer_name')
    .eq('instance_id', instanceId)
    .limit(5);

  const resultsStudentName =
    ((resultsRows as Array<{ student_name?: string | null }> | null) ?? [])
      .map((r) => String(r.student_name ?? '').trim())
      .find(Boolean) ?? null;
  const resultsTrainerName =
    ((resultsRows as Array<{ trainer_name?: string | null }> | null) ?? [])
      .map((r) => String(r.trainer_name ?? '').trim())
      .find(Boolean) ?? null;

  const st = student as {
    name?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
    student_id?: string | null;
  } | null;

  const nameParts = [st?.first_name, st?.last_name].map((x) => String(x ?? '').trim()).filter(Boolean).join(' ').trim();
  const studentFullName = String(st?.name ?? '').trim() || nameParts || resultsStudentName;

  return {
    studentFullName: studentFullName || null,
    studentId: String(st?.student_id ?? '').trim() || null,
    studentEmail: String(st?.email ?? '').trim() || null,
    trainerFullName: trainerFullName || resultsTrainerName,
    resultsStudentName,
    resultsTrainerName,
  };
}

export interface ResultsOfficeEntry {
  section_id: number;
  entered_date: string | null;
  entered_by: string | null;
  initial_checked?: boolean;
  updated_checked?: boolean;
}

export interface ResultsDataEntry {
  section_id: number;
  first_attempt_satisfactory: string | null;
  first_attempt_date: string | null;
  first_attempt_feedback: string | null;
  second_attempt_satisfactory: string | null;
  second_attempt_date: string | null;
  second_attempt_feedback: string | null;
  third_attempt_satisfactory: string | null;
  third_attempt_date: string | null;
  third_attempt_feedback: string | null;
  student_name: string | null;
  student_signature: string | null;
  trainer_name: string | null;
  trainer_signature: string | null;
  trainer_date: string | null;
}

export async function fetchResultsData(instanceId: number): Promise<Record<number, ResultsDataEntry>> {
  const { data, error } = await supabase
    .from('skyline_form_results_data')
    .select('section_id, first_attempt_satisfactory, first_attempt_date, first_attempt_feedback, second_attempt_satisfactory, second_attempt_date, second_attempt_feedback, third_attempt_satisfactory, third_attempt_date, third_attempt_feedback, student_name, student_signature, trainer_name, trainer_signature, trainer_date')
    .eq('instance_id', instanceId);
  if (error) {
    console.error('fetchResultsData error', error);
    return {};
  }
  const out: Record<number, ResultsDataEntry> = {};
  for (const row of (data as Record<string, unknown>[]) || []) {
    const sid = row.section_id as number;
    out[sid] = {
      section_id: sid,
      first_attempt_satisfactory: (row.first_attempt_satisfactory as string) ?? null,
      first_attempt_date: (row.first_attempt_date as string) ?? null,
      first_attempt_feedback: (row.first_attempt_feedback as string) ?? null,
      second_attempt_satisfactory: (row.second_attempt_satisfactory as string) ?? null,
      second_attempt_date: (row.second_attempt_date as string) ?? null,
      second_attempt_feedback: (row.second_attempt_feedback as string) ?? null,
      third_attempt_satisfactory: (row.third_attempt_satisfactory as string) ?? null,
      third_attempt_date: (row.third_attempt_date as string) ?? null,
      third_attempt_feedback: (row.third_attempt_feedback as string) ?? null,
      student_name: (row.student_name as string) ?? null,
      student_signature: (row.student_signature as string) ?? null,
      trainer_name: (row.trainer_name as string) ?? null,
      trainer_signature: (row.trainer_signature as string) ?? null,
      trainer_date: (row.trainer_date as string) ?? null,
    };
  }
  return out;
}

export async function saveResultsData(
  instanceId: number,
  sectionId: number,
  data: Partial<Omit<ResultsDataEntry, 'section_id'>>,
  options?: { actorRole?: 'student' | 'trainer' | 'office' | string | null; source?: string }
): Promise<void> {
  await assertStudentInstanceMutationAllowed(instanceId, {
    actorRole: options?.actorRole,
    source: options?.source,
  });
  const { error } = await supabase.from('skyline_form_results_data').upsert(
    {
      instance_id: instanceId,
      section_id: sectionId,
      ...data,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'instance_id,section_id' }
  );
  if (error) console.error('saveResultsData error', error);
}

export async function fetchResultsOffice(instanceId: number): Promise<Record<number, ResultsOfficeEntry>> {
  const { data, error } = await supabase
    .from('skyline_form_results_office')
    .select('section_id, entered_date, entered_by, initial_checked, updated_checked')
    .eq('instance_id', instanceId);
  if (error) {
    console.error('fetchResultsOffice error', error);
    return {};
  }
  const out: Record<number, ResultsOfficeEntry> = {};
  for (const row of (data as Array<{
    section_id: number;
    entered_date: string | null;
    entered_by: string | null;
    initial_checked?: boolean | null;
    updated_checked?: boolean | null;
  }>) || []) {
    out[row.section_id] = {
      section_id: row.section_id,
      entered_date: row.entered_date,
      entered_by: row.entered_by,
      initial_checked: Boolean(row.initial_checked ?? false),
      updated_checked: Boolean(row.updated_checked ?? false),
    };
  }
  return out;
}

export async function saveResultsOffice(
  instanceId: number,
  sectionId: number,
  data: Partial<Omit<ResultsOfficeEntry, 'section_id'>>
): Promise<void> {
  const { error } = await supabase.from('skyline_form_results_office').upsert(
    {
      instance_id: instanceId,
      section_id: sectionId,
      ...data,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'instance_id,section_id' }
  );
  if (error) throw new Error(error.message || 'saveResultsOffice failed');
}

export interface AssessmentSummaryDataEntry {
  start_date: string | null;
  end_date: string | null;
  final_attempt_1_result: string | null;
  final_attempt_2_result: string | null;
  final_attempt_3_result: string | null;
  trainer_sig_1: string | null;
  trainer_date_1: string | null;
  trainer_sig_2: string | null;
  trainer_date_2: string | null;
  trainer_sig_3: string | null;
  trainer_date_3: string | null;
  student_sig_1: string | null;
  student_date_1: string | null;
  student_sig_2: string | null;
  student_date_2: string | null;
  student_sig_3: string | null;
  student_date_3: string | null;
  student_overall_feedback: string | null;
  admin_initials: string | null;
  admin_initial_checked?: boolean;
  admin_updated_checked?: boolean;
}

export async function fetchAssessmentSummaryData(instanceId: number): Promise<AssessmentSummaryDataEntry | null> {
  const { data, error } = await supabase
    .from('skyline_form_assessment_summary_data')
    .select('*')
    .eq('instance_id', instanceId)
    .maybeSingle();
  if (error || !data) return null;
  const r = data as Record<string, unknown>;
  return {
    start_date: (r.start_date as string) ?? null,
    end_date: (r.end_date as string) ?? null,
    final_attempt_1_result: (r.final_attempt_1_result as string) ?? null,
    final_attempt_2_result: (r.final_attempt_2_result as string) ?? null,
    final_attempt_3_result: (r.final_attempt_3_result as string) ?? null,
    trainer_sig_1: (r.trainer_sig_1 as string) ?? null,
    trainer_date_1: (r.trainer_date_1 as string) ?? null,
    trainer_sig_2: (r.trainer_sig_2 as string) ?? null,
    trainer_date_2: (r.trainer_date_2 as string) ?? null,
    trainer_sig_3: (r.trainer_sig_3 as string) ?? null,
    trainer_date_3: (r.trainer_date_3 as string) ?? null,
    student_sig_1: (r.student_sig_1 as string) ?? null,
    student_date_1: (r.student_date_1 as string) ?? null,
    student_sig_2: (r.student_sig_2 as string) ?? null,
    student_date_2: (r.student_date_2 as string) ?? null,
    student_sig_3: (r.student_sig_3 as string) ?? null,
    student_date_3: (r.student_date_3 as string) ?? null,
    student_overall_feedback: (r.student_overall_feedback as string) ?? null,
    admin_initials: (r.admin_initials as string) ?? null,
    admin_initial_checked: Boolean(r.admin_initial_checked ?? false),
    admin_updated_checked: Boolean(r.admin_updated_checked ?? false),
  };
}

export async function fetchAssessmentSummaries(instanceIds: number[]): Promise<Record<number, Pick<AssessmentSummaryDataEntry, 'final_attempt_1_result' | 'final_attempt_2_result' | 'final_attempt_3_result' | 'admin_initial_checked' | 'admin_updated_checked'>>> {
  const ids = Array.from(new Set((instanceIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0)));
  if (ids.length === 0) return {};
  const { data, error } = await supabase
    .from('skyline_form_assessment_summary_data')
    .select('instance_id, final_attempt_1_result, final_attempt_2_result, final_attempt_3_result, admin_initial_checked, admin_updated_checked')
    .in('instance_id', ids);
  if (error) {
    console.error('fetchAssessmentSummaries error', error);
    return {};
  }
  const out: Record<number, Pick<AssessmentSummaryDataEntry, 'final_attempt_1_result' | 'final_attempt_2_result' | 'final_attempt_3_result' | 'admin_initial_checked' | 'admin_updated_checked'>> = {};
  for (const r of (data as Array<Record<string, unknown>>) || []) {
    const id = Number(r.instance_id);
    if (!Number.isFinite(id) || id <= 0) continue;
    out[id] = {
      final_attempt_1_result: (r.final_attempt_1_result as string) ?? null,
      final_attempt_2_result: (r.final_attempt_2_result as string) ?? null,
      final_attempt_3_result: (r.final_attempt_3_result as string) ?? null,
      admin_initial_checked: Boolean(r.admin_initial_checked ?? false),
      admin_updated_checked: Boolean(r.admin_updated_checked ?? false),
    };
  }
  return out;
}

export async function saveAssessmentSummaryData(
  instanceId: number,
  data: Partial<AssessmentSummaryDataEntry>,
  options?: { actorRole?: 'student' | 'trainer' | 'office' | string | null; source?: string }
): Promise<void> {
  await assertStudentInstanceMutationAllowed(instanceId, {
    actorRole: options?.actorRole,
    source: options?.source,
  });
  const { error } = await supabase.from('skyline_form_assessment_summary_data').upsert(
    {
      instance_id: instanceId,
      ...data,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'instance_id' }
  );
  if (error) throw new Error(error.message || 'saveAssessmentSummaryData failed');
}

export async function fetchTrainerAssessments(instanceId: number): Promise<Record<number, string>> {
  const { data, error } = await supabase
    .from('skyline_form_trainer_assessments')
    .select('question_id, satisfactory')
    .eq('instance_id', instanceId);
  if (error) {
    console.error('fetchTrainerAssessments error', error);
    return {};
  }
  const out: Record<number, string> = {};
  for (const row of (data as { question_id: number; satisfactory: string | null }[]) || []) {
    if (row.satisfactory) out[row.question_id] = row.satisfactory;
  }
  return out;
}

export async function saveTrainerAssessment(
  instanceId: number,
  questionId: number,
  satisfactory: 'yes' | 'no'
): Promise<void> {
  const { error } = await supabase.from('skyline_form_trainer_assessments').upsert(
    { instance_id: instanceId, question_id: questionId, satisfactory, updated_at: new Date().toISOString() },
    { onConflict: 'instance_id,question_id' }
  );
  if (error) console.error('saveTrainerAssessment error', error);
}

/** Per-row satisfactory for Assessment Task 2+ grid_table questions. Key: `q-${questionId}-${rowId}` */
export async function fetchTrainerRowAssessments(instanceId: number): Promise<Record<string, string>> {
  const { data, error } = await supabase
    .from('skyline_form_trainer_row_assessments')
    .select('question_id, row_id, satisfactory')
    .eq('instance_id', instanceId);
  if (error) {
    console.error('fetchTrainerRowAssessments error', error);
    return {};
  }
  const out: Record<string, string> = {};
  for (const row of (data as { question_id: number; row_id: number; satisfactory: string | null }[]) || []) {
    if (row.satisfactory) out[`q-${row.question_id}-${row.row_id}`] = row.satisfactory;
  }
  return out;
}

export async function saveTrainerRowAssessment(
  instanceId: number,
  questionId: number,
  rowId: number,
  satisfactory: 'yes' | 'no'
): Promise<void> {
  const { error } = await supabase.from('skyline_form_trainer_row_assessments').upsert(
    { instance_id: instanceId, question_id: questionId, row_id: rowId, satisfactory, updated_at: new Date().toISOString() },
    { onConflict: 'instance_id,question_id,row_id' }
  );
  if (error) console.error('saveTrainerRowAssessment error', error);
}

export async function saveAnswer(
  instanceId: number,
  questionId: number,
  rowId: number | null,
  value: { text?: string; number?: number; json?: unknown },
  options?: {
    allowClear?: boolean;
    source?: string;
    actorRole?: 'student' | 'trainer' | 'office' | string | null;
  }
): Promise<void> {
  await assertStudentInstanceMutationAllowed(instanceId, {
    actorRole: options?.actorRole,
    source: options?.source,
  });
  const q = supabase
    .from('skyline_form_answers')
    .select('id, value_text, value_number, value_json')
    .eq('instance_id', instanceId)
    .eq('question_id', questionId);

  const { data: existing } = rowId === null
    ? await q.is('row_id', null).maybeSingle()
    : await q.eq('row_id', rowId).maybeSingle();

  const { created_by, updated_by } = getAuditFields();
  const merged = mergeSaveValuePreservingExisting(
    existing
      ? {
          text: (existing as { value_text?: string | null }).value_text ?? null,
          number: (existing as { value_number?: number | null }).value_number ?? null,
          json: (existing as { value_json?: unknown }).value_json ?? null,
        }
      : null,
    {
      text: value.text ?? null,
      number: value.number ?? null,
      json: value.json ?? null,
    },
    { allowClear: options?.allowClear, source: options?.source ?? 'saveAnswer' },
  );

  const payload: Record<string, unknown> = {
    value_text: merged.text ?? null,
    value_number: merged.number ?? null,
    value_json: merged.json ?? null,
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    payload.updated_by = updated_by;
    await supabase.from('skyline_form_answers').update(payload).eq('id', (existing as { id: number }).id);
  } else {
    if (merged.text == null && merged.number == null && merged.json == null) {
      return;
    }
    await supabase.from('skyline_form_answers').insert({
      instance_id: instanceId,
      question_id: questionId,
      row_id: rowId,
      ...payload,
      created_by,
    });
  }
}

/** Get existing instance for student+form (to avoid duplicate sends). Finds instance regardless of current role. */
export async function getInstanceForStudentAndForm(
  formId: number,
  studentId: number
): Promise<{ id: number } | null> {
  const { data, error } = await supabase
    .from('skyline_form_instances')
    .select('id')
    .eq('form_id', formId)
    .eq('student_id', studentId)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return { id: Number((data as { id: number }).id) };
}

/** Bulk fetch instances for one student across many forms. */
export async function listInstancesForStudentAndForms(
  studentId: number,
  formIds: number[]
): Promise<Array<{ id: number; form_id: number; start_date: string | null; end_date: string | null }>> {
  const sid = Number(studentId);
  if (!Number.isFinite(sid) || sid <= 0) return [];
  const ids = Array.from(new Set((formIds || []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)));
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from('skyline_form_instances')
    .select('id, form_id, start_date, end_date')
    .eq('student_id', sid)
    .in('form_id', ids);
  if (error) {
    console.error('listInstancesForStudentAndForms error', error);
    return [];
  }
  const rows = (data as Array<{ id: number; form_id: number; start_date: string | null; end_date: string | null }> | null) || [];
  return rows.map((r) => ({
    id: Number(r.id),
    form_id: Number(r.form_id),
    start_date: r.start_date ? String(r.start_date) : null,
    end_date: r.end_date ? String(r.end_date) : null,
  }));
}

export async function createFormInstance(
  formId: number,
  roleContext: string,
  studentId?: number | null
  ,
  opts?: { start_date?: string | null; end_date?: string | null }
): Promise<FormInstance | null> {
  const { created_by } = getAuditFields();
  const now = new Date();
  const startDate = getMelbourneDateStr(now);
  const endDate = getMelbourneDateStr(new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000));
  // When callers pass start_date/end_date keys (including null), honour them — do not invent defaults.
  // Defaults apply only when the opts object omits those keys (legacy create paths).
  const start =
    opts && Object.prototype.hasOwnProperty.call(opts, 'start_date')
      ? opts.start_date || null
      : startDate;
  const end =
    opts && Object.prototype.hasOwnProperty.call(opts, 'end_date')
      ? opts.end_date || null
      : endDate;
  const insert: Record<string, unknown> = {
    form_id: formId,
    role_context: roleContext,
    created_by,
    start_date: start,
    end_date: end,
  };
  if (studentId != null) insert.student_id = studentId;
  const { data, error } = await supabase
    .from('skyline_form_instances')
    .insert(insert)
    .select('*')
    .single();
  if (error) {
    console.error('createFormInstance error', error);
    return null;
  }
  return data as FormInstance;
}

/** Clear attempt results and per-attempt summary fields so the student starts at attempt 1. */
export async function clearAssessmentAttemptHistory(instanceId: number): Promise<void> {
  await saveAssessmentSummaryData(instanceId, {
    final_attempt_1_result: null,
    final_attempt_2_result: null,
    final_attempt_3_result: null,
    trainer_sig_1: null,
    trainer_date_1: null,
    trainer_sig_2: null,
    trainer_date_2: null,
    trainer_sig_3: null,
    trainer_date_3: null,
    student_sig_1: null,
    student_date_1: null,
    student_sig_2: null,
    student_date_2: null,
    student_sig_3: null,
    student_date_3: null,
    student_overall_feedback: null,
    admin_initial_checked: false,
    admin_updated_checked: false,
  });

  const { error: resultsError } = await supabase
    .from('skyline_form_results_data')
    .update({
      first_attempt_satisfactory: null,
      first_attempt_date: null,
      first_attempt_feedback: null,
      second_attempt_satisfactory: null,
      second_attempt_date: null,
      second_attempt_feedback: null,
      third_attempt_satisfactory: null,
      third_attempt_date: null,
      third_attempt_feedback: null,
      updated_at: new Date().toISOString(),
    })
    .eq('instance_id', instanceId);
  if (resultsError) {
    console.error('clearAssessmentAttemptHistory results_data error', resultsError);
  }

  const resetTables = [
    'skyline_form_trainer_assessments',
    'skyline_form_trainer_row_assessments',
    'skyline_form_results_office',
  ] as const;
  for (const table of resetTables) {
    const { error } = await supabase.from(table).delete().eq('instance_id', instanceId);
    if (error) console.error(`clearAssessmentAttemptHistory ${table} error`, error);
  }
}

export async function updateFormInstanceDates(
  instanceId: number,
  updates: { start_date?: string | null; end_date?: string | null; extension_date?: string | null },
  options?: { resetAttempts?: boolean }
): Promise<void> {
  const changingStart = 'start_date' in updates;
  const changingEnd = 'end_date' in updates;
  const changingExtension = 'extension_date' in updates;
  if (!changingStart && !changingEnd && !changingExtension) return;

  const { data: current, error: fetchError } = await supabase
    .from('skyline_form_instances')
    .select('did_not_attempt, no_attempt_rollovers, status, role_context, workflow_status')
    .eq('id', instanceId)
    .maybeSingle();
  if (fetchError) {
    console.error('updateFormInstanceDates fetch error', fetchError);
    throw fetchError;
  }

  const payload: Record<string, unknown> = {};
  if (changingStart) payload.start_date = updates.start_date ? updates.start_date.trim() : null;
  if (changingEnd) payload.end_date = updates.end_date ? updates.end_date.trim() : null;
  // Setting an extension never touches end_date and never resets attempts (only an end_date change does).
  if (changingExtension) payload.extension_date = updates.extension_date ? updates.extension_date.trim() : null;

  const hadTerminalRollover =
    Number((current as { no_attempt_rollovers?: number | null } | null)?.no_attempt_rollovers ?? 0) > 0 ||
    isDidNotAttemptAnyFailure({
      didNotAttempt: (current as { did_not_attempt?: boolean | null } | null)?.did_not_attempt,
      noAttemptRollovers: (current as { no_attempt_rollovers?: number | null } | null)?.no_attempt_rollovers,
    });
  const workflowStatus = String(
    (current as { workflow_status?: string | null } | null)?.workflow_status ?? '',
  ).trim();
  const resetAttempts =
    Boolean(options?.resetAttempts) ||
    shouldAutoResetTerminalAssessmentOnEndDateChange(
      {
        did_not_attempt: (current as { did_not_attempt?: boolean | null } | null)?.did_not_attempt,
        no_attempt_rollovers: (current as { no_attempt_rollovers?: number | null } | null)?.no_attempt_rollovers,
        workflow_status: workflowStatus,
      },
      changingEnd,
    );

  if (resetAttempts) {
    payload.status = 'draft';
    payload.role_context = 'student';
    payload.workflow_status = 'draft';
    payload.submission_count = 0;
    payload.submitted_at = null;
    payload.did_not_attempt = false;
    payload.no_attempt_rollovers = 0;
    payload.trainer_nyc_assessed_on_1 = null;
    payload.trainer_nyc_assessed_on_2 = null;
    payload.trainer_nyc_assessed_on_3 = null;
  } else if (changingEnd) {
    payload.did_not_attempt = false;
    payload.no_attempt_rollovers = 0;
    payload.status = 'draft';
    payload.role_context = 'student';
    payload.workflow_status = 'draft';
  } else if (changingStart && hadTerminalRollover) {
    payload.did_not_attempt = false;
    payload.no_attempt_rollovers = 0;
    payload.status = 'draft';
    payload.role_context = 'student';
    payload.workflow_status = 'draft';
  } else if (changingStart || changingEnd) {
    const st = String((current as { status?: string | null } | null)?.status ?? '').trim();
    if (st === 'draft') {
      payload.workflow_status = 'draft';
    }
  }

  if (Object.keys(payload).length === 0) return;

  const { error: updateError } = await supabase.from('skyline_form_instances').update(payload).eq('id', instanceId);
  if (updateError) {
    if (String(updateError.message ?? '').toLowerCase().includes('workflow_status')) {
      const { workflow_status: _wf, ...withoutWf } = payload;
      const { error: retryError } = await supabase.from('skyline_form_instances').update(withoutWf).eq('id', instanceId);
      if (retryError) {
        console.error('updateFormInstanceDates update error', retryError);
        throw retryError;
      }
      if (resetAttempts) await clearAssessmentAttemptHistory(instanceId);
      return;
    }
    console.error('updateFormInstanceDates update error', updateError);
    throw updateError;
  }

  if (resetAttempts) await clearAssessmentAttemptHistory(instanceId);
}

export type InstanceAccessRole = 'student' | 'trainer' | 'office';

const MELBOURNE_TZ = 'Australia/Melbourne';

function getMelbourneDateStr(d: Date): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: MELBOURNE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(d);
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function getMelbourneTodayIso(): string {
  return getMelbourneDateStr(new Date());
}

export function addDaysToIsoDate(dateStr: string, days: number): string {
  const trimmed = String(dateStr || '').trim();
  if (!ISO_DATE_RE.test(trimmed)) return trimmed;
  const base = new Date(`${trimmed}T00:00:00.000Z`);
  const next = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
  return next.toISOString().slice(0, 10);
}

export type TrainerAssessmentAttempt = 1 | 2 | 3;

const TRAINER_NYC_ASSESSED_ON_COL: Record<TrainerAssessmentAttempt, string> = {
  1: 'trainer_nyc_assessed_on_1',
  2: 'trainer_nyc_assessed_on_2',
  3: 'trainer_nyc_assessed_on_3',
};

/** Melbourne date when trainer submitted NYC for this attempt (workflow, not summary sheet). */
export async function recordTrainerNycAssessedOn(
  instanceId: number,
  attempt: TrainerAssessmentAttempt,
  assessedOnMel?: string
): Promise<string> {
  const assessedOn = (assessedOnMel ?? getMelbourneDateStr(new Date())).trim();
  if (!ISO_DATE_RE.test(assessedOn)) {
    throw new Error('Invalid Melbourne assessment date');
  }
  const col = TRAINER_NYC_ASSESSED_ON_COL[attempt];
  const { error } = await supabase.from('skyline_form_instances').update({ [col]: assessedOn }).eq('id', instanceId);
  if (error) {
    console.error('recordTrainerNycAssessedOn error', error);
    throw error;
  }
  return assessedOn;
}

export const STUDENT_RESUBMISSION_DAYS_AFTER_NYC = 5;

/** Student resubmission end date (Melbourne calendar) = trainer NYC assessed-on + 5 days. */
export function studentResubmissionDeadlineFromAssessedOn(assessedOnMel: string): string {
  return addDaysToIsoDate(assessedOnMel, STUDENT_RESUBMISSION_DAYS_AFTER_NYC);
}

/** UTC timestamp for end_date 23:59:59.999 in Melbourne. */
function getMelbourneEndOfDayUTC(dateStr: string): number {
  const d1 = new Date(dateStr + 'T12:59:59.999Z');
  const d2 = new Date(dateStr + 'T13:59:59.999Z');
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: MELBOURNE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const toParts = (d: Date) => {
    const p = fmt.formatToParts(d);
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? '0';
    return {
      date: `${get('year')}-${get('month').padStart(2, '0')}-${get('day').padStart(2, '0')}`,
      hour: Number(get('hour')),
      min: Number(get('minute')),
    };
  };
  const r1 = toParts(d1);
  const r2 = toParts(d2);
  if (r1.date === dateStr && r1.hour === 23 && r1.min === 59) return d1.getTime();
  if (r2.date === dateStr && r2.hour === 23 && r2.min === 59) return d2.getTime();
  return d2.getTime();
}

export interface InstanceAccessValidationResult {
  valid: boolean;
  role_context: InstanceAccessRole | null;
  tokenId: number | null;
  reason?: string;
  courseAccess?: StudentAssessmentAccessResult;
}

function generateAccessToken(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Get an existing valid (non-revoked, not expired) token URL for instance+role, or null if none. */
export async function getExistingInstanceAccessLink(
  instanceId: number,
  roleContext: InstanceAccessRole
): Promise<string | null> {
  if (roleContext === 'student') {
    const courseAccess = await getStudentAssessmentAccess({ instanceId });
    if (!studentMayOpenAssessment(courseAccess)) return null;
  }
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('skyline_instance_access_tokens')
    .select('token')
    .eq('instance_id', instanceId)
    .eq('role_context', roleContext)
    .is('revoked_at', null)
    .is('consumed_at', null)
    .gt('expires_at', now)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const t = (data as { token: string }).token;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}/instances/${instanceId}?token=${encodeURIComponent(t)}`;
}

/** Get existing valid link or issue a new one. Prevents overwriting student token when admin opens. */
export async function getOrIssueInstanceAccessLink(
  instanceId: number,
  roleContext: InstanceAccessRole
): Promise<string | null> {
  const existing = await getExistingInstanceAccessLink(instanceId, roleContext);
  if (existing) return existing;
  return issueInstanceAccessLink(instanceId, roleContext);
}

export async function issueInstanceAccessLink(
  instanceId: number,
  roleContext: InstanceAccessRole,
  ttlMinutes?: number,
  /** When true, use provided `fixedExpiresAt` (per-instance deadline alignment). */
  useResubmissionExpiry?: boolean,
  /** When provided, use this expiry to align with an instance-specific deadline (admin extend). */
  resubmissionExpiresAt?: string
): Promise<string | null> {
  const iid = Number(instanceId);
  if (roleContext === 'student' && Number.isFinite(iid) && iid > 0) {
    const courseAccess = await getStudentAssessmentAccess({ instanceId: iid });
    if (!studentMayOpenAssessment(courseAccess)) {
      console.warn('issueInstanceAccessLink blocked by course lifecycle', {
        instanceId: iid,
        reason: courseAccess.reason,
        courseId: courseAccess.courseId,
        courseStatus: courseAccess.courseStatus,
      });
      return null;
    }
  }
  const token = generateAccessToken();
  let expiresAt: string;
  const { data: instDates } = await supabase
    .from('skyline_form_instances')
    .select('start_date, end_date, extension_date')
    .eq('id', instanceId)
    .maybeSingle();
  if (roleContext === 'student') {
    // Enforce access window in Melbourne time (AEDT/AEST): must be within [start_date, deadline] inclusive,
    // where deadline = COALESCE(extension_date, end_date). End is treated as end-of-day (23:59).
    const start = String((instDates as { start_date?: string | null } | null)?.start_date ?? '').trim();
    const end = getEffectiveEndDate(instDates as { end_date?: string | null; extension_date?: string | null } | null);
    const todayMel = getMelbourneDateStr(new Date());
    if (start && todayMel < start) return null;
    if (end && todayMel > end) return null;
  }
  const instanceEndDate = getEffectiveEndDate(instDates as { end_date?: string | null; extension_date?: string | null } | null) || null;
  const isTrainerOrOffice = roleContext === 'trainer' || roleContext === 'office';
  if (useResubmissionExpiry && resubmissionExpiresAt) {
    // Align new token expiry to the instance's current deadline (admin-extended).
    expiresAt = resubmissionExpiresAt;
  } else if (roleContext === 'student' && instanceEndDate && instanceEndDate.trim()) {
    // Student access should expire at the instance deadline (extension_date, else end_date; Melbourne end-of-day).
    expiresAt = new Date(getMelbourneEndOfDayUTC(instanceEndDate.trim())).toISOString();
  } else if (ttlMinutes != null && Number.isFinite(ttlMinutes) && ttlMinutes > 0) {
    expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
  } else {
    // Default expiry now comes from instance-level policy, not skyline_forms.start_date/end_date.
    // Student links default to 30 days; trainer/office links default to 90 days.
    expiresAt = new Date(Date.now() + (isTrainerOrOffice ? 90 : 30) * 24 * 60 * 60 * 1000).toISOString();
  }
  const { error } = await supabase.from('skyline_instance_access_tokens').insert({
    instance_id: instanceId,
    role_context: roleContext,
    token,
    expires_at: expiresAt,
  });
  if (error) {
    console.error('issueInstanceAccessLink error', error);
    return null;
  }
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const base = `${origin}/instances/${instanceId}`;
  return `${base}?token=${encodeURIComponent(token)}`;
}

export async function studentLoginWithOtp(email: string, otp: string): Promise<{ ok: true; studentId: number; email: string } | { ok: false; error: string }> {
  const e = String(email || '').trim();
  const o = String(otp || '').trim();
  if (!e) return { ok: false, error: 'Email is required.' };
  if (!o) return { ok: false, error: 'OTP is required.' };
  const { data: authData, error: authError } = await supabase.rpc('skyline_verify_student_otp', {
    p_email: e,
    p_otp: o,
  });
  if (authError) return { ok: false, error: 'Authentication failed.' };
  const rows = authData as Array<{ id: number; email: string }> | null;
  if (!rows || rows.length === 0) return { ok: false, error: 'Invalid or expired OTP.' };
  const sid = Number(rows[0].id);
  if (!Number.isFinite(sid) || sid <= 0) return { ok: false, error: 'Invalid student.' };
  return { ok: true, studentId: sid, email: String(rows[0].email ?? e) };
}

export async function listStudentAssessmentsPaged(
  studentId: number,
  page = 1,
  pageSize = 20,
  search?: string
): Promise<PaginatedResult<SubmittedInstanceRow>> {
  const sid = Number(studentId);
  if (!Number.isFinite(sid) || sid <= 0) return { data: [], total: 0, page, pageSize };
  const from = Math.max(0, (page - 1) * pageSize);
  const to = from + pageSize - 1;
  let query = supabase
    .from('skyline_form_instances')
    .select(
      'id, form_id, student_id, status, role_context, workflow_status, created_at, submitted_at, submission_count, start_date, end_date, no_attempt_rollovers, did_not_attempt, skyline_form_answers(count), skyline_form_trainer_assessments(count), skyline_form_trainer_row_assessments(count), skyline_form_assessment_summary_data(final_attempt_1_result, final_attempt_2_result, final_attempt_3_result, admin_initial_checked, admin_updated_checked), skyline_students!inner(id, first_name, last_name, name, email), skyline_forms!inner(id, name, version)',
      { count: 'exact' }
    )
    .eq('student_id', sid)
    .order('start_date', { ascending: true, nullsFirst: false })
    .order('end_date', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false })
    .order('id', { ascending: false });

  const q = String(search ?? '').trim();
  if (q) {
    const escaped = q.replace(/[%_,]/g, '');
    // Filter by form name/version or status text.
    query = query.or(`status.ilike.%${escaped}%,role_context.ilike.%${escaped}%,skyline_forms.name.ilike.%${escaped}%,skyline_forms.version.ilike.%${escaped}%`);
  }

  const { data: instances, error, count } = await query.range(from, to);
  if (error) {
    console.error('listStudentAssessmentsPaged error', error);
    return { data: [], total: 0, page, pageSize };
  }

  const rows = (instances as Array<Record<string, unknown>>) || [];
  const total = Number(count ?? rows.length) || 0;

  const instanceIds = rows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0);
  const now = Date.now();
  const tokenMap = new Map<string, boolean>();
  if (instanceIds.length > 0) {
    const { data: tokens } = await supabase
      .from('skyline_instance_access_tokens')
      .select('instance_id, role_context, expires_at, revoked_at')
      .in('instance_id', instanceIds);
    for (const t of (tokens as Array<{ instance_id: number; role_context: string; expires_at: string; revoked_at: string | null }>) || []) {
      const key = `${t.instance_id}:${t.role_context}`;
      const valid = t.revoked_at == null && t.expires_at && new Date(t.expires_at).getTime() > now;
      if (valid) tokenMap.set(key, false);
      else if (!tokenMap.has(key)) tokenMap.set(key, true);
    }
  }

  const mapped = rows.map((r) => {
      const form = (r.skyline_forms as { name?: string | null; version?: string | null } | null) ?? null;
      const stu = (r.skyline_students as { first_name?: string | null; last_name?: string | null; name?: string | null; email?: string | null } | null) ?? null;
      const first = String(stu?.first_name ?? '').trim();
      const last = String(stu?.last_name ?? '').trim();
      const student_name = [first, last].filter(Boolean).join(' ').trim() || String(stu?.name ?? '') || 'Student';
      const baseId = Number(r.id);
      const roleCtx = String(r.role_context ?? 'student');
      const link_expired = tokenMap.get(`${Number(r.id)}:student`) !== false;
      const relationCount = (value: unknown): number => {
        const first = Array.isArray(value) ? value[0] : null;
        return Math.max(0, Number((first as { count?: number } | null)?.count ?? 0) || 0);
      };
      const summary = (
        Array.isArray(r.skyline_form_assessment_summary_data)
          ? r.skyline_form_assessment_summary_data[0]
          : r.skyline_form_assessment_summary_data
      ) as Record<string, unknown> | null;
      const attemptResults = [
        summary?.final_attempt_1_result ?? null,
        summary?.final_attempt_2_result ?? null,
        summary?.final_attempt_3_result ?? null,
      ] as AttemptResult[];
      const trainerAssessmentExists =
        attemptResults.some((result) => result !== null) ||
        relationCount(r.skyline_form_trainer_assessments) > 0 ||
        relationCount(r.skyline_form_trainer_row_assessments) > 0;
      return {
        id: baseId,
        form_id: Number(r.form_id),
        form_name: String(form?.name ?? ''),
        form_version: form?.version != null ? String(form.version) : null,
        student_id: Number(r.student_id),
        student_name,
        student_email: String(stu?.email ?? ''),
        status: String(r.status ?? 'draft'),
        role_context: String(roleCtx),
        workflow_status: r.workflow_status != null ? String(r.workflow_status) : null,
        created_at: String(r.created_at ?? ''),
        submitted_at: r.submitted_at ? String(r.submitted_at) : null,
        submission_count: Number((r as { submission_count?: number | null }).submission_count ?? 0) || 0,
        start_date: (r as { start_date?: string | null }).start_date ? String((r as { start_date?: string | null }).start_date) : null,
        end_date: (r as { end_date?: string | null }).end_date ? String((r as { end_date?: string | null }).end_date) : null,
        no_attempt_rollovers: (r as { no_attempt_rollovers?: number | null }).no_attempt_rollovers ?? null,
        did_not_attempt: (r as { did_not_attempt?: boolean | null }).did_not_attempt ?? null,
        answer_count: relationCount(r.skyline_form_answers),
        attempt_results: attemptResults,
        trainer_result: [...attemptResults].reverse().find((result) => result !== null) ?? null,
        trainer_assessment_exists: trainerAssessmentExists,
        office_assessment_completed:
          String(r.workflow_status ?? '').trim() === 'completed' ||
          (Boolean(summary?.admin_initial_checked) && Boolean(summary?.admin_updated_checked)),
        link_expired,
      };
    });

  return {
    data: await withExtensionDates(await withFormCourseIds(mapped)),
    total,
    page,
    pageSize,
  };
}

export async function validateInstanceAccessToken(
  instanceId: number,
  token: string
): Promise<InstanceAccessValidationResult> {
  const { data, error } = await supabase
    .from('skyline_instance_access_tokens')
    .select('id, role_context, expires_at, consumed_at, revoked_at')
    .eq('instance_id', instanceId)
    .eq('token', token)
    .maybeSingle();
  if (error || !data) {
    if (error) console.error('validateInstanceAccessToken error', error);
    return { valid: false, role_context: null, tokenId: null, reason: 'Invalid secure link.' };
  }
  const row = data as Record<string, unknown>;
  const role = String(row.role_context ?? '') as InstanceAccessRole;
  if (role !== 'student' && role !== 'trainer' && role !== 'office') {
    return { valid: false, role_context: null, tokenId: Number(row.id ?? 0) || null, reason: 'Invalid access role.' };
  }
  if (row.revoked_at) {
    return { valid: false, role_context: null, tokenId: Number(row.id ?? 0) || null, reason: 'This secure link is no longer active.' };
  }
  if (row.consumed_at) {
    return { valid: false, role_context: null, tokenId: Number(row.id ?? 0) || null, reason: 'This secure link was already used.' };
  }
  const expiresAt = row.expires_at ? new Date(String(row.expires_at)).getTime() : 0;
  if (!expiresAt || Number.isNaN(expiresAt) || expiresAt <= Date.now()) {
    return { valid: false, role_context: null, tokenId: Number(row.id ?? 0) || null, reason: 'This secure link has expired.' };
  }

  if (role === 'student') {
    const { data: inst } = await supabase
      .from('skyline_form_instances')
      .select('form_id, student_id, start_date, end_date, extension_date, did_not_attempt')
      .eq('id', instanceId)
      .single();
    if (inst) {
      const studentId = (inst as { student_id?: number | null }).student_id;
      if (studentId != null) {
        const { data: student } = await supabase.from('skyline_students').select('status').eq('id', studentId).maybeSingle();
        const status = (student as { status?: string | null } | null)?.status;
        if (status === 'inactive') {
          return {
            valid: false,
            role_context: null,
            tokenId: Number(row.id ?? 0) || null,
            reason: 'Your account is inactive. Contact your administrator to restore access.',
          };
        }
      }

      const didNotAttempt = Boolean((inst as { did_not_attempt?: boolean | null }).did_not_attempt);
      if (didNotAttempt) {
        return {
          valid: false,
          role_context: null,
          tokenId: Number(row.id ?? 0) || null,
          reason: 'This assessment closed after missed attempt windows. Contact your administrator.',
        };
      }

      const startDate = (inst as { start_date?: string | null }).start_date ?? null;
      const endDateRaw = getEffectiveEndDate(inst as { end_date?: string | null; extension_date?: string | null }) || null;
      const endDate = endDateRaw != null ? String(endDateRaw).trim() : null;
      const todayMel = getMelbourneDateStr(new Date());
      const start = (startDate ?? '').trim();
      const end = (endDate ?? '').trim();
      if (start && todayMel < start) {
        return { valid: false, role_context: null, tokenId: Number(row.id ?? 0) || null, reason: 'This assessment is not available yet.' };
      }
      if (end && todayMel > end) {
        return { valid: false, role_context: null, tokenId: Number(row.id ?? 0) || null, reason: 'This assessment has expired. Contact your administrator to extend it.' };
      }

      const courseAccess = await getStudentAssessmentAccess({
        instanceId,
        studentId: studentId != null ? Number(studentId) : null,
        formId: Number((inst as { form_id?: number | null }).form_id ?? 0) || null,
      });
      if (!studentMayOpenAssessment(courseAccess)) {
        console.warn('validateInstanceAccessToken blocked by course lifecycle', {
          instanceId,
          studentId,
          reason: courseAccess.reason,
          courseId: courseAccess.courseId,
          courseStatus: courseAccess.courseStatus,
        });
        return {
          valid: false,
          role_context: null,
          tokenId: Number(row.id ?? 0) || null,
          reason: courseAccess.message,
          courseAccess,
        };
      }

      return {
        valid: true,
        role_context: role,
        tokenId: Number(row.id ?? 0) || null,
        courseAccess,
      };
    }
    return {
      valid: false,
      role_context: null,
      tokenId: Number(row.id ?? 0) || null,
      reason: 'Assessment instance not found.',
    };
  }

  return {
    valid: true,
    role_context: role,
    tokenId: Number(row.id ?? 0) || null,
  };
}

export async function consumeInstanceAccessToken(tokenId: number): Promise<void> {
  if (!tokenId) return;
  const { error } = await supabase
    .from('skyline_instance_access_tokens')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', tokenId);
  if (error) console.error('consumeInstanceAccessToken error', error);
}

export async function revokeRoleAccessTokens(instanceId: number, roleContext: InstanceAccessRole): Promise<void> {
  const { error } = await supabase
    .from('skyline_instance_access_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('instance_id', instanceId)
    .eq('role_context', roleContext)
    .is('consumed_at', null)
    .is('revoked_at', null);
  if (error) console.error('revokeRoleAccessTokens error', error);
}

export interface InstanceAccessTokenInfo {
  id: number;
  role_context: InstanceAccessRole;
  expires_at: string;
  revoked_at: string | null;
  consumed_at: string | null;
}

export async function listInstanceAccessTokens(instanceId: number): Promise<InstanceAccessTokenInfo[]> {
  const { data, error } = await supabase
    .from('skyline_instance_access_tokens')
    .select('id, role_context, expires_at, revoked_at, consumed_at')
    .eq('instance_id', instanceId)
    .order('id', { ascending: false });
  if (error) {
    console.error('listInstanceAccessTokens error', error);
    return [];
  }
  return (data as InstanceAccessTokenInfo[]) || [];
}

/**
 * Re-enable revoked links and extend the deadline. Admin can use this to allow access past the form end_date.
 * The deadline is extended through extension_date — end_date is NEVER changed here. Student link expiry is set to the
 * (new) effective deadline, Melbourne end-of-day; trainer/office links keep the plain +extraDays expiry.
 */
export async function extendInstanceAccessTokens(instanceId: number, roleContext: InstanceAccessRole, extraDays = 30): Promise<void> {
  const today = getMelbourneDateStr(new Date());
  const desiredEnd = getMelbourneDateStr(new Date(Date.now() + extraDays * 24 * 60 * 60 * 1000));
  const { data: inst } = await supabase
    .from('skyline_form_instances')
    .select('end_date, extension_date')
    .eq('id', instanceId)
    .maybeSingle();
  const currentEffective = getEffectiveEndDate(inst as { end_date?: string | null; extension_date?: string | null } | null);
  const nextEffective = currentEffective
    ? (currentEffective < today ? desiredEnd : (currentEffective < desiredEnd ? desiredEnd : currentEffective))
    : desiredEnd;
  if (nextEffective !== currentEffective) {
    const { error: extErr } = await supabase.from('skyline_form_instances').update({ extension_date: nextEffective }).eq('id', instanceId);
    if (extErr) console.error('extendInstanceAccessTokens extension_date update error', extErr);
  }
  const newExpiresAt =
    roleContext === 'student'
      ? new Date(getMelbourneEndOfDayUTC(nextEffective)).toISOString()
      : new Date(Date.now() + extraDays * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase
    .from('skyline_instance_access_tokens')
    .update({ revoked_at: null, expires_at: newExpiresAt })
    .eq('instance_id', instanceId)
    .eq('role_context', roleContext)
    .is('consumed_at', null);
  if (error) console.error('extendInstanceAccessTokens error', error);
}

/** Extend this instance's tokens to a specific end date (Melbourne end-of-day). For per-instance submission deadline only. */
export async function extendInstanceAccessTokensToDate(
  instanceId: number,
  roleContext: InstanceAccessRole,
  endDateStr: string
): Promise<void> {
  await supabase.from('skyline_form_instances').update({ end_date: endDateStr.trim() || null }).eq('id', instanceId);
  // Link expiry follows the effective deadline: a real extension (kept in step by the DB trigger) outlives end_date.
  const { data: after } = await supabase.from('skyline_form_instances').select('end_date, extension_date').eq('id', instanceId).maybeSingle();
  const effective = getEffectiveEndDate(after as { end_date?: string | null; extension_date?: string | null } | null) || endDateStr.trim();
  const utcMs = getMelbourneEndOfDayUTC(effective);
  const newExpiresAt = new Date(utcMs).toISOString();
  const { error } = await supabase
    .from('skyline_instance_access_tokens')
    .update({ revoked_at: null, expires_at: newExpiresAt })
    .eq('instance_id', instanceId)
    .eq('role_context', roleContext)
    .is('consumed_at', null);
  if (error) console.error('extendInstanceAccessTokensToDate error', error);
}

/**
 * Align the student link expiry (and re-enable it) to the instance's effective deadline, Melbourne end-of-day.
 * Never writes end_date or extension_date. No-op when the instance has no deadline.
 */
export async function syncStudentTokenExpiryToDeadline(instanceId: number): Promise<void> {
  const { data: inst } = await supabase
    .from('skyline_form_instances')
    .select('end_date, extension_date')
    .eq('id', instanceId)
    .maybeSingle();
  const effective = getEffectiveEndDate(inst as { end_date?: string | null; extension_date?: string | null } | null);
  if (!effective) return;
  const { error } = await supabase
    .from('skyline_instance_access_tokens')
    .update({ revoked_at: null, expires_at: new Date(getMelbourneEndOfDayUTC(effective)).toISOString() })
    .eq('instance_id', instanceId)
    .eq('role_context', 'student')
    .is('consumed_at', null);
  if (error) console.error('syncStudentTokenExpiryToDeadline error', error);
}

/** Allow student resubmission: set instance back to draft, role to student, and re-enable student link. For 2nd/3rd attempts. */
export async function allowStudentResubmission(instanceId: number): Promise<void> {
  const { updated_by } = getAuditFields();
  const payload: Record<string, unknown> = {
    status: 'draft',
    role_context: 'student',
    workflow_status: 'draft',
    updated_by,
  };
  const { error } = await supabase.from('skyline_form_instances').update(payload).eq('id', instanceId);
  if (error) {
    const msg = String(error.message ?? '').toLowerCase();
    if (msg.includes('workflow_status')) {
      const { workflow_status: _wf, ...withoutWf } = payload;
      const { error: retryErr } = await supabase
        .from('skyline_form_instances')
        .update(withoutWf)
        .eq('id', instanceId);
      if (retryErr) throw retryErr;
    } else {
      throw error;
    }
  }
  await extendInstanceAccessTokens(instanceId, 'student', 30);
}

export interface StudentLoginResult {
  success: boolean;
  url?: string;
  instanceId?: number;
  error?: string;
}

/** Request OTP via Edge Function (OTP is created and email sent server-side; never exposed to client). */
async function requestOtpViaEdgeFunction(
  email: string,
  type: 'staff' | 'student' | 'induction'
): Promise<{ success: boolean; message: string }> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!supabaseUrl?.trim() || !anonKey?.trim()) {
    return { success: false, message: 'App is not configured. Contact your administrator.' };
  }
  const base = `${supabaseUrl.replace(/\/$/, '')}/functions/v1`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${anonKey}`,
  };
  try {
    let res: Response;
    if (type === 'induction') {
      res = await fetch(`${base}/skyline-request-induction-otp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email: email.trim() }),
      });
      // Older projects may not have deployed the induction-only function yet.
      if (res.status === 404) {
        res = await fetch(`${base}/skyline-request-otp`, {
          method: 'POST',
          headers: { ...headers, 'X-Skyline-Otp-Type': 'induction' },
          body: JSON.stringify({ email: email.trim(), type: 'induction' }),
        });
      }
    } else {
      res = await fetch(`${base}/skyline-request-otp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email: email.trim(), type }),
      });
    }
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
    const success = !!json.success;
    const message = typeof json.message === 'string' ? json.message : (success ? 'OTP sent. Check your email. Valid for 10 minutes.' : 'Failed to request OTP.');
    return { success, message };
  } catch (e) {
    console.error('requestOtp edge function error', e);
    return { success: false, message: 'Failed to request OTP. Please try again.' };
  }
}

/** Request OTP for student form access. Uses Edge Function so OTP is never sent to the client. */
export async function requestStudentOtp(email: string): Promise<{ success: boolean; message: string }> {
  return requestOtpViaEdgeFunction(email.trim(), 'student');
}

/** Request OTP for public induction (@slit.edu.au / @student.slit.edu.au via skyline_request_induction_otp). */
export async function requestInductionOtp(email: string): Promise<{ success: boolean; message: string }> {
  return requestOtpViaEdgeFunction(email.trim(), 'induction');
}

async function studentFormAccessFromId(formId: number, studentId: number): Promise<StudentLoginResult> {
  const { data: student } = await supabase.from('skyline_students').select('status').eq('id', studentId).maybeSingle();
  const studentStatus = (student as { status?: string | null } | null)?.status;
  if (studentStatus === 'inactive') {
    return {
      success: false,
      error: 'Your account is inactive. Contact your administrator to restore access.',
    };
  }
  const instance = await getInstanceForStudentAndForm(formId, studentId);
  if (!instance) {
    return {
      success: false,
      error: "You don't have access to this form. Ask your admin to send it to you.",
    };
  }

  const { data: instRow } = await supabase
    .from('skyline_form_instances')
    .select('status, submitted_at')
    .eq('id', instance.id)
    .single();
  const instStatus = (instRow as { status?: string } | null)?.status ?? 'draft';
  const hasSubmittedBefore = !!(instRow as { submitted_at?: string } | null)?.submitted_at;
  const isResubmission = hasSubmittedBefore && instStatus === 'draft';
  // Forms no longer have their own start/end access window. Access is controlled per assessment instance
  // via secure tokens (admin can revoke/extend the instance deadline).
  let fixedExpiresAt: string | undefined;
  {
    const { data: allTokens } = await supabase
      .from('skyline_instance_access_tokens')
      .select('expires_at, revoked_at')
      .eq('instance_id', instance.id)
      .eq('role_context', 'student');
    const now = Date.now();
    const candidates =
      ((allTokens as Array<{ expires_at: string; revoked_at: string | null }> | null) ?? [])
        .filter((t) => !t.revoked_at && t.expires_at)
        .map((t) => new Date(t.expires_at).getTime())
        .filter((ms) => Number.isFinite(ms) && ms > now);
    if (candidates.length > 0) {
      fixedExpiresAt = new Date(Math.max(...candidates)).toISOString();
    }
  }

  if (hasSubmittedBefore && instStatus !== 'draft') {
    const { data: allTokens } = await supabase
      .from('skyline_instance_access_tokens')
      .select('expires_at, revoked_at')
      .eq('instance_id', instance.id)
      .eq('role_context', 'student');
    const now = Date.now();
    const anyValid = (allTokens as Array<{ expires_at: string; revoked_at: string | null }> | null)?.some(
      (t) => !t.revoked_at && t.expires_at && new Date(t.expires_at).getTime() > now
    ) ?? false;
    if (!anyValid) {
      return {
        success: false,
        error: 'Assessment submitted. Admin must allow resubmission before you can access again.',
      };
    }
  }

  const url = await issueInstanceAccessLink(
    instance.id,
    'student',
    undefined,
    // Preserve existing per-instance deadline when present, or when this is a resubmission flow.
    // (New token will align to the already-extended deadline if admin has set it.)
    isResubmission || !!fixedExpiresAt,
    fixedExpiresAt
  );
  if (!url) return { success: false, error: 'Failed to generate access link.' };
  return { success: true, url, instanceId: instance.id };
}

/** Student login via OTP for generic link access. Returns URL with token to redirect to. */
export async function studentLoginWithOtpForForm(formId: number, email: string, otp: string): Promise<StudentLoginResult> {
  const { data: authData, error: authError } = await supabase.rpc('skyline_verify_student_otp', {
    p_email: email.trim(),
    p_otp: otp.trim(),
  });
  if (authError) {
    return { success: false, error: 'Authentication failed.' };
  }
  const rows = authData as Array<{ id: number; email: string }> | null;
  if (!rows || rows.length === 0) {
    return { success: false, error: 'Invalid or expired OTP.' };
  }
  const studentId = rows[0].id;
  return studentFormAccessFromId(formId, studentId);
}

/**
 * Verify induction OTP (consumes the code). Matches enrolled students or active staff users.
 * Prefer using `unlockSkylineInductionSession` for the real flow so OTP is not verified twice.
 */
export async function verifyStudentOtpForInduction(
  email: string,
  otp: string
): Promise<{ success: boolean; error?: string }> {
  const { data: authData, error: authError } = await supabase.rpc('skyline_verify_induction_otp', {
    p_email: email.trim(),
    p_otp: otp.trim(),
  });
  if (authError) {
    return { success: false, error: 'Authentication failed.' };
  }
  const authRows = authData as
    | Array<{ student_id: number | null; guest_email: string | null; email_out: string | null }>
    | null;
  if (!authRows || authRows.length === 0) {
    return { success: false, error: 'Invalid or expired OTP.' };
  }
  const row = authRows[0];
  if (row.student_id != null) {
    const { data: student } = await supabase.from('skyline_students').select('status').eq('id', row.student_id).maybeSingle();
    const studentStatus = (student as { status?: string | null } | null)?.status;
    if (studentStatus === 'inactive') {
      return {
        success: false,
        error: 'Your account is inactive. Contact your administrator to restore access.',
      };
    }
  }
  return { success: true };
}

export async function setStudentPassword(studentId: number, password: string): Promise<{ success: boolean; message: string }> {
  const { data, error } = await supabase.rpc('skyline_student_set_password', {
    p_student_id: studentId,
    p_password: password,
  });
  if (error) return { success: false, message: error.message };
  const rows = data as Array<{ success: boolean; message: string }> | null;
  const row = rows?.[0];
  return row ? { success: row.success, message: row.message } : { success: false, message: 'Unknown error.' };
}

export interface Trainer {
  id: number;
  full_name: string;
  email: string;
  phone: string | null;
  status: string | null;
  role?: string;
  created_at: string;
}

/** User with role (admin, trainer, office) for Users directory */
export interface UserRow {
  id: number;
  full_name: string;
  email: string;
  phone: string | null;
  status: string | null;
  role: string;
  can_login_as_student?: boolean;
  can_login_as_trainer?: boolean;
  can_view_finance_reports?: boolean;
  created_at: string;
}

export interface CreateUserInput {
  full_name: string;
  email: string;
  phone?: string;
  status?: string;
  role: 'superadmin' | 'admin' | 'trainer' | 'office';
  can_login_as_student?: boolean;
  can_login_as_trainer?: boolean;
  can_view_finance_reports?: boolean;
}

export interface CreateTrainerInput {
  full_name: string;
  email: string;
  phone?: string;
  status?: string;
}

export type UpdateTrainerInput = Partial<CreateTrainerInput>;

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type AppUserRole = 'superadmin' | 'admin' | 'trainer' | 'office';

export interface AppUser {
  id: number;
  full_name: string;
  email: string;
  phone: string | null;
  status: string | null;
  role: AppUserRole;
  can_login_as_student?: boolean;
  can_login_as_trainer?: boolean;
  can_view_finance_reports?: boolean;
}

/** Finance Reports: superadmin always; admin when superadmin grants can_view_finance_reports. */
export function canViewFinanceReports(
  user: Pick<AppUser, 'role' | 'can_view_finance_reports'> | null | undefined
): boolean {
  if (!user) return false;
  if (user.role === 'superadmin') return true;
  if (user.role === 'admin' && Boolean(user.can_view_finance_reports)) return true;
  return false;
}

/** Payment Plans: admin and superadmin only (not office/trainers). */
export function canManagePaymentPlans(
  user: Pick<AppUser, 'role'> | null | undefined
): boolean {
  if (!user) return false;
  return user.role === 'admin' || user.role === 'superadmin';
}

/** Finance nav section: payment plans and/or finance reports. */
export function canAccessFinanceNav(
  user: Pick<AppUser, 'role' | 'can_view_finance_reports'> | null | undefined
): boolean {
  return canManagePaymentPlans(user) || canViewFinanceReports(user);
}

const AUTH_STORAGE_KEY = 'skyline_auth_user';
export const STUDENT_DASHBOARD_AUTH_STORAGE_KEY = 'signflow_student_dashboard_auth_v1';
/** Tab-scoped superadmin "view as" another staff user (sessionStorage; does not replace localStorage login). */
export const STAFF_IMPERSONATION_STORAGE_KEY = 'signflow_staff_impersonation_v1';

export interface StaffImpersonationPayload {
  user: AppUser;
  impersonatorUserId: number;
  at: number;
}

export function parseStaffImpersonationSession(): StaffImpersonationPayload | null {
  try {
    const s = sessionStorage.getItem(STAFF_IMPERSONATION_STORAGE_KEY);
    if (!s) return null;
    const raw = JSON.parse(s) as Partial<StaffImpersonationPayload>;
    const u = raw?.user;
    if (!u || !Number.isFinite(Number(u.id)) || !u.email || !u.role) return null;
    const impersonatorUserId = Number(raw.impersonatorUserId);
    if (!Number.isFinite(impersonatorUserId) || impersonatorUserId <= 0) return null;
    return {
      user: {
        id: Number(u.id),
        full_name: String(u.full_name ?? ''),
        email: String(u.email ?? ''),
        phone: u.phone != null ? String(u.phone) : null,
        status: u.status != null ? String(u.status) : null,
        role: u.role as AppUserRole,
        can_login_as_student: Boolean((u as { can_login_as_student?: unknown }).can_login_as_student),
        can_login_as_trainer: Boolean((u as { can_login_as_trainer?: unknown }).can_login_as_trainer),
        can_view_finance_reports: Boolean((u as { can_view_finance_reports?: unknown }).can_view_finance_reports),
      },
      impersonatorUserId,
      at: Number(raw.at) || Date.now(),
    };
  } catch {
    return null;
  }
}

export function setStaffImpersonationSession(user: AppUser, impersonatorUserId: number): void {
  const payload: StaffImpersonationPayload = { user, impersonatorUserId, at: Date.now() };
  sessionStorage.setItem(STAFF_IMPERSONATION_STORAGE_KEY, JSON.stringify(payload));
}

export function clearStaffImpersonationSession(): void {
  sessionStorage.removeItem(STAFF_IMPERSONATION_STORAGE_KEY);
}

/** New tabs don't inherit sessionStorage; superadmin “Open as user” queues here briefly, then the new tab moves it into sessionStorage. */
const STAFF_IMPERSONATION_PENDING_KEY = 'signflow_staff_impersonation_pending_v1';
const IMPERSONATION_PENDING_MAX_MS = 120_000;

/** Queue impersonation for the next tab opened via window.open (same browser profile / localStorage). */
export function queueStaffImpersonationTabOpen(user: AppUser, impersonatorUserId: number): void {
  const payload: StaffImpersonationPayload = { user, impersonatorUserId, at: Date.now() };
  localStorage.setItem(STAFF_IMPERSONATION_PENDING_KEY, JSON.stringify(payload));
}

/**
 * Run once on app load: if superadmin queued “Open as user”, move payload into this tab’s sessionStorage.
 * Returns true when impersonation was applied.
 */
export function consumeStaffImpersonationPendingIfEligible(): boolean {
  try {
    const s = localStorage.getItem(STAFF_IMPERSONATION_PENDING_KEY);
    if (!s) return false;
    const raw = JSON.parse(s) as Partial<StaffImpersonationPayload>;
    const u = raw?.user;
    const stored = getStoredUser();
    if (!u || !stored || Number(raw.impersonatorUserId) !== stored.id) return false;
    const age = Date.now() - (Number(raw.at) || 0);
    if (age > IMPERSONATION_PENDING_MAX_MS || age < 0) {
      localStorage.removeItem(STAFF_IMPERSONATION_PENDING_KEY);
      return false;
    }
    const appUser: AppUser = {
      id: Number(u.id),
      full_name: String(u.full_name ?? ''),
      email: String(u.email ?? ''),
      phone: u.phone != null ? String(u.phone) : null,
      status: u.status != null ? String(u.status) : null,
      role: u.role as AppUserRole,
      can_login_as_student: Boolean((u as { can_login_as_student?: unknown }).can_login_as_student),
      can_login_as_trainer: Boolean((u as { can_login_as_trainer?: unknown }).can_login_as_trainer),
      can_view_finance_reports: Boolean((u as { can_view_finance_reports?: unknown }).can_view_finance_reports),
    };
    if (!Number.isFinite(appUser.id) || appUser.id <= 0 || !appUser.email) return false;
    localStorage.removeItem(STAFF_IMPERSONATION_PENDING_KEY);
    setStaffImpersonationSession(appUser, stored.id);
    return true;
  } catch {
    return false;
  }
}

/** Active staff session for this tab: impersonated user if superadmin opened "Open as user", else localStorage user. */
export function getEffectiveStoredUser(): AppUser | null {
  const stored = getStoredUser();
  const imp = parseStaffImpersonationSession();
  if (!imp?.user?.id) return stored;
  if (!stored || imp.impersonatorUserId !== stored.id) {
    clearStaffImpersonationSession();
    return stored;
  }
  return imp.user;
}

/** True when this tab is viewing the app as another staff user (superadmin preview). */
export function isStaffImpersonationActive(): boolean {
  const stored = getStoredUser();
  const imp = parseStaffImpersonationSession();
  return !!(stored && imp && imp.impersonatorUserId === stored.id && imp.user?.id && imp.user.id !== stored.id);
}

export function getStoredUser(): AppUser | null {
  try {
    const s = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!s) return null;
    const u = JSON.parse(s) as AppUser;
    return u && u.id && u.email ? u : null;
  } catch {
    return null;
  }
}

export function setStoredUser(user: AppUser | null): void {
  if (user) {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(user));
  } else {
    localStorage.removeItem(AUTH_STORAGE_KEY);
  }
}

/**
 * Server-issued staff session token (returned by the login RPCs, valid 12 hours).
 * It is what proves who the caller is to the SECURITY DEFINER RPCs below — the server
 * never trusts a user id sent by the client. Kept apart from the stored user so the
 * superadmin "open as user" preview never changes whose token is sent.
 */
const STAFF_SESSION_TOKEN_KEY = 'skyline_staff_session_token_v1';

export function getStaffSessionToken(): string | null {
  try {
    return localStorage.getItem(STAFF_SESSION_TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

export function setStaffSessionToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(STAFF_SESSION_TOKEN_KEY, token);
    else localStorage.removeItem(STAFF_SESSION_TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Logout: delete the session row on the server, then forget the token locally. */
export async function endStaffSession(): Promise<void> {
  const token = getStaffSessionToken();
  setStaffSessionToken(null);
  if (!token) return;
  try {
    await supabase.rpc('skyline_logout', { p_token: token });
  } catch (e) {
    console.error('skyline_logout error', e);
  }
}

export type StaffRpcFailure = {
  ok: false;
  /** session = sign in again; forbidden = server said 403; error = anything else. */
  reason: 'session' | 'forbidden' | 'error';
  message: string;
};

const STAFF_SESSION_MISSING: StaffRpcFailure = {
  ok: false,
  reason: 'session',
  message: 'Your session has expired. Please sign out and sign in again.',
};

function staffRpcFailure(
  error: { code?: string; message?: string } | null,
  status: number,
  /** Shown on 403. Omit to show the server's own (already user-friendly) message. */
  forbiddenMessage?: string
): StaffRpcFailure {
  const code = String(error?.code ?? '');
  // Our RPCs raise PTxxx with a message written for end users; anything else is unexpected.
  const serverMessage = /^PT\d{3}$/.test(code) ? String(error?.message ?? '').trim() : '';
  if (code === 'PT401') {
    setStaffSessionToken(null);
    return STAFF_SESSION_MISSING;
  }
  if (code === 'PT403') {
    return {
      ok: false,
      reason: 'forbidden',
      message: forbiddenMessage || serverMessage || "You don't have permission to do this.",
    };
  }
  if (serverMessage) return { ok: false, reason: 'error', message: serverMessage };
  if (status === 401 || status === 403) {
    return { ok: false, reason: 'forbidden', message: "You don't have permission to do this." };
  }
  return { ok: false, reason: 'error', message: 'Something went wrong. Please try again.' };
}

/**
 * While a super admin is "Previewing as <user>", the session token is still the super admin's.
 * Trainer RPCs take p_as_user_id so the server answers for the previewed user instead. The
 * server accepts it only from a super admin (anyone else gets 403), and login-as-student is
 * still logged with the super admin as the actor.
 */
function previewAsUserParam(): { p_as_user_id?: number } {
  if (!isStaffImpersonationActive()) return {};
  const id = Number(parseStaffImpersonationSession()?.user?.id);
  return Number.isFinite(id) && id > 0 ? { p_as_user_id: id } : {};
}

/** UI convenience only: should "Login as student" be shown? The server re-checks on click. */
export async function canLoginAsStudent(studentId: number): Promise<boolean> {
  const token = getStaffSessionToken();
  const sid = Number(studentId);
  if (!token || !Number.isFinite(sid) || sid <= 0) return false;
  const { data, error } = await supabase.rpc('skyline_can_login_as_student', {
    p_token: token,
    p_student_id: sid,
    ...previewAsUserParam(),
  });
  if (error) return false;
  return data === true;
}

/** Server-side authorisation for "Login as student". Writes an impersonation_logs row on success. */
export async function loginAsStudentViaServer(
  studentId: number
): Promise<{ ok: true; studentId: number; email: string } | StaffRpcFailure> {
  const token = getStaffSessionToken();
  if (!token) return STAFF_SESSION_MISSING;
  const { data, error, status } = await supabase.rpc('skyline_login_as_student', {
    p_token: token,
    p_student_id: Number(studentId),
    ...previewAsUserParam(),
  });
  if (error) {
    return staffRpcFailure(error, status, "You don't have permission to log in as this student.");
  }
  const row = ((data as Array<Record<string, unknown>> | null) || [])[0];
  const sid = Number(row?.student_id);
  if (!row || !Number.isFinite(sid) || sid <= 0) {
    return { ok: false, reason: 'error', message: 'Something went wrong. Please try again.' };
  }
  return { ok: true, studentId: sid, email: String(row.student_email ?? '') };
}

/** Admin-only (enforced on the server): switch "trainers may log in as students" for a batch. */
export async function setBatchTrainerStudentLogin(
  batchId: number,
  allow: boolean
): Promise<{ ok: true } | StaffRpcFailure> {
  const token = getStaffSessionToken();
  if (!token) return STAFF_SESSION_MISSING;
  const { error, status } = await supabase.rpc('skyline_set_batch_trainer_student_login', {
    p_token: token,
    p_batch_id: Number(batchId),
    p_allow: Boolean(allow),
  });
  if (error) return staffRpcFailure(error, status, 'Only an admin can change this setting.');
  return { ok: true };
}

/**
 * "Login as student": ask the server (which authorises and records it), then open the student
 * dashboard in a new tab. The staff session in this tab is left untouched.
 */
export async function openStudentDashboardAsStaff(
  studentId: number,
  fallbackEmail: string | null | undefined,
  byUserId: number | null | undefined
): Promise<{ ok: true } | StaffRpcFailure> {
  const res = await loginAsStudentViaServer(studentId);
  if (!res.ok) return res;
  sessionStorage.setItem(
    STUDENT_DASHBOARD_AUTH_STORAGE_KEY,
    JSON.stringify({ studentId: res.studentId, email: res.email || fallbackEmail || '', at: Date.now(), by: byUserId ?? null })
  );
  const opened = window.open('/student/dashboard', '_blank');
  if (!opened) {
    return {
      ok: false,
      reason: 'error',
      message: 'Your browser blocked the new tab. Allow pop-ups for this site and try again.',
    };
  }
  return { ok: true };
}

/** A student as a trainer sees them: basic details only. */
export interface TrainerStudentRow {
  id: number;
  student_code: string | null;
  full_name: string;
  email: string;
  phone: string | null;
  status: string | null;
  batch_id: number | null;
  batch_name: string | null;
  course_name: string | null;
  /** True when the server would allow "Login as student" for the signed-in staff member. */
  can_login_as_student: boolean;
}

function mapTrainerStudentRow(row: Record<string, unknown>): TrainerStudentRow {
  return {
    id: Number(row.id),
    student_code: row.student_code ? String(row.student_code) : null,
    full_name: String(row.full_name ?? ''),
    email: String(row.email ?? ''),
    phone: row.phone ? String(row.phone) : null,
    status: row.status ? String(row.status) : null,
    batch_id: row.batch_id != null ? Number(row.batch_id) : null,
    batch_name: row.batch_name ? String(row.batch_name) : null,
    course_name: row.course_name ? String(row.course_name) : null,
    can_login_as_student: row.can_login_as_student === true,
  };
}

/** Students in the batches the signed-in staff member trains (checked on the server). */
export async function listMyStudentsForTrainer(
  page = 1,
  pageSize = 20,
  search?: string
): Promise<{ ok: true; data: TrainerStudentRow[]; total: number } | StaffRpcFailure> {
  const token = getStaffSessionToken();
  if (!token) return STAFF_SESSION_MISSING;
  const { data, error, status } = await supabase.rpc('skyline_trainer_list_my_students', {
    p_token: token,
    p_search: search?.trim() || null,
    p_limit: pageSize,
    p_offset: Math.max(0, (page - 1) * pageSize),
    ...previewAsUserParam(),
  });
  if (error) {
    console.error('listMyStudentsForTrainer error', error);
    return staffRpcFailure(error, status);
  }
  const rows = (data as Record<string, unknown>[] | null) || [];
  return {
    ok: true,
    data: rows.map(mapTrainerStudentRow),
    total: rows.length > 0 ? Number(rows[0].total_count ?? rows.length) : 0,
  };
}

/** One student's basic details. The server answers 403 for a student outside the trainer's batches. */
export async function getMyStudentForTrainer(
  studentId: number
): Promise<{ ok: true; student: TrainerStudentRow } | StaffRpcFailure> {
  const token = getStaffSessionToken();
  if (!token) return STAFF_SESSION_MISSING;
  const { data, error, status } = await supabase.rpc('skyline_trainer_get_student', {
    p_token: token,
    p_student_id: Number(studentId),
    ...previewAsUserParam(),
  });
  if (error) {
    console.error('getMyStudentForTrainer error', error);
    return staffRpcFailure(error, status);
  }
  const rows = (data as Record<string, unknown>[] | null) || [];
  if (rows.length === 0) return { ok: false, reason: 'error', message: 'Something went wrong. Please try again.' };
  return { ok: true, student: mapTrainerStudentRow(rows[0]) };
}

/** Load impersonation rights from DB (cached auth may predate these columns). */
export async function fetchUserLoginRights(
  userId: number
): Promise<Pick<AppUser, 'can_login_as_student' | 'can_login_as_trainer'> | null> {
  if (!Number.isFinite(userId) || userId <= 0) return null;
  try {
    return await dedupeSupabaseRead(`skyline_users:login-rights:${userId}`, 60_000, async () => {
      const { data, error } = await supabase
        .from('skyline_users')
        .select('can_login_as_student, can_login_as_trainer')
        .eq('id', userId)
        .maybeSingle();
      if (error) {
        recordSupabaseError('skyline_users', error);
        return null;
      }
      if (!data) return null;
      const row = data as { can_login_as_student?: boolean | null; can_login_as_trainer?: boolean | null };
      return {
        can_login_as_student: Boolean(row.can_login_as_student),
        can_login_as_trainer: Boolean(row.can_login_as_trainer),
      };
    });
  } catch (e) {
    if (e instanceof SupabaseBackoffError) return null;
    throw e;
  }
}

/** Audit fields for created_by / updated_by (current user). Use for insert/update. */
function getAuditFields(): { created_by: number | null; updated_by: number | null } {
  const u = getEffectiveStoredUser();
  const id = u?.id ?? null;
  return { created_by: id, updated_by: id };
}

/** Request OTP for staff login. Uses Edge Function so OTP is created and email sent server-side (never exposed in network). */
export async function requestOtp(email: string): Promise<{ success: boolean; message: string }> {
  return requestOtpViaEdgeFunction(email.trim(), 'staff');
}

/** Login with OTP (no password). */
export async function loginWithOtp(email: string, otp: string): Promise<AppUser | null> {
  const { data, error } = await supabase.rpc('skyline_verify_otp_login', {
    p_email: email.trim(),
    p_otp: otp.trim(),
  });
  if (error) {
    console.error('loginWithOtp error', error);
    return null;
  }
  const rows = (data as Array<Record<string, unknown>>) || [];
  const row = rows[0];
  if (!row || !row.id) return null;
  setStaffSessionToken(row.session_token ? String(row.session_token) : null);
  return {
    id: Number(row.id),
    full_name: String(row.full_name ?? ''),
    email: String(row.email ?? ''),
    phone: row.phone ? String(row.phone) : null,
    status: row.status ? String(row.status) : null,
    role: (row.role as AppUserRole) ?? 'trainer',
    can_login_as_student: Boolean((row as { can_login_as_student?: unknown }).can_login_as_student),
    can_login_as_trainer: Boolean((row as { can_login_as_trainer?: unknown }).can_login_as_trainer),
    can_view_finance_reports: Boolean((row as { can_view_finance_reports?: unknown }).can_view_finance_reports),
  };
}

/**
 * Columns clients may read from skyline_users. password_hash is deliberately absent: anon/authenticated
 * have no SELECT on it, so select("*") on this table fails. Add new columns here AND grant SELECT on them.
 */
const STAFF_USER_COLUMNS =
  'id, full_name, email, phone, status, role, is_master, can_login_as_student, can_login_as_trainer, can_view_finance_reports, created_at, updated_at, updated_by';

function mapTrainerRow(row: Record<string, unknown>): Trainer {
  return {
    id: Number(row.id),
    full_name: String(row.full_name ?? ''),
    email: String(row.email ?? ''),
    phone: row.phone ? String(row.phone) : null,
    status: row.status ? String(row.status) : null,
    role: row.role ? String(row.role) : undefined,
    created_at: String(row.created_at ?? ''),
  };
}

function mapUserRow(row: Record<string, unknown>): UserRow {
  return {
    id: Number(row.id),
    full_name: String(row.full_name ?? ''),
    email: String(row.email ?? ''),
    phone: row.phone ? String(row.phone) : null,
    status: row.status ? String(row.status) : null,
    role: String(row.role ?? 'trainer'),
    can_login_as_student: Boolean(row.can_login_as_student),
    can_login_as_trainer: Boolean(row.can_login_as_trainer),
    can_view_finance_reports: Boolean(row.can_view_finance_reports),
    created_at: String(row.created_at ?? ''),
  };
}

export async function listTrainers(): Promise<Trainer[]> {
  const { data, error } = await supabase
    .from('skyline_users')
    .select(STAFF_USER_COLUMNS)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('listTrainers error', error);
    return [];
  }
  return ((data as Record<string, unknown>[]) || []).map(mapTrainerRow);
}

export async function listTrainersPaged(
  page = 1,
  pageSize = 20,
  search?: string
): Promise<PaginatedResult<Trainer>> {
  const res = await listUsersPaged(page, pageSize, search, undefined, undefined);
  return {
    data: res.data.map((u) => ({ id: u.id, full_name: u.full_name, email: u.email, phone: u.phone, status: u.status, created_at: u.created_at })),
    total: res.total,
    page: res.page,
    pageSize: res.pageSize,
  };
}

/** List users with optional role and status filters. Excludes master user. */
export async function listUsersPaged(
  page = 1,
  pageSize = 20,
  search?: string,
  roleFilter?: '' | 'superadmin' | 'admin' | 'trainer' | 'office',
  statusFilter?: '' | 'active' | 'inactive'
): Promise<PaginatedResult<UserRow>> {
  const from = Math.max(0, (page - 1) * pageSize);
  const to = from + pageSize - 1;
  let query = supabase
    .from('skyline_users')
    .select(STAFF_USER_COLUMNS, { count: 'exact' })
    .order('created_at', { ascending: false })
    .or('is_master.eq.false,is_master.is.null');
  if (roleFilter) query = query.eq('role', roleFilter);
  if (statusFilter) query = query.eq('status', statusFilter);
  const q = (search ?? '').trim();
  if (q) {
    const escaped = q.replace(/[%_,]/g, '');
    query = query.or(`full_name.ilike.%${escaped}%,email.ilike.%${escaped}%,phone.ilike.%${escaped}%`);
  }
  const { data, error, count } = await query.range(from, to);
  if (error) {
    console.error('listUsersPaged error', error);
    return { data: [], total: 0, page, pageSize };
  }
  return {
    data: ((data as Record<string, unknown>[]) || []).map(mapUserRow),
    total: Number(count ?? 0),
    page,
    pageSize,
  };
}

/** Users who can be assigned as batch trainers (role trainer or admin, active). Excludes master. */
export async function listUsersForBatchAssignment(): Promise<UserRow[]> {
  const { data, error } = await supabase
    .from('skyline_users')
    .select(STAFF_USER_COLUMNS)
    .in('role', ['trainer', 'admin', 'superadmin'])
    .eq('status', 'active')
    .or('is_master.eq.false,is_master.is.null')
    .order('full_name');
  if (error) {
    console.error('listUsersForBatchAssignment error', error);
    return [];
  }
  return ((data as Record<string, unknown>[]) || []).map(mapUserRow);
}

export async function listUsersForBatchAssignmentPaged(
  page = 1,
  pageSize = 20,
  search?: string
): Promise<PaginatedResult<UserRow>> {
  const from = Math.max(0, (page - 1) * pageSize);
  const to = from + pageSize - 1;
  let query = supabase
    .from('skyline_users')
    .select(STAFF_USER_COLUMNS, { count: 'exact' })
    .in('role', ['trainer', 'admin', 'superadmin'])
    .eq('status', 'active')
    .or('is_master.eq.false,is_master.is.null')
    .order('full_name');
  if (search && search.trim()) {
    query = query.or(`full_name.ilike.%${search.trim()}%,email.ilike.%${search.trim()}%`);
  }
  const { data, error, count } = await query.range(from, to);
  if (error) {
    console.error('listUsersForBatchAssignmentPaged error', error);
    return { data: [], total: 0, page, pageSize };
  }
  const mapped = ((data as Record<string, unknown>[]) || []).map(mapUserRow);
  return {
    data: mapped,
    total: Number(count ?? 0),
    page,
    pageSize,
  };
}

export async function createTrainer(input: CreateTrainerInput): Promise<Trainer | null> {
  const res = await createUser({ ...input, role: 'trainer' });
  if (!res.ok) return null;
  const u = res.user;
  return { id: u.id, full_name: u.full_name, email: u.email, phone: u.phone, status: u.status, created_at: u.created_at };
}

export async function updateTrainer(id: number, input: UpdateTrainerInput): Promise<Trainer | null> {
  const res = await updateUser(id, input);
  if (!res.ok) return null;
  const u = res.user;
  return { id: u.id, full_name: u.full_name, email: u.email, phone: u.phone, status: u.status, created_at: u.created_at };
}

export type UpdateUserInput = Partial<CreateUserInput>;

export type SaveUserResult = { ok: true; user: UserRow } | StaffRpcFailure;

/**
 * Create a staff user. The server checks the caller's session token: admin or super admin
 * only, and only a super admin may create admin / super admin accounts.
 */
export async function createUser(input: CreateUserInput): Promise<SaveUserResult> {
  const token = getStaffSessionToken();
  if (!token) return STAFF_SESSION_MISSING;
  const { data, error, status } = await supabase.rpc('skyline_admin_create_user', {
    p_token: token,
    p_full_name: input.full_name.trim(),
    p_email: input.email.trim(),
    p_phone: input.phone?.trim() || null,
    p_status: input.status?.trim() || 'active',
    p_role: input.role,
  });
  if (error) {
    console.error('createUser error', error);
    return staffRpcFailure(error, status);
  }
  const rows = (data as Record<string, unknown>[] | null) || [];
  if (rows.length === 0) return { ok: false, reason: 'error', message: 'Something went wrong. Please try again.' };
  return { ok: true, user: mapUserRow(rows[0]) };
}

/**
 * Update a staff user. Only the fields present in `input` are sent. The server checks the
 * caller's session token; changing role or any can_* right needs a super admin.
 */
export async function updateUser(id: number, input: UpdateUserInput): Promise<SaveUserResult> {
  const token = getStaffSessionToken();
  if (!token) return STAFF_SESSION_MISSING;
  const changes: Record<string, unknown> = {};
  if (input.full_name !== undefined) changes.full_name = input.full_name.trim();
  if (input.email !== undefined) changes.email = input.email.trim();
  if (input.phone !== undefined) changes.phone = input.phone?.trim() || null;
  if (input.status !== undefined) changes.status = input.status?.trim() || 'active';
  if (input.role !== undefined) changes.role = input.role;
  if (input.can_login_as_student !== undefined) changes.can_login_as_student = Boolean(input.can_login_as_student);
  if (input.can_login_as_trainer !== undefined) changes.can_login_as_trainer = Boolean(input.can_login_as_trainer);
  if (input.can_view_finance_reports !== undefined) {
    changes.can_view_finance_reports = Boolean(input.can_view_finance_reports);
  }
  const { data, error, status } = await supabase.rpc('skyline_admin_update_user', {
    p_token: token,
    p_user_id: Number(id),
    p_changes: changes,
  });
  if (error) {
    console.error('updateUser error', error);
    return staffRpcFailure(error, status);
  }
  const rows = (data as Record<string, unknown>[] | null) || [];
  if (rows.length === 0) return { ok: false, reason: 'error', message: 'Something went wrong. Please try again.' };
  return { ok: true, user: mapUserRow(rows[0]) };
}

export interface Batch {
  id: number;
  name: string;
  /** Primary trainer (notifications default, legacy column). */
  trainer_id: number;
  trainer_name: string | null;
  /** All assigned trainers (primary first). */
  trainer_ids?: number[];
  trainer_names?: string[];
  course_id: number | null;
  course_name: string | null;
  created_at: string;
  /** Admin-only switch: assigned trainers may use "Login as student" for this batch's students. */
  allow_trainer_student_login?: boolean;
}

/** Comma-separated trainer names for batch directory UI. */
export function formatBatchTrainersLabel(batch: Pick<Batch, 'trainer_name' | 'trainer_names' | 'trainer_id'>): string {
  const names = (batch.trainer_names ?? []).map((n) => String(n ?? '').trim()).filter(Boolean);
  if (names.length > 0) return names.join(', ');
  if (batch.trainer_name?.trim()) return batch.trainer_name.trim();
  return `ID: ${batch.trainer_id}`;
}

export function batchIncludesTrainer(
  batch: Pick<Batch, 'trainer_id' | 'trainer_ids'>,
  trainerUserId: number
): boolean {
  const uid = Number(trainerUserId);
  if (!Number.isFinite(uid) || uid <= 0) return false;
  if (Number(batch.trainer_id) === uid) return true;
  return (batch.trainer_ids ?? []).some((id) => Number(id) === uid);
}

/** Batch ids where user is primary or additional trainer. */
export async function fetchBatchIdsForTrainer(userId: number): Promise<number[]> {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return [];
  const ids = new Set<number>();
  const { data: primaryRows, error: primaryErr } = await supabase.from('skyline_batches').select('id').eq('trainer_id', uid);
  if (primaryErr) console.error('fetchBatchIdsForTrainer primary error', primaryErr);
  for (const r of (primaryRows as { id: number }[] | null) || []) {
    const id = Number(r.id);
    if (Number.isFinite(id) && id > 0) ids.add(id);
  }
  const { data: extraRows, error: extraErr } = await supabase
    .from('skyline_batch_trainers')
    .select('batch_id')
    .eq('user_id', uid);
  if (extraErr) {
    // Table may not exist until migration is applied — primary-only fallback.
    if (!String(extraErr.message ?? '').toLowerCase().includes('skyline_batch_trainers')) {
      console.error('fetchBatchIdsForTrainer junction error', extraErr);
    }
    return [...ids];
  }
  for (const r of (extraRows as { batch_id: number }[] | null) || []) {
    const id = Number(r.batch_id);
    if (Number.isFinite(id) && id > 0) ids.add(id);
  }
  return [...ids];
}

export async function fetchBatchTrainerIds(batchId: number): Promise<number[]> {
  const bid = Number(batchId);
  if (!Number.isFinite(bid) || bid <= 0) return [];
  const { data: links, error } = await supabase
    .from('skyline_batch_trainers')
    .select('user_id')
    .eq('batch_id', bid);
  if (error) {
    if (!String(error.message ?? '').toLowerCase().includes('skyline_batch_trainers')) {
      console.error('fetchBatchTrainerIds error', error);
    }
    const batch = await getBatchById(bid);
    return batch ? [batch.trainer_id] : [];
  }
  const ids = ((links as { user_id: number }[] | null) || [])
    .map((r) => Number(r.user_id))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (ids.length > 0) return [...new Set(ids)];
  const batch = await getBatchById(bid);
  return batch ? [batch.trainer_id] : [];
}

async function syncBatchTrainers(batchId: number, trainerIds: number[]): Promise<boolean> {
  const bid = Number(batchId);
  const ids = [...new Set(trainerIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))];
  if (!Number.isFinite(bid) || bid <= 0 || ids.length === 0) return false;
  const { error: delErr } = await supabase.from('skyline_batch_trainers').delete().eq('batch_id', bid);
  if (delErr) {
    console.error('syncBatchTrainers delete error', delErr);
    return false;
  }
  const rows = ids.map((user_id) => ({ batch_id: bid, user_id }));
  const { error: insErr } = await supabase.from('skyline_batch_trainers').insert(rows);
  if (insErr) {
    console.error('syncBatchTrainers insert error', insErr);
    return false;
  }
  return true;
}

async function hydrateBatchRows(rows: Record<string, unknown>[]): Promise<Batch[]> {
  if (rows.length === 0) return [];
  const batchIds = rows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0);
  const trainerIdsFromRows = [...new Set(rows.map((r) => Number(r.trainer_id)).filter((n) => Number.isFinite(n) && n > 0))];
  const junctionByBatch = new Map<number, number[]>();
  if (batchIds.length > 0) {
    const { data: links, error: linkErr } = await supabase
      .from('skyline_batch_trainers')
      .select('batch_id, user_id')
      .in('batch_id', batchIds);
    if (linkErr && !String(linkErr.message ?? '').toLowerCase().includes('skyline_batch_trainers')) {
      console.error('hydrateBatchRows junction error', linkErr);
    } else {
      for (const link of (links as { batch_id: number; user_id: number }[] | null) || []) {
        const bid = Number(link.batch_id);
        const uid = Number(link.user_id);
        if (!Number.isFinite(bid) || bid <= 0 || !Number.isFinite(uid) || uid <= 0) continue;
        if (!junctionByBatch.has(bid)) junctionByBatch.set(bid, []);
        junctionByBatch.get(bid)!.push(uid);
      }
    }
  }
  const allTrainerIds = new Set<number>(trainerIdsFromRows);
  for (const ids of junctionByBatch.values()) ids.forEach((id) => allTrainerIds.add(id));
  const trainerMap = new Map<number, string>();
  if (allTrainerIds.size > 0) {
    const { data: trainers } = await supabase
      .from('skyline_users')
      .select('id, full_name')
      .in('id', [...allTrainerIds]);
    for (const t of (trainers as { id: number; full_name: string }[] | null) || []) {
      trainerMap.set(Number(t.id), t.full_name ?? '');
    }
  }
  const courseIds = [
    ...new Set(
      rows
        .map((r) => (r.course_id != null ? Number(r.course_id) : null))
        .filter((x): x is number => x != null && Number.isFinite(x))
    ),
  ];
  const courseMap = new Map<number, string>();
  if (courseIds.length > 0) {
    const { data: courses } = await supabase.from('skyline_courses').select('id, name').in('id', courseIds);
    for (const c of (courses as { id: number; name: string }[] | null) || []) {
      courseMap.set(Number(c.id), c.name ?? '');
    }
  }
  return rows.map((r) => {
    const bid = Number(r.id);
    const primaryId = Number(r.trainer_id);
    let trainerIds = junctionByBatch.get(bid) ?? [];
    if (trainerIds.length === 0 && Number.isFinite(primaryId) && primaryId > 0) trainerIds = [primaryId];
    else if (Number.isFinite(primaryId) && primaryId > 0 && !trainerIds.includes(primaryId)) {
      trainerIds = [primaryId, ...trainerIds.filter((id) => id !== primaryId)];
    }
    const trainerNames = trainerIds.map((id) => trainerMap.get(id) ?? '').filter(Boolean);
    const batch = mapBatchRow(
      r,
      trainerMap.get(primaryId) ?? null,
      r.course_id != null ? (courseMap.get(Number(r.course_id)) ?? null) : null
    );
    return {
      ...batch,
      trainer_ids: trainerIds,
      trainer_names: trainerNames,
    };
  });
}

export interface Student {
  id: number;
  student_id: string | null;
  name: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  phone: string | null;
  batch_id: number | null;
  batch_name: string | null;
  date_of_birth: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  guardian_name: string | null;
  guardian_phone: string | null;
  notes: string | null;
  status: string | null;
  created_at: string;
}

function mapStudentRow(row: Record<string, unknown>): Student {
  const first = String(row.first_name ?? '').trim();
  const last = String(row.last_name ?? '').trim();
  const displayName = String(row.name ?? '').trim() || [first, last].filter(Boolean).join(' ').trim();
  return {
    id: Number(row.id),
    student_id: row.student_id ? String(row.student_id) : null,
    name: displayName,
    first_name: first || null,
    last_name: last || null,
    email: String(row.email ?? ''),
    phone: row.phone ? String(row.phone) : null,
    batch_id: row.batch_id != null ? Number(row.batch_id) : null,
    batch_name: row.batch_name != null ? String(row.batch_name) : null,
    date_of_birth: row.date_of_birth ? String(row.date_of_birth) : null,
    address_line_1: row.address_line_1 ? String(row.address_line_1) : null,
    address_line_2: row.address_line_2 ? String(row.address_line_2) : null,
    city: row.city ? String(row.city) : null,
    state: row.state ? String(row.state) : null,
    postal_code: row.postal_code ? String(row.postal_code) : null,
    country: row.country ? String(row.country) : null,
    guardian_name: row.guardian_name ? String(row.guardian_name) : null,
    guardian_phone: row.guardian_phone ? String(row.guardian_phone) : null,
    notes: row.notes ? String(row.notes) : null,
    status: row.status ? String(row.status) : null,
    created_at: String(row.created_at ?? ''),
  } as Student;
}

export interface SubmittedInstanceRow {
  id: number;
  form_id: number;
  form_name: string;
  form_version: string | null;
  /** Unit of competency code from skyline_forms (when loaded). */
  form_unit_code?: string | null;
  /** Unit of competency title from skyline_forms (when loaded). */
  form_unit_name?: string | null;
  student_id: number | null;
  student_name: string;
  student_email: string;
  status: string;
  role_context: string;
  workflow_status?: string | null;
  created_at: string;
  submitted_at: string | null;
  submission_count: number;
  start_date: string | null;
  end_date: string | null;
  /** Optional admin-granted later deadline (never earlier than end_date). Deadline = COALESCE(extension_date, end_date). */
  extension_date?: string | null;
  no_attempt_rollovers?: number | null;
  did_not_attempt?: boolean | null;
  /** Number of persisted student answers returned with dashboard rows. */
  answer_count?: number;
  /** Final trainer outcomes, ordered by attempt. */
  attempt_results?: AttemptResult[];
  /** Latest non-null final trainer outcome. */
  trainer_result?: AttemptResult;
  /** True when any trainer marking row or final trainer outcome exists. */
  trainer_assessment_exists?: boolean;
  /** Final office/admin approval inferred from workflow and office checks. */
  office_assessment_completed?: boolean;
  /** Course IDs this form is linked to (via `skyline_course_forms`). Filled for list queries that need trainer course highlight. */
  form_course_ids?: number[];
  /** True if the link for this role is revoked or past expiry (show Enable); false = active (show Expire) */
  link_expired: boolean;
  /** Student batch (when available for dashboards). */
  batch_id?: number | null;
  batch_name?: string | null;
  /** Trainer assigned to student's batch (when available). */
  trainer_name?: string | null;
}

/** Batch-attach `form_course_ids` for assessment directory / dashboards. */
async function withFormCourseIds<T extends SubmittedInstanceRow>(rows: T[]): Promise<T[]> {
  const formIds = [...new Set(rows.map((r) => r.form_id).filter((n) => Number.isFinite(n) && n > 0))];
  if (formIds.length === 0) return rows;
  const { data, error } = await supabase.from('skyline_course_forms').select('form_id, course_id').in('form_id', formIds);
  if (error) {
    console.error('withFormCourseIds error', error);
    return rows;
  }
  const byForm = new Map<number, number[]>();
  for (const row of (data as { form_id: number; course_id: number }[] | null) || []) {
    const fid = Number(row.form_id);
    const cid = Number(row.course_id);
    if (!Number.isFinite(fid) || fid <= 0) continue;
    if (!byForm.has(fid)) byForm.set(fid, []);
    if (Number.isFinite(cid) && cid > 0) byForm.get(fid)!.push(cid);
  }
  return rows.map((r) => ({
    ...r,
    form_course_ids: [...new Set(byForm.get(r.form_id) ?? [])],
  }));
}

/**
 * Batch-attach `extension_date` to instance rows (the paged RPCs / mixed selects do not return it).
 * Degrades to "no extension" if the lookup fails (e.g. before the extension_date migration has been applied).
 */
async function withExtensionDates<T extends SubmittedInstanceRow>(rows: T[]): Promise<T[]> {
  const ids = [...new Set(rows.map((r) => r.id).filter((n) => Number.isFinite(n) && n > 0))];
  if (ids.length === 0) return rows;
  const byId = new Map<number, string | null>();
  for (let i = 0; i < ids.length; i += 500) {
    const { data, error } = await supabase
      .from('skyline_form_instances')
      .select('id, extension_date')
      .in('id', ids.slice(i, i + 500));
    if (error) {
      console.error('withExtensionDates error', error);
      return rows;
    }
    for (const r of (data as { id: number; extension_date: string | null }[] | null) || []) {
      byId.set(Number(r.id), r.extension_date ? String(r.extension_date) : null);
    }
  }
  return rows.map((r) => ({ ...r, extension_date: byId.get(r.id) ?? null }));
}

export interface AdminDashboardStatsV2 {
  totals: { assessments: number; students: number; trainers: number; admins: number };
  workflow: { awaiting_student: number; awaiting_trainer: number; awaiting_office: number; completed: number };
}

export async function getAdminDashboardStatsV2(
  input: {
    fromDate?: string | null;
    toDate?: string | null;
    status: 'all' | 'awaiting_student' | 'awaiting_trainer' | 'awaiting_office' | 'completed';
    batchId?: number | null;
  },
  options?: { forceRefresh?: boolean }
): Promise<{ ok: true; stats: AdminDashboardStatsV2 } | { ok: false; error: string }> {
  const bid =
    input.batchId != null && Number.isFinite(Number(input.batchId)) && Number(input.batchId) > 0 ? Number(input.batchId) : null;
  const cacheKey = `skyline_admin_dashboard_stats_v2:${input.fromDate ?? ''}:${input.toDate ?? ''}:${input.status}:${bid ?? ''}`;
  try {
    return await dedupeSupabaseRead(
      cacheKey,
      60_000,
      async () => {
        const { data, error } = await supabase.rpc('skyline_admin_dashboard_stats_v2', {
          p_from_date: input.fromDate && /^\d{4}-\d{2}-\d{2}$/.test(String(input.fromDate)) ? String(input.fromDate) : null,
          p_to_date: input.toDate && /^\d{4}-\d{2}-\d{2}$/.test(String(input.toDate)) ? String(input.toDate) : null,
          p_status: input.status,
          p_batch_id: bid,
        });
        if (error) {
          recordSupabaseError('skyline_admin_dashboard_stats_v2', error);
          return { ok: false as const, error: error.message };
        }
        const raw = data as { ok?: boolean; totals?: unknown; workflow?: unknown } | null;
        if (!raw || raw.ok !== true) return { ok: false as const, error: 'Failed to load dashboard stats' };
        const totals = raw.totals as { assessments?: unknown; students?: unknown; trainers?: unknown; admins?: unknown } | undefined;
        const workflow = raw.workflow as { awaiting_student?: unknown; awaiting_trainer?: unknown; awaiting_office?: unknown; completed?: unknown } | undefined;
        return {
          ok: true as const,
          stats: {
            totals: {
              assessments: Number(totals?.assessments ?? 0) || 0,
              students: Number(totals?.students ?? 0) || 0,
              trainers: Number(totals?.trainers ?? 0) || 0,
              admins: Number(totals?.admins ?? 0) || 0,
            },
            workflow: {
              awaiting_student: Number(workflow?.awaiting_student ?? 0) || 0,
              awaiting_trainer: Number(workflow?.awaiting_trainer ?? 0) || 0,
              awaiting_office: Number(workflow?.awaiting_office ?? 0) || 0,
              completed: Number(workflow?.completed ?? 0) || 0,
            },
          },
        };
      },
      { skipCache: options?.forceRefresh }
    );
  } catch (e) {
    if (e instanceof SupabaseBackoffError) {
      return { ok: false, error: 'Dashboard temporarily unavailable. Try again in a few minutes.' };
    }
    throw e;
  }
}

export async function listAdminDashboardInstancesPaged(
  page = 1,
  pageSize = 20,
  status: 'all' | 'awaiting_student' | 'awaiting_trainer' | 'awaiting_office' | 'completed',
  fromDate?: string | null,
  toDate?: string | null,
  batchId?: number | null,
  options?: { forceRefresh?: boolean }
): Promise<PaginatedResult<SubmittedInstanceRow>> {
  const bid = batchId != null && Number.isFinite(Number(batchId)) && Number(batchId) > 0 ? Number(batchId) : null;
  const cacheKey = `skyline_admin_dashboard_instances_paged:${page}:${pageSize}:${status}:${fromDate ?? ''}:${toDate ?? ''}:${bid ?? ''}`;
  try {
    return await dedupeSupabaseRead(
      cacheKey,
      60_000,
      async () => {
        const { data, error } = await supabase.rpc('skyline_admin_dashboard_instances_paged', {
          p_page: page,
          p_page_size: pageSize,
          p_status: status,
          p_from_date: fromDate && /^\d{4}-\d{2}-\d{2}$/.test(String(fromDate)) ? String(fromDate) : null,
          p_to_date: toDate && /^\d{4}-\d{2}-\d{2}$/.test(String(toDate)) ? String(toDate) : null,
          p_batch_id: bid,
        });
        if (error) {
          recordSupabaseError('skyline_admin_dashboard_instances_paged', error);
          return { data: [], total: 0, page, pageSize };
        }
        return mapAdminDashboardInstancesPaged(data, page, pageSize);
      },
      { skipCache: options?.forceRefresh }
    );
  } catch (e) {
    if (e instanceof SupabaseBackoffError) {
      return { data: [], total: 0, page, pageSize };
    }
    throw e;
  }
}

async function mapAdminDashboardInstancesPaged(
  data: unknown,
  page: number,
  pageSize: number
): Promise<PaginatedResult<SubmittedInstanceRow>> {
  const rowsRaw =
    (data as Array<{
      id: number;
      form_id: number;
      form_name: string | null;
      form_version: string | null;
      student_id: number | null;
      student_name: string | null;
      student_email: string | null;
      status: string | null;
      role_context: string | null;
      start_date: string | null;
      end_date: string | null;
      created_at: string | null;
      batch_id?: number | null;
      batch_name?: string | null;
      trainer_name?: string | null;
      total_count: number | null;
    }> | null) || [];
  const total = rowsRaw.length > 0 ? Number(rowsRaw[0].total_count ?? rowsRaw.length) : 0;
  // No token lookup needed for admin dashboard list; link controls live in assessments directory.
  return {
    data: await withExtensionDates(rowsRaw.map((r) => ({
      id: Number(r.id),
      form_id: Number(r.form_id),
      form_name: String(r.form_name ?? ''),
      form_version: r.form_version != null ? String(r.form_version) : null,
      student_id: r.student_id == null ? null : Number(r.student_id),
      student_name: String(r.student_name ?? 'Unknown student'),
      student_email: String(r.student_email ?? ''),
      status: String(r.status ?? 'draft'),
      role_context: String(r.role_context ?? 'student'),
      created_at: String(r.created_at ?? ''),
      submitted_at: null,
      submission_count: 0,
      start_date: r.start_date ? String(r.start_date) : null,
      end_date: r.end_date ? String(r.end_date) : null,
      batch_id: r.batch_id != null ? Number(r.batch_id) : null,
      batch_name: r.batch_name != null ? String(r.batch_name) : null,
      trainer_name: r.trainer_name != null ? String(r.trainer_name) : null,
      link_expired: false,
    }))),
    total: Number.isFinite(total) ? total : 0,
    page,
    pageSize,
  };
}

export async function listStudentsInBatch(batchId: number): Promise<Student[]> {
  const { data, error } = await supabase
    .from('skyline_students')
    .select('*, skyline_batches(name)')
    .eq('batch_id', batchId)
    .eq('status', 'active')
    .order('name');
  if (error) {
    console.error('listStudentsInBatch error', error);
    return [];
  }
  return ((data as Record<string, unknown>[]) || []).map((r) => {
    const batch = r.skyline_batches as { name?: string } | null;
    return mapStudentRow({ ...r, batch_name: batch?.name ?? null });
  });
}

export async function listStudents(): Promise<Student[]> {
  const { data, error } = await supabase
    .from('skyline_students')
    .select('*, skyline_batches(name)')
    .or('status.is.null,status.eq.active')
    .order('created_at', { ascending: false });
  if (error) {
    console.error('listStudents error', error);
    return [];
  }
  return ((data as Record<string, unknown>[]) || []).map((r) => {
    const batch = r.skyline_batches as { name?: string } | null;
    return mapStudentRow({ ...r, batch_name: batch?.name ?? null });
  });
}

export async function listStudentsPaged(
  page = 1,
  pageSize = 20,
  search?: string,
  statusFilter?: '' | 'active' | 'inactive',
  filters?: { batchId?: number | null; courseIds?: number[] }
): Promise<PaginatedResult<Student>> {
  const from = Math.max(0, (page - 1) * pageSize);
  const to = from + pageSize - 1;
  let query = supabase.from('skyline_students').select('*, skyline_batches(name)', { count: 'exact' });
  // All / unset: no status filter. Active: non-inactive (null or active). Inactive: inactive only.
  if (statusFilter === 'inactive') {
    query = query.eq('status', 'inactive');
  } else if (statusFilter === 'active') {
    query = query.or('status.is.null,status.eq.active');
  }
  const batchId = filters?.batchId != null ? Number(filters.batchId) : null;
  if (batchId != null && Number.isFinite(batchId) && batchId > 0) {
    query = query.eq('batch_id', batchId);
  }
  const courseIds = (filters?.courseIds || [])
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (courseIds.length > 0) {
    const { data: scRows, error: scErr } = await supabase
      .from('skyline_student_courses')
      .select('student_id')
      .in('course_id', courseIds)
      .eq('status', 'active');
    if (scErr) {
      console.error('listStudentsPaged course filter error', scErr);
      return { data: [], total: 0, page, pageSize };
    }
    const sIds = ((scRows as Array<{ student_id: number }> | null) || [])
      .map((r) => Number(r.student_id))
      .filter((n) => Number.isFinite(n) && n > 0);
    const uniq = Array.from(new Set(sIds));
    if (uniq.length === 0) return { data: [], total: 0, page, pageSize };
    query = query.in('id', uniq);
  }
  const q = (search ?? '').trim();
  if (q) {
    const escaped = q.replace(/[%_,]/g, '');
    const conditions: string[] = [
      `student_id.ilike.%${escaped}%`,
      `first_name.ilike.%${escaped}%`,
      `last_name.ilike.%${escaped}%`,
      `name.ilike.%${escaped}%`,
      `email.ilike.%${escaped}%`,
      `phone.ilike.%${escaped}%`,
      `city.ilike.%${escaped}%`,
    ];

    // Batch name match → student.batch_id.in(...)
    const { data: batchRows } = await supabase
      .from('skyline_batches')
      .select('id')
      .ilike('name', `%${escaped}%`);
    const batchIds = ((batchRows as Array<{ id: number }> | null) || [])
      .map((b) => Number(b.id))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (batchIds.length > 0) conditions.push(`batch_id.in.(${batchIds.join(',')})`);

    // Course name / qualification code match → skyline_student_courses → student ids → id.in(...)
    const { data: courseRows } = await supabase
      .from('skyline_courses')
      .select('id')
      .or(`name.ilike.%${escaped}%,qualification_code.ilike.%${escaped}%`);
    const courseIds = ((courseRows as Array<{ id: number }> | null) || [])
      .map((c) => Number(c.id))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (courseIds.length > 0) {
      const { data: scRows } = await supabase
        .from('skyline_student_courses')
        .select('student_id')
        .in('course_id', courseIds)
        .eq('status', 'active');
      const sIds = ((scRows as Array<{ student_id: number }> | null) || [])
        .map((r) => Number(r.student_id))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (sIds.length > 0) conditions.push(`id.in.(${Array.from(new Set(sIds)).join(',')})`);
    }

    query = query.or(conditions.join(','));
  }
  query = query.order('created_at', { ascending: false }).order('id', { ascending: false });
  const { data, error, count } = await query.range(from, to);
  if (error) {
    console.error('listStudentsPaged error', error);
    return { data: [], total: 0, page, pageSize };
  }
  const rows = (data as Record<string, unknown>[]) || [];
  const mapped = rows.map((r) => {
    const batch = r.skyline_batches as { name?: string } | null;
    return mapStudentRow({
      ...r,
      batch_name: batch?.name ?? null,
    });
  });
  return {
    data: mapped,
    total: Number(count ?? 0),
    page,
    pageSize,
  };
}

export async function getStudentsByEmails(emails: string[]): Promise<Student[]> {
  const cleaned = Array.from(
    new Set(
      (emails || [])
        .map((e) => String(e ?? '').trim().toLowerCase())
        .filter(Boolean)
    )
  );
  if (cleaned.length === 0) return [];
  const out: Student[] = [];
  const chunkSize = 200;
  for (let i = 0; i < cleaned.length; i += chunkSize) {
    const chunk = cleaned.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from('skyline_students')
      .select('*, skyline_batches(name)')
      .in('email', chunk);
    if (error) {
      console.error('getStudentsByEmails error', error);
      continue;
    }
    const rows = ((data as Record<string, unknown>[]) || []).map((r) => {
      const batch = r.skyline_batches as { name?: string } | null;
      return mapStudentRow({ ...r, batch_name: batch?.name ?? null });
    });
    out.push(...rows);
  }
  return out;
}

export async function getStudentsByStudentIds(studentIds: string[]): Promise<Student[]> {
  const cleaned = Array.from(
    new Set(
      (studentIds || [])
        .map((id) => String(id ?? '').trim())
        .filter(Boolean)
    )
  );
  if (cleaned.length === 0) return [];
  const out: Student[] = [];
  const chunkSize = 200;
  for (let i = 0; i < cleaned.length; i += chunkSize) {
    const chunk = cleaned.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from('skyline_students')
      .select('*, skyline_batches(name)')
      .in('student_id', chunk);
    if (error) {
      console.error('getStudentsByStudentIds error', error);
      continue;
    }
    const rows = ((data as Record<string, unknown>[]) || []).map((r) => {
      const batch = r.skyline_batches as { name?: string } | null;
      return mapStudentRow({ ...r, batch_name: batch?.name ?? null });
    });
    out.push(...rows);
  }
  return out;
}

export async function getActiveCourseIdsForStudent(studentId: number): Promise<number[]> {
  const sid = Number(studentId);
  if (!Number.isFinite(sid) || sid <= 0) return [];
  const { data, error } = await supabase
    .from('skyline_student_courses')
    .select('course_id')
    .eq('student_id', sid)
    .eq('status', 'active');
  if (error) {
    console.error('getActiveCourseIdsForStudent error', error);
    return [];
  }
  return ((data as Array<{ course_id: number }> | null) || [])
    .map((r) => Number(r.course_id))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export async function listSubmittedInstances(): Promise<SubmittedInstanceRow[]> {
  const { data: instances, error } = await supabase
    .from('skyline_form_instances')
    .select('id, form_id, student_id, status, role_context, created_at, submitted_at, submission_count')
    .not('student_id', 'is', null)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('listSubmittedInstances error', error);
    return [];
  }

  const rows = (instances as Array<Record<string, unknown>>) || [];
  const instanceIds = rows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0);
  const formIds = Array.from(new Set(rows.map((r) => Number(r.form_id)).filter((n) => Number.isFinite(n) && n > 0)));
  const studentIds = Array.from(new Set(rows.map((r) => Number(r.student_id)).filter((n) => Number.isFinite(n) && n > 0)));

  const now = Date.now();
  const tokenMap = new Map<string, boolean>();
  if (instanceIds.length > 0) {
    const { data: tokens } = await supabase
      .from('skyline_instance_access_tokens')
      .select('instance_id, role_context, expires_at, revoked_at')
      .in('instance_id', instanceIds);
    for (const t of (tokens as Array<{ instance_id: number; role_context: string; expires_at: string; revoked_at: string | null }>) || []) {
      const key = `${t.instance_id}:${t.role_context}`;
      const valid = t.revoked_at == null && t.expires_at && new Date(t.expires_at).getTime() > now;
      if (valid) tokenMap.set(key, false);
      else if (!tokenMap.has(key)) tokenMap.set(key, true);
    }
  }

  const formMap = new Map<number, { name: string; version: string | null }>();
  if (formIds.length > 0) {
    const { data: forms } = await supabase.from('skyline_forms').select('id, name, version').in('id', formIds);
    for (const f of (forms as Array<Record<string, unknown>>) || []) {
      formMap.set(Number(f.id), {
        name: String(f.name ?? ''),
        version: f.version ? String(f.version) : null,
      });
    }
  }

  const studentMap = new Map<number, { name: string; email: string }>();
  if (studentIds.length > 0) {
    const { data: students } = await supabase
      .from('skyline_students')
      .select('id, name, first_name, last_name, email')
      .in('id', studentIds);
    for (const s of (students as Array<Record<string, unknown>>) || []) {
      const first = String(s.first_name ?? '').trim();
      const last = String(s.last_name ?? '').trim();
      const name = [first, last].filter(Boolean).join(' ').trim() || String(s.name ?? '');
      studentMap.set(Number(s.id), { name, email: String(s.email ?? '') });
    }
  }

  return rows.map((r) => {
    const formId = Number(r.form_id);
    const studentIdRaw = r.student_id;
    const studentId = studentIdRaw == null ? null : Number(studentIdRaw);
    const form = formMap.get(formId);
    const student = studentId != null ? studentMap.get(studentId) : undefined;
    const roleCtx = String(r.role_context ?? 'student');
    const link_expired = tokenMap.get(`${Number(r.id)}:${roleCtx}`) !== false;
    return {
      id: Number(r.id),
      form_id: formId,
      form_name: form?.name || `Form #${formId}`,
      form_version: form?.version ?? null,
      student_id: studentId,
      student_name: student?.name || 'Unknown student',
      student_email: student?.email || '',
      status: String(r.status ?? 'draft'),
      role_context: roleCtx,
      created_at: String(r.created_at ?? ''),
      submitted_at: r.submitted_at ? String(r.submitted_at) : null,
      submission_count: Number(r.submission_count ?? 0) || 0,
      start_date: r.start_date ? String(r.start_date) : null,
      end_date: r.end_date ? String(r.end_date) : null,
      link_expired,
    };
  });
}

/** yyyy-MM-dd; instance start <= day and (end is null or end >= day). */
export async function listFormIdsForCourseActiveOn(courseId: number, activeOnIso: string): Promise<number[]> {
  const cid = Number(courseId);
  const d = (activeOnIso ?? '').trim();
  if (!Number.isFinite(cid) || cid <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return [];
  const { data, error } = await supabase.rpc('skyline_form_ids_for_course_active_on', {
    p_course_id: cid,
    p_on: d,
  });
  if (error) {
    console.error('listFormIdsForCourseActiveOn error', error);
    return [];
  }
  if (Array.isArray(data)) return (data as unknown[]).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
  return [];
}

export type AssessmentDirectoryWorkflowFilter =
  | 'all'
  | 'awaiting_student'
  | 'awaiting_trainer'
  | 'awaiting_office'
  | 'did_not_attempt'
  | 'completed';

export async function listSubmittedInstancesPaged(
  page = 1,
  pageSize = 20,
  search?: string,
  courseId?: number,
  formId?: number,
  studentId?: number,
  sort?: { key: 'created' | 'student' | 'form' | 'start' | 'end' | 'workflow'; dir: 'asc' | 'desc' },
  activeOnIso?: string | null,
  workflowStatus?: AssessmentDirectoryWorkflowFilter | null,
  startFromIso?: string | null,
  endDateToIso?: string | null,
  batchId?: number | null
): Promise<PaginatedResult<SubmittedInstanceRow>> {
  const active =
    activeOnIso && /^\d{4}-\d{2}-\d{2}$/.test(String(activeOnIso).trim()) ? String(activeOnIso).trim() : null;
  const startFrom =
    startFromIso && /^\d{4}-\d{2}-\d{2}$/.test(String(startFromIso).trim()) ? String(startFromIso).trim() : null;
  const endDateTo =
    endDateToIso && /^\d{4}-\d{2}-\d{2}$/.test(String(endDateToIso).trim()) ? String(endDateToIso).trim() : null;
  const wf = workflowStatus && workflowStatus !== 'all' ? workflowStatus : null;
  // Pass the raw search string. The RPC parses Student ID + Unit Code (AND) itself so
  // Admin Directory works even when PostgREST has a stale schema cache for extra args.
  const rawSearch = (search ?? '').trim() || null;
  const { data, error } = await supabase.rpc('skyline_list_submitted_instances_paged', {
    p_page: page,
    p_page_size: pageSize,
    p_search: rawSearch,
    p_course_id: Number.isFinite(Number(courseId)) && Number(courseId) > 0 ? Number(courseId) : null,
    p_form_id: Number.isFinite(Number(formId)) && Number(formId) > 0 ? Number(formId) : null,
    p_student_id: Number.isFinite(Number(studentId)) && Number(studentId) > 0 ? Number(studentId) : null,
    p_active_on: active,
    p_workflow_status: wf,
    p_start_from: startFrom,
    p_end_date_to: endDateTo,
    p_sort_key: sort?.key ?? 'created',
    p_sort_dir: sort?.dir ?? 'desc',
    p_batch_id: Number.isFinite(Number(batchId)) && Number(batchId) > 0 ? Number(batchId) : null,
  });
  if (error) {
    console.error('skyline_list_submitted_instances_paged rpc error', error);
    return { data: [], total: 0, page, pageSize };
  }

  const rowsRaw =
    (data as Array<{
      id: number;
      form_id: number;
      form_name: string | null;
      form_version: string | null;
      student_id: number | null;
      student_name: string | null;
      student_email: string | null;
      status: string | null;
      role_context: string | null;
      created_at: string | null;
      submitted_at: string | null;
      submission_count: number | null;
      start_date: string | null;
      end_date: string | null;
      total_count: number | null;
    }> | null) || [];

  const total = rowsRaw.length > 0 ? Number(rowsRaw[0].total_count ?? rowsRaw.length) : 0;
  const instanceIds = rowsRaw.map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0);

  const instanceStateMap = new Map<
    number,
    {
      status: string | null;
      role_context: string | null;
      workflow_status: string | null;
      no_attempt_rollovers: number | null;
      did_not_attempt: boolean | null;
    }
  >();
  if (instanceIds.length > 0) {
    const { data: instanceStates, error: stateError } = await supabase
      .from('skyline_form_instances')
      .select('id, status, role_context, workflow_status, no_attempt_rollovers, did_not_attempt')
      .in('id', instanceIds);
    if (stateError) {
      console.error('assessment directory instance state read error', stateError);
    } else {
      for (const state of instanceStates ?? []) {
        instanceStateMap.set(Number(state.id), {
          status: state.status,
          role_context: state.role_context,
          workflow_status: state.workflow_status,
          no_attempt_rollovers: state.no_attempt_rollovers,
          did_not_attempt: state.did_not_attempt,
        });
      }
    }
  }

  const now = Date.now();
  const tokenMap = new Map<string, boolean>();
  if (instanceIds.length > 0) {
    const { data: tokens } = await supabase
      .from('skyline_instance_access_tokens')
      .select('instance_id, role_context, expires_at, revoked_at')
      .in('instance_id', instanceIds);
    for (const t of (tokens as Array<{ instance_id: number; role_context: string; expires_at: string; revoked_at: string | null }>) || []) {
      const key = `${t.instance_id}:${t.role_context}`;
      const valid = t.revoked_at == null && t.expires_at && new Date(t.expires_at).getTime() > now;
      if (valid) tokenMap.set(key, false);
      else if (!tokenMap.has(key)) tokenMap.set(key, true);
    }
  }
  const mappedDir = rowsRaw.map((r) => {
      const baseId = Number(r.id);
      const state = instanceStateMap.get(baseId);
      const roleCtx = state?.role_context ?? String(r.role_context ?? 'student');
      const tokenKey = `${baseId}:${roleCtx}`;
      const link_expired = tokenMap.get(tokenKey) !== false;
      return {
        id: baseId,
        form_id: Number(r.form_id),
        form_name: String(r.form_name ?? ''),
        form_version: r.form_version != null ? String(r.form_version) : null,
        student_id: r.student_id == null ? null : Number(r.student_id),
        student_name: String(r.student_name ?? 'Unknown student'),
        student_email: String(r.student_email ?? ''),
        status: state?.status ?? String(r.status ?? 'draft'),
        role_context: String(roleCtx),
        workflow_status: state?.workflow_status ?? null,
        created_at: String(r.created_at ?? ''),
        submitted_at: r.submitted_at ? String(r.submitted_at) : null,
        submission_count: Number(r.submission_count ?? 0) || 0,
        start_date: r.start_date ? String(r.start_date) : null,
        end_date: r.end_date ? String(r.end_date) : null,
        no_attempt_rollovers: state?.no_attempt_rollovers ?? null,
        did_not_attempt: state?.did_not_attempt ?? null,
        link_expired,
      };
    });

  return {
    data: await withExtensionDates(await withFormCourseIds(mappedDir)),
    total,
    page,
    pageSize,
  };
}

/** Get assessments for trainer (students in their batches) or office (all waiting office).
 * When pendingOnly is true, returns only pending items for current role (trainer: waiting trainer, office: waiting office). */
export async function listDashboardInstances(
  role: 'trainer' | 'office',
  userId: number,
  page = 1,
  pageSize = 20,
  search?: string,
  pendingOnly = false,
  batchId?: number | null
): Promise<PaginatedResult<SubmittedInstanceRow>> {
  /** Instances are scoped to these students only (active / unset status). Avoid filters on embedded `skyline_students.*` in OR — PostgREST often returns PGRST100. */
  let eligibleStudentIds: number[] = [];
  const bid = batchId != null && Number.isFinite(Number(batchId)) && Number(batchId) > 0 ? Number(batchId) : null;
  if (role === 'trainer') {
    const batchIdsAll = await fetchBatchIdsForTrainer(userId);
    const batchIds = bid ? batchIdsAll.filter((id) => id === bid) : batchIdsAll;
    if (batchIds.length === 0) return { data: [], total: 0, page, pageSize };
    const { data: students } = await supabase
      .from('skyline_students')
      .select('id')
      .in('batch_id', batchIds)
      .or('status.is.null,status.eq.active');
    eligibleStudentIds = ((students as { id: number }[]) || []).map((s) => s.id);
    if (eligibleStudentIds.length === 0) return { data: [], total: 0, page, pageSize };
  } else {
    let studsQuery = supabase
      .from('skyline_students')
      .select('id')
      .or('status.is.null,status.eq.active');
    if (bid) studsQuery = studsQuery.eq('batch_id', bid);
    const { data: studs } = await studsQuery;
    eligibleStudentIds = ((studs as { id: number }[]) || []).map((s) => s.id);
    if (eligibleStudentIds.length === 0) return { data: [], total: 0, page, pageSize };
  }

  const parsedSearch = parseAssessmentSearch(search);
  const rawSearchEscaped = parsedSearch.raw.replace(/[%,]/g, '');
  const { data: rawMatchingBatches } = rawSearchEscaped
    ? await supabase
        .from('skyline_batches')
        .select('id')
        .ilike('name', `%${rawSearchEscaped}%`)
    : { data: [] as Array<{ id: number }> };
  const isBatchNameSearch =
    !parsedSearch.studentId &&
    ((rawMatchingBatches as Array<{ id: number }> | null) ?? []).length > 0;

  // Exact external Student ID within authorised students (AND with other filters).
  if (parsedSearch.studentId) {
    const extId = parsedSearch.studentId.replace(/[%_,]/g, '');
    const { data: sidRows } = await supabase
      .from('skyline_students')
      .select('id')
      .eq('student_id', extId);
    const foundIds = ((sidRows as Array<{ id: number }>) || [])
      .map((s) => Number(s.id))
      .filter((n) => Number.isFinite(n) && n > 0);
    const exactIds = foundIds.filter((id) => eligibleStudentIds.includes(id));
    if (exactIds.length === 0) return { data: [], total: 0, page, pageSize };
    eligibleStudentIds = exactIds;
  }

  let unitFormIds: number[] | null = null;
  if (parsedSearch.unitCode && !isBatchNameSearch) {
    const unitEscaped = parsedSearch.unitCode.replace(/[%,]/g, '');
    const { data: unitFormRows } = await supabase
      .from('skyline_forms')
      .select('id')
      .or(`unit_code.ilike.%${unitEscaped}%,name.ilike.%${unitEscaped}%`);
    unitFormIds = ((unitFormRows as Array<Record<string, unknown>>) || [])
      .map((f) => Number(f.id))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (unitFormIds.length === 0) return { data: [], total: 0, page, pageSize };
  }

  const from = Math.max(0, (page - 1) * pageSize);
  const to = from + pageSize - 1;
  let query = supabase
    .from('skyline_form_instances')
    .select(
      'id, form_id, student_id, status, role_context, workflow_status, created_at, submitted_at, start_date, end_date, submission_count, no_attempt_rollovers, did_not_attempt, skyline_form_answers(count), skyline_students!inner(status)',
      { count: 'exact' }
    )
    .not('student_id', 'is', null)
    .in('student_id', eligibleStudentIds);

  if (unitFormIds) {
    query = query.in('form_id', unitFormIds);
  }

  if (role === 'trainer') {
    if (pendingOnly) {
      // Pending trainer queue: role_context must be trainer; not completed (locked).
      // Use OR for status: in SQL, `status <> 'locked'` excludes NULL rows — include null explicitly.
      query = query.eq('role_context', 'trainer').or('status.is.null,status.neq.locked');
    } else {
      query = query.or('role_context.eq.trainer,role_context.eq.office,status.eq.locked');
    }
  } else {
    if (pendingOnly) {
      query = query.eq('role_context', 'office').or('status.is.null,status.neq.locked');
    } else {
      query = query.or('role_context.eq.office,status.eq.locked');
    }
  }

  const q = isBatchNameSearch ? parsedSearch.raw : parsedSearch.generalQuery;
  if (q) {
    const escaped = q.replace(/[%,]/g, '');
    const conditions: string[] = [`status.ilike.%${escaped}%`, `role_context.ilike.%${escaped}%`];
    const { data: formRows } = await supabase
      .from('skyline_forms')
      .select('id')
      .or(
        `name.ilike.%${escaped}%,version.ilike.%${escaped}%,unit_code.ilike.%${escaped}%,unit_name.ilike.%${escaped}%`
      );
    const formIds = ((formRows as Array<Record<string, unknown>>) || []).map((f) => Number(f.id)).filter((n) => Number.isFinite(n) && n > 0);
    if (formIds.length > 0) conditions.push(`form_id.in.(${formIds.join(',')})`);
    const { data: matchingBatches } = await supabase
      .from('skyline_batches')
      .select('id')
      .ilike('name', `%${escaped}%`);
    const matchingBatchIds = ((matchingBatches as Array<{ id: number }>) || [])
      .map((b) => Number(b.id))
      .filter((id) => Number.isFinite(id) && id > 0);
    const studentSearchConditions = [
      `student_id.ilike.%${escaped}%`,
      `name.ilike.%${escaped}%`,
      `first_name.ilike.%${escaped}%`,
      `last_name.ilike.%${escaped}%`,
      `email.ilike.%${escaped}%`,
    ];
    if (matchingBatchIds.length > 0) {
      studentSearchConditions.push(`batch_id.in.(${matchingBatchIds.join(',')})`);
    }
    const { data: studentRows } = await supabase
      .from('skyline_students')
      .select('id')
      .or(studentSearchConditions.join(','));
    const searchStudentIds = ((studentRows as Array<Record<string, unknown>>) || []).map((s) => Number(s.id)).filter((n) => Number.isFinite(n) && n > 0);
    if (searchStudentIds.length > 0) {
      const overlap = eligibleStudentIds.filter((id) => searchStudentIds.includes(id));
      if (overlap.length === 0) return { data: [], total: 0, page, pageSize };
      conditions.push(`student_id.in.(${overlap.join(',')})`);
    }
    query = query.or(conditions.join(','));
  }

  query = query.order('created_at', { ascending: false }).order('id', { ascending: false });
  const { data: instances, error, count } = await query.range(from, to);
  if (error) {
    console.error('listDashboardInstances error', error.message || error, error);
    return { data: [], total: 0, page, pageSize };
  }

  const rows = (instances as Array<Record<string, unknown>>) || [];
  const instanceIds = rows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0);
  const formIds = Array.from(new Set(rows.map((r) => Number(r.form_id)).filter((n) => Number.isFinite(n) && n > 0)));
  const sIds = Array.from(new Set(rows.map((r) => Number(r.student_id)).filter((n) => Number.isFinite(n) && n > 0)));

  const now = Date.now();
  const tokenMap = new Map<string, boolean>();
  if (instanceIds.length > 0) {
    const { data: tokens } = await supabase
      .from('skyline_instance_access_tokens')
      .select('instance_id, role_context, expires_at, revoked_at')
      .in('instance_id', instanceIds);
    for (const t of (tokens as Array<{ instance_id: number; role_context: string; expires_at: string; revoked_at: string | null }>) || []) {
      const key = `${t.instance_id}:${t.role_context}`;
      const valid = t.revoked_at == null && t.expires_at && new Date(t.expires_at).getTime() > now;
      if (valid) tokenMap.set(key, false);
      else if (!tokenMap.has(key)) tokenMap.set(key, true);
    }
  }

  const formMap = new Map<number, { name: string; version: string | null; unit_code: string | null; unit_name: string | null }>();
  if (formIds.length > 0) {
    const { data: forms } = await supabase.from('skyline_forms').select('id, name, version, unit_code, unit_name').in('id', formIds);
    for (const f of (forms as Array<Record<string, unknown>>) || []) {
      formMap.set(Number(f.id), {
        name: String(f.name ?? ''),
        version: f.version ? String(f.version) : null,
        unit_code: f.unit_code != null && String(f.unit_code).trim() ? String(f.unit_code).trim() : null,
        unit_name: f.unit_name != null && String(f.unit_name).trim() ? String(f.unit_name).trim() : null,
      });
    }
  }
  const studentMap = new Map<number, { name: string; email: string; batch_id: number | null }>();
  if (sIds.length > 0) {
    const { data: students } = await supabase
      .from('skyline_students')
      .select('id, name, first_name, last_name, email, batch_id')
      .in('id', sIds);
    for (const s of (students as Array<Record<string, unknown>>) || []) {
      const first = String(s.first_name ?? '').trim();
      const last = String(s.last_name ?? '').trim();
      const name = [first, last].filter(Boolean).join(' ').trim() || String(s.name ?? '');
      const batch_id = s.batch_id != null && s.batch_id !== '' ? Number(s.batch_id) : null;
      studentMap.set(Number(s.id), { name, email: String(s.email ?? ''), batch_id: Number.isFinite(batch_id as number) ? batch_id : null });
    }
  }

  const batchIds = Array.from(new Set(Array.from(studentMap.values()).map((s) => s.batch_id).filter((x): x is number => x != null && Number.isFinite(x) && x > 0)));
  const batchMap = new Map<number, { name: string | null; trainer_name: string | null }>();
  if (batchIds.length > 0) {
    const { data: batches } = await supabase.from('skyline_batches').select('id, name, trainer_id').in('id', batchIds);
    const trainerIds = Array.from(new Set(((batches as Array<Record<string, unknown>>) || []).map((b) => Number(b.trainer_id)).filter((n) => Number.isFinite(n) && n > 0)));
    const trainerMap = new Map<number, string>();
    if (trainerIds.length > 0) {
      const { data: trainers } = await supabase.from('skyline_users').select('id, full_name').in('id', trainerIds);
      for (const t of (trainers as Array<Record<string, unknown>>) || []) {
        trainerMap.set(Number(t.id), String(t.full_name ?? '').trim());
      }
    }
    for (const b of (batches as Array<Record<string, unknown>>) || []) {
      const id = Number(b.id);
      if (!Number.isFinite(id) || id <= 0) continue;
      const tid = Number(b.trainer_id);
      batchMap.set(id, { name: b.name != null ? String(b.name) : null, trainer_name: trainerMap.get(tid) ?? null });
    }
  }

  const targetRole = role === 'trainer' ? 'trainer' : 'office';
  const mappedDash = rows.map((r) => {
      const formId = Number(r.form_id);
      const studentId = r.student_id == null ? null : Number(r.student_id);
      const form = formMap.get(formId);
      const student = studentId != null ? studentMap.get(studentId) : undefined;
      const batch = student?.batch_id != null ? batchMap.get(student.batch_id) : undefined;
      const roleCtx = String(r.role_context ?? 'student');
      const link_expired = tokenMap.get(`${Number(r.id)}:${targetRole}`) !== false;
      const answerCountRelation = Array.isArray(r.skyline_form_answers) ? r.skyline_form_answers[0] : null;
      return {
        id: Number(r.id),
        form_id: formId,
        form_name: form?.name || `Form #${formId}`,
        form_version: form?.version ?? null,
        form_unit_code: form?.unit_code ?? null,
        form_unit_name: form?.unit_name ?? null,
        student_id: studentId,
        student_name: student?.name || 'Unknown student',
        student_email: student?.email || '',
        batch_id: student?.batch_id ?? null,
        batch_name: batch?.name ?? null,
        trainer_name: batch?.trainer_name ?? null,
        status: String(r.status ?? 'draft'),
        role_context: roleCtx,
        workflow_status: r.workflow_status != null ? String(r.workflow_status) : null,
        created_at: String(r.created_at ?? ''),
        submitted_at: r.submitted_at ? String(r.submitted_at) : null,
        submission_count: Number(r.submission_count ?? 0) || 0,
        start_date: r.start_date ? String(r.start_date) : null,
        end_date: r.end_date ? String(r.end_date) : null,
        no_attempt_rollovers:
          r.no_attempt_rollovers != null && r.no_attempt_rollovers !== ''
            ? Number(r.no_attempt_rollovers)
            : null,
        did_not_attempt: Boolean(r.did_not_attempt),
        answer_count: Math.max(0, Number((answerCountRelation as { count?: number } | null)?.count ?? 0) || 0),
        link_expired,
      };
    });

  return {
    data: await withExtensionDates(await withFormCourseIds(mappedDash)),
    total: Number(count ?? 0),
    page,
    pageSize,
  };
}

/** Max rows to load for trainer “Grade me” grouped view (two pages of 1000 if needed). */
export const TRAINER_GRADE_ME_MAX_INSTANCES = 2000;

/** All pending trainer assessments (up to {@link TRAINER_GRADE_ME_MAX_INSTANCES} rows) for grouped / per-unit UI. */
export async function listTrainerPendingForGradeMePanel(
  trainerUserId: number,
  search = '',
  batchId: number | null = null,
): Promise<{ rows: SubmittedInstanceRow[]; total: number; truncated: boolean }> {
  const pageSize = 1000;
  const first = await listDashboardInstances('trainer', trainerUserId, 1, pageSize, search, true, batchId);
  let rows = first.data;
  const total = first.total;
  if (total > pageSize && rows.length === pageSize) {
    const second = await listDashboardInstances('trainer', trainerUserId, 2, pageSize, search, true, batchId);
    rows = [...rows, ...second.data];
  }
  const truncated = total > TRAINER_GRADE_ME_MAX_INSTANCES;
  const capped = rows.slice(0, TRAINER_GRADE_ME_MAX_INSTANCES);
  return { rows: capped, total, truncated };
}

/** Trainer view: list all instances for a specific unit/form, limited to students in trainer's batches. */
export async function listTrainerUnitInstancesPaged(
  trainerUserId: number,
  formId: number,
  page = 1,
  pageSize = 20,
  search?: string
): Promise<PaginatedResult<SubmittedInstanceRow>> {
  const tid = Number(trainerUserId);
  const fid = Number(formId);
  if (!Number.isFinite(tid) || tid <= 0 || !Number.isFinite(fid) || fid <= 0) {
    return { data: [], total: 0, page, pageSize };
  }

  const batchIds = await fetchBatchIdsForTrainer(tid);
  if (batchIds.length === 0) return { data: [], total: 0, page, pageSize };

  const { data: students } = await supabase
    .from('skyline_students')
    .select('id')
    .in('batch_id', batchIds)
    .or('status.is.null,status.eq.active');
  const eligibleStudentIds = ((students as { id: number }[]) || [])
    .map((s) => Number(s.id))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (eligibleStudentIds.length === 0) return { data: [], total: 0, page, pageSize };

  const from = Math.max(0, (page - 1) * pageSize);
  const to = from + pageSize - 1;

  let query = supabase
    .from('skyline_form_instances')
    .select('id, form_id, student_id, status, role_context, created_at, submitted_at, start_date, end_date, submission_count', {
      count: 'exact',
    })
    .eq('form_id', fid)
    .not('student_id', 'is', null)
    .in('student_id', eligibleStudentIds);

  const q = (search ?? '').trim();
  if (q) {
    const escaped = q.replace(/[%,]/g, '');
    const { data: matchingBatches } = await supabase
      .from('skyline_batches')
      .select('id')
      .in('id', batchIds)
      .ilike('name', `%${escaped}%`);
    const matchingBatchIds = ((matchingBatches as Array<{ id: number }>) || [])
      .map((b) => Number(b.id))
      .filter((id) => Number.isFinite(id) && id > 0);
    const studentSearchConditions = [
      `student_id.ilike.%${escaped}%`,
      `name.ilike.%${escaped}%`,
      `first_name.ilike.%${escaped}%`,
      `last_name.ilike.%${escaped}%`,
      `email.ilike.%${escaped}%`,
    ];
    if (matchingBatchIds.length > 0) {
      studentSearchConditions.push(`batch_id.in.(${matchingBatchIds.join(',')})`);
    }
    const { data: studentRows } = await supabase
      .from('skyline_students')
      .select('id')
      .or(studentSearchConditions.join(','));
    const searchStudentIds = ((studentRows as Array<Record<string, unknown>>) || [])
      .map((s) => Number(s.id))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (searchStudentIds.length === 0) return { data: [], total: 0, page, pageSize };
    const overlap = eligibleStudentIds.filter((id) => searchStudentIds.includes(id));
    if (overlap.length === 0) return { data: [], total: 0, page, pageSize };
    query = query.in('student_id', overlap);
  }

  query = query.order('created_at', { ascending: false }).order('id', { ascending: false });
  const { data: instances, error, count } = await query.range(from, to);
  if (error) {
    console.error('listTrainerUnitInstancesPaged error', error.message || error, error);
    return { data: [], total: 0, page, pageSize };
  }

  const rows = (instances as Array<Record<string, unknown>>) || [];
  const instanceIds = rows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0);
  const studentIds = Array.from(new Set(rows.map((r) => Number(r.student_id)).filter((n) => Number.isFinite(n) && n > 0)));

  const now = Date.now();
  const tokenMap = new Map<string, boolean>();
  if (instanceIds.length > 0) {
    const { data: tokens } = await supabase
      .from('skyline_instance_access_tokens')
      .select('instance_id, role_context, expires_at, revoked_at')
      .in('instance_id', instanceIds)
      .eq('role_context', 'trainer');
    for (const t of (tokens as Array<{ instance_id: number; role_context: string; expires_at: string; revoked_at: string | null }>) || []) {
      const key = `${t.instance_id}:${t.role_context}`;
      const valid = t.revoked_at == null && t.expires_at && new Date(t.expires_at).getTime() > now;
      if (valid) tokenMap.set(key, false);
      else if (!tokenMap.has(key)) tokenMap.set(key, true);
    }
  }

  const form = await fetchForm(fid, { allowInactiveForAdmin: true });
  const formName = form?.name ?? `Form #${fid}`;
  const formVersion = form?.version ?? null;
  const formUnitCode = form?.unit_code != null && String(form.unit_code).trim() ? String(form.unit_code).trim() : null;
  const formUnitName = form?.unit_name != null && String(form.unit_name).trim() ? String(form.unit_name).trim() : null;

  const studentMap = new Map<number, { name: string; email: string; batch_id: number | null; batch_name: string | null }>();
  if (studentIds.length > 0) {
    const { data: studentsRows } = await supabase
      .from('skyline_students')
      .select('id, name, first_name, last_name, email, batch_id, skyline_batches(name)')
      .in('id', studentIds);
    for (const s of (studentsRows as Array<Record<string, unknown>>) || []) {
      const first = String(s.first_name ?? '').trim();
      const last = String(s.last_name ?? '').trim();
      const name = [first, last].filter(Boolean).join(' ').trim() || String(s.name ?? '');
      const batch = s.skyline_batches as { name?: string | null } | null;
      studentMap.set(Number(s.id), {
        name,
        email: String(s.email ?? ''),
        batch_id: s.batch_id != null ? Number(s.batch_id) : null,
        batch_name: batch?.name != null ? String(batch.name) : null,
      });
    }
  }

  const mapped = rows.map((r) => {
    const instanceId = Number(r.id);
    const studentId = r.student_id == null ? null : Number(r.student_id);
    const student = studentId != null ? studentMap.get(studentId) : undefined;
    const link_expired = tokenMap.get(`${instanceId}:trainer`) !== false;
    return {
      id: instanceId,
      form_id: fid,
      form_name: formName,
      form_version: formVersion,
      form_unit_code: formUnitCode,
      form_unit_name: formUnitName,
      student_id: studentId,
      student_name: student?.name || 'Unknown student',
      student_email: student?.email || '',
      batch_id: student?.batch_id ?? null,
      batch_name: student?.batch_name ?? null,
      status: String(r.status ?? 'draft'),
      role_context: String(r.role_context ?? 'student'),
      created_at: String(r.created_at ?? ''),
      submitted_at: r.submitted_at ? String(r.submitted_at) : null,
      submission_count: Number(r.submission_count ?? 0) || 0,
      start_date: r.start_date ? String(r.start_date) : null,
      end_date: r.end_date ? String(r.end_date) : null,
      link_expired,
    } satisfies SubmittedInstanceRow;
  });

  return {
    data: await withExtensionDates(await withFormCourseIds(mapped)),
    total: Number(count ?? 0),
    page,
    pageSize,
  };
}

/** Batches assigned to the trainer (read-only list for dashboard). */
export async function listTrainerBatches(userId: number): Promise<Batch[]> {
  const batchIds = await fetchBatchIdsForTrainer(userId);
  if (batchIds.length === 0) return [];
  const { data, error } = await supabase
    .from('skyline_batches')
    .select('id, name, trainer_id, course_id, created_at, allow_trainer_student_login')
    .in('id', batchIds)
    .order('name', { ascending: true });
  if (error) {
    console.error('listTrainerBatches error', error);
    return [];
  }
  return hydrateBatchRows((data as Record<string, unknown>[]) || []);
}

/** One row per distinct course attached to batches where this user is the trainer (for units / materials UI). */
export type TrainerCourseOption = {
  courseId: number;
  courseName: string;
  qualificationCode: string | null;
  batchNames: string[];
};

export async function listTrainerCourseOptionsForUnits(userId: number): Promise<TrainerCourseOption[]> {
  const batches = await listTrainerBatches(userId);
  const byCourse = new Map<number, Set<string>>();
  for (const b of batches) {
    const cid = b.course_id;
    if (cid == null || !Number.isFinite(Number(cid)) || Number(cid) <= 0) continue;
    const id = Number(cid);
    if (!byCourse.has(id)) byCourse.set(id, new Set());
    byCourse.get(id)!.add(b.name);
  }
  if (byCourse.size === 0) return [];
  const ids = [...byCourse.keys()];
  const { data: courses, error } = await supabase.from('skyline_courses').select('id, name, qualification_code').in('id', ids);
  if (error) console.error('listTrainerCourseOptionsForUnits courses error', error);
  const cmap = new Map((courses as { id: number; name: string; qualification_code: string | null }[] | null)?.map((c) => [c.id, c]) ?? []);
  const result: TrainerCourseOption[] = [];
  for (const courseId of ids) {
    const meta = cmap.get(courseId);
    const batchNames = [...(byCourse.get(courseId) ?? new Set())].sort();
    result.push({
      courseId,
      courseName: meta?.name?.trim() || `Course ${courseId}`,
      qualificationCode: meta?.qualification_code ?? null,
      batchNames,
    });
  }
  result.sort((a, b) => a.courseName.localeCompare(b.courseName));
  return result;
}

/** Number of batches assigned to the trainer. */
export async function getTrainerBatchCount(userId: number): Promise<number> {
  const ids = await fetchBatchIdsForTrainer(userId);
  return ids.length;
}

/** Pending count for dashboard: trainer = waiting_trainer in their batches, office = waiting_office. */
export async function getDashboardPendingCount(role: 'trainer' | 'office', userId: number): Promise<number> {
  if (role === 'trainer') {
    const batchIds = await fetchBatchIdsForTrainer(userId);
    if (batchIds.length === 0) return 0;
    // Match listDashboardInstances: only active students appear in the pending table.
    const { data: students } = await supabase
      .from('skyline_students')
      .select('id')
      .in('batch_id', batchIds)
      .or('status.is.null,status.eq.active');
    const studentIds = ((students as { id: number }[]) || []).map((s) => s.id);
    if (studentIds.length === 0) return 0;
    const { count } = await supabase
      .from('skyline_form_instances')
      .select('id', { count: 'exact', head: true })
      .in('student_id', studentIds)
      .eq('role_context', 'trainer')
      .or('status.is.null,status.neq.locked');
    return Number(count ?? 0);
  }
  const { data: studs } = await supabase
    .from('skyline_students')
    .select('id')
    .or('status.is.null,status.eq.active');
  const eligibleOfficeStudentIds = ((studs as { id: number }[]) || []).map((s) => s.id);
  if (eligibleOfficeStudentIds.length === 0) return 0;
  const { count } = await supabase
    .from('skyline_form_instances')
    .select('id', { count: 'exact', head: true })
    .in('student_id', eligibleOfficeStudentIds)
    .eq('role_context', 'office')
    .or('did_not_attempt.is.null,did_not_attempt.eq.false')
    .or('status.is.null,status.neq.locked');
  return Number(count ?? 0);
}

export interface CreateBatchInput {
  name: string;
  trainer_id: number;
  /** All trainers for the batch; first entry is stored as primary `trainer_id`. */
  trainer_ids?: number[];
  course_id?: number | null;
}

export async function listBatches(): Promise<Batch[]> {
  try {
    return await dedupeSupabaseRead('skyline_batches:list', 120_000, async () => {
      const { data, error } = await supabase
        .from('skyline_batches')
        .select('id, name, trainer_id, course_id, created_at, allow_trainer_student_login')
        .order('name', { ascending: true })
        .limit(500);
      if (error) {
        recordSupabaseError('skyline_batches', error);
        return [];
      }
      return hydrateBatchRows((data as Record<string, unknown>[]) || []);
    });
  } catch (e) {
    if (e instanceof SupabaseBackoffError) return [];
    throw e;
  }
}

export async function listBatchesPaged(
  page = 1,
  pageSize = 20,
  search?: string,
  courseFilter?: number | number[] | null
): Promise<PaginatedResult<Batch>> {
  const from = Math.max(0, (page - 1) * pageSize);
  const to = from + pageSize - 1;
  let query = supabase
    .from('skyline_batches')
    .select('id, name, trainer_id, course_id, created_at, allow_trainer_student_login', { count: 'exact' })
    .order('name', { ascending: true });
  if (search && search.trim()) {
    query = query.ilike('name', `%${search.trim()}%`);
  }
  if (courseFilter != null) {
    const arr = Array.isArray(courseFilter) ? courseFilter : [courseFilter];
    const ids = [...new Set(arr.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0))];
    if (ids.length === 1) {
      query = query.eq('course_id', ids[0]);
    } else if (ids.length > 1) {
      query = query.in('course_id', ids);
    }
  }
  const { data, error, count } = await query.range(from, to);
  if (error) {
    console.error('listBatchesPaged error', error);
    return { data: [], total: 0, page, pageSize };
  }
  const rows = (data as Record<string, unknown>[]) || [];
  if (rows.length === 0) return { data: [], total: Number(count ?? 0), page, pageSize };
  const mapped = await hydrateBatchRows(rows);
  return {
    data: mapped,
    total: Number(count ?? 0),
    page,
    pageSize,
  };
}

export async function getBatchById(id: number): Promise<Batch | null> {
  const bid = Number(id);
  if (!Number.isFinite(bid) || bid <= 0) return null;
  const { data, error } = await supabase
    .from('skyline_batches')
    .select('id, name, trainer_id, course_id, created_at, allow_trainer_student_login')
    .eq('id', bid)
    .maybeSingle();
  if (error) {
    console.error('getBatchById error', error);
    return null;
  }
  if (!data) return null;
  const [batch] = await hydrateBatchRows([data as Record<string, unknown>]);
  return batch ?? null;
}

export interface BatchAssessmentOptionsPayload {
  students: Array<{ id: number; label: string }>;
  units: Array<{ id: number; name: string }>;
  student_units: Record<string, number[]>;
  /** Total students matching filters (not only the current page). */
  studentsTotal: number;
  /** 1-based page echoed from the RPC. */
  studentsPage: number;
  studentsPageSize: number;
  /** All student ids matching filters (compact; for select-all and mass actions). */
  eligibleStudentIds: number[];
}

/**
 * Date filters for batch unit assessment UI (see skyline_batch_assessment_options RPC).
 * Range mode (both dates set): start_date = from, end_date between from and to (inclusive).
 * When To is empty (`startOnlyNullEnd` true): default is "active on" From — start ≤ From ≤ end (or no end yet).
 * Set `openNullEndExact` to only match open-ended instances with start exactly on From.
 *
 * `units` in the payload are only forms with at least one matching instance (same filter as students).
 */
export async function fetchBatchAssessmentOptions(
  batchId: number,
  courseId: number,
  fromDate: string,
  toDate: string,
  startOnlyNullEnd: boolean,
  openNullEndExact = false,
  pagination?: { page?: number; pageSize?: number; formId?: number | null }
): Promise<BatchAssessmentOptionsPayload | null> {
  const bid = Number(batchId);
  const cid = Number(courseId);
  if (!Number.isFinite(bid) || bid <= 0 || !Number.isFinite(cid) || cid <= 0) return null;
  const page = pagination?.page != null ? Number(pagination.page) : 1;
  const pageSize = pagination?.pageSize != null ? Number(pagination.pageSize) : 25;
  const formId = pagination?.formId;
  const { data, error } = await supabase.rpc('skyline_batch_assessment_options', {
    p_batch_id: bid,
    p_course_id: cid,
    p_from_date: fromDate,
    p_to_date: toDate,
    p_start_only_null_end: startOnlyNullEnd,
    p_open_null_end_exact: startOnlyNullEnd ? Boolean(openNullEndExact) : false,
    p_page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
    p_page_size: Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 25,
    p_form_id:
      formId != null && Number.isFinite(Number(formId)) && Number(formId) > 0 ? Math.floor(Number(formId)) : null,
  });
  if (error) {
    console.error('fetchBatchAssessmentOptions rpc error', error);
    return null;
  }
  const raw = data as {
    students?: Array<{ id: number; label: string }>;
    units?: Array<{ id: number; name: string }>;
    student_units?: Record<string, unknown>;
    students_total?: number;
    students_page?: number;
    students_page_size?: number;
    eligible_student_ids?: unknown;
  } | null;
  if (!raw || typeof raw !== 'object') {
    return {
      students: [],
      units: [],
      student_units: {},
      studentsTotal: 0,
      studentsPage: 1,
      studentsPageSize: 25,
      eligibleStudentIds: [],
    };
  }
  const su: Record<string, number[]> = {};
  if (raw.student_units && typeof raw.student_units === 'object') {
    for (const [k, v] of Object.entries(raw.student_units)) {
      if (Array.isArray(v)) su[k] = v.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
    }
  }
  let eligibleStudentIds: number[] = [];
  if (Array.isArray(raw.eligible_student_ids)) {
    eligibleStudentIds = raw.eligible_student_ids
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n) && n > 0);
  }
  const studentsTotal = Number(raw.students_total);
  const studentsPage = Number(raw.students_page);
  const studentsPageSize = Number(raw.students_page_size);
  return {
    students: Array.isArray(raw.students) ? raw.students : [],
    units: Array.isArray(raw.units) ? raw.units : [],
    student_units: su,
    studentsTotal: Number.isFinite(studentsTotal) ? studentsTotal : 0,
    studentsPage: Number.isFinite(studentsPage) && studentsPage > 0 ? studentsPage : 1,
    studentsPageSize: Number.isFinite(studentsPageSize) && studentsPageSize > 0 ? studentsPageSize : 25,
    eligibleStudentIds,
  };
}

/** Batches currently assigned to a course (course_id). */
export async function listBatchesForCourse(courseId: number): Promise<Batch[]> {
  if (!courseId || !Number.isFinite(courseId)) return [];
  const { data, error } = await supabase
    .from('skyline_batches')
    .select('id, name, trainer_id, course_id, created_at, allow_trainer_student_login')
    .eq('course_id', courseId)
    .order('name', { ascending: true });
  if (error) {
    console.error('listBatchesForCourse error', error);
    return [];
  }
  const rows = (data as Record<string, unknown>[]) || [];
  if (rows.length === 0) return [];
  return hydrateBatchRows(rows);
}

/** Assign batches to a course (one-to-many). Replaces existing course→batch assignments. */
export async function setCourseBatches(courseId: number, batchIds: number[]): Promise<boolean> {
  try {
    if (!courseId || !Number.isFinite(courseId)) return false;
    const { updated_by } = getAuditFields();
    const normalized = [...new Set(batchIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))];
    // Unassign any batches currently in this course but not selected.
    if (normalized.length > 0) {
      const { error: unassignErr } = await supabase
        .from('skyline_batches')
        .update({ course_id: null, updated_by })
        .eq('course_id', courseId)
        .not('id', 'in', `(${normalized.join(',')})`);
      if (unassignErr) {
        console.error('setCourseBatches unassign error', unassignErr);
        return false;
      }
      // Assign selected batches to this course.
      const { error: assignErr } = await supabase
        .from('skyline_batches')
        .update({ course_id: courseId, updated_by })
        .in('id', normalized);
      if (assignErr) {
        console.error('setCourseBatches assign error', assignErr);
        return false;
      }
    } else {
      const { error: unassignAllErr } = await supabase
        .from('skyline_batches')
        .update({ course_id: null, updated_by })
        .eq('course_id', courseId);
      if (unassignAllErr) {
        console.error('setCourseBatches unassignAll error', unassignAllErr);
        return false;
      }
    }
    return true;
  } catch (e) {
    console.error('setCourseBatches error', e);
    return false;
  }
}

function mapBatchRow(row: Record<string, unknown>, trainerName: string | null, courseName: string | null): Batch {
  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
    trainer_id: Number(row.trainer_id),
    trainer_name: trainerName,
    course_id: row.course_id != null ? Number(row.course_id) : null,
    course_name: courseName,
    created_at: String(row.created_at ?? ''),
    allow_trainer_student_login: Boolean(row.allow_trainer_student_login),
  };
}

export async function createBatch(input: CreateBatchInput): Promise<Batch | null> {
  const trainerIds = [...new Set((input.trainer_ids?.length ? input.trainer_ids : [input.trainer_id]).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  const primaryTrainerId = trainerIds[0] ?? Number(input.trainer_id);
  if (!Number.isFinite(primaryTrainerId) || primaryTrainerId <= 0) return null;
  const { created_by } = getAuditFields();
  const { data, error } = await supabase
    .from('skyline_batches')
    .insert({
      name: input.name.trim(),
      trainer_id: primaryTrainerId,
      course_id: input.course_id ?? null,
      created_by,
    })
    .select('id, name, trainer_id, course_id, created_at, allow_trainer_student_login')
    .single();
  if (error) {
    console.error('createBatch error', error);
    return null;
  }
  const row = data as Record<string, unknown>;
  const batchId = Number(row.id);
  if (Number.isFinite(batchId) && batchId > 0) {
    await syncBatchTrainers(batchId, trainerIds);
  }
  const [batch] = await hydrateBatchRows([row]);
  return batch ?? null;
}

export type UpdateBatchInput = Partial<Pick<CreateBatchInput, 'name' | 'trainer_id' | 'course_id' | 'trainer_ids'>>;

export async function updateBatch(id: number, input: UpdateBatchInput): Promise<Batch | null> {
  const payload: Record<string, unknown> = {};
  if (input.name !== undefined) payload.name = input.name.trim();
  if (input.trainer_ids !== undefined) {
    const trainerIds = [...new Set(input.trainer_ids.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    if (trainerIds.length > 0) payload.trainer_id = trainerIds[0];
  } else if (input.trainer_id !== undefined) {
    payload.trainer_id = input.trainer_id;
  }
  if (input.course_id !== undefined) payload.course_id = input.course_id;
  payload.updated_by = getAuditFields().updated_by;
  const { data, error } = await supabase
    .from('skyline_batches')
    .update(payload)
    .eq('id', id)
    .select('id, name, trainer_id, course_id, created_at, allow_trainer_student_login')
    .single();
  if (error) {
    console.error('updateBatch error', error);
    return null;
  }
  const row = data as Record<string, unknown>;
  if (input.trainer_ids !== undefined) {
    const trainerIds = [...new Set(input.trainer_ids.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    if (trainerIds.length > 0) await syncBatchTrainers(id, trainerIds);
  } else if (input.trainer_id !== undefined) {
    const existing = await fetchBatchTrainerIds(id);
    const merged = [...new Set([Number(input.trainer_id), ...existing.filter((x) => x !== Number(input.trainer_id))])];
    await syncBatchTrainers(id, merged);
  }
  const [batch] = await hydrateBatchRows([row]);
  return batch ?? null;
}

export async function updateBatchStudentAssignments(
  batchId: number,
  studentIds: number[]
): Promise<{ ok: boolean; error?: string }> {
  const bid = Number(batchId);
  if (!Number.isFinite(bid) || bid <= 0) return { ok: false, error: 'Invalid batch id' };
  const ids = Array.from(new Set(studentIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)));
  try {
    const { data, error } = await supabase.rpc('skyline_update_batch_student_assignments', {
      p_batch_id: bid,
      p_student_ids: ids,
    });
    if (error) {
      console.error('updateBatchStudentAssignments rpc error', error);
      return { ok: false, error: error.message };
    }
    const row = data as { ok?: boolean; error?: string } | null;
    if (!row?.ok) {
      return {
        ok: false,
        error: row?.error ?? 'Failed to update batch student assignments',
      };
    }
    return { ok: true };
  } catch (e) {
    console.error('updateBatchStudentAssignments error', e);
    return { ok: false, error: e instanceof Error ? e.message : 'Failed to update batch student assignments' };
  }
}

export interface CreateStudentInput {
  student_id: string;
  first_name: string;
  last_name?: string;
  email: string;
  phone?: string;
  batch_id?: number | null;
  course_ids?: number[];
  date_of_birth?: string;
  address_line_1?: string;
  address_line_2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  country?: string;
  guardian_name?: string;
  guardian_phone?: string;
  notes?: string;
  status?: string;
}

export type SetStudentCoursesOptions = {
  /** Per-course lifecycle fields when assigning (Edit Student). */
  enrollments?: Array<{
    course_id: number;
    start_date?: string | null;
    end_date?: string | null;
    enrollment_status?: StudentCourseEnrollmentStatus;
    intake_label?: string | null;
  }>;
  /** Prefer cancel over hard-delete when pruning deselected courses that have assessments. */
  cancelInsteadOfDelete?: boolean;
};

export async function setStudentCourses(
  studentId: number,
  courseIds: number[],
  options?: SetStudentCoursesOptions
): Promise<{ ok: boolean; error?: string }> {
  const sid = Number(studentId);
  if (!Number.isFinite(sid) || sid <= 0) return { ok: false, error: 'Invalid student' };
  const ids = Array.from(new Set(courseIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)));
  const { updated_by } = getAuditFields();
  const byCourse = new Map(
    (options?.enrollments ?? []).map((e) => [Number(e.course_id), e] as const)
  );
  try {
    const existingActive = await listStudentCourseEnrollments(sid);
    const existingIds = existingActive.map((e) => e.course_id);
    const toRemove = existingIds.filter((id) => !ids.includes(id));

    for (const cid of toRemove) {
      if (options?.cancelInsteadOfDelete) {
        const res = await upsertStudentCourseEnrollment({
          studentId: sid,
          courseId: cid,
          enrollment_status: 'cancelled',
          link_status: 'inactive',
          allowCreate: false,
        });
        if (!res.ok) {
          // Fall back to soft-inactive without status change if cancel transition blocked
          const { error } = await supabase
            .from('skyline_student_courses')
            .update({ status: 'inactive', updated_by })
            .eq('student_id', sid)
            .eq('course_id', cid);
          if (error) return { ok: false, error: error.message };
        }
      } else {
        const { error } = await supabase
          .from('skyline_student_courses')
          .update({ status: 'inactive', updated_by })
          .eq('student_id', sid)
          .eq('course_id', cid);
        if (error) return { ok: false, error: error.message };
      }
    }

    if (ids.length === 0) return { ok: true };

    let hasInProgress = existingActive.some(
      (e) => e.enrollment_status === 'in_progress' && ids.includes(e.course_id)
    );

    for (const cid of ids) {
      const draft = byCourse.get(cid);
      const already = existingActive.find((e) => e.course_id === cid);
      if (already) {
        const res = await upsertStudentCourseEnrollment({
          studentId: sid,
          courseId: cid,
          start_date: draft?.start_date !== undefined ? draft.start_date : undefined,
          end_date: draft?.end_date !== undefined ? draft.end_date : undefined,
          enrollment_status: draft?.enrollment_status,
          intake_label: draft?.intake_label,
          link_status: 'active',
          allowCreate: false,
        });
        if (!res.ok) return { ok: false, error: res.error };
        if ((draft?.enrollment_status ?? already.enrollment_status) === 'in_progress') {
          hasInProgress = true;
        }
      } else {
        const status = defaultStatusForNewCourseEnrollment({
          hasInProgress,
          startDate: draft?.start_date,
          endDate: draft?.end_date,
          explicitStatus: draft?.enrollment_status,
        });
        const res = await upsertStudentCourseEnrollment({
          studentId: sid,
          courseId: cid,
          start_date: draft?.start_date ?? null,
          end_date: draft?.end_date ?? null,
          enrollment_status: status,
          intake_label: draft?.intake_label ?? null,
          link_status: 'active',
          allowCreate: true,
        });
        if (!res.ok) return { ok: false, error: res.error };
        if (status === 'in_progress') hasInProgress = true;
      }
    }
    return { ok: true };
  } catch (e) {
    console.error('setStudentCourses error', e);
    return { ok: false, error: e instanceof Error ? e.message : 'setStudentCourses failed' };
  }
}

/** Add courses to a student without removing existing course mappings. */
export async function appendStudentCourses(
  studentId: number,
  courseIds: number[],
  options?: {
    enrollments?: Array<{
      course_id: number;
      start_date?: string | null;
      end_date?: string | null;
      enrollment_status?: StudentCourseEnrollmentStatus;
    }>;
    /** When true, also upsert dates/status for courses the student already has (import recompute). */
    updateExisting?: boolean;
  }
): Promise<{ ok: boolean; error?: string }> {
  const sid = Number(studentId);
  if (!Number.isFinite(sid) || sid <= 0) return { ok: false, error: 'Invalid student' };
  const ids = Array.from(new Set(courseIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)));
  if (ids.length === 0) return { ok: true };
  const existing = await listStudentCourseEnrollments(sid);
  const existingIds = new Set(existing.map((e) => e.course_id));
  const byCourse = new Map((options?.enrollments ?? []).map((e) => [Number(e.course_id), e] as const));

  if (options?.updateExisting) {
    for (const cid of ids.filter((id) => existingIds.has(id))) {
      const draft = byCourse.get(cid);
      if (!draft) continue;
      const res = await upsertStudentCourseEnrollment({
        studentId: sid,
        courseId: cid,
        start_date: draft.start_date !== undefined ? draft.start_date : undefined,
        end_date: draft.end_date !== undefined ? draft.end_date : undefined,
        enrollment_status: draft.enrollment_status,
        link_status: 'active',
        allowCreate: true,
      });
      if (!res.ok) return res;
    }
  }

  const toAdd = ids.filter((id) => !existingIds.has(id));
  if (toAdd.length === 0) return { ok: true };

  let hasInProgress = existing.some((e) => e.enrollment_status === 'in_progress');

  for (const cid of toAdd) {
    const draft = byCourse.get(cid);
    const status = defaultStatusForNewCourseEnrollment({
      hasInProgress,
      startDate: draft?.start_date,
      endDate: draft?.end_date,
      explicitStatus: draft?.enrollment_status,
    });
    const res = await upsertStudentCourseEnrollment({
      studentId: sid,
      courseId: cid,
      start_date: draft?.start_date ?? null,
      end_date: draft?.end_date ?? null,
      enrollment_status: status,
      link_status: 'active',
      allowCreate: true,
    });
    if (!res.ok) return res;
    if (status === 'in_progress') hasInProgress = true;
  }
  return { ok: true };
}

export type StudentCourseEnrollmentStatus = CourseLifecycleStatus;

export interface StudentCourseEnrollment {
  course_id: number;
  name: string;
  qualification_code: string | null;
  enrolled_at: string;
  start_date: string | null;
  end_date: string | null;
  enrollment_status: StudentCourseEnrollmentStatus;
  completed_at: string | null;
  intake_label: string | null;
  link_status: 'active' | 'inactive';
  enrollment_status_changed_at: string | null;
}

export type UpsertStudentCourseEnrollmentInput = {
  studentId: number;
  courseId: number;
  start_date?: string | null;
  end_date?: string | null;
  enrollment_status?: StudentCourseEnrollmentStatus | null;
  intake_label?: string | null;
  link_status?: 'active' | 'inactive';
  completed_at?: string | null;
  allowCreate?: boolean;
};

export async function upsertStudentCourseEnrollment(
  input: UpsertStudentCourseEnrollmentInput
): Promise<{ ok: boolean; error?: string; data?: Record<string, unknown> }> {
  const sid = Number(input.studentId);
  const cid = Number(input.courseId);
  if (!Number.isFinite(sid) || sid <= 0 || !Number.isFinite(cid) || cid <= 0) {
    return { ok: false, error: 'Invalid student or course' };
  }
  if (input.enrollment_status != null && !isCourseLifecycleStatus(input.enrollment_status)) {
    return { ok: false, error: 'Invalid course status.' };
  }
  const dateErr = validateCourseDateOrder(input.start_date ?? null, input.end_date ?? null);
  if (dateErr) return { ok: false, error: dateErr };

  const { updated_by } = getAuditFields();
  const { data, error } = await supabase.rpc('skyline_upsert_student_course_enrollment', {
    p_student_id: sid,
    p_course_id: cid,
    p_start_date: input.start_date === undefined ? null : input.start_date,
    p_end_date: input.end_date === undefined ? null : input.end_date,
    p_enrollment_status: input.enrollment_status ?? null,
    p_intake_label: input.intake_label === undefined ? null : input.intake_label,
    p_link_status: input.link_status ?? 'active',
    p_completed_at: input.completed_at ?? null,
    p_actor_user_id: updated_by,
    p_allow_create: input.allowCreate !== false,
  });
  if (error) {
    console.error('upsertStudentCourseEnrollment rpc error', error);
    return { ok: false, error: error.message };
  }
  const payload = (data ?? {}) as { ok?: boolean; error?: string };
  if (!payload.ok) {
    return { ok: false, error: payload.error ?? 'Could not update course enrolment' };
  }
  return { ok: true, data: payload as Record<string, unknown> };
}

export type ImportTimetableUnitInput = {
  form_id: number;
  start_date?: string | null;
  end_date?: string | null;
};

export type ImportStudentCourseTimetableResult = {
  ok: boolean;
  error?: string;
  is_new?: boolean;
  enrollment_status?: string;
  previous_status?: string;
  start_date?: string | null;
  end_date?: string | null;
  units_created?: number;
  units_updated?: number;
  units_unchanged?: number;
};

/** Atomic timetable import for one student-course (units + enrolment + date recalc). */
export async function importStudentCourseTimetable(input: {
  studentId: number;
  courseId: number;
  units: ImportTimetableUnitInput[];
  enrollmentStatus?: StudentCourseEnrollmentStatus | null;
  explicitStatus?: boolean;
}): Promise<ImportStudentCourseTimetableResult> {
  const sid = Number(input.studentId);
  const cid = Number(input.courseId);
  if (!Number.isFinite(sid) || sid <= 0 || !Number.isFinite(cid) || cid <= 0) {
    return { ok: false, error: 'Invalid student or course' };
  }
  const { updated_by } = getAuditFields();
  const units = (input.units ?? [])
    .map((u) => ({
      form_id: Number(u.form_id),
      start_date: u.start_date ?? null,
      end_date: u.end_date ?? null,
    }))
    .filter((u) => Number.isFinite(u.form_id) && u.form_id > 0);

  const { data, error } = await supabase.rpc('skyline_import_student_course_timetable', {
    p_student_id: sid,
    p_course_id: cid,
    p_units: units,
    p_enrollment_status: input.enrollmentStatus ?? null,
    p_explicit_status: Boolean(input.explicitStatus && input.enrollmentStatus),
    p_actor_user_id: updated_by,
  });
  if (error) {
    console.error('importStudentCourseTimetable rpc error', error);
    return { ok: false, error: error.message };
  }
  const payload = (data ?? {}) as ImportStudentCourseTimetableResult;
  if (!payload.ok) {
    return { ok: false, error: payload.error ?? 'Timetable import failed' };
  }
  return payload;
}

export async function listStudentCourseEnrollments(studentId: number): Promise<StudentCourseEnrollment[]> {
  const sid = Number(studentId);
  if (!Number.isFinite(sid) || sid <= 0) return [];
  const { data, error } = await supabase
    .from('skyline_student_courses')
    .select(
      'created_at, status, start_date, end_date, enrollment_status, completed_at, intake_label, enrollment_status_changed_at, course_id, skyline_courses(id, name, qualification_code)'
    )
    .eq('student_id', sid)
    .eq('status', 'active')
    .order('created_at', { ascending: false });
  if (error) {
    console.error('listStudentCourseEnrollments error', error);
    return [];
  }
  const rows =
    (data as unknown as Array<{
      created_at?: string;
      status?: string;
      start_date?: string | null;
      end_date?: string | null;
      enrollment_status?: string | null;
      completed_at?: string | null;
      intake_label?: string | null;
      enrollment_status_changed_at?: string | null;
      course_id: number;
      skyline_courses: { id: number; name: string; qualification_code: string | null } | null;
    }> | null) ?? [];
  return rows
    .map((r) => {
      const c = r.skyline_courses;
      if (!c) return null;
      const enrollmentStatus = normalizeCourseLifecycleStatus(r.enrollment_status) ?? 'in_progress';
      return {
        course_id: Number(c.id),
        name: c.name,
        qualification_code: c.qualification_code,
        enrolled_at: String(r.created_at ?? ''),
        start_date: r.start_date ? String(r.start_date) : null,
        end_date: r.end_date ? String(r.end_date) : null,
        enrollment_status: enrollmentStatus,
        completed_at: r.completed_at ? String(r.completed_at) : null,
        intake_label: r.intake_label ? String(r.intake_label) : null,
        link_status: r.status === 'inactive' ? 'inactive' : 'active',
        enrollment_status_changed_at: r.enrollment_status_changed_at
          ? String(r.enrollment_status_changed_at)
          : null,
      } satisfies StudentCourseEnrollment;
    })
    .filter((c): c is StudentCourseEnrollment => !!c);
}

export async function updateStudentCourseEnrollment(
  studentId: number,
  courseId: number,
  patch: Partial<
    Pick<StudentCourseEnrollment, 'start_date' | 'end_date' | 'enrollment_status' | 'completed_at' | 'intake_label'>
  >
): Promise<{ ok: boolean; error?: string }> {
  return upsertStudentCourseEnrollment({
    studentId,
    courseId,
    start_date: patch.start_date,
    end_date: patch.end_date,
    enrollment_status: patch.enrollment_status,
    completed_at: patch.completed_at,
    intake_label: patch.intake_label,
    allowCreate: false,
  });
}

export async function markStudentCourseComplete(
  studentId: number,
  courseId: number,
  completedAt: string
): Promise<{ ok: boolean; error?: string }> {
  const date = String(completedAt ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'Invalid completion date' };
  return updateStudentCourseEnrollment(studentId, courseId, {
    enrollment_status: 'completed',
    completed_at: date,
    end_date: date,
  });
}

export async function getActiveStudentCountsByCourse(courseIds: number[]): Promise<Record<number, number>> {
  const ids = Array.from(new Set(courseIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)));
  if (ids.length === 0) return {};
  const { data: scRows, error: scError } = await supabase
    .from('skyline_student_courses')
    .select('course_id, student_id')
    .in('course_id', ids)
    .eq('status', 'active');
  if (scError) {
    console.error('getActiveStudentCountsByCourse error', scError);
    return {};
  }
  const pairs = (scRows as Array<{ course_id: number; student_id: number }> | null) || [];
  const studentIds = Array.from(
    new Set(pairs.map((p) => Number(p.student_id)).filter((n) => Number.isFinite(n) && n > 0))
  );
  const activeStudentIds = new Set<number>();
  const chunkSize = 200;
  for (let i = 0; i < studentIds.length; i += chunkSize) {
    const chunk = studentIds.slice(i, i + chunkSize);
    const { data: stRows, error: stError } = await supabase
      .from('skyline_students')
      .select('id')
      .in('id', chunk)
      .eq('status', 'active');
    if (stError) {
      console.error('getActiveStudentCountsByCourse students error', stError);
      return {};
    }
    for (const r of (stRows as Array<{ id: number }> | null) || []) {
      const sid = Number(r.id);
      if (Number.isFinite(sid) && sid > 0) activeStudentIds.add(sid);
    }
  }
  const out: Record<number, number> = {};
  for (const id of ids) out[id] = 0;
  for (const p of pairs) {
    const sid = Number(p.student_id);
    if (!activeStudentIds.has(sid)) continue;
    const cid = Number(p.course_id);
    out[cid] = (out[cid] ?? 0) + 1;
  }
  return out;
}

export async function getCoursesByQualificationCodes(
  qualificationCodes: string[]
): Promise<Record<string, { id: number; name: string; qualification_code: string | null }>> {
  const codes = Array.from(
    new Set(
      (qualificationCodes || [])
        .map((c) => String(c ?? '').trim().toUpperCase())
        .filter(Boolean)
    )
  );
  if (codes.length === 0) return {};
  const out: Record<string, { id: number; name: string; qualification_code: string | null }> = {};
  const chunkSize = 200;
  for (let i = 0; i < codes.length; i += chunkSize) {
    const chunk = codes.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from('skyline_courses')
      .select('id, name, qualification_code')
      .in('qualification_code', chunk);
    if (error) {
      console.error('getCoursesByQualificationCodes error', error);
      continue;
    }
    for (const r of (data as Array<{ id: number; name: string; qualification_code: string | null }> | null) || []) {
      const code = String(r.qualification_code ?? '').trim().toUpperCase();
      if (!code) continue;
      out[code] = { id: Number(r.id), name: String(r.name ?? ''), qualification_code: r.qualification_code };
    }
  }
  return out;
}

export async function ensureStudentEnrolledInCourse(
  studentId: number,
  courseId: number,
  options?: {
    start_date?: string | null;
    end_date?: string | null;
    enrollment_status?: StudentCourseEnrollmentStatus;
  }
): Promise<{ ok: boolean; error?: string }> {
  const sid = Number(studentId);
  const cid = Number(courseId);
  if (!Number.isFinite(sid) || sid <= 0 || !Number.isFinite(cid) || cid <= 0) {
    return { ok: false, error: 'Invalid student or course' };
  }
  const existing = await listStudentCourseEnrollments(sid);
  if (existing.some((e) => e.course_id === cid)) return { ok: true };
  const hasInProgress = existing.some((e) => e.enrollment_status === 'in_progress');
  const status = defaultStatusForNewCourseEnrollment({
    hasInProgress,
    startDate: options?.start_date,
    endDate: options?.end_date,
    explicitStatus: options?.enrollment_status,
  });
  return upsertStudentCourseEnrollment({
    studentId: sid,
    courseId: cid,
    start_date: options?.start_date ?? null,
    end_date: options?.end_date ?? null,
    enrollment_status: status,
    link_status: 'active',
    allowCreate: true,
  });
}

export async function createStudent(
  input: CreateStudentInput
): Promise<{ ok: true; student: Student } | { ok: false; error: string; student?: Student }> {
  const first = input.first_name.trim();
  const last = (input.last_name ?? '').trim();
  const fullName = [first, last].filter(Boolean).join(' ');
  const studentIdKey = input.student_id.trim();
  if (!studentIdKey) {
    return { ok: false, error: 'Student ID is required' };
  }
  const { created_by } = getAuditFields();
  const pendingBatchId = input.batch_id ?? null;
  const { data, error } = await supabase
    .from('skyline_students')
    .insert({
      student_id: studentIdKey,
      name: fullName || first,
      first_name: first || null,
      last_name: last || null,
      email: input.email.trim(),
      phone: input.phone?.trim() || null,
      batch_id: null,
      date_of_birth: input.date_of_birth?.trim() || null,
      address_line_1: input.address_line_1?.trim() || null,
      address_line_2: input.address_line_2?.trim() || null,
      city: input.city?.trim() || null,
      state: input.state?.trim() || null,
      postal_code: input.postal_code?.trim() || null,
      country: input.country?.trim() || null,
      guardian_name: input.guardian_name?.trim() || null,
      guardian_phone: input.guardian_phone?.trim() || null,
      notes: input.notes?.trim() || null,
      status: input.status?.trim() || 'active',
      created_by,
    })
    .select('*')
    .single();
  if (error) {
    console.error('createStudent error', error);
    if (error.code === '23505') {
      return { ok: false, error: `A student with ID "${studentIdKey}" already exists.` };
    }
    return { ok: false, error: error.message || 'Failed to create student' };
  }
  const row = data as Record<string, unknown>;
  const firstName = String(row.first_name ?? '').trim();
  const lastName = String(row.last_name ?? '').trim();
  const createdStudent: Student = {
    id: Number(row.id),
    student_id: row.student_id ? String(row.student_id) : null,
    name: String(row.name ?? '') || [firstName, lastName].filter(Boolean).join(' '),
    first_name: firstName || null,
    last_name: lastName || null,
    email: String(row.email ?? ''),
    phone: row.phone ? String(row.phone) : null,
    batch_id: row.batch_id != null ? Number(row.batch_id) : null,
    batch_name: null,
    date_of_birth: row.date_of_birth ? String(row.date_of_birth) : null,
    address_line_1: row.address_line_1 ? String(row.address_line_1) : null,
    address_line_2: row.address_line_2 ? String(row.address_line_2) : null,
    city: row.city ? String(row.city) : null,
    state: row.state ? String(row.state) : null,
    postal_code: row.postal_code ? String(row.postal_code) : null,
    country: row.country ? String(row.country) : null,
    guardian_name: row.guardian_name ? String(row.guardian_name) : null,
    guardian_phone: row.guardian_phone ? String(row.guardian_phone) : null,
    notes: row.notes ? String(row.notes) : null,
    status: row.status ? String(row.status) : null,
    created_at: String(row.created_at ?? ''),
  };

  const courseIds = Array.from(
    new Set((input.course_ids ?? []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))
  );

  // If a batch is chosen, ensure its course is included in enrolments before assigning batch_id.
  let batchCourseId: number | null = null;
  if (pendingBatchId != null && Number.isFinite(Number(pendingBatchId)) && Number(pendingBatchId) > 0) {
    const batch = await getBatchById(Number(pendingBatchId));
    if (batch?.course_id) {
      batchCourseId = Number(batch.course_id);
      if (Number.isFinite(batchCourseId) && batchCourseId > 0 && !courseIds.includes(batchCourseId)) {
        courseIds.push(batchCourseId);
      }
    }
  }

  if (courseIds.length > 0) {
    const courseRes = await setStudentCourses(createdStudent.id, courseIds);
    if (!courseRes.ok) {
      // Retry as Tentative without dates so a bad default status cannot orphan the student.
      const retry = await setStudentCourses(createdStudent.id, courseIds, {
        enrollments: courseIds.map((course_id) => ({
          course_id,
          start_date: null,
          end_date: null,
          enrollment_status: 'tentative' as StudentCourseEnrollmentStatus,
        })),
      });
      if (!retry.ok) {
        return {
          ok: false,
          error: retry.error ?? courseRes.error ?? 'Student was created but course enrolment failed.',
          student: createdStudent,
        };
      }
    }
  }

  if (pendingBatchId != null && Number.isFinite(Number(pendingBatchId)) && Number(pendingBatchId) > 0) {
    if (batchCourseId) {
      const enrolled = await getActiveCourseIdsForStudent(createdStudent.id);
      if (!enrolled.includes(batchCourseId)) {
        const enrolRes = await ensureStudentEnrolledInCourse(createdStudent.id, batchCourseId);
        if (!enrolRes.ok) {
          return {
            ok: false,
            error:
              enrolRes.error ??
              'Student was created but could not enrol in the batch course required for batch assignment.',
            student: createdStudent,
          };
        }
      }
    }
    const { error: batchErr } = await supabase
      .from('skyline_students')
      .update({ batch_id: pendingBatchId, updated_by: getAuditFields().updated_by })
      .eq('id', createdStudent.id);
    if (batchErr) {
      console.error('createStudent batch_id assignment error', batchErr);
      return {
        ok: false,
        error: batchErr.message || 'Student was created but could not be assigned to the selected batch.',
        student: createdStudent,
      };
    }
    createdStudent.batch_id = Number(pendingBatchId);
  }

  return { ok: true, student: createdStudent };
}

export type UpdateStudentInput = Partial<Omit<CreateStudentInput, 'email'>> & { email?: string };

export async function updateStudent(id: number, input: UpdateStudentInput): Promise<Student | null> {
  const first = input.first_name !== undefined ? input.first_name.trim() : undefined;
  const last = input.last_name !== undefined ? (input.last_name ?? '').trim() : undefined;
  const fullName = first !== undefined && last !== undefined
    ? [first, last].filter(Boolean).join(' ')
    : undefined;
  const payload: Record<string, unknown> = {};
  if (fullName !== undefined) payload.name = fullName || first;
  if (first !== undefined) payload.first_name = first || null;
  if (last !== undefined) payload.last_name = last || null;
  if (input.email !== undefined) payload.email = input.email.trim();
  if (input.student_id !== undefined) payload.student_id = input.student_id?.trim() || null;
  if (input.phone !== undefined) payload.phone = input.phone?.trim() || null;
  if (input.batch_id !== undefined) {
    const bid = input.batch_id != null ? Number(input.batch_id) : null;
    if (bid != null && Number.isFinite(bid) && bid > 0) {
      const batch = await getBatchById(bid);
      if (batch?.course_id) {
        const enrolled = await getActiveCourseIdsForStudent(id);
        if (!enrolled.includes(batch.course_id)) {
          const enrolRes = await ensureStudentEnrolledInCourse(id, batch.course_id);
          if (!enrolRes.ok) {
            console.error('updateStudent batch course enrol failed', enrolRes.error);
            throw new Error(
              enrolRes.error ||
                'Student could not be enrolled in the batch course required for batch assignment.'
            );
          }
        }
      }
    }
    payload.batch_id = input.batch_id;
  }
  if (input.date_of_birth !== undefined) payload.date_of_birth = input.date_of_birth?.trim() || null;
  if (input.address_line_1 !== undefined) payload.address_line_1 = input.address_line_1?.trim() || null;
  if (input.address_line_2 !== undefined) payload.address_line_2 = input.address_line_2?.trim() || null;
  if (input.city !== undefined) payload.city = input.city?.trim() || null;
  if (input.state !== undefined) payload.state = input.state?.trim() || null;
  if (input.postal_code !== undefined) payload.postal_code = input.postal_code?.trim() || null;
  if (input.country !== undefined) payload.country = input.country?.trim() || null;
  if (input.guardian_name !== undefined) payload.guardian_name = input.guardian_name?.trim() || null;
  if (input.guardian_phone !== undefined) payload.guardian_phone = input.guardian_phone?.trim() || null;
  if (input.notes !== undefined) payload.notes = input.notes?.trim() || null;
  if (input.status !== undefined) payload.status = input.status?.trim() || null;
  payload.updated_by = getAuditFields().updated_by;
  const { data, error } = await supabase
    .from('skyline_students')
    .update(payload)
    .eq('id', id)
    .select('*, skyline_batches(name)')
    .single();
  if (error) {
    console.error('updateStudent error', error);
    return null;
  }
  const row = data as Record<string, unknown>;
  const batch = row.skyline_batches as { name?: string } | null;
  const firstName = String(row.first_name ?? '').trim();
  const lastName = String(row.last_name ?? '').trim();
  return {
    id: Number(row.id),
    student_id: row.student_id ? String(row.student_id) : null,
    name: String(row.name ?? '') || [firstName, lastName].filter(Boolean).join(' '),
    first_name: firstName || null,
    last_name: lastName || null,
    email: String(row.email ?? ''),
    phone: row.phone ? String(row.phone) : null,
    batch_id: row.batch_id != null ? Number(row.batch_id) : null,
    batch_name: batch?.name ?? null,
    date_of_birth: row.date_of_birth ? String(row.date_of_birth) : null,
    address_line_1: row.address_line_1 ? String(row.address_line_1) : null,
    address_line_2: row.address_line_2 ? String(row.address_line_2) : null,
    city: row.city ? String(row.city) : null,
    state: row.state ? String(row.state) : null,
    postal_code: row.postal_code ? String(row.postal_code) : null,
    country: row.country ? String(row.country) : null,
    guardian_name: row.guardian_name ? String(row.guardian_name) : null,
    guardian_phone: row.guardian_phone ? String(row.guardian_phone) : null,
    notes: row.notes ? String(row.notes) : null,
    status: row.status ? String(row.status) : null,
    created_at: String(row.created_at ?? ''),
  };
}

const DEFAULT_ROLES = { student: true, trainer: true, office: true };
const READ_ONLY_VISIBLE = { student: true, trainer: true, office: true };
const READ_ONLY_EDIT = { student: false, trainer: false, office: false };
const STUDENT_ONLY = { student: true, trainer: false, office: false };
const TRAINER_OFFICE_VISIBLE = { student: false, trainer: true, office: true };
const TRAINER_ONLY_EDIT = { student: false, trainer: true, office: false };
const TRAINER_OFFICE_EDIT = { student: false, trainer: true, office: true };
const ALL_CAN_EDIT = { student: true, trainer: true, office: true };

interface AssessmentTaskInput {
  task1_label: string;
  task1_method: string;
  task2_label: string;
  task2_method: string;
}

interface AssessmentTask {
  label: string;
  method: string;
}

async function createCompulsoryFormStructure(formId: number, assessmentTasks?: AssessmentTaskInput | AssessmentTask[]): Promise<void> {
  // Single compulsory step: Student & Trainer, Qualification, Assessment Tasks, Assessment Submission
  // Subtitle "Student, trainer, qualification & assessment" is used only for this step; other steps keep their own titles/subtitles
  const { data: step } = await supabase
    .from('skyline_form_steps')
    .insert({ form_id: formId, title: 'Introductory Details', subtitle: 'Student, trainer, qualification & assessment', sort_order: 0 })
    .select('id')
    .single();
  if (!step) return;
  const stepId = (step as { id: number }).id;

  const { data: sec1 } = await supabase
    .from('skyline_form_sections')
    .insert({ step_id: stepId, title: 'Student and trainer details', pdf_render_mode: 'normal', sort_order: 0 })
    .select('id')
    .single();
  if (sec1) {
    const s = sec1 as { id: number };
    await supabase.from('skyline_form_questions').insert([
      { section_id: s.id, type: 'short_text', code: 'student.fullName', label: 'Student Full Name', required: true, sort_order: 0, role_visibility: DEFAULT_ROLES, role_editability: STUDENT_ONLY },
      { section_id: s.id, type: 'short_text', code: 'student.id', label: 'Student ID', required: true, sort_order: 1, role_visibility: DEFAULT_ROLES, role_editability: STUDENT_ONLY },
      { section_id: s.id, type: 'short_text', code: 'student.email', label: 'Student Email', required: true, sort_order: 2, role_visibility: DEFAULT_ROLES, role_editability: STUDENT_ONLY },
      { section_id: s.id, type: 'short_text', code: 'trainer.fullName', label: 'Trainer Full Name', required: true, sort_order: 3, role_visibility: DEFAULT_ROLES, role_editability: TRAINER_OFFICE_EDIT },
    ]);
  }

  const { data: sec2a } = await supabase
    .from('skyline_form_sections')
    .insert({ step_id: stepId, title: 'Qualification and unit of competency', pdf_render_mode: 'normal', sort_order: 1 })
    .select('id')
    .single();
  if (sec2a) {
    const s = sec2a as { id: number };
    await supabase.from('skyline_form_questions').insert([
      { section_id: s.id, type: 'short_text', code: 'qualification.code', label: 'Qualification Code', sort_order: 0, role_visibility: READ_ONLY_VISIBLE, role_editability: READ_ONLY_EDIT },
      { section_id: s.id, type: 'short_text', code: 'qualification.name', label: 'Qualification Name', sort_order: 1, role_visibility: READ_ONLY_VISIBLE, role_editability: READ_ONLY_EDIT },
      { section_id: s.id, type: 'short_text', code: 'unit.code', label: 'Unit Code', sort_order: 2, role_visibility: READ_ONLY_VISIBLE, role_editability: READ_ONLY_EDIT },
      { section_id: s.id, type: 'short_text', code: 'unit.name', label: 'Unit Name', sort_order: 3, role_visibility: READ_ONLY_VISIBLE, role_editability: READ_ONLY_EDIT },
    ]);
  }

  const { data: sec2b } = await supabase
    .from('skyline_form_sections')
    .insert({ step_id: stepId, title: 'Assessment Tasks', description: 'The student must be assessed as satisfactory in each of the following assessment tasks in order to demonstrate competence.', pdf_render_mode: 'assessment_tasks', sort_order: 2 })
    .select('id')
    .single();
  let taskRowIds: number[] = [];
  if (sec2b) {
    const s = sec2b as { id: number };
    const { data: q } = await supabase
      .from('skyline_form_questions')
      .insert({ section_id: s.id, type: 'grid_table', code: 'assessment.tasks', label: 'Assessment Tasks', sort_order: 0, role_visibility: READ_ONLY_VISIBLE, role_editability: READ_ONLY_EDIT, pdf_meta: { columns: ['Evidence number', 'Assessment method/ Type of evidence'] } })
      .select('id')
      .single();
    if (q) {
      const qid = (q as { id: number }).id;
      let rowsToInsert: Array<{ question_id: number; row_label: string; row_help: string; sort_order: number }> = [];
      
      if (Array.isArray(assessmentTasks)) {
        // New format: array of tasks
        rowsToInsert = assessmentTasks.map((task, index) => ({
          question_id: qid,
          row_label: task.label,
          row_help: task.method,
          sort_order: index,
        }));
      } else if (assessmentTasks) {
        // Legacy format: object with task1/task2
        rowsToInsert = [
          { question_id: qid, row_label: assessmentTasks.task1_label, row_help: assessmentTasks.task1_method, sort_order: 0 },
          { question_id: qid, row_label: assessmentTasks.task2_label, row_help: assessmentTasks.task2_method, sort_order: 1 },
        ];
      } else {
        // Default fallback: Assessment Task - 1 and Assessment Task - 2
        rowsToInsert = [
          { question_id: qid, row_label: 'Assessment Task - 1', row_help: 'Written Questions', sort_order: 0 },
          { question_id: qid, row_label: 'Assessment Task - 2', row_help: 'Practical', sort_order: 1 },
        ];
      }
      
      for (const row of rowsToInsert) {
        const { data: inserted } = await supabase.from('skyline_form_question_rows').insert(row).select('id').single();
        if (inserted) taskRowIds.push((inserted as { id: number }).id);
      }
    }
  }

  const { data: sec2c } = await supabase
    .from('skyline_form_sections')
    .insert({ step_id: stepId, title: 'Assessment Submission Method', pdf_render_mode: 'assessment_submission', sort_order: 3 })
    .select('id')
    .single();
  if (sec2c) {
    const s = sec2c as { id: number };
    const { data: qSub } = await supabase
      .from('skyline_form_questions')
      .insert({ section_id: s.id, type: 'multi_choice', code: 'assessment.submission', label: 'Assessment Submission Method', sort_order: 0, role_visibility: READ_ONLY_VISIBLE, role_editability: STUDENT_ONLY })
      .select('id')
      .single();
    if (qSub) {
      const qid = (qSub as { id: number }).id;
      await supabase.from('skyline_form_question_options').insert([
        { question_id: qid, value: 'hand', label: 'By hand to trainer/assessor', sort_order: 0 },
        { question_id: qid, value: 'email', label: 'By email to trainer/assessor', sort_order: 1 },
        { question_id: qid, value: 'lms', label: 'Online submission via Learning Management System (LMS)', sort_order: 2 },
        { question_id: qid, value: 'other', label: 'Any other method', sort_order: 3 },
      ]);
    }
    await supabase.from('skyline_form_questions').insert({ section_id: s.id, type: 'short_text', code: 'assessment.otherDesc', label: 'Please describe other method', sort_order: 1, role_visibility: READ_ONLY_VISIBLE, role_editability: STUDENT_ONLY });
  }

  // Introductory Reasonable Adjustment – instruction only; full form is in Appendix A
  const { data: secRA } = await supabase
    .from('skyline_form_sections')
    .insert({ step_id: stepId, title: 'Reasonable Adjustment', description: 'Reasonable Adjustment: See Appendix A – Reasonable Adjustments for details and to record any adjustments applied.', pdf_render_mode: 'reasonable_adjustment_indicator', sort_order: 4 })
    .select('id')
    .single();
  if (secRA) {
    const raSecId = (secRA as { id: number }).id;
    await supabase.from('skyline_form_questions').insert([
      { section_id: raSecId, type: 'instruction_block', label: 'Reasonable Adjustment', help_text: 'Reasonable Adjustment: See Appendix A – Reasonable Adjustments for details and to record any adjustments applied.', sort_order: 0, role_visibility: READ_ONLY_VISIBLE, role_editability: { student: false, trainer: false, office: false } },
    ]);
  }

  await createDefaultSectionsToStep(stepId, 5);

  const { data: taskRows } = taskRowIds.length > 0
    ? await supabase.from('skyline_form_question_rows').select('id, row_label').in('id', taskRowIds).order('sort_order')
    : { data: [] };
  const rows = (taskRows as { id: number; row_label: string }[]) || [];
  let taskStepOrder = 1;
  for (const row of rows) {
    await insertAssessmentTaskStepWithSections(formId, row.id, row.row_label, taskStepOrder++);
  }

  // Assessment Summary Sheet (common, always after last assessment)
  const { data: summaryStep } = await supabase
    .from('skyline_form_steps')
    .insert({ form_id: formId, title: 'Assessment Summary', subtitle: 'Final record of student competency', sort_order: taskStepOrder++ })
    .select('id')
    .single();
  if (summaryStep) {
    await supabase
      .from('skyline_form_sections')
      .insert({ step_id: (summaryStep as { id: number }).id, title: 'Assessment Summary Sheet', pdf_render_mode: 'assessment_summary', sort_order: 0 });
  }

  // Appendix A - Reasonable Adjustments (full: policy, matrix, explanation, declaration, signature)
  const { data: reasonableStep } = await supabase
    .from('skyline_form_steps')
    .insert({ form_id: formId, title: 'Appendix A - Reasonable Adjustments', subtitle: 'Reasonable adjustment strategies and declaration', sort_order: taskStepOrder++ })
    .select('id')
    .single();
  if (reasonableStep) {
    const raStepId = (reasonableStep as { id: number }).id;
    const { data: raSection } = await supabase
      .from('skyline_form_sections')
      .insert({ step_id: raStepId, title: 'Appendix A – Reasonable Adjustments', description: null, pdf_render_mode: 'reasonable_adjustment', sort_order: 0 })
      .select('id')
      .single();
    if (raSection) {
      const raSecId = (raSection as { id: number }).id;
      await supabase.from('skyline_form_questions').insert([
        { section_id: raSecId, type: 'short_text', code: 'reasonable_adjustment_appendix.task', label: 'Write (task name and number) where reasonable adjustments have been applied', sort_order: 0, role_visibility: TRAINER_OFFICE_VISIBLE, role_editability: TRAINER_OFFICE_EDIT },
        { section_id: raSecId, type: 'long_text', code: 'reasonable_adjustment_appendix.explanation', label: 'Explanation of reasonable adjustments strategy used', sort_order: 1, role_visibility: TRAINER_OFFICE_VISIBLE, role_editability: TRAINER_OFFICE_EDIT },
        { section_id: raSecId, type: 'short_text', code: 'reasonable_adjustment_appendix.matrix', label: 'Reasonable Adjustment Strategies Matrix (select as applicable)', sort_order: 2, role_visibility: TRAINER_OFFICE_VISIBLE, role_editability: TRAINER_OFFICE_EDIT, pdf_meta: { appendixMatrix: true } },
        { section_id: raSecId, type: 'signature', code: 'trainer.reasonableAdjustmentAppendixSignature', label: 'Trainer/Assessor Signature', sort_order: 3, role_visibility: TRAINER_OFFICE_VISIBLE, role_editability: TRAINER_OFFICE_EDIT, pdf_meta: { showNameField: true, showDateField: true } },
      ]);
    }
  }

  // Learner Evaluation (after Appendix A, required on every form)
  const { data: learnerEvalStep } = await supabase
    .from('skyline_form_steps')
    .insert({ form_id: formId, title: 'Learner Evaluation', subtitle: 'Training evaluation and feedback', sort_order: taskStepOrder++ })
    .select('id')
    .single();
  if (learnerEvalStep) {
    const leStepId = (learnerEvalStep as { id: number }).id;
    
    // Participant Information Section
    const { data: participantSec } = await supabase
      .from('skyline_form_sections')
      .insert({ step_id: leStepId, title: 'Participant Information', pdf_render_mode: 'normal', sort_order: 0 })
      .select('id')
      .single();
    if (participantSec) {
      const pSecId = (participantSec as { id: number }).id;
      await supabase.from('skyline_form_questions').insert([
        { section_id: pSecId, type: 'short_text', code: 'evaluation.unitName', label: 'Unit of Competency Name', sort_order: 0, role_visibility: READ_ONLY_VISIBLE, role_editability: READ_ONLY_EDIT },
        { section_id: pSecId, type: 'short_text', code: 'evaluation.studentName', label: 'Student Name (Optional)', sort_order: 1, role_visibility: READ_ONLY_VISIBLE, role_editability: STUDENT_ONLY },
        { section_id: pSecId, type: 'short_text', code: 'evaluation.trainerName', label: 'Trainer/Assessor Name', sort_order: 2, role_visibility: READ_ONLY_VISIBLE, role_editability: TRAINER_ONLY_EDIT },
        { section_id: pSecId, type: 'short_text', code: 'evaluation.employer', label: 'Employer/Work site (if applicable)', sort_order: 3, role_visibility: READ_ONLY_VISIBLE, role_editability: TRAINER_ONLY_EDIT },
        { section_id: pSecId, type: 'short_text', code: 'evaluation.trainingDates', label: 'Dates of Training', sort_order: 4, role_visibility: READ_ONLY_VISIBLE, role_editability: STUDENT_ONLY },
        { section_id: pSecId, type: 'short_text', code: 'evaluation.evaluationDate', label: 'Date of Evaluation', sort_order: 5, role_visibility: READ_ONLY_VISIBLE, role_editability: STUDENT_ONLY },
      ]);
    }

    // Logistics and Support Evaluation Section
    const { data: logisticsSec } = await supabase
      .from('skyline_form_sections')
      .insert({ step_id: leStepId, title: 'Logistics and Support Evaluation', pdf_render_mode: 'likert_table', sort_order: 1 })
      .select('id')
      .single();
    if (logisticsSec) {
      const lSecId = (logisticsSec as { id: number }).id;
      const logisticsQ = await supabase.from('skyline_form_questions')
        .insert({ section_id: lSecId, type: 'likert_5', code: 'evaluation.logistics', label: 'Logistics and Support Evaluation', sort_order: 0, role_visibility: READ_ONLY_VISIBLE, role_editability: ALL_CAN_EDIT })
        .select('id')
        .single();
      if (logisticsQ.data) {
        const qId = (logisticsQ.data as { id: number }).id;
        await supabase.from('skyline_form_question_rows').insert([
          { question_id: qId, row_label: 'The communication regarding the required attendance and time to study to pass this unit was correct', sort_order: 0 },
          { question_id: qId, row_label: 'The staff were efficient and helpful.', sort_order: 1 },
          { question_id: qId, row_label: 'The training equipment and material used was effective and prepared.', sort_order: 2 },
          { question_id: qId, row_label: 'The training venue was conducive to learning (set-up for convenience of students, comfortable in terms of temperature, etc.)', sort_order: 3 },
        ]);
      }
      await supabase.from('skyline_form_questions').insert({
        section_id: lSecId, type: 'long_text', code: 'evaluation.logisticsComments', label: 'Additional Comments on Logistics and Support', sort_order: 1, role_visibility: READ_ONLY_VISIBLE, role_editability: ALL_CAN_EDIT
      });
    }

    // Trainer/Assessor Evaluation Section
    const { data: trainerSec } = await supabase
      .from('skyline_form_sections')
      .insert({ step_id: leStepId, title: 'Trainer/Assessor Evaluation', pdf_render_mode: 'likert_table', sort_order: 2 })
      .select('id')
      .single();
    if (trainerSec) {
      const tSecId = (trainerSec as { id: number }).id;
      const trainerQ = await supabase.from('skyline_form_questions')
        .insert({ section_id: tSecId, type: 'likert_5', code: 'evaluation.trainer', label: 'Trainer/Assessor Evaluation', sort_order: 0, role_visibility: READ_ONLY_VISIBLE, role_editability: ALL_CAN_EDIT })
        .select('id')
        .single();
      if (trainerQ.data) {
        const qId = (trainerQ.data as { id: number }).id;
        await supabase.from('skyline_form_question_rows').insert([
          { question_id: qId, row_label: 'The trainer/assessor was prepared and knowledgeable on the subject of the program', sort_order: 0 },
          { question_id: qId, row_label: 'The trainer/assessor encouraged student participation and input', sort_order: 1 },
          { question_id: qId, row_label: 'The trainer/assessor made use of a variety of methods, exercises, activities and discussions', sort_order: 2 },
          { question_id: qId, row_label: 'The trainer/assessor used the material in a structured and effective manner', sort_order: 3 },
          { question_id: qId, row_label: 'The trainer/assessor was approachable and respectful of the learners', sort_order: 4 },
          { question_id: qId, row_label: 'The trainer/assessor was punctual and kept to the schedule', sort_order: 5 },
          { question_id: qId, row_label: 'The trainer/assessor was easy to understand and used the correct language', sort_order: 6 },
        ]);
      }
      await supabase.from('skyline_form_questions').insert({
        section_id: tSecId, type: 'long_text', code: 'evaluation.trainerComments', label: 'Additional Comments on Training', sort_order: 1, role_visibility: READ_ONLY_VISIBLE, role_editability: ALL_CAN_EDIT
      });
    }

    // Learning Evaluation Section
    const { data: learningSec } = await supabase
      .from('skyline_form_sections')
      .insert({ step_id: leStepId, title: 'Learning Evaluation', pdf_render_mode: 'likert_table', sort_order: 3 })
      .select('id')
      .single();
    if (learningSec) {
      const learnSecId = (learningSec as { id: number }).id;
      const learningQ = await supabase.from('skyline_form_questions')
        .insert({ section_id: learnSecId, type: 'likert_5', code: 'evaluation.learning', label: 'Learning Evaluation', sort_order: 0, role_visibility: READ_ONLY_VISIBLE, role_editability: ALL_CAN_EDIT })
        .select('id')
        .single();
      if (learningQ.data) {
        const qId = (learningQ.data as { id: number }).id;
        await supabase.from('skyline_form_question_rows').insert([
          { question_id: qId, row_label: 'The learning outcomes of the unit are relevant and suitable.', sort_order: 0 },
          { question_id: qId, row_label: 'The content of the unit was relevant and suitable for the target group.', sort_order: 1 },
          { question_id: qId, row_label: 'The length of the training was suitable for the unit.', sort_order: 2 },
          { question_id: qId, row_label: 'The learning material assisted in the learning of new knowledge and skills to apply in a practical manner.', sort_order: 3 },
          { question_id: qId, row_label: 'The learning material was free from spelling and grammar errors', sort_order: 4 },
          { question_id: qId, row_label: 'Handouts and exercises were clear, concise and relevant to the outcomes and content.', sort_order: 5 },
          { question_id: qId, row_label: 'Learning material was generally of a high standard, and user-friendly', sort_order: 6 },
        ]);
      }
      await supabase.from('skyline_form_questions').insert({
        section_id: learnSecId, type: 'long_text', code: 'evaluation.learningComments', label: 'Additional Comments on Learning Evaluation', sort_order: 1, role_visibility: READ_ONLY_VISIBLE, role_editability: ALL_CAN_EDIT
      });
    }
  }

  // Written Evidence Checklist is now inside each assessment task (between Questions and Results)
}

export interface CreateFormInput {
  name: string;
  version?: string;
  qualification_code: string;
  qualification_name: string;
  unit_code: string;
  unit_name: string;
  assessment_tasks: AssessmentTask[];
  start_date?: string | null;
  end_date?: string | null;
  // Legacy fields for backward compatibility
  assessment_task_1_label?: string;
  assessment_task_1_method?: string;
  assessment_task_2_label?: string;
  assessment_task_2_method?: string;
}

export function getDefaultFormDates(): { start_date: string; end_date: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    start_date: `${y}-${pad(m + 1)}-01`,
    end_date: `${y}-${pad(m + 1)}-${pad(new Date(y, m + 1, 0).getDate())}`,
  };
}

export async function createForm(input: CreateFormInput): Promise<Form | null> {
  const { name, version, qualification_code, qualification_name, unit_code, unit_name, assessment_tasks, start_date: inputStart, end_date: inputEnd, assessment_task_1_label, assessment_task_1_method, assessment_task_2_label, assessment_task_2_method } = input;
  const defaults = getDefaultFormDates();
  const start_date = (inputStart && inputStart.trim()) ? inputStart.trim() : defaults.start_date;
  const end_date = (inputEnd && inputEnd.trim()) ? inputEnd.trim() : defaults.end_date;
  const { created_by } = getAuditFields();
  const { data, error } = await supabase
    .from('skyline_forms')
    .insert({
      name,
      qualification_code: qualification_code,
      qualification_name: qualification_name,
      unit_code: unit_code,
      unit_name: unit_name,
      version: (version || '1.0.0').trim() || '1.0.0',
      status: 'published',
      start_date,
      end_date,
      created_by,
    })
    .select('*')
    .single();
  if (error) {
    console.error('createForm error', error);
    return null;
  }
  const form = data as Form;
  
  // Use new array format if provided, otherwise fall back to legacy format
  if (assessment_tasks && assessment_tasks.length > 0) {
    await createCompulsoryFormStructure(form.id, assessment_tasks);
  } else if (assessment_task_1_label && assessment_task_1_method && assessment_task_2_label && assessment_task_2_method) {
    // Legacy format
    await createCompulsoryFormStructure(form.id, {
      task1_label: assessment_task_1_label,
      task1_method: assessment_task_1_method,
      task2_label: assessment_task_2_label,
      task2_method: assessment_task_2_method,
    });
  } else {
    // Default fallback
    await createCompulsoryFormStructure(form.id);
  }
  return form;
}

export async function listForms(
  status?: string,
  options?: { asAdmin?: boolean }
): Promise<Form[]> {
  let query = supabase.from('skyline_forms').select('*').order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  if (!options?.asAdmin) query = query.eq('active', true);
  const { data, error } = await query;
  if (error) {
    console.error('listForms error', error);
    return [];
  }
  return (data as Form[]) || [];
}

export async function listFormsPaged(
  page = 1,
  pageSize = 20,
  status?: string,
  courseId?: number,
  search?: string,
  options?: { asAdmin?: boolean }
): Promise<PaginatedResult<Form>> {
  const from = Math.max(0, (page - 1) * pageSize);
  const to = from + pageSize - 1;
  let query = supabase
    .from('skyline_forms')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  if (!options?.asAdmin) query = query.eq('active', true);
  if (search && search.trim()) {
    query = query.ilike('name', `%${search.trim()}%`);
  }
  if (courseId && Number.isFinite(courseId)) {
    const { data: links } = await supabase
      .from('skyline_course_forms')
      .select('form_id')
      .eq('course_id', courseId);
    const formIds = ((links as { form_id: number }[]) || []).map((r) => r.form_id);
    if (formIds.length === 0) return { data: [], total: 0, page, pageSize };
    query = query.in('id', formIds);
  }
  const { data, error, count } = await query.range(from, to);
  if (error) {
    console.error('listFormsPaged error', error);
    return { data: [], total: 0, page, pageSize };
  }
  return {
    data: (data as Form[]) || [],
    total: Number(count ?? 0),
    page,
    pageSize,
  };
}

/** Unit/form picker: only forms that have at least one assessment in the course active on this day. */
export async function listFormsPagedForCourseAndActiveOn(
  page = 1,
  pageSize = 20,
  courseId: number,
  search: string | undefined,
  options: { asAdmin?: boolean } | undefined,
  activeOnIso: string
): Promise<PaginatedResult<Form>> {
  const cid = Number(courseId);
  if (!Number.isFinite(cid) || cid <= 0) return { data: [], total: 0, page, pageSize };
  const allowed = await listFormIdsForCourseActiveOn(cid, activeOnIso);
  if (allowed.length === 0) return { data: [], total: 0, page, pageSize };
  const from = Math.max(0, (page - 1) * pageSize);
  const to = from + pageSize - 1;
  let query = supabase
    .from('skyline_forms')
    .select('*', { count: 'exact' })
    .in('id', allowed)
    .order('name', { ascending: true });
  if (!options?.asAdmin) query = query.eq('active', true);
  if (search && search.trim()) query = query.ilike('name', `%${search.trim()}%`);
  const { data, error, count } = await query.range(from, to);
  if (error) {
    console.error('listFormsPagedForCourseAndActiveOn error', error);
    return { data: [], total: 0, page, pageSize };
  }
  return {
    data: (data as Form[]) || [],
    total: Number(count ?? 0),
    page,
    pageSize,
  };
}

// ============ Courses (form categories, many-to-many with forms) ============

export interface Course {
  id: number;
  name: string;
  /** Stored on the course row; may be absent from API before migration. */
  qualification_code?: string | null;
  sort_order: number;
  created_at: string;
}

export interface CourseLinkExport {
  id: number;
  course_id: number;
  batch_id: number | null;
  payload_json: unknown;
  created_at: string;
}

export async function listCourses(): Promise<Course[]> {
  const { data, error } = await supabase
    .from('skyline_courses')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (error) {
    console.error('listCourses error', error);
    return [];
  }
  return (data as Course[]) || [];
}

export async function listCoursesPaged(
  page = 1,
  pageSize = 20,
  search?: string,
  restrictToCourseIds?: number[] | null
): Promise<PaginatedResult<Course>> {
  const from = Math.max(0, (page - 1) * pageSize);
  const to = from + pageSize - 1;
  let query = supabase
    .from('skyline_courses')
    .select('*', { count: 'exact' })
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  const rid = restrictToCourseIds
    ? [...new Set(restrictToCourseIds.map(Number).filter((n) => Number.isFinite(n) && n > 0))]
    : [];
  if (rid.length === 1) {
    query = query.eq('id', rid[0]);
  } else if (rid.length > 1) {
    query = query.in('id', rid);
  }
  const q = (search ?? '').trim();
  if (q) {
    const like = `%${q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
    query = query.or(`name.ilike.${like},qualification_code.ilike.${like}`);
  }
  const { data, error, count } = await query.range(from, to);
  if (error) {
    console.error('listCoursesPaged error', error);
    return { data: [], total: 0, page, pageSize };
  }
  return {
    data: (data as Course[]) || [],
    total: Number(count ?? 0),
    page,
    pageSize,
  };
}

export async function createCourse(
  name: string,
  qualificationCode?: string | null
): Promise<Course | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const code = (qualificationCode ?? '').trim() || null;
  const { created_by } = getAuditFields();
  const { data, error } = await supabase
    .from('skyline_courses')
    .insert({ name: trimmed, qualification_code: code, created_by })
    .select('*')
    .single();
  if (error) {
    console.error('createCourse error', error);
    return null;
  }
  return data as Course;
}

export async function updateCourse(
  id: number,
  input: { name?: string; qualification_code?: string | null; sort_order?: number }
): Promise<Course | null> {
  const payload: Record<string, unknown> = {};
  if (input.name !== undefined) payload.name = input.name.trim();
  if (input.qualification_code !== undefined) {
    const c = input.qualification_code;
    payload.qualification_code = c == null || String(c).trim() === '' ? null : String(c).trim();
  }
  if (input.sort_order !== undefined) payload.sort_order = input.sort_order;
  payload.updated_by = getAuditFields().updated_by;
  const { data, error } = await supabase
    .from('skyline_courses')
    .update(payload)
    .eq('id', id)
    .select('*')
    .single();
  if (error) {
    console.error('updateCourse error', error);
    return null;
  }
  return data as Course;
}

export async function deleteCourse(id: number): Promise<boolean> {
  const { error } = await supabase.from('skyline_courses').delete().eq('id', id);
  if (error) {
    console.error('deleteCourse error', error);
    return false;
  }
  return true;
}

/** Forms assigned to this course. */
export async function getFormsForCourse(
  courseId: number,
  options?: { asAdmin?: boolean }
): Promise<Form[]> {
  const { data: links, error: linkErr } = await supabase
    .from('skyline_course_forms')
    .select('form_id')
    .eq('course_id', courseId);
  if (linkErr || !links?.length) return [];
  const formIds = (links as { form_id: number }[]).map((r) => r.form_id);
  let query = supabase
    .from('skyline_forms')
    .select('*')
    .in('id', formIds)
    .order('name');
  if (!options?.asAdmin) query = query.eq('active', true);
  const { data: forms, error } = await query;
  if (error) {
    console.error('getFormsForCourse error', error);
    return [];
  }
  return (forms as Form[]) || [];
}

export async function getCourseLabelsForStudent(
  studentId: number
): Promise<Array<{ id: number; name: string; qualification_code: string | null }>> {
  const sid = Number(studentId);
  if (!Number.isFinite(sid) || sid <= 0) return [];
  const { data, error } = await supabase
    .from('skyline_student_courses')
    .select('course_id, skyline_courses(id, name, qualification_code)')
    .eq('student_id', sid)
    .eq('status', 'active');
  if (error) {
    console.error('getCourseLabelsForStudent error', error);
    return [];
  }
  const rows =
    (data as unknown as Array<{ skyline_courses: { id: number; name: string; qualification_code: string | null } | null }> | null) || [];
  return rows
    .map((r) => r.skyline_courses)
    .filter((c): c is { id: number; name: string; qualification_code: string | null } => !!c);
}

export async function upsertStudentAssessmentsForCourse(
  studentId: number,
  courseId: number,
  dates?: { start_date?: string | null; end_date?: string | null }
): Promise<{ created: number; updated: number; skipped: number }> {
  const sid = Number(studentId);
  const cid = Number(courseId);
  if (!Number.isFinite(sid) || sid <= 0 || !Number.isFinite(cid) || cid <= 0) return { created: 0, updated: 0, skipped: 0 };
  const forms = await getFormsForCourse(cid, { asAdmin: true });
  const start = (dates?.start_date ?? null) as string | null;
  const end = (dates?.end_date ?? null) as string | null;
  let created = 0;
  let updated = 0;
  for (const f of forms) {
    const formId = Number(f.id);
    if (!Number.isFinite(formId) || formId <= 0) continue;
    const existing = await getInstanceForStudentAndForm(formId, sid);
    if (!existing) {
      const inst = await createFormInstance(formId, 'student', sid, { start_date: start, end_date: end });
      if (inst?.id) {
        created++;
        if (end) await extendInstanceAccessTokensToDate(inst.id, 'student', end);
      }
    } else {
      await updateFormInstanceDates(existing.id, { start_date: start, end_date: end });
      if (end) await extendInstanceAccessTokensToDate(existing.id, 'student', end);
      updated++;
    }
  }
  const skipped = forms.length === 0 ? 1 : 0;
  return { created, updated, skipped };
}

export async function listActiveFormsByQualificationCode(qualificationCode?: string | null): Promise<Form[]> {
  const code = String(qualificationCode ?? '').trim();
  let query = supabase.from('skyline_forms').select('*').eq('active', true).order('name');
  if (code) query = query.eq('qualification_code', code);
  const { data, error } = await query;
  if (error) {
    console.error('listActiveFormsByQualificationCode error', error);
    return [];
  }
  return (data as Form[]) || [];
}

export async function upsertStudentAssessmentsForForms(
  studentId: number,
  formIds: number[],
  dates?: { start_date?: string | null; end_date?: string | null }
): Promise<{ created: number; updated: number; skipped: number }> {
  const sid = Number(studentId);
  if (!Number.isFinite(sid) || sid <= 0) return { created: 0, updated: 0, skipped: 0 };
  const ids = Array.from(new Set((formIds || []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)));
  if (ids.length === 0) return { created: 0, updated: 0, skipped: 1 };
  const start = (dates?.start_date ?? null) as string | null;
  const end = (dates?.end_date ?? null) as string | null;
  let created = 0;
  let updated = 0;
  for (const formId of ids) {
    const existing = await getInstanceForStudentAndForm(formId, sid);
    if (!existing) {
      const inst = await createFormInstance(formId, 'student', sid, { start_date: start, end_date: end });
      if (inst?.id) {
        created++;
        if (end) await extendInstanceAccessTokensToDate(inst.id, 'student', end);
      }
    } else {
      await updateFormInstanceDates(existing.id, { start_date: start, end_date: end });
      if (end) await extendInstanceAccessTokensToDate(existing.id, 'student', end);
      updated++;
    }
  }
  return { created, updated, skipped: 0 };
}

/** Courses for multiple forms at once (e.g. forms list). Returns map formId -> Course[]. */
export async function getCoursesForForms(formIds: number[]): Promise<Map<number, Course[]>> {
  const result = new Map<number, Course[]>();
  if (formIds.length === 0) return result;
  const { data: links, error: linkErr } = await supabase
    .from('skyline_course_forms')
    .select('course_id, form_id')
    .in('form_id', formIds);
  if (linkErr || !links?.length) return result;
  const courseIds = [...new Set((links as { course_id: number }[]).map((r) => r.course_id))];
  const { data: courses, error } = await supabase
    .from('skyline_courses')
    .select('*')
    .in('id', courseIds)
    .order('sort_order')
    .order('name');
  if (error || !courses?.length) return result;
  const courseMap = new Map((courses as Course[]).map((c) => [c.id, c]));
  for (const { form_id, course_id } of links as { form_id: number; course_id: number }[]) {
    const c = courseMap.get(course_id);
    if (c) {
      const list = result.get(form_id) ?? [];
      list.push(c);
      result.set(form_id, list);
    }
  }
  return result;
}

/** Courses this form belongs to. */
export async function getCoursesForForm(formId: number): Promise<Course[]> {
  const { data: links, error: linkErr } = await supabase
    .from('skyline_course_forms')
    .select('course_id')
    .eq('form_id', formId);
  if (linkErr || !links?.length) return [];
  const courseIds = (links as { course_id: number }[]).map((r) => r.course_id);
  const { data: courses, error } = await supabase
    .from('skyline_courses')
    .select('*')
    .in('id', courseIds)
    .order('sort_order')
    .order('name');
  if (error) {
    console.error('getCoursesForForm error', error);
    return [];
  }
  return (courses as Course[]) || [];
}

/** Replace form-course assignments. courseIds = which courses this form belongs to. */
export async function setFormCourses(formId: number, courseIds: number[]): Promise<boolean> {
  const { error: delErr } = await supabase.from('skyline_course_forms').delete().eq('form_id', formId);
  if (delErr) {
    console.error('setFormCourses delete error', delErr);
    return false;
  }
  if (courseIds.length === 0) return true;
  const rows = courseIds.map((course_id) => ({ course_id, form_id: formId }));
  const { error } = await supabase.from('skyline_course_forms').insert(rows);
  if (error) {
    console.error('setFormCourses insert error', error);
    return false;
  }
  return true;
}

/** Set which forms belong to a course. Replaces existing. */
export async function setCourseForms(courseId: number, formIds: number[]): Promise<boolean> {
  const { error: delErr } = await supabase.from('skyline_course_forms').delete().eq('course_id', courseId);
  if (delErr) {
    console.error('setCourseForms delete error', delErr);
    return false;
  }
  if (formIds.length === 0) return true;
  const rows = formIds.map((form_id) => ({ course_id: courseId, form_id }));
  const { error } = await supabase.from('skyline_course_forms').insert(rows);
  if (error) {
    console.error('setCourseForms insert error', error);
    return false;
  }
  return true;
}

export async function createCourseLinkExport(
  courseId: number,
  batchId: number | null,
  payload: unknown
): Promise<CourseLinkExport | null> {
  try {
    const { created_by } = getAuditFields();
    const { data, error } = await supabase
      .from('skyline_course_link_exports')
      .insert({
        course_id: courseId,
        batch_id: batchId,
        payload_json: payload,
        created_by,
      })
      .select('id, course_id, batch_id, payload_json, created_at')
      .single();
    if (error || !data) {
      console.error('createCourseLinkExport error', error);
      return null;
    }
    const row = data as Record<string, unknown>;
    return {
      id: Number(row.id),
      course_id: Number(row.course_id),
      batch_id: row.batch_id != null ? Number(row.batch_id) : null,
      payload_json: row.payload_json,
      created_at: String(row.created_at ?? ''),
    };
  } catch (e) {
    console.error('createCourseLinkExport error', e);
    return null;
  }
}

export async function listCourseLinkExports(courseId: number, limit = 10): Promise<CourseLinkExport[]> {
  try {
    const { data, error } = await supabase
      .from('skyline_course_link_exports')
      .select('id, course_id, batch_id, payload_json, created_at')
      .eq('course_id', courseId)
      .order('created_at', { ascending: false })
      .limit(Math.max(1, Math.min(50, limit)));
    if (error) {
      console.error('listCourseLinkExports error', error);
      return [];
    }
    return ((data as Record<string, unknown>[]) || []).map((row) => ({
      id: Number(row.id),
      course_id: Number(row.course_id),
      batch_id: row.batch_id != null ? Number(row.batch_id) : null,
      payload_json: row.payload_json,
      created_at: String(row.created_at ?? ''),
    }));
  } catch (e) {
    console.error('listCourseLinkExports error', e);
    return [];
  }
}

/** Returns true if another form (excluding excludeFormId) already has this name (case-insensitive trim). */
export async function formNameExists(name: string, excludeFormId?: number): Promise<boolean> {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const forms = await listForms(undefined, { asAdmin: true });
  return forms.some((f) => f.id !== excludeFormId && f.name.trim().toLowerCase() === trimmed.toLowerCase());
}

function nextVersion(version: string | null): string {
  if (!version || typeof version !== 'string') return '1.1.0';
  const parts = version.trim().split('.').map((s) => parseInt(s, 10) || 0);
  const [major = 1, minor = 0] = parts;
  return `${major}.${minor + 1}.0`;
}

export async function duplicateForm(formId: number): Promise<Form | null> {
  const form = await fetchForm(formId, { allowInactiveForAdmin: true });
  if (!form) return null;

  const newVersion = nextVersion(form.version);
  const newName = `${form.name} (Copy)`;

  const { start_date: defStart, end_date: defEnd } = getDefaultFormDates();
  const { created_by } = getAuditFields();
  const { data: newFormData, error: formErr } = await supabase
    .from('skyline_forms')
    .insert({
      name: newName,
      version: newVersion,
      status: 'published',
      unit_code: form.unit_code,
      unit_name: form.unit_name,
      qualification_code: form.qualification_code,
      qualification_name: form.qualification_name,
      header_asset_url: form.header_asset_url,
      cover_asset_url: form.cover_asset_url,
      start_date: form.start_date ?? defStart,
      end_date: form.end_date ?? defEnd,
      created_by,
    })
    .select('*')
    .single();
  if (formErr || !newFormData) {
    console.error('duplicateForm: failed to insert form', formErr);
    return null;
  }
  const newForm = newFormData as Form;
  const newFormId = newForm.id;

  const steps = await fetchFormSteps(formId);
  const rowIdMap = new Map<number, number>();
  /** Old question id → new question id (required to rewire contentBlocks / isAdditionalBlockOf). */
  const questionIdMap = new Map<number, number>();

  for (const step of steps) {
    const { data: newStepData, error: stepErr } = await supabase
      .from('skyline_form_steps')
      .insert({
        form_id: newFormId,
        title: step.title,
        subtitle: step.subtitle,
        sort_order: step.sort_order,
      })
      .select('id')
      .single();
    if (stepErr || !newStepData) {
      console.error('duplicateForm: failed to insert step', stepErr);
      continue;
    }
    const newStepId = (newStepData as { id: number }).id;

    const { data: sections } = await supabase
      .from('skyline_form_sections')
      .select('*')
      .eq('step_id', step.id)
      .order('sort_order', { ascending: true });
    const sectionsList = (sections as (FormSection & { assessment_task_row_id?: number | null })[]) || [];

    for (const section of sectionsList) {
      const mappedRowId = section.assessment_task_row_id != null ? rowIdMap.get(section.assessment_task_row_id) ?? null : null;
      const { data: newSectionData, error: sectionErr } = await supabase
        .from('skyline_form_sections')
        .insert({
          step_id: newStepId,
          title: section.title,
          description: section.description ?? null,
          pdf_render_mode: section.pdf_render_mode,
          sort_order: section.sort_order,
          assessment_task_row_id: mappedRowId,
          instructions_meta: (section as unknown as { instructions_meta?: unknown }).instructions_meta ?? null,
        })
        .select('id')
        .single();
      if (sectionErr || !newSectionData) {
        console.error('duplicateForm: failed to insert section', sectionErr);
        continue;
      }
      const newSectionId = (newSectionData as { id: number }).id;

      const { data: questions } = await supabase
        .from('skyline_form_questions')
        .select('*')
        .eq('section_id', section.id)
        .order('sort_order', { ascending: true });
      const questionsList = (questions as FormQuestion[]) || [];

      for (const q of questionsList) {
        const { data: newQData, error: qErr } = await supabase
          .from('skyline_form_questions')
          .insert({
            section_id: newSectionId,
            type: q.type,
            code: q.code,
            label: q.label,
            help_text: q.help_text ?? null,
            required: q.required ?? false,
            sort_order: q.sort_order,
            role_visibility: q.role_visibility ?? {},
            role_editability: q.role_editability ?? {},
            // Temporary: contentBlocks / isAdditionalBlockOf still point at OLD ids until remap pass.
            pdf_meta: q.pdf_meta ?? {},
          })
          .select('id')
          .single();
        if (qErr || !newQData) {
          console.error('duplicateForm: failed to insert question', qErr);
          continue;
        }
        const newQuestionId = (newQData as { id: number }).id;
        questionIdMap.set(q.id, newQuestionId);

        const { data: options } = await supabase
          .from('skyline_form_question_options')
          .select('*')
          .eq('question_id', q.id)
          .order('sort_order', { ascending: true });
        const optionsList = (options as FormQuestionOption[]) || [];
        if (optionsList.length > 0) {
          await supabase.from('skyline_form_question_options').insert(
            optionsList.map((o) => ({
              question_id: newQuestionId,
              value: o.value,
              label: o.label,
              sort_order: o.sort_order,
            }))
          );
        }

        const { data: rows } = await supabase
          .from('skyline_form_question_rows')
          .select('*')
          .eq('question_id', q.id)
          .order('sort_order', { ascending: true });
        const rowsList = (rows as FormQuestionRow[]) || [];
        for (const row of rowsList) {
          const { data: newRowData, error: rowErr } = await supabase
            .from('skyline_form_question_rows')
            .insert({
              question_id: newQuestionId,
              row_label: row.row_label,
              row_help: row.row_help ?? null,
              row_image_url: row.row_image_url ?? null,
              row_meta: row.row_meta ?? null,
              sort_order: row.sort_order,
            })
            .select('id')
            .single();
          if (!rowErr && newRowData) {
            rowIdMap.set(row.id, (newRowData as { id: number }).id);
          }
        }
      }
    }
  }

  // Rewire contentBlocks.questionId + isAdditionalBlockOf so each cloned table keeps a unique child id.
  // Without this, every parent that embedded the same child grid would share answers (data corruption).
  if (questionIdMap.size > 0) {
    const newQuestionIds = Array.from(questionIdMap.values());
    const { data: clonedQuestions } = await supabase
      .from('skyline_form_questions')
      .select('id, pdf_meta')
      .in('id', newQuestionIds);
    for (const cq of (clonedQuestions as Array<{ id: number; pdf_meta: unknown }>) || []) {
      // pdf_meta was copied from the SOURCE question; map using old→new by reversing via source meta.
      // The cloned row still has OLD ids in pdf_meta — remap those through questionIdMap.
      const remapped = remapPdfMetaQuestionIds(cq.pdf_meta, questionIdMap);
      if (remapped) {
        await supabase.from('skyline_form_questions').update({ pdf_meta: remapped }).eq('id', cq.id);
      }
    }
  }

  // Assessment task labels (Assessment Task - 1, Assessment Task - 2, …) are LOCAL to each form.
  // Rows and step titles were already cloned with the source labels — do NOT renumber them
  // based on max(task number) inside the copy (that produced 3/4, 5/6, … across duplicates).

  return newForm;
}

/**
 * Read-only: plan form-scoped renumber of default "Assessment Task N" labels
 * (e.g. bad duplicates that ended up as Task 3/4). Does not write.
 */
export async function diagnoseAssessmentTaskLabelScope(
  formId: number
): Promise<
  | { ok: true; formId: number; plans: Array<{ id: number; from: string; to: string }> }
  | { ok: false; error: string }
> {
  const fid = Number(formId);
  if (!Number.isFinite(fid) || fid <= 0) return { ok: false, error: 'Invalid form id.' };
  const rows = await loadAssessmentTaskRowsForForm(fid);
  if (rows == null) return { ok: false, error: 'Assessment tasks grid not found on this form.' };
  return { ok: true, formId: fid, plans: planFormScopedAssessmentTaskLabelRepair(rows) };
}

/**
 * Opt-in repair: renumber default Assessment Task labels to 1..N by local sort_order.
 * Preserves custom suffixes; never changes IDs, questions, answers, or other forms.
 */
export async function repairAssessmentTaskLabelsToLocalOrder(
  formId: number
): Promise<
  | { ok: true; formId: number; updated: number; plans: Array<{ id: number; from: string; to: string }> }
  | { ok: false; error: string }
> {
  const diagnosis = await diagnoseAssessmentTaskLabelScope(formId);
  if (!diagnosis.ok) return diagnosis;
  const { plans } = diagnosis;
  if (plans.length === 0) {
    return { ok: true, formId: diagnosis.formId, updated: 0, plans: [] };
  }

  const { data: steps } = await supabase
    .from('skyline_form_steps')
    .select('id')
    .eq('form_id', diagnosis.formId);
  const stepIds = ((steps as { id: number }[]) ?? []).map((s) => s.id);

  let updated = 0;
  for (const plan of plans) {
    const { error } = await supabase
      .from('skyline_form_question_rows')
      .update({ row_label: plan.to })
      .eq('id', plan.id);
    if (error) return { ok: false, error: error.message };
    updated += 1;
    if (stepIds.length > 0) {
      const { data: linked } = await supabase
        .from('skyline_form_sections')
        .select('step_id')
        .in('step_id', stepIds)
        .eq('assessment_task_row_id', plan.id);
      const linkedStepIds = [
        ...new Set(((linked as { step_id: number }[]) ?? []).map((s) => s.step_id)),
      ];
      for (const sid of linkedStepIds) {
        const { error: stepErr } = await supabase
          .from('skyline_form_steps')
          .update({ title: plan.to })
          .eq('id', sid);
        if (stepErr) return { ok: false, error: stepErr.message };
      }
    }
  }
  return { ok: true, formId: diagnosis.formId, updated, plans };
}

async function loadAssessmentTaskRowsForForm(
  formId: number
): Promise<Array<{ id: number; row_label: string; sort_order: number }> | null> {
  const { data: steps } = await supabase
    .from('skyline_form_steps')
    .select('id')
    .eq('form_id', formId)
    .order('sort_order');
  const stepIds = ((steps as { id: number }[]) ?? []).map((s) => s.id);
  if (stepIds.length === 0) return null;
  const { data: assessmentSecs } = await supabase
    .from('skyline_form_sections')
    .select('id')
    .in('step_id', stepIds)
    .eq('pdf_render_mode', 'assessment_tasks');
  const assessmentSecId = (assessmentSecs as { id: number }[])?.[0]?.id;
  if (!assessmentSecId) return null;
  const { data: assessmentQ } = await supabase
    .from('skyline_form_questions')
    .select('id')
    .eq('section_id', assessmentSecId)
    .eq('code', 'assessment.tasks')
    .maybeSingle();
  if (!assessmentQ) return null;
  const qid = (assessmentQ as { id: number }).id;
  const { data: taskRows } = await supabase
    .from('skyline_form_question_rows')
    .select('id, row_label, sort_order')
    .eq('question_id', qid)
    .order('sort_order');
  return (taskRows as { id: number; row_label: string; sort_order: number }[]) ?? [];
}

/**
 * Superadmin: permanently delete a form. Related rows cascade (course links, steps, questions, instances, answers, tokens).
 */
export async function deleteFormSuperadmin(formId: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const fid = Number(formId);
  if (!Number.isFinite(fid) || fid <= 0) return { ok: false, error: 'Invalid form id.' };
  const { error } = await supabase.from('skyline_forms').delete().eq('id', fid);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export type SharedContentBlockDiagnosis = {
  formId: number;
  sharedChildCount: number;
  plans: Array<{
    sharedChildId: number;
    ownerParentId: number | null;
    parentsNeedingClone: number[];
  }>;
  /** Flat diagnostic rows for admin/dev (parent → child → usage). */
  blocks?: Array<{
    parent_question_id: number;
    parent_question_label: string;
    parent_display_order: number;
    block_index: number;
    block_type: string | null;
    referenced_child_question_id: number;
    child_question_exists: boolean;
    child_question_type: string | null;
    is_additional_block_of: string | null;
    duplicate_reference_count: number;
    row_ids?: number[];
  }>;
};

export type SharedContentBlockRepairResult =
  | {
      ok: true;
      formId: number;
      clonesCreated: number;
      rewiredParents: number;
      duplicatesFound: number;
      remainingDuplicates: number;
      diagnosis: SharedContentBlockDiagnosis;
      projectRef?: string;
    }
  | { ok: false; error: string; remainingDuplicates?: number; diagnosis?: SharedContentBlockDiagnosis };

function supabaseProjectRef(): string | undefined {
  try {
    const url = (import.meta as { env?: { VITE_SUPABASE_URL?: string } }).env?.VITE_SUPABASE_URL;
    if (!url) return undefined;
    return new URL(url).hostname.split('.')[0];
  } catch {
    return undefined;
  }
}

function diagnosisFromQuestions(
  formId: number,
  questions: Array<{ id: number; label?: string | null; type?: string; sort_order?: number; pdf_meta?: unknown; rows?: Array<{ id: number }> }>
): SharedContentBlockDiagnosis {
  const shared = findSharedContentBlockQuestionIds(questions);
  const plans = planSharedContentBlockRepairs(questions, shared);
  const byId = new Map(questions.map((q) => [q.id, q]));
  const blocks: NonNullable<SharedContentBlockDiagnosis['blocks']> = [];
  for (const q of questions) {
    const pm = q.pdf_meta as PdfMetaLike | null | undefined;
    const contentBlocks = Array.isArray(pm?.contentBlocks) ? pm!.contentBlocks! : [];
    contentBlocks.forEach((b, blockIndex) => {
      const cid = Number(b?.questionId);
      if (!Number.isFinite(cid) || cid <= 0) return;
      const child = byId.get(cid);
      let usage = 0;
      for (const other of questions) {
        const opm = other.pdf_meta as PdfMetaLike | null | undefined;
        const obs = Array.isArray(opm?.contentBlocks) ? opm!.contentBlocks! : [];
        if (obs.some((x) => Number(x?.questionId) === cid)) usage += 1;
      }
      blocks.push({
        parent_question_id: q.id,
        parent_question_label: String(q.label ?? '').slice(0, 120),
        parent_display_order: Number(q.sort_order ?? 0),
        block_index: blockIndex,
        block_type: typeof b?.type === 'string' ? b.type : null,
        referenced_child_question_id: cid,
        child_question_exists: !!child,
        child_question_type: child?.type ?? null,
        is_additional_block_of:
          pm?.isAdditionalBlockOf != null ? String(pm.isAdditionalBlockOf) : null,
        duplicate_reference_count: usage,
        row_ids: (child?.rows ?? []).map((r) => r.id),
      });
    });
  }
  blocks.sort(
    (a, b) =>
      b.duplicate_reference_count - a.duplicate_reference_count ||
      a.referenced_child_question_id - b.referenced_child_question_id ||
      a.parent_display_order - b.parent_display_order
  );
  return { formId, sharedChildCount: shared.size, plans, blocks };
}

/** Read-only: detect contentBlocks.questionId values shared by multiple parents (answer cross-talk). */
export async function diagnoseSharedContentBlockGrids(
  formId: number
): Promise<SharedContentBlockDiagnosis | { ok: false; error: string }> {
  const fid = Number(formId);
  if (!Number.isFinite(fid) || fid <= 0) return { ok: false, error: 'Invalid form id.' };

  const { data: rpcData, error: rpcErr } = await supabase.rpc('skyline_diagnose_shared_content_block_grids', {
    p_form_id: fid,
  });
  if (!rpcErr && rpcData && typeof rpcData === 'object') {
    const raw = rpcData as {
      ok?: boolean;
      error?: string;
      formId?: number;
      sharedChildCount?: number;
      blocks?: SharedContentBlockDiagnosis['blocks'];
    };
    if (raw.ok === false) return { ok: false, error: raw.error ?? 'Diagnose failed.' };
    const tpl = await fetchTemplateForForm(fid, { skipEnsureTaskSections: true });
    const questions = tpl
      ? tpl.steps.flatMap((st) => st.sections.flatMap((sec) => sec.questions))
      : [];
    const shared = findSharedContentBlockQuestionIds(questions);
    const plans = planSharedContentBlockRepairs(questions, shared);
    return {
      formId: fid,
      sharedChildCount: Number(raw.sharedChildCount ?? shared.size),
      plans,
      blocks: Array.isArray(raw.blocks) ? raw.blocks : undefined,
    };
  }

  const tpl = await fetchTemplateForForm(fid, { skipEnsureTaskSections: true });
  if (!tpl) return { ok: false, error: 'Form not found.' };
  const questions = tpl.steps.flatMap((st) => st.sections.flatMap((sec) => sec.questions));
  return diagnosisFromQuestions(fid, questions);
}

/**
 * Repair forms where multiple parents embed the same child grid_table questionId.
 * Prefers atomic DB RPC; fails if any shared references remain after repair.
 * Does NOT copy student answers onto clones (historical shared answers stay on the owner child only).
 */
export async function repairSharedContentBlockGrids(
  formId: number
): Promise<SharedContentBlockRepairResult> {
  const fid = Number(formId);
  if (!Number.isFinite(fid) || fid <= 0) return { ok: false, error: 'Invalid form id.' };
  const projectRef = supabaseProjectRef();

  const { data: rpcData, error: rpcErr } = await supabase.rpc('skyline_repair_shared_content_block_grids', {
    p_form_id: fid,
  });
  if (!rpcErr && rpcData && typeof rpcData === 'object') {
    const raw = rpcData as {
      ok?: boolean;
      error?: string;
      formId?: number;
      childrenCreated?: number;
      parentsRemapped?: number;
      duplicatesFound?: number;
      remainingDuplicates?: number;
      after?: { sharedChildCount?: number; blocks?: SharedContentBlockDiagnosis['blocks'] };
    };
    invalidateSupabaseReadCache();
    const remaining = Number(raw.remainingDuplicates ?? raw.after?.sharedChildCount ?? 0);
    if (raw.ok === false || remaining > 0) {
      const afterDiag = await diagnoseSharedContentBlockGrids(fid);
      return {
        ok: false,
        error: raw.error ?? `Repair incomplete: ${remaining} shared child reference(s) remain.`,
        remainingDuplicates: remaining,
        diagnosis: 'ok' in afterDiag && afterDiag.ok === false ? undefined : (afterDiag as SharedContentBlockDiagnosis),
      };
    }
    const afterDiag = await diagnoseSharedContentBlockGrids(fid);
    const diagnosis =
      'ok' in afterDiag && afterDiag.ok === false
        ? {
            formId: fid,
            sharedChildCount: 0,
            plans: [],
            blocks: raw.after?.blocks,
          }
        : (afterDiag as SharedContentBlockDiagnosis);
    if (import.meta.env.DEV) {
      console.info('[repairSharedContentBlockGrids]', {
        formId: fid,
        projectRef,
        duplicatesFound: Number(raw.duplicatesFound ?? 0),
        childrenCreated: Number(raw.childrenCreated ?? 0),
        parentsRemapped: Number(raw.parentsRemapped ?? 0),
        remainingDuplicates: remaining,
      });
    }
    return {
      ok: true,
      formId: fid,
      clonesCreated: Number(raw.childrenCreated ?? 0),
      rewiredParents: Number(raw.parentsRemapped ?? 0),
      duplicatesFound: Number(raw.duplicatesFound ?? 0),
      remainingDuplicates: remaining,
      diagnosis,
      projectRef,
    };
  }

  // Fallback: client-side repair (pre-RPC environments). Check every write error and verify.
  const diagnosis = await diagnoseSharedContentBlockGrids(fid);
  if ('ok' in diagnosis && diagnosis.ok === false) return diagnosis;
  const d = diagnosis as SharedContentBlockDiagnosis;
  if (d.plans.length === 0) {
    return {
      ok: true,
      formId: fid,
      clonesCreated: 0,
      rewiredParents: 0,
      duplicatesFound: 0,
      remainingDuplicates: 0,
      diagnosis: d,
      projectRef,
    };
  }

  const tpl = await fetchTemplateForForm(fid, { skipEnsureTaskSections: true });
  if (!tpl) return { ok: false, error: 'Form not found.' };
  const questions = tpl.steps.flatMap((st) => st.sections.flatMap((sec) => sec.questions));
  const byId = new Map(questions.map((q) => [q.id, q]));

  let clonesCreated = 0;
  let rewiredParents = 0;

  for (const plan of d.plans) {
    const sourceChild = byId.get(plan.sharedChildId);
    if (!sourceChild) continue;

    let sectionId: number | null = null;
    for (const st of tpl.steps) {
      for (const sec of st.sections) {
        if (sec.questions.some((q) => q.id === plan.sharedChildId || q.id === plan.ownerParentId)) {
          sectionId = sec.id;
          break;
        }
      }
      if (sectionId != null) break;
    }
    if (sectionId == null || !Number.isFinite(sectionId)) {
      return { ok: false, error: `Could not resolve section for shared child ${plan.sharedChildId}` };
    }

    const { data: childOpts, error: optsErr } = await supabase
      .from('skyline_form_question_options')
      .select('*')
      .eq('question_id', plan.sharedChildId)
      .order('sort_order');
    if (optsErr) return { ok: false, error: optsErr.message };
    const { data: childRows, error: rowsErr } = await supabase
      .from('skyline_form_question_rows')
      .select('*')
      .eq('question_id', plan.sharedChildId)
      .order('sort_order');
    if (rowsErr) return { ok: false, error: rowsErr.message };

    for (const parentId of plan.parentsNeedingClone) {
      const parent = byId.get(parentId);
      if (!parent) continue;
      const parentPm = { ...((parent.pdf_meta ?? {}) as PdfMetaLike) };
      const blocks = Array.isArray(parentPm.contentBlocks) ? [...parentPm.contentBlocks!] : [];

      const maxSortRes = await supabase
        .from('skyline_form_questions')
        .select('sort_order')
        .eq('section_id', sectionId)
        .order('sort_order', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (maxSortRes.error) return { ok: false, error: maxSortRes.error.message };
      const nextSort = Number((maxSortRes.data as { sort_order?: number } | null)?.sort_order ?? 0) + 1;

      const childPm = { ...((sourceChild.pdf_meta ?? {}) as PdfMetaLike), isAdditionalBlockOf: parentId };
      const { data: newChild, error: childErr } = await supabase
        .from('skyline_form_questions')
        .insert({
          section_id: sectionId,
          type: sourceChild.type,
          code: sourceChild.code,
          label: sourceChild.label,
          help_text: sourceChild.help_text ?? null,
          required: sourceChild.required ?? false,
          sort_order: nextSort,
          role_visibility: sourceChild.role_visibility ?? {},
          role_editability: sourceChild.role_editability ?? {},
          pdf_meta: childPm,
        })
        .select('id')
        .single();
      if (childErr || !newChild) {
        return { ok: false, error: childErr?.message ?? `Failed to clone child for parent ${parentId}` };
      }
      const newChildId = Number((newChild as { id: number }).id);
      clonesCreated += 1;

      const optsList = (childOpts as FormQuestionOption[]) || [];
      if (optsList.length > 0) {
        const { error: insOptsErr } = await supabase.from('skyline_form_question_options').insert(
          optsList.map((o) => ({
            question_id: newChildId,
            value: o.value,
            label: o.label,
            sort_order: o.sort_order,
          }))
        );
        if (insOptsErr) return { ok: false, error: insOptsErr.message };
      }
      const rowInserts = ((childRows as FormQuestionRow[]) || []).map((row) => ({
        question_id: newChildId,
        row_label: row.row_label,
        row_help: row.row_help ?? null,
        row_image_url: row.row_image_url ?? null,
        row_meta: row.row_meta ?? null,
        sort_order: row.sort_order,
      }));
      if (rowInserts.length > 0) {
        const { error: insRowsErr } = await supabase.from('skyline_form_question_rows').insert(rowInserts);
        if (insRowsErr) return { ok: false, error: insRowsErr.message };
      }

      const nextBlocks: ContentBlockLike[] = blocks.map((b) => {
        if (Number(b?.questionId) === plan.sharedChildId) {
          return { ...b, questionId: newChildId };
        }
        return b;
      });
      const { error: parentUpdErr } = await supabase
        .from('skyline_form_questions')
        .update({ pdf_meta: { ...parentPm, contentBlocks: nextBlocks } })
        .eq('id', parentId);
      if (parentUpdErr) return { ok: false, error: parentUpdErr.message };
      rewiredParents += 1;
      byId.set(parentId, {
        ...parent,
        pdf_meta: { ...parentPm, contentBlocks: nextBlocks } as FormQuestion['pdf_meta'],
      });
    }

    if (plan.ownerParentId != null) {
      const ownerChildPm = {
        ...((sourceChild.pdf_meta ?? {}) as PdfMetaLike),
        isAdditionalBlockOf: plan.ownerParentId,
      };
      const { error: ownerErr } = await supabase
        .from('skyline_form_questions')
        .update({ pdf_meta: ownerChildPm })
        .eq('id', plan.sharedChildId);
      if (ownerErr) return { ok: false, error: ownerErr.message };
    }
  }

  invalidateSupabaseReadCache();
  const after = await diagnoseSharedContentBlockGrids(fid);
  if ('ok' in after && after.ok === false) {
    return { ok: false, error: after.error };
  }
  const afterDiag = after as SharedContentBlockDiagnosis;
  if (afterDiag.sharedChildCount > 0) {
    return {
      ok: false,
      error: `Repair incomplete: ${afterDiag.sharedChildCount} shared child reference(s) remain.`,
      remainingDuplicates: afterDiag.sharedChildCount,
      diagnosis: afterDiag,
    };
  }
  return {
    ok: true,
    formId: fid,
    clonesCreated,
    rewiredParents,
    duplicatesFound: d.sharedChildCount,
    remainingDuplicates: 0,
    diagnosis: afterDiag,
    projectRef,
  };
}

export async function updateInstanceRole(instanceId: number, roleContext: string): Promise<void> {
  const { updated_by } = getAuditFields();
  await supabase.from('skyline_form_instances').update({ role_context: roleContext, updated_by }).eq('id', instanceId);
}

export type InstanceWorkflowStatus =
  | 'draft'
  | 'waiting_trainer'
  | 'waiting_office'
  | 'completed'
  | 'failed'
  | 'awaiting_submission';

/**
 * Atomically moves an instance to the trainer queue (student submit / same semantics as
 * `updateInstanceWorkflowStatus(..., 'waiting_trainer')`) in a single DB round-trip.
 * Prefer this for student final submit to avoid partial state if separate updates fail.
 */
export async function submitInstanceToTrainerViaRpc(
  instanceId: number,
  requestId: string,
): Promise<{ ok: boolean; error?: string; code?: string; duplicate?: boolean }> {
  try {
    await assertStudentInstanceMutationAllowed(instanceId, {
      actorRole: 'student',
      source: 'submit',
    });
  } catch (e) {
    if (e instanceof StudentCourseAccessError) {
      return { ok: false, error: e.message, code: e.code };
    }
    throw e;
  }
  const { data, error } = await supabase.rpc('skyline_submit_instance_to_trainer', {
    p_instance_id: instanceId,
    p_request_id: requestId,
  });
  if (error) return { ok: false, error: error.message };
  const row = data as { ok?: boolean; error?: string; duplicate?: boolean } | null;
  if (row && typeof row === 'object' && row.ok === false) {
    return { ok: false, error: typeof row.error === 'string' ? row.error : 'Submit failed' };
  }
  return { ok: true, duplicate: Boolean(row?.duplicate) };
}

/** Hand off an already-submitted instance to the trainer queue without changing submission_count. */
export async function repairInstanceTrainerHandoff(instanceId: number): Promise<{ ok: boolean; error?: string }> {
  if (!Number.isFinite(instanceId) || instanceId <= 0) return { ok: false, error: 'Invalid instance' };
  const { data: instRow, error: readErr } = await supabase
    .from('skyline_form_instances')
    .select('status, role_context, submission_count, submitted_at')
    .eq('id', instanceId)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!instRow) return { ok: false, error: 'Instance not found' };
  const row = instRow as {
    status?: string | null;
    role_context?: string | null;
    submission_count?: number | null;
    submitted_at?: string | null;
  };
  const submitted =
    Math.min(3, Math.max(0, Number(row.submission_count ?? 0) || (row.submitted_at ? 1 : 0))) > 0;
  if (!submitted) return { ok: false, error: 'No student submission to hand off' };
  if (String(row.role_context ?? '').trim() === 'trainer' && String(row.status ?? '').trim() !== 'draft') {
    return { ok: true };
  }
  const payload: Record<string, unknown> = {
    status: 'submitted',
    role_context: 'trainer',
    updated_by: getAuditFields().updated_by,
  };
  const payloadWithWf: Record<string, unknown> = { ...payload, workflow_status: 'waiting_trainer' };
  const { error } = await supabase.from('skyline_form_instances').update(payloadWithWf).eq('id', instanceId);
  if (error) {
    const msg = String((error as { message?: string }).message ?? '');
    if (msg.toLowerCase().includes('workflow_status')) {
      const { error: retryErr } = await supabase.from('skyline_form_instances').update(payload).eq('id', instanceId);
      if (retryErr) return { ok: false, error: retryErr.message };
      return { ok: true };
    }
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

export async function updateInstanceWorkflowStatus(instanceId: number, workflowStatus: InstanceWorkflowStatus): Promise<void> {
  const nowIso = new Date().toISOString();
  const payload: Record<string, unknown> = { updated_by: getAuditFields().updated_by };
  // Use legacy status fields only, so this works even without workflow_status migration.
  if (workflowStatus === 'draft') {
    payload.status = 'draft';
    // Instance is back with the student (initial state or post–NYC resubmission).
    payload.role_context = 'student';
  }
  if (workflowStatus === 'awaiting_submission') {
    payload.status = 'incomplete';
    payload.role_context = 'student';
  }
  if (workflowStatus === 'waiting_trainer' || workflowStatus === 'waiting_office') payload.status = 'submitted';
  if (workflowStatus === 'completed' || workflowStatus === 'failed') payload.status = 'locked';
  if (workflowStatus === 'waiting_office') {
    // Handed to office for processing (trainer submit path).
    payload.role_context = 'office';
  }
  if (workflowStatus === 'failed') {
    payload.role_context = 'office';
  }
  if (workflowStatus === 'waiting_trainer') {
    // Student submitted (or admin sent to trainer): workflow must match trainer dashboard filters
    // (`listDashboardInstances` pending queue requires role_context = trainer). Keep this in the same
    // update as submission_count so a partial failure cannot leave submission_count set but role stuck on student.
    payload.role_context = 'trainer';
    const { data: instRow } = await supabase
      .from('skyline_form_instances')
      .select('submission_count, submitted_at')
      .eq('id', instanceId)
      .single();
    const existingSubmittedAt = (instRow as { submitted_at?: string | null } | null)?.submitted_at;
    const current = Number((instRow as { submission_count?: number | null } | null)?.submission_count ?? 0) || 0;
    // First student submission sets submitted_at; resubmissions must not overwrite the original timestamp.
    if (!existingSubmittedAt) {
      payload.submitted_at = nowIso;
      payload.submission_count = Math.max(1, current);
    }
    // If already submitted, only hand off to trainer — do not bump submission_count again.
  }
  // Best-effort: also persist workflow_status when the column exists.
  const payloadWithWf: Record<string, unknown> = { ...payload, workflow_status: workflowStatus };
  const { error } = await supabase.from('skyline_form_instances').update(payloadWithWf).eq('id', instanceId);
  let finalError = error;
  if (error) {
    // If the DB doesn't have workflow_status yet, retry without it.
    const msg = String((error as { message?: string } | null)?.message ?? '');
    if (msg.toLowerCase().includes('workflow_status')) {
      const { error: retryErr } = await supabase.from('skyline_form_instances').update(payload).eq('id', instanceId);
      finalError = retryErr ?? null;
    }
  }
  if (finalError) {
    console.error('updateInstanceWorkflowStatus error', finalError);
    throw new Error(String((finalError as { message?: string }).message ?? finalError ?? 'updateInstanceWorkflowStatus failed'));
  }
}

/** Skyline induction windows (enrollment hub). */
export interface SkylineInductionRow {
  id: number;
  title: string;
  start_at: string;
  end_at: string;
  access_token: string;
  created_at: string;
  updated_at: string;
  /** Set when admin removes the window from the list; submissions keep their rows; public link disabled. */
  deleted_at?: string | null;
}

export async function listSkylineInductions(): Promise<SkylineInductionRow[]> {
  const { data, error } = await supabase
    .from('skyline_inductions')
    .select('id, title, start_at, end_at, access_token, created_at, updated_at')
    .is('deleted_at', null)
    .order('start_at', { ascending: false });
  if (error) {
    console.error('listSkylineInductions error', error);
    return [];
  }
  return (data as SkylineInductionRow[]) ?? [];
}

export async function createSkylineInduction(input: {
  title: string;
  start_at_iso: string;
  end_at_iso: string;
}): Promise<{ row: SkylineInductionRow | null; error: Error | null }> {
  const audit = getAuditFields();
  const { data, error } = await supabase
    .from('skyline_inductions')
    .insert({
      title: input.title.trim() || 'Induction',
      start_at: input.start_at_iso,
      end_at: input.end_at_iso,
      created_by: audit.created_by,
      updated_by: audit.updated_by,
    })
    .select('id, title, start_at, end_at, access_token, created_at, updated_at')
    .single();
  if (error) return { row: null, error: new Error(error.message) };
  return { row: data as SkylineInductionRow, error: null };
}

/** Soft-delete: keeps induction row and all submissions; public link stops working. */
export async function deleteSkylineInduction(id: number): Promise<{ error: Error | null }> {
  const audit = getAuditFields();
  const { error } = await supabase
    .from('skyline_inductions')
    .update({ deleted_at: new Date().toISOString(), updated_by: audit.updated_by })
    .eq('id', id)
    .is('deleted_at', null);
  return { error: error ? new Error(error.message) : null };
}

/** Update induction window end time (Melbourne date+time → UTC); link token unchanged. */
export async function patchSkylineInductionEndAt(input: {
  inductionId: number;
  end_at_iso: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc('skyline_admin_patch_induction_end_at', {
    p_induction_id: input.inductionId,
    p_end_at: input.end_at_iso,
  });
  if (error) return { ok: false, error: error.message };
  const j = data as { ok?: boolean; error?: string } | null;
  if (!j?.ok) return { ok: false, error: j?.error || 'Could not update end time.' };
  return { ok: true };
}

export async function getSkylineInductionByToken(
  accessToken: string
): Promise<SkylineInductionRow | null> {
  const { data, error } = await supabase
    .from('skyline_inductions')
    .select('id, title, start_at, end_at, access_token, created_at, updated_at')
    .eq('access_token', accessToken)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) {
    console.error('getSkylineInductionByToken error', error);
    return null;
  }
  return (data as SkylineInductionRow) ?? null;
}

export async function unlockSkylineInductionSession(input: {
  accessToken: string;
  email: string;
  otp: string;
}): Promise<{ ok: true; sessionToken: string; studentEmail: string } | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc('skyline_induction_unlock', {
    p_access_token: input.accessToken,
    p_email: input.email.trim(),
    p_otp: input.otp.trim(),
  });
  if (error) return { ok: false, error: error.message };
  const j = data as { ok?: boolean; error?: string; session_token?: string; student_email?: string } | null;
  if (!j?.ok) return { ok: false, error: j?.error || 'Unlock failed.' };
  if (!j.session_token) return { ok: false, error: 'No session issued.' };
  return { ok: true, sessionToken: j.session_token, studentEmail: String(j.student_email || '') };
}

export async function getSkylineInductionSubmissionState(input: {
  accessToken: string;
  sessionToken: string;
}): Promise<
  | {
      ok: true;
      submitted: false;
      outsideWindow?: boolean;
      draftPayload?: Record<string, unknown>;
      draftSavedAt?: string | null;
    }
  | { ok: true; submitted: true; payload: Record<string, unknown> }
  | { ok: false; error: string }
> {
  const { data, error } = await supabase.rpc('skyline_induction_submission_state', {
    p_access_token: input.accessToken,
    p_session_token: input.sessionToken,
  });
  if (error) return { ok: false, error: error.message };
  const j = data as {
    ok?: boolean;
    error?: string;
    submitted?: boolean;
    payload?: Record<string, unknown>;
    draft_payload?: Record<string, unknown>;
    draft_saved_at?: string | null;
    outside_window?: boolean;
  } | null;
  if (!j?.ok) return { ok: false, error: j?.error || 'Could not load submission state.' };
  if (j.submitted && j.payload) return { ok: true, submitted: true, payload: j.payload };
  return {
    ok: true,
    submitted: false,
    outsideWindow: j.outside_window === true,
    draftPayload: j.draft_payload,
    draftSavedAt: j.draft_saved_at ?? null,
  };
}

export async function saveSkylineInductionDraft(input: {
  accessToken: string;
  sessionToken: string;
  payload: Record<string, unknown>;
}): Promise<{ ok: true; savedAt?: string } | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc('skyline_induction_save_draft', {
    p_access_token: input.accessToken,
    p_session_token: input.sessionToken,
    p_payload: input.payload,
  });
  if (error) return { ok: false, error: error.message };
  const j = data as { ok?: boolean; error?: string; saved_at?: string } | null;
  if (!j?.ok) return { ok: false, error: j?.error || 'Could not save draft.' };
  return { ok: true, savedAt: j.saved_at };
}

export async function submitSkylineInductionForm(input: {
  accessToken: string;
  sessionToken: string;
  payload: Record<string, unknown>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc('skyline_induction_submit', {
    p_access_token: input.accessToken,
    p_session_token: input.sessionToken,
    p_payload: input.payload,
  });
  if (error) return { ok: false, error: error.message };
  const j = data as { ok?: boolean; error?: string } | null;
  if (!j?.ok) return { ok: false, error: j?.error || 'Submit failed.' };
  return { ok: true };
}

/** Admin: one row per student/guest who submitted for an induction window. */
export interface SkylineInductionSubmissionRow {
  id: number;
  student_email: string;
  submitted_at: string;
  payload: Record<string, unknown>;
  student_id: number | null;
  guest_email: string | null;
}

export interface AdminDashboardStats {
  totals: { assessments: number; students: number; trainers: number; admins: number };
  workflow: { awaiting_student: number; awaiting_trainer: number; awaiting_office: number; completed: number };
  top_pending_by_student: Array<{ student_id: number; student_name: string; student_email: string; pending_count: number }>;
  top_pending_by_trainer: Array<{ trainer_id: number; trainer_name: string; trainer_email: string; pending_count: number }>;
}

export async function getAdminDashboardStats(input: {
  startAt?: string | null; // timestamptz ISO
  endAt?: string | null; // timestamptz ISO
  status?: 'all' | 'awaiting_student' | 'awaiting_trainer' | 'awaiting_office' | 'completed';
}): Promise<{ ok: true; stats: AdminDashboardStats } | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc('skyline_admin_dashboard_stats', {
    p_start_at: input.startAt ?? null,
    p_end_at: input.endAt ?? null,
    p_status: input.status ?? 'all',
  });
  if (error) return { ok: false, error: error.message };
  const j = data as { ok?: boolean; error?: string } & Partial<AdminDashboardStats> | null;
  if (!j?.ok) return { ok: false, error: (j as { error?: string } | null)?.error || 'Could not load dashboard stats.' };
  const totals = (j.totals ?? {}) as AdminDashboardStats['totals'];
  const workflow = (j.workflow ?? {}) as AdminDashboardStats['workflow'];
  return {
    ok: true,
    stats: {
      totals: {
        assessments: Number((totals as any).assessments ?? 0) || 0,
        students: Number((totals as any).students ?? 0) || 0,
        trainers: Number((totals as any).trainers ?? 0) || 0,
        admins: Number((totals as any).admins ?? 0) || 0,
      },
      workflow: {
        awaiting_student: Number((workflow as any).awaiting_student ?? 0) || 0,
        awaiting_trainer: Number((workflow as any).awaiting_trainer ?? 0) || 0,
        awaiting_office: Number((workflow as any).awaiting_office ?? 0) || 0,
        completed: Number((workflow as any).completed ?? 0) || 0,
      },
      top_pending_by_student: Array.isArray((j as any).top_pending_by_student) ? ((j as any).top_pending_by_student as any[]) : [],
      top_pending_by_trainer: Array.isArray((j as any).top_pending_by_trainer) ? ((j as any).top_pending_by_trainer as any[]) : [],
    },
  };
}

function parseInductionSubmissionsRpcPayload(data: unknown): SkylineInductionSubmissionRow[] {
  if (data == null) return [];
  if (Array.isArray(data)) return data as SkylineInductionSubmissionRow[];
  if (typeof data === 'string') {
    try {
      return parseInductionSubmissionsRpcPayload(JSON.parse(data) as unknown);
    } catch {
      return [];
    }
  }
  if (typeof data === 'object') {
    const o = data as Record<string, unknown>;
    if ('id' in o && 'payload' in o) return [data as SkylineInductionSubmissionRow];
    const vals = Object.values(o);
    if (
      vals.length > 0 &&
      vals.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v))
    ) {
      return vals as SkylineInductionSubmissionRow[];
    }
  }
  return [];
}

export async function countSkylineInductionSubmissions(
  inductionId: number,
): Promise<{ count: number; error?: string }> {
  const { data, error } = await supabase.rpc('skyline_admin_count_induction_submissions', {
    p_induction_id: inductionId,
  });
  if (error) {
    console.error('countSkylineInductionSubmissions error', error);
    return { count: 0, error: error.message };
  }
  return { count: Number(data ?? 0) || 0 };
}

export async function listSkylineInductionSubmissions(
  inductionId: number,
): Promise<{ rows: SkylineInductionSubmissionRow[]; error?: string }> {
  const { data, error } = await supabase.rpc('skyline_admin_list_induction_submissions', {
    p_induction_id: inductionId,
  });
  if (error) {
    console.error('listSkylineInductionSubmissions error', error);
    return { rows: [], error: error.message };
  }
  return { rows: parseInductionSubmissionsRpcPayload(data) };
}

export async function patchSkylineInductionSubmissionOffice(input: {
  submissionId: number;
  officeSmsBy: string;
  officeSmsDate: string;
  officePrismsBy: string;
  officePrismsDate: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc('skyline_admin_patch_induction_submission_office', {
    p_submission_id: input.submissionId,
    p_office: {
      officeSmsBy: input.officeSmsBy,
      officeSmsDate: input.officeSmsDate,
      officePrismsBy: input.officePrismsBy,
      officePrismsDate: input.officePrismsDate,
    },
  });
  if (error) return { ok: false, error: error.message };
  const j = data as { ok?: boolean; error?: string } | null;
  if (!j?.ok) return { ok: false, error: j?.error || 'Could not update office fields.' };
  return { ok: true };
}

export async function patchSkylineInductionSubmissionPayload(input: {
  submissionId: number;
  payload: Record<string, unknown>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc('skyline_admin_patch_induction_submission_payload', {
    p_submission_id: input.submissionId,
    p_payload: input.payload,
  });
  if (error) return { ok: false, error: error.message };
  const j = data as { ok?: boolean; error?: string } | null;
  if (!j?.ok) return { ok: false, error: j?.error || 'Could not update submission.' };
  return { ok: true };
}

export async function deleteStudentIfNoAssessments(studentId: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const sid = Number(studentId);
  if (!Number.isFinite(sid) || sid <= 0) return { ok: false, error: 'Invalid student id.' };
  const { data, error } = await supabase.rpc('skyline_admin_delete_student_if_no_assessments', { p_student_id: sid });
  if (error) return { ok: false, error: error.message };
  const j = data as { ok?: boolean; error?: string } | null;
  if (!j?.ok) return { ok: false, error: j?.error || 'Could not delete student.' };
  return { ok: true };
}

export async function deleteBatchIfAllStudentsInactive(batchId: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const bid = Number(batchId);
  if (!Number.isFinite(bid) || bid <= 0) return { ok: false, error: 'Invalid batch id.' };
  const { data, error } = await supabase.rpc('skyline_admin_delete_batch_if_all_students_inactive', { p_batch_id: bid });
  if (error) return { ok: false, error: error.message };
  const j = data as { ok?: boolean; error?: string } | null;
  if (!j?.ok) return { ok: false, error: j?.error || 'Could not delete batch.' };
  return { ok: true };
}

export async function deleteStudentSuperadmin(studentId: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const sid = Number(studentId);
  if (!Number.isFinite(sid) || sid <= 0) return { ok: false, error: 'Invalid student id.' };
  const { data, error } = await supabase.rpc('skyline_superadmin_delete_student', { p_student_id: sid });
  if (error) return { ok: false, error: error.message };
  const j = data as { ok?: boolean; error?: string } | null;
  if (!j?.ok) return { ok: false, error: j?.error || 'Could not delete student.' };
  return { ok: true };
}

export async function deleteBatchSuperadmin(
  batchId: number,
  studentIdsFullDelete: number[]
): Promise<{ ok: true } | { ok: false; error: string }> {
  const bid = Number(batchId);
  if (!Number.isFinite(bid) || bid <= 0) return { ok: false, error: 'Invalid batch id.' };
  const ids = [...new Set((studentIdsFullDelete || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  const { data, error } = await supabase.rpc('skyline_superadmin_delete_batch', {
    p_batch_id: bid,
    p_student_ids_full_delete: ids,
  });
  if (error) return { ok: false, error: error.message };
  const j = data as { ok?: boolean; error?: string } | null;
  if (!j?.ok) return { ok: false, error: j?.error || 'Could not delete batch.' };
  return { ok: true };
}

/** Resolved ids/messages for workflow push + in-app notifications (send-notification edge function). */
export type InstanceWorkflowNotificationContext = {
  formName: string;
  /** `skyline_students.id` as string — used as `skyline_notifications.user_id` for student in-app rows + optional future student push. */
  studentNotificationUserId: string | null;
  /** Primary trainer (`skyline_batches.trainer_id`). */
  trainerUserId: number | null;
  /** All trainers assigned to the student's batch (primary + additional). */
  trainerUserIds: number[];
};

export async function getInstanceWorkflowNotificationContext(instanceId: number): Promise<InstanceWorkflowNotificationContext | null> {
  const iid = Number(instanceId);
  if (!Number.isFinite(iid) || iid <= 0) return null;
  const inst = await fetchInstance(iid);
  if (!inst) return null;
  const form = await fetchForm(inst.form_id);
  const formName = form?.name?.trim() || 'Assessment';
  const rawSid = (inst as { student_id?: number | null }).student_id;
  const sid = rawSid != null ? Number(rawSid) : null;
  if (!sid || !Number.isFinite(sid) || sid <= 0) {
    return { formName, studentNotificationUserId: null, trainerUserId: null, trainerUserIds: [] };
  }
  const studentNotificationUserId = String(sid);
  let trainerUserId: number | null = null;
  let trainerUserIds: number[] = [];
  const { data: st, error: stErr } = await supabase
    .from('skyline_students')
    .select('batch_id')
    .eq('id', sid)
    .maybeSingle();
  if (stErr) console.error('getInstanceWorkflowNotificationContext student', stErr);
  const batchId = st?.batch_id != null ? Number((st as { batch_id?: unknown }).batch_id) : null;
  if (batchId && Number.isFinite(batchId) && batchId > 0) {
    trainerUserIds = await fetchBatchTrainerIds(batchId);
    const { data: b, error: bErr } = await supabase
      .from('skyline_batches')
      .select('trainer_id')
      .eq('id', batchId)
      .maybeSingle();
    if (bErr) console.error('getInstanceWorkflowNotificationContext batch', bErr);
    const tid = b?.trainer_id != null ? Number((b as { trainer_id?: unknown }).trainer_id) : null;
    if (tid && Number.isFinite(tid) && tid > 0) {
      trainerUserId = tid;
      if (!trainerUserIds.includes(tid)) trainerUserIds = [tid, ...trainerUserIds];
    } else if (trainerUserIds.length > 0) {
      trainerUserId = trainerUserIds[0];
    }
  }
  return { formName, studentNotificationUserId, trainerUserId, trainerUserIds };
}

/** Fire-and-forget in-app + FCM via Edge Function (service role inside function). */
export async function invokeWorkflowSendNotification(input: {
  userIds: string[];
  title: string;
  message: string;
  url?: string;
  type?: string;
}): Promise<void> {
  const userIds = [...new Set((input.userIds || []).map((x) => String(x).trim()).filter(Boolean))];
  if (userIds.length === 0) return;
  try {
    const { error } = await supabase.functions.invoke('send-notification', {
      body: {
        userIds,
        title: input.title.trim(),
        message: input.message.trim(),
        url: (input.url ?? '/').trim() || '/',
        type: (input.type ?? 'workflow').trim() || 'workflow',
      },
    });
    if (error) console.error('invokeWorkflowSendNotification', error.message);
  } catch (e) {
    console.error('invokeWorkflowSendNotification', e);
  }
}
