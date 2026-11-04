import type { FormAnswer } from '../types/database';
import {
  fetchAnswersForInstance,
  fetchAssessmentSummaryData,
  fetchInstance,
  fetchInstanceAdminReferenceNotes,
  fetchInstanceIdentitySources,
  fetchResultsData,
  fetchResultsOffice,
  fetchTemplateForForm,
  saveAnswer,
  saveAssessmentSummaryData,
  saveResultsData,
  saveResultsOffice,
  updateInstanceAdminReferenceNote,
  type AssessmentSummaryDataEntry,
  type FormQuestionWithOptionsAndRows,
  type FormTemplate,
  type ResultsDataEntry,
  type ResultsOfficeEntry,
  type SubmittedInstanceRow,
} from './formEngine';
import { mergeFormAnswersPreservingExisting, type FormAnswersMap } from '../utils/formAnswerMerge';
import { buildTaskResultSections, getTaskResultSectionIdsForRow, isPreAssessmentSummaryStepIndex, mergeResultsOfficeForTaskSections, type TaskResultSectionEntry } from '../utils/taskResultsOutcome';
import { getInstanceWorkflowLabel } from '../utils/assessmentRowUi';
import {
  evaluateAndUpdateAssessmentStatus,
  type AssessmentCompletionEvaluation,
} from './assessmentCompletionStatus';
import { normalizeInstanceWorkflowStatus } from '../utils/instanceWorkflow';
import { extractStudentDeclarationIso } from '../utils/assessmentAttemptDates';

export type QuickEditAnswerValue = string | number | boolean | Record<string, unknown> | string[] | null;

export type IntroQuestionField = {
  questionId: number;
  rowId: number | null;
  code: string | null;
  label: string;
  type: string;
  sectionTitle: string;
  sectionMode: string | null;
  required?: boolean;
  showDateField?: boolean;
};

export type QuickEditContext = {
  instanceId: number;
  formId: number;
  studentName: string;
  studentEmail: string;
  studentIdLabel: string | null;
  unitCode: string | null;
  unitTitle: string | null;
  formName: string;
  formVersion: string | null;
  startDate: string | null;
  endDate: string | null;
  /** Instance-level optional later deadline (not a form answer; never printed in PDFs). */
  extensionDate?: string | null;
  statusLabel: string;
  workflowStatus: string | null;
  trainerName: string | null;
};

export type QuickEditData = {
  context: QuickEditContext;
  template: FormTemplate | null;
  introQuestions: IntroQuestionField[];
  answers: Record<string, QuickEditAnswerValue>;
  resultsSections: TaskResultSectionEntry[];
  resultsData: Record<number, ResultsDataEntry>;
  resultsOffice: Record<number, ResultsOfficeEntry>;
  assessmentSummary: AssessmentSummaryDataEntry;
  adminReferenceNote: string;
};

const INTRO_SECTION_MODES = new Set([
  'declarations',
  'assessment_submission',
  'reasonable_adjustment',
  'likert_table',
  'additional_instructions',
]);

const SKIP_QUESTION_TYPES = new Set(['instruction_block', 'page_break', 'grid_table', 'image', 'likert_5']);

function introSignatureShowsDateField(
  q: FormQuestionWithOptionsAndRows,
  sectionMode: string,
): boolean {
  if (q.type !== 'signature') return false;
  const pm = (q.pdf_meta as { showDateField?: boolean } | null) ?? {};
  if (pm.showDateField) return true;
  const code = String(q.code ?? '').trim();
  if (code === 'student.declarationSignature') return true;
  if (code === 'trainer.reasonableAdjustmentSignature') return true;
  if (sectionMode === 'reasonable_adjustment') return true;
  if (sectionMode === 'declarations') return true;
  return false;
}

const EMPTY_SUMMARY = (): AssessmentSummaryDataEntry => ({
  start_date: null,
  end_date: null,
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
  admin_initials: null,
  admin_initial_checked: false,
  admin_updated_checked: false,
});

export function getAnswerKey(questionId: number, rowId: number | null): string {
  return rowId != null ? `q-${questionId}-${rowId}` : `q-${questionId}`;
}

export function parseAnswerValue(a: FormAnswer): QuickEditAnswerValue {
  const j =
    a.value_json != null && typeof a.value_json === 'object' && !Array.isArray(a.value_json)
      ? (a.value_json as Record<string, unknown>)
      : null;
  if (j && typeof j.answerImageUrl === 'string' && j.answerImageUrl.trim()) {
    return { text: String(a.value_text ?? j.text ?? ''), answerImageUrl: j.answerImageUrl };
  }
  if (a.value_text != null) return a.value_text;
  if (a.value_number != null) return a.value_number;
  if (a.value_json != null) return a.value_json as Record<string, unknown> | string[];
  return null;
}

export function valueToSavePayload(value: QuickEditAnswerValue): {
  text?: string;
  number?: number;
  json?: unknown;
} {
  if (value == null) return {};
  let text: string | undefined;
  let num: number | undefined;
  let json: unknown;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number') num = value;
  else if (typeof value === 'boolean') text = value ? 'true' : 'false';
  else if (Array.isArray(value)) json = value;
  else if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.text === 'string' && Object.keys(o).every((k) => k === 'text' || k === 'answerImageUrl')) {
      const url = typeof o.answerImageUrl === 'string' && o.answerImageUrl.trim() ? o.answerImageUrl : null;
      return { text: o.text, json: url ? { answerImageUrl: url } : undefined };
    }
    json = value;
  }
  return { text, number: num, json };
}

export type SignatureDisplay = {
  signed: boolean;
  signedBy: string | null;
  signedAt: string | null;
  preview: string | null;
};

export function parseSignatureDisplay(value: QuickEditAnswerValue | string | null | undefined): SignatureDisplay {
  if (value == null) return { signed: false, signedBy: null, signedAt: null, preview: null };
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return {
      signed: trimmed.length > 0,
      signedBy: trimmed && !trimmed.startsWith('data:') ? trimmed : null,
      signedAt: null,
      preview: trimmed.startsWith('data:') ? trimmed : null,
    };
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    const sig = String(o.signature ?? o.imageDataUrl ?? o.typedText ?? '').trim();
    const signedAt = String(o.date ?? o.signedAtDate ?? o.signedAt ?? '').trim() || null;
    const signedBy = String(o.signedBy ?? o.typedText ?? '').trim() || (sig && !sig.startsWith('data:') ? sig : null);
    return {
      signed: sig.length > 0,
      signedBy,
      signedAt,
      preview: sig.startsWith('data:') ? sig : null,
    };
  }
  return { signed: false, signedBy: null, signedAt: null, preview: null };
}

function collectIntroQuestions(template: FormTemplate): IntroQuestionField[] {
  const out: IntroQuestionField[] = [];
  const seen = new Set<string>();

  for (let stepIndex = 0; stepIndex < (template.steps ?? []).length; stepIndex++) {
    if (!isPreAssessmentSummaryStepIndex(template, stepIndex)) continue;
    for (const section of template.steps![stepIndex].sections) {
      const mode = String(section.pdf_render_mode ?? '');
      if (!INTRO_SECTION_MODES.has(mode)) continue;

      const pushQuestion = (q: FormQuestionWithOptionsAndRows, rowId: number | null, rowLabel?: string) => {
        if (SKIP_QUESTION_TYPES.has(q.type)) return;
        const key = `${q.id}-${rowId ?? 'null'}`;
        if (seen.has(key)) return;
        seen.add(key);
        const label = rowLabel ? `${q.label} — ${rowLabel}` : q.label;
        out.push({
          questionId: q.id,
          rowId,
          code: q.code ?? null,
          label,
          type: q.type,
          sectionTitle: section.title?.trim() || mode,
          sectionMode: mode || null,
          required: Boolean(q.required),
          showDateField: introSignatureShowsDateField(q, mode),
        });
      };

      for (const q of section.questions) {
        if (q.type === 'grid_table' && q.rows.length > 0) {
          for (const r of q.rows) pushQuestion(q, r.id, r.row_label);
          continue;
        }
        pushQuestion(q, null);
      }
    }
  }

  return out;
}

function answersFromRows(rows: FormAnswer[]): Record<string, QuickEditAnswerValue> {
  const map: Record<string, QuickEditAnswerValue> = {};
  for (const a of rows) {
    map[getAnswerKey(a.question_id, a.row_id)] = parseAnswerValue(a);
  }
  return map;
}

function buildContext(row: SubmittedInstanceRow, identity: Awaited<ReturnType<typeof fetchInstanceIdentitySources>>): QuickEditContext {
  return {
    instanceId: row.id,
    formId: row.form_id,
    studentName: row.student_name || identity?.studentFullName || '—',
    studentEmail: row.student_email || identity?.studentEmail || '—',
    studentIdLabel: identity?.studentId ?? null,
    unitCode: row.form_unit_code ?? null,
    unitTitle: row.form_unit_name ?? null,
    formName: row.form_name,
    formVersion: row.form_version,
    startDate: row.start_date,
    endDate: row.end_date,
    extensionDate: row.extension_date ?? null,
    statusLabel: getInstanceWorkflowLabel({
      status: row.status,
      role_context: row.role_context,
      did_not_attempt: (row as { did_not_attempt?: boolean | null }).did_not_attempt ?? null,
      no_attempt_rollovers: (row as { no_attempt_rollovers?: number | null }).no_attempt_rollovers ?? null,
      submission_count: row.submission_count,
      submitted_at: row.submitted_at,
    }),
    workflowStatus: row.workflow_status ?? null,
    trainerName: identity?.trainerFullName ?? null,
  };
}

export async function loadQuickEditData(row: SubmittedInstanceRow): Promise<QuickEditData> {
  const instanceId = row.id;
  const [
    template,
    answerRows,
    resultsData,
    resultsOffice,
    assessmentSummary,
    adminNotes,
    identity,
  ] = await Promise.all([
    fetchTemplateForForm(row.form_id, { allowInactiveForAdmin: true, skipEnsureTaskSections: true }),
    fetchAnswersForInstance(instanceId),
    fetchResultsData(instanceId),
    fetchResultsOffice(instanceId),
    fetchAssessmentSummaryData(instanceId),
    fetchInstanceAdminReferenceNotes([instanceId]),
    fetchInstanceIdentitySources(instanceId),
  ]);

  const introQuestions = template ? collectIntroQuestions(template) : [];
  const resultsSections = buildTaskResultSections(template, resultsData);
  const mergedResultsOffice = mergeResultsOfficeForTaskSections(template, resultsSections, resultsOffice);

  return {
    context: buildContext(row, identity),
    template,
    introQuestions,
    answers: answersFromRows(answerRows),
    resultsSections,
    resultsData,
    resultsOffice: mergedResultsOffice,
    assessmentSummary: assessmentSummary ?? EMPTY_SUMMARY(),
    adminReferenceNote: adminNotes[instanceId] ?? '',
  };
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function diffPartialRecord<T extends object>(
  baseline: T,
  draft: T,
  keys: (keyof T)[],
): Partial<T> {
  const patch: Partial<T> = {};
  for (const key of keys) {
    if (!valuesEqual(baseline[key], draft[key])) {
      patch[key] = draft[key];
    }
  }
  return patch;
}

const RESULTS_PATCH_KEYS: (keyof ResultsDataEntry)[] = [
  'first_attempt_satisfactory',
  'first_attempt_date',
  'first_attempt_feedback',
  'second_attempt_satisfactory',
  'second_attempt_date',
  'second_attempt_feedback',
  'third_attempt_satisfactory',
  'third_attempt_date',
  'third_attempt_feedback',
  'student_name',
  'student_signature',
  'trainer_name',
  'trainer_signature',
  'trainer_date',
];

const SUMMARY_PATCH_KEYS: (keyof AssessmentSummaryDataEntry)[] = [
  'start_date',
  'end_date',
  'final_attempt_1_result',
  'final_attempt_2_result',
  'final_attempt_3_result',
  'trainer_sig_1',
  'trainer_date_1',
  'trainer_sig_2',
  'trainer_date_2',
  'trainer_sig_3',
  'trainer_date_3',
  'student_sig_1',
  'student_date_1',
  'student_sig_2',
  'student_date_2',
  'student_sig_3',
  'student_date_3',
  'student_overall_feedback',
  'admin_initials',
  'admin_initial_checked',
  'admin_updated_checked',
];

const OFFICE_PATCH_KEYS: (keyof ResultsOfficeEntry)[] = [
  'entered_date',
  'entered_by',
  'initial_checked',
  'updated_checked',
];

export type QuickEditSaveInput = {
  baseline: QuickEditData;
  draft: QuickEditData;
};

export async function saveQuickEditChanges(input: QuickEditSaveInput): Promise<{ ok: true } | { ok: false; error: string }> {
  const { baseline, draft } = input;
  const instanceId = baseline.context.instanceId;
  const errors: string[] = [];

  try {
    for (const field of baseline.introQuestions) {
      const key = getAnswerKey(field.questionId, field.rowId);
      const before = baseline.answers[key] ?? null;
      const after = draft.answers[key] ?? null;
      if (valuesEqual(before, after)) continue;

      const allowClear = after == null || (typeof after === 'string' && after.trim() === '');
      const payload = valueToSavePayload(after);
      await saveAnswer(instanceId, field.questionId, field.rowId, payload, {
        allowClear,
        source: 'adminQuickEdit',
      });
    }

    for (const entry of draft.resultsSections) {
      const sectionId = entry.sectionId;
      if (sectionId == null) continue;
      const before = baseline.resultsData[sectionId] ?? ({ section_id: sectionId } as ResultsDataEntry);
      const after = draft.resultsData[sectionId] ?? ({ section_id: sectionId } as ResultsDataEntry);
      const patch = diffPartialRecord(before, after, RESULTS_PATCH_KEYS);
      if (Object.keys(patch).length > 0) {
        await saveResultsData(instanceId, sectionId, patch, { source: 'adminQuickEdit' });
      }

      const beforeOffice = baseline.resultsOffice[sectionId] ?? ({ section_id: sectionId } as ResultsOfficeEntry);
      const afterOffice = draft.resultsOffice[sectionId] ?? ({ section_id: sectionId } as ResultsOfficeEntry);
      const officePatch = diffPartialRecord(beforeOffice, afterOffice, OFFICE_PATCH_KEYS);
      if (Object.keys(officePatch).length > 0) {
        const siblingIds =
          entry.taskRowId != null && draft.template
            ? getTaskResultSectionIdsForRow(draft.template, entry.taskRowId)
            : [sectionId];
        const targetSectionIds = siblingIds.length > 0 ? siblingIds : [sectionId];
        for (const sid of targetSectionIds) {
          await saveResultsOffice(instanceId, sid, officePatch);
        }
      }
    }

    const summaryPatch = diffPartialRecord(baseline.assessmentSummary, draft.assessmentSummary, SUMMARY_PATCH_KEYS);
    if (Object.keys(summaryPatch).length > 0) {
      await saveAssessmentSummaryData(instanceId, summaryPatch, { source: 'adminQuickEdit' });
    }

    const noteBefore = (baseline.adminReferenceNote ?? '').trim();
    const noteAfter = (draft.adminReferenceNote ?? '').trim();
    if (noteBefore !== noteAfter) {
      const res = await updateInstanceAdminReferenceNote(instanceId, noteAfter);
      if (!res.ok) errors.push(res.error ?? 'Could not save admin reference note');
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Save failed' };
  }

  if (errors.length > 0) return { ok: false, error: errors.join('; ') };
  return { ok: true };
}

export function getQuickEditStudentDeclarationIso(data: QuickEditData): string | undefined {
  const declarationQuestionId =
    data.template?.steps
      ?.flatMap((st) => st.sections)
      .flatMap((s) => s.questions)
      .find((item) => item.code === 'student.declarationSignature')?.id ?? null;
  if (declarationQuestionId == null) return undefined;
  return extractStudentDeclarationIso(data.answers, getAnswerKey, declarationQuestionId);
}

export async function recalculateQuickEditCompletionStatus(params: {
  row: SubmittedInstanceRow;
  data: QuickEditData;
  studentDeclarationIso?: string;
}): Promise<AssessmentCompletionEvaluation> {
  const inst = await fetchInstance(params.row.id);
  const workflowSource = inst ?? params.row;
  const workflowStatus = normalizeInstanceWorkflowStatus({
    workflow_status: (workflowSource as { workflow_status?: string | null }).workflow_status,
    status: workflowSource.status,
    role_context: workflowSource.role_context,
    submission_count: workflowSource.submission_count,
    submitted_at: workflowSource.submitted_at,
    did_not_attempt: (workflowSource as { did_not_attempt?: boolean | null }).did_not_attempt ?? null,
  });

  return evaluateAndUpdateAssessmentStatus({
    instanceId: params.row.id,
    template: params.data.template,
    resultsData: params.data.resultsData,
    resultsOffice: params.data.resultsOffice,
    assessmentSummary: params.data.assessmentSummary,
    submissionCount: Number(workflowSource.submission_count ?? 0) || 0,
    submittedAt: workflowSource.submitted_at,
    workflowStatus,
    roleContext: workflowSource.role_context,
    studentDeclarationIso: params.studentDeclarationIso,
    options: { adminQuickEdit: true, applyUpdate: true },
  });
}

export function cloneQuickEditData(data: QuickEditData): QuickEditData {
  return JSON.parse(JSON.stringify(data)) as QuickEditData;
}

/** Merge incoming answer edits without wiping untouched keys. */
export function mergeAnswerDraft(
  existing: Record<string, QuickEditAnswerValue>,
  incoming: Record<string, QuickEditAnswerValue>,
): Record<string, QuickEditAnswerValue> {
  return mergeFormAnswersPreservingExisting(existing as FormAnswersMap, incoming as FormAnswersMap, {
    source: 'adminQuickEdit',
  }) as Record<string, QuickEditAnswerValue>;
}
