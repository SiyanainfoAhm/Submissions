import { normalizeRichTextForPage } from '../utils/richText';
import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  fetchTemplateForForm,
  fetchAnswersForInstance,
  fetchInstance,
  fetchInstanceIdentitySources,
  saveAnswer as persistAnswer,
  saveTrainerAssessment,
  fetchTrainerAssessments,
  fetchTrainerRowAssessments,
  fetchResultsOffice,
  saveResultsOffice,
  fetchResultsData,
  saveResultsData as persistResultsData,
  fetchAssessmentSummaryData,
  saveAssessmentSummaryData as persistAssessmentSummaryData,
  submitInstanceToTrainerViaRpc,
  updateInstanceRole,
  updateInstanceWorkflowStatus,
  validateInstanceAccessToken,
  revokeRoleAccessTokens,
  extendInstanceAccessTokensToDate,
  recordTrainerNycAssessedOn,
  studentResubmissionDeadlineFromAssessedOn,
  getInstanceWorkflowNotificationContext,
  invokeWorkflowSendNotification,
  type InstanceWorkflowNotificationContext,
} from '../lib/formEngine';
import type { FormTemplate, FormQuestionWithOptionsAndRows, FormSectionWithQuestions } from '../lib/formEngine';
import { getWrittenEvidenceChecklistQuestions, isWrittenEvidenceChecklistSection } from '../lib/writtenEvidenceChecklist';
import { getTaskQuestionDisplayNumbers } from '../lib/taskQuestionsNumbering';
import type { FormAnswer } from '../types/database';
import type { FormRole } from '../utils/roleGuard';
import { isRoleVisible, isRoleEditable } from '../utils/roleGuard';
import { legacyGridCountsAsFilled, mergeGridTableAnswers } from '../utils/gridTableAnswers';
import {
  describeContentBlockRequiredGaps,
  describeGridRequiredGap,
  describeSignatureRequiredGap,
  summarizeContentBlockGaps,
} from '../utils/assessmentRequiredGaps';
import {
  formatAssessmentValidationError,
  pickAssessmentValidationToast,
  scrollToAssessmentQuestion,
  type AssessmentQuestionErrorMeta,
} from '../utils/assessmentValidationMessages';
import {
  collectOrderedQuestionIdsFromSections,
  collectStepAnswerSaveTargets,
  groupSaveTargetsByQuestion,
} from '../utils/stepAnswerSave';
import { mergeFormAnswersPreservingExisting } from '../utils/formAnswerMerge';
import {
  buildIdentityHydrationUpdates,
  buildIdentitySourceValues,
  type IdentityFieldCode,
  type IdentityQuestionRef,
} from '../utils/identityFieldRepair';
import {
  MSG_COURSE_NOT_IN_PROGRESS,
  MSG_COURSE_NOT_GOING_ON,
  MSG_COURSE_TENTATIVE,
  MSG_COURSE_SUSPENDED,
  MSG_COURSE_CANCELLED,
  MSG_COURSE_COMPLETED,
  studentMayMutateAssessment,
  type StudentAssessmentAccessResult,
} from '../lib/studentAssessmentAccess';
import { Card } from '../components/ui/Card';
import { Loader } from '../components/ui/Loader';
import { Button } from '../components/ui/Button';
import { Stepper } from '../components/ui/Stepper';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { StoredPdfPanel } from '../components/pdf/StoredPdfPanel';
import { QuestionRenderer } from '../components/form-fill/QuestionRenderer';
import { TaskInstructionsBlocksDisplay } from '../components/form-fill/TaskInstructionsBlocksDisplay';
import { getQuestionInstructionsData } from '../utils/questionInstructionLabel';
import { SectionLikertTable } from '../components/form-fill/SectionLikertTable';
import { SignatureField } from '../components/form-fill/SignatureField';
import { AppendixAMatrixForm } from '../components/form-fill/AppendixAMatrixForm';
import { DatePicker } from '../components/ui/DatePicker';
import { toast } from '../utils/toast';
import {
  buildTaskResultSections,
  formatAttemptSatLabel,
  formatCompetentBlockerMessage,
  formatSummaryDisplayDate,
  getEffectiveAttemptSat,
  getFirstPreSummaryTaskResultSectionId,
  getMergedResultsForTaskRow,
  getTaskResultChecks,
  getTrainerAttemptOutcomeFromChecks,
  isPostSummaryAssessmentTaskStep,
  isPreSummarySection,
  maxTaskAttemptDate,
} from '../utils/taskResultsOutcome';
import {
  ASSESSMENT_RESULT_PROGRESS_MESSAGE,
  hasAtLeastOneValidResultSheetAttempt,
  hasAtLeastOneValidSummaryAttempt,
  toggleOutcomeSelection,
  validateAssessmentBeforeProgress,
} from '../utils/assessmentResultValidation';
import {
  getAssessmentSummaryDateChainMins,
  getResultsMinFirstAttemptDate,
  getResultsMinSecondAttemptDate,
  getResultsMinThirdAttemptDate,
  getResultsTrainerFooterDateMin,
  getResultsSheetFieldDateErrors,
  getSummarySheetFieldDateErrors,
  isCalendarBefore,
  maxIsoDate,
  normalizeCalendarDateToIso,
  validateAssessmentSummaryDateChain,
  validateResultsSheetDateChain,
} from '../utils/assessmentAttemptDates';
import {
  applyResultsStudentSignatureConvenience,
  applyResultsTrainerSignatureConvenience,
} from '../utils/assessmentSignatureConvenience';

type AttemptOutcome = 'competent' | 'not_yet_competent' | null;

type QuestionSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

function AnswerSaveStatusIcon({ status }: { status?: QuestionSaveStatus }) {
  if (!status || status === 'idle') return null;
  if (status === 'saving') {
    return <Loader2 className="w-4 h-4 animate-spin text-gray-500 shrink-0" aria-label="Saving answer" />;
  }
  if (status === 'saved') {
    return <Check className="w-4 h-4 text-emerald-600 shrink-0" strokeWidth={2.5} aria-label="Answer saved" />;
  }
  return <span className="w-4 h-4 text-red-600 text-xs font-bold shrink-0 leading-4" title="Save failed">!</span>;
}

function getVisibleStepsForRole(template: FormTemplate, role: FormRole) {
  const isAppendixAStep = (s: { title?: string | null }) => /Appendix\s*A/i.test((s.title || '').trim());
  return (template.steps ?? []).filter((s) => role !== 'student' || !isAppendixAStep(s));
}

function batchTrainerNotifyUserIds(ctx: InstanceWorkflowNotificationContext | null): string[] {
  if (!ctx) return [];
  const raw =
    ctx.trainerUserIds.length > 0
      ? ctx.trainerUserIds
      : ctx.trainerUserId != null
        ? [ctx.trainerUserId]
        : [];
  return [...new Set(raw.map((id) => String(id)).filter(Boolean))];
}

function getAnswerKey(questionId: number, rowId: number | null): string {
  if (rowId === null) return `q-${questionId}`;
  return `q-${questionId}-${rowId}`;
}

/** Undo `getAnswerKey` for keys used in debounced save map (`q-12` or `q-12-34`). */
function parseDebouncedAnswerKey(key: string): { questionId: number; rowId: number | null } | null {
  const m = /^q-(\d+)(?:-(\d+))?$/.exec(key);
  if (!m) return null;
  return { questionId: Number(m[1]), rowId: m[2] != null ? Number(m[2]) : null };
}

function addIsoDays(iso: string, days: number): string | undefined {
  const s = String(iso || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Earliest ISO date allowed on student.declarationSignature for resubmissions (strictly after trainer assessment). */
function getStudentResubDeclarationMinDate(
  rd: import('../lib/formEngine').ResultsDataEntry | null | undefined,
  submissionCount: number,
): string | undefined {
  if (!rd || submissionCount < 2) return undefined;
  const baseDeclMin =
    submissionCount >= 3
      ? maxIsoDate(
          rd.second_attempt_date ?? undefined,
          rd.trainer_date ?? undefined,
          rd.first_attempt_date ?? undefined,
        )
      : maxIsoDate(rd.trainer_date ?? undefined, rd.first_attempt_date ?? undefined);
  return baseDeclMin ? (addIsoDays(baseDeclMin, 1) ?? baseDeclMin) : undefined;
}

function clampIsoToMin(value: string | null | undefined, min: string | undefined): string | null {
  const v = String(value ?? '').trim();
  const m = min?.trim();
  if (!m) return v || null;
  if (!v) return null;
  const vi = normalizeCalendarDateToIso(v);
  const mi = normalizeCalendarDateToIso(m);
  if (vi && mi && vi < mi) return mi;
  return v;
}

/** Trainers/office/admins are staff roles (used for sheet date field editability — not date-order bypass). */
function canStaffBypassDateOrderConstraints(role: FormRole, isAdminEditMode: boolean): boolean {
  return role === 'trainer' || role === 'office' || isAdminEditMode;
}

function pickDateWithMin(value: string | null | undefined, min: string | undefined): string | null {
  return clampIsoToMin(value, min);
}

function pickDateWithMinForStaff(
  value: string | null | undefined,
  min: string | undefined,
  staffBypass: boolean,
): string | null {
  return staffBypass ? (value?.trim() || null) : pickDateWithMin(value, min);
}

/** Staff correcting historical dates need full calendar navigation — not only selectable days. */
function staffDatePickerMin(min: string | undefined, staffBypass: boolean): string | undefined {
  return staffBypass ? undefined : min || undefined;
}

function getPreSummaryTaskResultSectionIds(template: FormTemplate): number[] {
  return (template.steps ?? [])
    .flatMap((st) => st.sections)
    .filter((s) => s.pdf_render_mode === 'task_results' && isPreSummarySection(template, s.id))
    .map((s) => s.id);
}

const SUMMARY_TRAINER_DATE_TO_RESULTS_ATTEMPT: Record<
  'trainer_date_1' | 'trainer_date_2' | 'trainer_date_3',
  'first_attempt_date' | 'second_attempt_date' | 'third_attempt_date'
> = {
  trainer_date_1: 'first_attempt_date',
  trainer_date_2: 'second_attempt_date',
  trainer_date_3: 'third_attempt_date',
};

const RESULTS_ATTEMPT_DATE_TO_SUMMARY_TRAINER: Record<
  'first_attempt_date' | 'second_attempt_date' | 'third_attempt_date',
  'trainer_date_1' | 'trainer_date_2' | 'trainer_date_3'
> = {
  first_attempt_date: 'trainer_date_1',
  second_attempt_date: 'trainer_date_2',
  third_attempt_date: 'trainer_date_3',
};

type AnswersMap = Record<string, string | number | boolean | Record<string, unknown> | string[]>;

function rowAnswerHasContent(val: string | number | boolean | Record<string, unknown> | string[] | undefined): boolean {
  if (val == null) return false;
  if (typeof val === 'object' && !Array.isArray(val)) {
    return Object.values(val as Record<string, unknown>).some((v) => String(v ?? '').trim());
  }
  return String(val).trim() !== '';
}

function summaryRequiresSecondAttempt(sum: import('../lib/formEngine').AssessmentSummaryDataEntry): boolean {
  return sum.final_attempt_1_result === 'not_yet_competent';
}

function summaryRequiresThirdAttempt(sum: import('../lib/formEngine').AssessmentSummaryDataEntry): boolean {
  return summaryRequiresSecondAttempt(sum) && sum.final_attempt_2_result === 'not_yet_competent';
}

function getSubmissionWave(submissionCount: number): 1 | 2 | 3 {
  return Math.min(Math.max(submissionCount || 1, 1), 3) as 1 | 2 | 3;
}

/**
 * Active attempt for trainer results / summary marking.
 * Each student hand-in (submission_count) maps to the attempt being reviewed:
 * 1st submit → attempt 1, 2nd submit → attempt 2, 3rd submit → attempt 3.
 * Prior per-task S/NS on the results sheet may differ from summary NYC; submission_count is authoritative.
 */
function getActiveMarkingAttemptNum(
  submissionCount: number,
  _sum?: import('../lib/formEngine').AssessmentSummaryDataEntry | null | undefined,
  _rd?: import('../lib/formEngine').ResultsDataEntry | null | undefined,
): 1 | 2 | 3 {
  return getSubmissionWave(submissionCount);
}

/** Student may prep attempt 2/3 summary fields in draft after trainer NYC, before the next hand-in. */
function getStudentPrepAttemptNum(
  submissionCount: number,
  sum: import('../lib/formEngine').AssessmentSummaryDataEntry | null | undefined,
): 1 | 2 | 3 {
  const wave = getSubmissionWave(submissionCount);
  const entry = sum ?? ({} as import('../lib/formEngine').AssessmentSummaryDataEntry);
  if (summaryRequiresThirdAttempt(entry) && wave < 3) return 3;
  if (summaryRequiresSecondAttempt(entry) && wave < 2) return 2;
  return wave;
}

/** Latest attempt the trainer is finalising on submit (matches current submission wave). */
function getTrainerSubmitAttemptNum(
  submissionCount: number,
  _sum?: import('../lib/formEngine').AssessmentSummaryDataEntry | null | undefined,
): 1 | 2 | 3 {
  return getSubmissionWave(submissionCount);
}

/** Trainers/admins may edit attempt columns up to and including the active marking attempt (not future). */
function isStaffAttemptColumnEditable(activeAttemptNum: 1 | 2 | 3, columnAttempt: 1 | 2 | 3): boolean {
  return columnAttempt <= activeAttemptNum;
}

/** Step validation requires the current active attempt column to be complete. */
function isCurrentMarkingAttemptColumn(activeAttemptNum: 1 | 2 | 3, columnAttempt: 1 | 2 | 3): boolean {
  return columnAttempt === activeAttemptNum;
}

type GridColumnType = 'question' | 'answer';

function normalizeGridColumnType(raw: unknown): GridColumnType {
  return String(raw ?? '').trim().toLowerCase() === 'question' ? 'question' : 'answer';
}

function getGridAnswerColumnIndexes(q: FormQuestionWithOptionsAndRows): number[] {
  const pm = (q.pdf_meta as Record<string, unknown>) || {};
  const colsMeta = pm.columnsMeta;
  if (Array.isArray(colsMeta) && colsMeta.length > 0) {
    return colsMeta
      .map((entry, idx) => {
        if (!entry || typeof entry !== 'object') return idx;
        const e = entry as Record<string, unknown>;
        return normalizeGridColumnType(e.type) === 'answer' ? idx : -1;
      })
      .filter((idx) => idx >= 0);
  }
  const columns = Array.isArray(pm.columns) ? (pm.columns as unknown[]) : [];
  const types = Array.isArray(pm.columnTypes) ? (pm.columnTypes as unknown[]) : [];
  if (columns.length > 0) {
    return columns
      .map((_, idx) => (normalizeGridColumnType(types[idx]) === 'answer' ? idx : -1))
      .filter((idx) => idx >= 0);
  }
  return [0];
}

function isGridTableFilled(q: FormQuestionWithOptionsAndRows, answers: AnswersMap): boolean {
  if (q.type !== 'grid_table' || !q.rows?.length) return false;
  const pm = (q.pdf_meta as Record<string, unknown>) || {};
  const layout = String(pm.layout ?? 'no_image');
  const isNoHeader = layout === 'no_image_no_header';
  const answerColIndexes = getGridAnswerColumnIndexes(q);
  const hasQuestionTypedColumn = (() => {
    const colsMeta = pm.columnsMeta;
    if (Array.isArray(colsMeta) && colsMeta.length > 0) {
      return colsMeta.some((entry) => {
        if (!entry || typeof entry !== 'object') return false;
        return normalizeGridColumnType((entry as Record<string, unknown>).type) === 'question';
      });
    }
    const types = Array.isArray(pm.columnTypes) ? (pm.columnTypes as unknown[]) : [];
    return types.some((t) => normalizeGridColumnType(t) === 'question');
  })();

  // Case 2: no-header + question-row style table:
  // required means at least one answer column must be fully filled down all rows.
  if (isNoHeader && hasQuestionTypedColumn && answerColIndexes.length > 0) {
    for (const colIdx of answerColIndexes) {
      let allRowsFilledForColumn = true;
      for (const r of q.rows) {
        const rowVal = answers[getAnswerKey(q.id, r.id)];
        const rowObj = rowVal && typeof rowVal === 'object' && !Array.isArray(rowVal)
          ? (rowVal as Record<string, unknown>)
          : null;
        const cellVal = rowObj ? String(rowObj[`r${r.id}_c${colIdx}`] ?? '').trim() : '';
        if (!cellVal) {
          allRowsFilledForColumn = false;
          break;
        }
      }
      if (allRowsFilledForColumn) return true;
    }
    return legacyGridCountsAsFilled(q, answers);
  }

  // Case 1: header table (or generic grid):
  // required means one full row across answer columns is enough.
  if (answerColIndexes.length > 0) {
    for (const r of q.rows) {
      const rowVal = answers[getAnswerKey(q.id, r.id)];
      const rowObj = rowVal && typeof rowVal === 'object' && !Array.isArray(rowVal)
        ? (rowVal as Record<string, unknown>)
        : null;
      if (!rowObj) continue;
      let fullRow = true;
      for (const colIdx of answerColIndexes) {
        const cellVal = String(rowObj[`r${r.id}_c${colIdx}`] ?? '').trim();
        if (!cellVal) {
          fullRow = false;
          break;
        }
      }
      if (fullRow) return true;
    }
    return legacyGridCountsAsFilled(q, answers);
  }

  // Fallback for legacy data shapes: any row having content counts as answered.
  for (const r of q.rows) {
    const key = getAnswerKey(q.id, r.id);
    if (rowAnswerHasContent(answers[key])) return true;
  }
  return legacyGridCountsAsFilled(q, answers);
}

function isLikertFilled(q: FormQuestionWithOptionsAndRows, answers: AnswersMap): boolean {
  if (q.type !== 'likert_5' || !q.rows?.length) return false;
  if (q.rows.length === 1) {
    const v = answers[getAnswerKey(q.id, q.rows[0].id)];
    return v != null && String(v).trim() !== '';
  }
  for (const r of q.rows) {
    const v = answers[getAnswerKey(q.id, r.id)];
    if (v == null || !String(v).trim()) return false;
  }
  return true;
}

/** Parent question with embedded `contentBlocks` answers child question IDs; row-based answers live on children, not `q-{parentId}`. */
function isRequiredSatisfiedByContentBlocks(
  q: FormQuestionWithOptionsAndRows,
  section: FormSectionWithQuestions,
  answers: AnswersMap
): boolean | null {
  const pm = (q.pdf_meta as Record<string, unknown>) || {};
  const blocks = pm.contentBlocks as Array<{ type: string; questionId?: number }> | undefined;
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  const hasBlockInputs = blocks.some(
    (b) => b.questionId && (b.type === 'grid_table' || b.type === 'short_text' || b.type === 'long_text')
  );
  if (!hasBlockInputs) return null;

  let allGridsOk = true;
  let anyGridBlock = false;
  let allTextBlocksOk = true;
  let anyTextBlock = false;

  for (const b of blocks) {
    if (!b.questionId) continue;
    const childQ = section.questions.find((x) => x.id === b.questionId);
    if (!childQ) continue;
    if (b.type === 'grid_table' && childQ.rows?.length) {
      anyGridBlock = true;
      if (!isGridTableFilled(childQ, answers)) allGridsOk = false;
    } else if (b.type === 'short_text' || b.type === 'long_text') {
      anyTextBlock = true;
      if (childQ.required && !rowAnswerHasContent(answers[getAnswerKey(childQ.id, null)] as string | number | boolean | Record<string, unknown> | string[] | undefined)) {
        allTextBlocksOk = false;
      }
    }
  }

  const parentKey = getAnswerKey(q.id, null);
  const parentFilled = String(answers[parentKey] ?? '').trim() !== '';

  if (parentFilled) return true;
  if (anyGridBlock && !allGridsOk) return false;
  if (anyTextBlock && !allTextBlocksOk) return false;
  return (anyGridBlock && allGridsOk) || (anyTextBlock && allTextBlocksOk);
}

/** Trainer Yes/No on a parent question also applies to embedded / linked child questions. */
function getTrainerSatisfactoryForQuestion(
  section: FormSectionWithQuestions,
  questionId: number,
  trainerAssessments: Record<number, string>
): 'yes' | 'no' | null {
  const direct = trainerAssessments[questionId];
  if (direct === 'yes' || direct === 'no') return direct;
  const childQ = section.questions.find((x) => x.id === questionId);
  const childPm = (childQ?.pdf_meta as Record<string, unknown>) || {};
  const additionalParentId = childPm.isAdditionalBlockOf;
  if (typeof additionalParentId === 'number') {
    const parentSat = trainerAssessments[additionalParentId];
    if (parentSat === 'yes' || parentSat === 'no') return parentSat;
  }
  for (const parent of section.questions) {
    const pm = (parent.pdf_meta as Record<string, unknown>) || {};
    const blocks = pm.contentBlocks as Array<{ questionId?: number }> | undefined;
    if (!Array.isArray(blocks)) continue;
    if (!blocks.some((b) => b.questionId === questionId)) continue;
    const parentSat = trainerAssessments[parent.id];
    if (parentSat === 'yes' || parentSat === 'no') return parentSat;
    const legacyAb = pm.additionalBlock as { questionId?: number } | undefined;
    if (legacyAb?.questionId === questionId) {
      const legacySat = trainerAssessments[parent.id];
      if (legacySat === 'yes' || legacySat === 'no') return legacySat;
    }
  }
  return null;
}

function parseAnswerValue(a: FormAnswer): string | number | boolean | Record<string, unknown> | string[] | null {
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

export const InstanceFillPage: React.FC = () => {
  const { instanceId } = useParams<{ instanceId: string }>();
  const [searchParams] = useSearchParams();
  const isAdminEditMode = searchParams.get('admin') === '1';
  const [adminSkipSavePrompt, setAdminSkipSavePrompt] = useState<'validation' | 'save' | null>(null);
  const [template, setTemplate] = useState<FormTemplate | null>(null);
  const [answers, setAnswers] = useState<Record<string, string | number | boolean | Record<string, unknown> | string[]>>({});
  const [trainerAssessments, setTrainerAssessments] = useState<Record<number, string>>({});
  const [trainerRowAssessments, setTrainerRowAssessments] = useState<Record<string, string>>({});
  const [resultsOffice, setResultsOffice] = useState<
    Record<number, { entered_date: string | null; entered_by: string | null; initial_checked: boolean; updated_checked: boolean }>
  >({});
  const [resultsData, setResultsData] = useState<Record<number, import('../lib/formEngine').ResultsDataEntry>>({});
  const [assessmentSummary, setAssessmentSummary] = useState<import('../lib/formEngine').AssessmentSummaryDataEntry | null>(null);
  const [role, setRole] = useState<FormRole>('student');
  const [workflowStatus, setWorkflowStatus] = useState<
    'draft' | 'waiting_trainer' | 'waiting_office' | 'completed' | 'failed' | 'awaiting_submission'
  >('draft');
  const submissionRequestIdRef = useRef<string | null>(null);
  const [submissionCount, setSubmissionCount] = useState<number>(0);
  const [didNotAttempt, setDidNotAttempt] = useState(false);
  const [instanceLegacyStatus, setInstanceLegacyStatus] = useState<string>('draft');
  const [instanceRoleContext, setInstanceRoleContext] = useState<FormRole>('student');
  /** Set after a successful Final Submit so the thank-you screen shows immediately (local workflow state can lag). */
  const [showPostSubmitThankYou, setShowPostSubmitThankYou] = useState(false);

  const staffBypassDateConstraints = useMemo(
    () => canStaffBypassDateOrderConstraints(role, isAdminEditMode),
    [role, isAdminEditMode],
  );

  /** Trainer (and office) may edit fields marked student-only in the template so they can correct student answers. */
  const isQuestionEditableForRole = useCallback(
    (re: Record<string, boolean> | null | undefined) => {
      const editability = re || {};
      // Admin edit mode unlocks every field regardless of template role editability.
      if (role === 'office' && isAdminEditMode) return true;
      if (role === 'office') {
        return (
          isRoleEditable(editability, 'office') ||
          isRoleEditable(editability, 'trainer') ||
          isRoleEditable(editability, 'student')
        );
      }
      if (role === 'trainer') {
        return isRoleEditable(editability, 'trainer') || isRoleEditable(editability, 'student');
      }
      return isRoleEditable(editability, role);
    },
    [role, isAdminEditMode]
  );

  /** Trainer/office may also VIEW fields marked student-visible so they can review/correct student work. */
  const isQuestionVisibleForRole = useCallback(
    (rv: Record<string, boolean> | null | undefined) => {
      const visibility = rv || {};
      if (role === 'office') {
        return (
          isRoleVisible(visibility, 'office') ||
          isRoleVisible(visibility, 'trainer') ||
          isRoleVisible(visibility, 'student')
        );
      }
      if (role === 'trainer') {
        return isRoleVisible(visibility, 'trainer') || isRoleVisible(visibility, 'student');
      }
      return isRoleVisible(visibility, role);
    },
    [role]
  );

  /** Derived unit outcome for an attempt: any task NS → NYC; all tasks S → Competent; otherwise incomplete (null). */
  const getTrainerAttemptOutcome = useCallback(
    (attempt: 1 | 2 | 3): AttemptOutcome => {
      const checks = getTaskResultChecks(template, attempt, resultsData, answers, trainerAssessments);
      return getTrainerAttemptOutcomeFromChecks(checks);
    },
    [template, resultsData, answers, trainerAssessments]
  );

  const competentBlockerToastRef = useRef<string | null>(null);

  /** Min calendar date for first-attempt results: student declaration (form) vs summary student_date_1 — whichever is later. */
  const studentDeclarationDateMinIso = useMemo(() => {
    if (!template) return undefined;
    const studentDeclQ = template.steps
      ?.flatMap((st) => st.sections)
      .flatMap((s) => s.questions)
      .find((q) => q.code === 'student.declarationSignature');
    if (!studentDeclQ) return undefined;
    const studentDeclVal = answers[getAnswerKey(studentDeclQ.id, null)];
    const studentDeclSigObj =
      studentDeclVal && typeof studentDeclVal === 'object' && !Array.isArray(studentDeclVal)
        ? (studentDeclVal as Record<string, unknown>)
        : null;
    const raw = studentDeclSigObj ? String(studentDeclSigObj.date ?? studentDeclSigObj.signedAtDate ?? '').trim() : '';
    return normalizeCalendarDateToIso(raw) ?? undefined;
  }, [template, answers]);

  const instanceStudentName = useMemo(() => {
    const q = template?.steps
      ?.flatMap((st) => st.sections)
      .flatMap((s) => s.questions)
      .find((item) => item.code === 'student.fullName');
    return q ? String(answers[getAnswerKey(q.id, null)] ?? '').trim() : '';
  }, [template, answers]);

  const instanceTrainerName = useMemo(() => {
    const q = template?.steps
      ?.flatMap((st) => st.sections)
      .flatMap((s) => s.questions)
      .find((item) => item.code === 'trainer.fullName');
    return q ? String(answers[getAnswerKey(q.id, null)] ?? '').trim() : '';
  }, [template, answers]);

  const [confirmConfig, setConfirmConfig] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
  } | null>(null);
  const [workflowSubmitting, setWorkflowSubmitting] = useState(false);
  const [manualSaveBusy, setManualSaveBusy] = useState(false);
  const [questionSaveStatus, setQuestionSaveStatus] = useState<Record<number, QuestionSaveStatus>>({});
  const [stepNavSaving, setStepNavSaving] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState<string | null>(null);
  const [courseRunningAccess, setCourseRunningAccess] = useState<StudentAssessmentAccessResult | null>(null);
  const [studentCourseMutationAllowed, setStudentCourseMutationAllowed] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** Ordered top-level question failures from the last validation pass (for toast summary + scroll). */
  const questionValidationMetaRef = useRef<AssessmentQuestionErrorMeta[]>([]);
  /** Debounce saves per answer key (questionId + rowId). A single shared timer causes grid tables to only persist the last row edited. */
  const saveTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const formScrollRef = useRef<HTMLFormElement>(null);

  const cancelPendingDebouncedAnswerSaves = useCallback(() => {
    for (const t of saveTimeoutsRef.current.values()) clearTimeout(t);
    saveTimeoutsRef.current.clear();
  }, []);

  const id = instanceId ? Number(instanceId) : 0;
  const accessToken = searchParams.get('token')?.trim() || '';
  const [pdfRefresh, setPdfRefresh] = useState(0);

  /** Pass effective token role so staff (trainer/office) are never lifecycle-blocked on student drafts. */
  const saveAnswer = useCallback(
    (
      instanceIdArg: number,
      questionId: number,
      rowId: number | null,
      value: { text?: string; number?: number; json?: unknown },
      options?: { allowClear?: boolean; source?: string; actorRole?: string | null },
    ) =>
      persistAnswer(instanceIdArg, questionId, rowId, value, {
        ...options,
        actorRole: options?.actorRole ?? role,
      }),
    [role],
  );
  const saveResultsData = useCallback(
    (
      instanceIdArg: number,
      sectionId: number,
      data: Partial<Omit<import('../lib/formEngine').ResultsDataEntry, 'section_id'>>,
      options?: { actorRole?: string | null; source?: string },
    ) =>
      persistResultsData(instanceIdArg, sectionId, data, {
        ...options,
        actorRole: options?.actorRole ?? role,
      }),
    [role],
  );
  const saveAssessmentSummaryData = useCallback(
    (
      instanceIdArg: number,
      data: Partial<import('../lib/formEngine').AssessmentSummaryDataEntry>,
      options?: { actorRole?: string | null; source?: string },
    ) =>
      persistAssessmentSummaryData(instanceIdArg, data, {
        ...options,
        actorRole: options?.actorRole ?? role,
      }),
    [role],
  );

  const loadData = useCallback(async () => {
    if (!id) return;
    setAccessDenied(null);
    setCourseRunningAccess(null);
    setStudentCourseMutationAllowed(true);
    setLoading(true);
    if (!accessToken) {
      setAccessDenied('Secure access token is missing. Please use the link shared by admin.');
      setLoading(false);
      return;
    }
    const [access, inst] = await Promise.all([
      validateInstanceAccessToken(id, accessToken),
      fetchInstance(id),
    ]);
    if (!access.valid || !access.role_context) {
      setAccessDenied(access.reason || 'Invalid secure access link.');
      setLoading(false);
      return;
    }
    const tokenRole = access.role_context as FormRole;
    setRole(tokenRole);
    const courseAccess = access.courseAccess ?? null;
    setCourseRunningAccess(courseAccess);
    const allowStudentMutate =
      tokenRole !== 'student' || !courseAccess || studentMayMutateAssessment(courseAccess);
    setStudentCourseMutationAllowed(allowStudentMutate);
    // Denied open: validate already rejects; for read-only, continue without mutation/hydration writes.
    if (tokenRole === 'student' && courseAccess && !allowStudentMutate) {
      setAccessDenied(courseAccess.message || MSG_COURSE_NOT_IN_PROGRESS);
      setLoading(false);
      return;
    }
    const formId = inst && Number.isFinite(Number(inst.form_id)) ? Number(inst.form_id) : null;
    const [tpl, ans, assessments, rowAssessments, officeData, resultsDataRes, summaryData] = await Promise.all([
      formId ? fetchTemplateForForm(formId, { skipEnsureTaskSections: true }) : Promise.resolve(null),
      fetchAnswersForInstance(id),
      fetchTrainerAssessments(id).catch(() => ({})),
      fetchTrainerRowAssessments(id).catch(() => ({})),
      fetchResultsOffice(id).catch(() => ({})),
      fetchResultsData(id).catch(() => ({})),
      fetchAssessmentSummaryData(id).catch(() => null),
    ]);
    if (!tpl || !inst) {
      setAccessDenied('Form not found or unavailable.');
      setLoading(false);
      return;
    }
    setTemplate(tpl || null);
    const roleCtx = (inst?.role_context as FormRole) || 'student';
    setInstanceRoleContext(roleCtx);
    const rawWorkflow = (inst as unknown as { workflow_status?: string } | null)?.workflow_status;
    const legacyStatus = String((inst as unknown as { status?: string } | null)?.status ?? 'draft').trim() || 'draft';
    setInstanceLegacyStatus(legacyStatus);
    const instSubmittedAt = (inst as unknown as { submitted_at?: string } | null)?.submitted_at;
    const instSubmissionCount = Number((inst as unknown as { submission_count?: number | null } | null)?.submission_count ?? 0) || 0;
    const studentHasSubmitted =
      instSubmissionCount > 0 || Boolean(String(instSubmittedAt ?? '').trim());
    const instDidNotAttempt = Boolean((inst as unknown as { did_not_attempt?: boolean | null } | null)?.did_not_attempt);
    setDidNotAttempt(instDidNotAttempt);
    let normalizedWorkflow = (
      rawWorkflow
        ? rawWorkflow
        : legacyStatus === 'locked'
          ? 'completed'
          : legacyStatus === 'submitted'
            ? roleCtx === 'office'
              ? 'waiting_office'
              : 'waiting_trainer'
            : legacyStatus === 'draft' && roleCtx === 'trainer'
              ? 'waiting_trainer'
              : legacyStatus === 'draft' && roleCtx === 'office'
                ? 'waiting_office'
                : 'draft'
    ) as 'draft' | 'waiting_trainer' | 'waiting_office' | 'completed' | 'failed' | 'awaiting_submission';
    // Student handed in while still with trainer/office — not when reopened for resubmission (student + draft).
    if (
      studentHasSubmitted &&
      !instDidNotAttempt &&
      normalizedWorkflow === 'draft' &&
      roleCtx !== 'student'
    ) {
      normalizedWorkflow = roleCtx === 'office' ? 'waiting_office' : 'waiting_trainer';
    }
    // Stale workflow_status=failed/completed while instance is still draft and student never submitted
    // (e.g. admin reopened dates but workflow_status was not reset).
    if (roleCtx === 'student' && legacyStatus === 'draft' && !studentHasSubmitted && !instDidNotAttempt) {
      if (normalizedWorkflow === 'failed' || normalizedWorkflow === 'completed') {
        normalizedWorkflow = 'draft';
      }
    }
    if (instDidNotAttempt && !studentHasSubmitted) {
      normalizedWorkflow = 'failed';
    }
    setWorkflowStatus(normalizedWorkflow);
    setSubmissionCount(instSubmissionCount || (instSubmittedAt ? 1 : 0));
    const ansMap: Record<string, string | number | boolean | Record<string, unknown> | string[]> = {};
    for (const a of ans) {
      const key = getAnswerKey(a.question_id, a.row_id);
      ansMap[key] = parseAnswerValue(a) as string | number | boolean | Record<string, unknown> | string[];
    }

    const identityQuestions: IdentityQuestionRef[] = [];
    for (const step of tpl?.steps ?? []) {
      for (const section of step.sections) {
        for (const q of section.questions) {
          if (
            q.code === 'student.fullName' ||
            q.code === 'student.id' ||
            q.code === 'student.email' ||
            q.code === 'trainer.fullName'
          ) {
            identityQuestions.push({ code: q.code as IdentityFieldCode, questionId: q.id });
          }
        }
      }
    }
    if (identityQuestions.length > 0 && allowStudentMutate) {
      const identitySources = await fetchInstanceIdentitySources(id);
      if (identitySources) {
        const sourceValues = buildIdentitySourceValues({
          profileName: identitySources.studentFullName,
          profileEmail: identitySources.studentEmail,
          profileStudentCode: identitySources.studentId,
          trainerName: identitySources.trainerFullName,
          resultsStudentName: identitySources.resultsStudentName,
          resultsTrainerName: identitySources.resultsTrainerName,
        });
        const hydrationUpdates = buildIdentityHydrationUpdates({
          questions: identityQuestions,
          currentAnswers: ansMap,
          sources: sourceValues,
          getAnswerKey: (questionId) => getAnswerKey(questionId, null),
        });
        for (const update of hydrationUpdates) {
          ansMap[getAnswerKey(update.questionId, null)] = update.value;
          await saveAnswer(id, update.questionId, null, { text: update.value }, {
            source: 'identity-hydration',
            actorRole: tokenRole,
          });
        }
      }
    } else if (identityQuestions.length > 0) {
      // Read-only view: hydrate display from profile without persisting.
      const identitySources = await fetchInstanceIdentitySources(id);
      if (identitySources) {
        const sourceValues = buildIdentitySourceValues({
          profileName: identitySources.studentFullName,
          profileEmail: identitySources.studentEmail,
          profileStudentCode: identitySources.studentId,
          trainerName: identitySources.trainerFullName,
          resultsStudentName: identitySources.resultsStudentName,
          resultsTrainerName: identitySources.resultsTrainerName,
        });
        const hydrationUpdates = buildIdentityHydrationUpdates({
          questions: identityQuestions,
          currentAnswers: ansMap,
          sources: sourceValues,
          getAnswerKey: (questionId) => getAnswerKey(questionId, null),
        });
        for (const update of hydrationUpdates) {
          ansMap[getAnswerKey(update.questionId, null)] = update.value;
        }
      }
    }

    setAnswers(ansMap);
    setTrainerAssessments(assessments || {});
    setTrainerRowAssessments(rowAssessments || {});
    const officeMap: Record<
      number,
      { entered_date: string | null; entered_by: string | null; initial_checked: boolean; updated_checked: boolean }
    > = {};
    for (const [secId, entry] of Object.entries(officeData || {})) {
      const e = entry as import('../lib/formEngine').ResultsOfficeEntry;
      officeMap[Number(secId)] = {
        entered_date: e.entered_date,
        entered_by: e.entered_by,
        initial_checked: Boolean(e.initial_checked ?? false),
        updated_checked: Boolean(e.updated_checked ?? false),
      };
    }
    setResultsOffice(officeMap);
    setResultsData(resultsDataRes || {});
    setAssessmentSummary(summaryData || null);
    setLoading(false);
  }, [id, accessToken, saveAnswer]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  /** Completed student hand-ins (DB submission_count). Trainers always use this — never a prep bump. */
  const submissionWave = useMemo(() => getSubmissionWave(submissionCount), [submissionCount]);

  /** Student-only: prep attempt 2/3 fields in draft after trainer NYC, before the next hand-in. */
  const markingRound = useMemo(() => {
    if (role === 'student' && workflowStatus === 'draft') {
      return getStudentPrepAttemptNum(submissionCount, assessmentSummary);
    }
    return submissionWave;
  }, [
    submissionCount,
    submissionWave,
    assessmentSummary?.final_attempt_1_result,
    assessmentSummary?.final_attempt_2_result,
    role,
    workflowStatus,
  ]);

  /** Normalize signature values: accept string or object with signature/imageDataUrl/typedText. DB stores TEXT. */
  const normalizeSignatureValue = useCallback((v: string | null | { signature?: string; imageDataUrl?: string; typedText?: string } | undefined): string | null => {
    if (v == null) return null;
    if (typeof v === 'string') return v.trim() || null;
    if (typeof v === 'object' && !Array.isArray(v)) {
      const s = String((v as Record<string, unknown>).signature ?? (v as Record<string, unknown>).imageDataUrl ?? (v as Record<string, unknown>).typedText ?? '').trim();
      return s || null;
    }
    return null;
  }, []);

  const handleResultsDataChange = useCallback(
    async (sectionId: number, field: keyof import('../lib/formEngine').ResultsDataEntry, value: string | null) => {
      const isSig = field === 'student_signature' || field === 'trainer_signature';
      const isFeedback =
        field === 'first_attempt_feedback' ||
        field === 'second_attempt_feedback' ||
        field === 'third_attempt_feedback';
      const normalized = isSig
        ? normalizeSignatureValue(value)
        : isFeedback
          ? value == null
            ? null
            : (() => {
                const s = String(value);
                return s.length === 0 ? null : s;
              })()
          : value != null
            ? String(value).trim() || null
            : null;
      const attemptDateField =
        field === 'first_attempt_date' || field === 'second_attempt_date' || field === 'third_attempt_date'
          ? field
          : null;

      let rejectReason: string | null = null;
      let savePatches: { sectionId: number; patch: Partial<import('../lib/formEngine').ResultsDataEntry> }[] = [];
      let summaryTrainerPatch: Partial<import('../lib/formEngine').AssessmentSummaryDataEntry> | null = null;

      setResultsData((prev) => {
        const rd = prev[sectionId];
        const base = rd ?? ({ section_id: sectionId } as import('../lib/formEngine').ResultsDataEntry);

        if (!staffBypassDateConstraints) {
          if (field === 'first_attempt_date' && normalized) {
            const minFirst = getResultsMinFirstAttemptDate(assessmentSummary, studentDeclarationDateMinIso);
            if (minFirst && isCalendarBefore(normalized, minFirst)) {
              rejectReason =
                'First attempt date must be on or after the student declaration date.';
              return prev;
            }
          }
          if (field === 'second_attempt_date' && normalized) {
            const minSecond = getResultsMinSecondAttemptDate(base, assessmentSummary);
            if (minSecond && isCalendarBefore(normalized, minSecond)) {
              const hasFirstTrainer = Boolean(
                String(base.trainer_date ?? assessmentSummary?.trainer_date_1 ?? '').trim(),
              );
              rejectReason = hasFirstTrainer
                ? '2nd attempt student date cannot be before the 1st attempt trainer date.'
                : '2nd attempt student date cannot be before the 1st attempt student date.';
              return prev;
            }
          }
          if (field === 'third_attempt_date' && normalized) {
            const minThird = getResultsMinThirdAttemptDate(base, assessmentSummary);
            if (minThird && isCalendarBefore(normalized, minThird)) {
              const hasSecondTrainer = Boolean(String(assessmentSummary?.trainer_date_2 ?? '').trim());
              rejectReason = hasSecondTrainer
                ? '3rd attempt student date cannot be before the 2nd attempt trainer date.'
                : '3rd attempt student date cannot be before the 2nd attempt student date.';
              return prev;
            }
          }
          if (field === 'trainer_date' && normalized) {
            const minTrainer = getResultsTrainerFooterDateMin(base);
            if (minTrainer && isCalendarBefore(normalized, minTrainer)) {
              rejectReason = 'Trainer date cannot be before the student attempt date.';
              return prev;
            }
          }
        }

        const next = { ...prev };
        const applyPatch = (sid: number, patch: Partial<import('../lib/formEngine').ResultsDataEntry>) => {
          const cur = next[sid] ?? ({ section_id: sid } as import('../lib/formEngine').ResultsDataEntry);
          next[sid] = { ...cur, ...patch } as import('../lib/formEngine').ResultsDataEntry;
        };

        let primaryPatch: Partial<import('../lib/formEngine').ResultsDataEntry> = { [field]: normalized };
        if (field === 'student_signature') {
          primaryPatch = applyResultsStudentSignatureConvenience(base, primaryPatch, instanceStudentName || null);
        }
        if (field === 'trainer_signature') {
          primaryPatch = applyResultsTrainerSignatureConvenience(base, primaryPatch, instanceTrainerName || null);
        }
        if (attemptDateField && normalized) {
          const existingTrainerFooterDate = String(base.trainer_date ?? '').trim();
          if (!existingTrainerFooterDate) primaryPatch.trainer_date = normalized;
        }
        applyPatch(sectionId, primaryPatch);
        savePatches.push({ sectionId, patch: primaryPatch });

        if (attemptDateField && normalized && template) {
          const sectionIds = getPreSummaryTaskResultSectionIds(template);
          for (const sid of sectionIds) {
            if (sid === sectionId) continue;
            const cur = next[sid] ?? ({ section_id: sid } as import('../lib/formEngine').ResultsDataEntry);
            const patch: Partial<import('../lib/formEngine').ResultsDataEntry> = { [attemptDateField]: normalized };
            if (!String(cur.trainer_date ?? '').trim()) patch.trainer_date = normalized;
            applyPatch(sid, patch);
            savePatches.push({ sectionId: sid, patch });
          }
          const summaryField = RESULTS_ATTEMPT_DATE_TO_SUMMARY_TRAINER[attemptDateField];
          const curSummaryTrainer = String(
            (assessmentSummary as unknown as Record<string, unknown> | null)?.[summaryField] ?? '',
          ).trim();
          if (!curSummaryTrainer) {
            summaryTrainerPatch = { [summaryField]: normalized };
          }
        }

        return next;
      });

      if (rejectReason) {
        toast.error(rejectReason);
        return;
      }

      const dedupedSaves = new Map<number, Partial<import('../lib/formEngine').ResultsDataEntry>>();
      for (const { sectionId: sid, patch } of savePatches) {
        dedupedSaves.set(sid, { ...(dedupedSaves.get(sid) ?? {}), ...patch });
      }
      await Promise.all(
        [...dedupedSaves.entries()].map(([sid, patch]) => saveResultsData(id, sid, patch)),
      );

      if (summaryTrainerPatch) {
        setAssessmentSummary((prev) =>
          prev
            ? { ...prev, ...summaryTrainerPatch }
            : ({ ...summaryTrainerPatch } as import('../lib/formEngine').AssessmentSummaryDataEntry),
        );
        await saveAssessmentSummaryData(id, summaryTrainerPatch);
      }

      setPdfRefresh((r) => r + 1);
    },
    [id, normalizeSignatureValue, assessmentSummary, studentDeclarationDateMinIso, template, staffBypassDateConstraints, instanceStudentName, instanceTrainerName]
  );

  const handleResultsOutcomeSelect = useCallback(
    (
      sectionId: number,
      field: 'first_attempt_satisfactory' | 'second_attempt_satisfactory' | 'third_attempt_satisfactory',
      value: 's' | 'ns',
      editable: boolean,
    ) => {
      if (!editable) return;
      const current = resultsData[sectionId]?.[field] ?? null;
      void handleResultsDataChange(sectionId, field, toggleOutcomeSelection(current, value));
    },
    [resultsData, handleResultsDataChange],
  );

  useEffect(() => {
    if (!template || !id) return;
    const studentNameQ = template.steps?.flatMap((st) => st.sections).flatMap((s) => s.questions).find((q) => q.code === 'student.fullName');
    const trainerNameQ = template.steps?.flatMap((st) => st.sections).flatMap((s) => s.questions).find((q) => q.code === 'trainer.fullName');
    const studentName = studentNameQ ? String(answers[getAnswerKey(studentNameQ.id, null)] ?? '').trim() : '';
    const trainerName = trainerNameQ ? String(answers[getAnswerKey(trainerNameQ.id, null)] ?? '').trim() : '';
    const taskResultSections =
      template.steps?.flatMap((st) => st.sections).filter(
        (s) => s.pdf_render_mode === 'task_results' && isPreSummarySection(template, s.id)
      ) ?? [];
    const updates: { sectionId: number; field: 'student_name' | 'trainer_name'; value: string }[] = [];
    for (const sec of taskResultSections) {
      const rd = resultsData[sec.id];
      const currentStudentName = (rd?.student_name ?? '').trim();
      const currentTrainerName = (rd?.trainer_name ?? '').trim();
      const sigIsTypedText = (s: string | null | undefined) => s && typeof s === 'string' && !s.startsWith('data:') && s.length > 1;
      const betterStudent = studentName || (sigIsTypedText(rd?.student_signature) ? rd!.student_signature! : '');
      const betterTrainer = trainerName || (sigIsTypedText(rd?.trainer_signature) ? rd!.trainer_signature! : '');
      if (betterStudent && (currentStudentName === '' || betterStudent.length > currentStudentName.length)) {
        updates.push({ sectionId: sec.id, field: 'student_name', value: betterStudent });
      }
      if (betterTrainer && (currentTrainerName === '' || betterTrainer.length > currentTrainerName.length)) {
        updates.push({ sectionId: sec.id, field: 'trainer_name', value: betterTrainer });
      }
    }
    if (updates.length === 0) return;
    setResultsData((prev) => {
      const next = { ...prev };
      for (const u of updates) {
        const existing = prev[u.sectionId];
        next[u.sectionId] = {
          ...(existing ?? ({ section_id: u.sectionId } as import('../lib/formEngine').ResultsDataEntry)),
          [u.field]: u.value,
        } as import('../lib/formEngine').ResultsDataEntry;
        saveResultsData(id, u.sectionId, { [u.field]: u.value });
      }
      setPdfRefresh((r) => r + 1);
      return next;
    });
  }, [template, answers, resultsData, id]);

  useEffect(() => {
    if (!template || !id) return;
    const studentNameQ = template.steps?.flatMap((st) => st.sections).flatMap((s) => s.questions).find((q) => q.code === 'student.fullName');
    const trainerNameQ = template.steps?.flatMap((st) => st.sections).flatMap((s) => s.questions).find((q) => q.code === 'trainer.fullName');
    const evalStudentNameQ = template.steps?.flatMap((st) => st.sections).flatMap((s) => s.questions).find((q) => q.code === 'evaluation.studentName');
    const evalTrainerNameQ = template.steps?.flatMap((st) => st.sections).flatMap((s) => s.questions).find((q) => q.code === 'evaluation.trainerName');
    const studentName = studentNameQ ? String(answers[getAnswerKey(studentNameQ.id, null)] ?? '').trim() : '';
    const trainerName = trainerNameQ ? String(answers[getAnswerKey(trainerNameQ.id, null)] ?? '').trim() : '';
    if (!studentName && !trainerName) return;
    const updates: { questionId: number; value: string }[] = [];
    if (evalStudentNameQ && studentName) {
      const current = String(answers[getAnswerKey(evalStudentNameQ.id, null)] ?? '').trim();
      if (current !== studentName) updates.push({ questionId: evalStudentNameQ.id, value: studentName });
    }
    if (evalTrainerNameQ && trainerName) {
      const current = String(answers[getAnswerKey(evalTrainerNameQ.id, null)] ?? '').trim();
      if (current !== trainerName) updates.push({ questionId: evalTrainerNameQ.id, value: trainerName });
    }
    if (updates.length === 0) return;
    setAnswers((prev) => {
      const next = { ...prev };
      for (const u of updates) {
        next[getAnswerKey(u.questionId, null)] = u.value;
      }
      return next;
    });
    for (const u of updates) {
      saveAnswer(id, u.questionId, null, { text: u.value });
    }
    setPdfRefresh((r) => r + 1);
  }, [template, answers, id]);

  useEffect(() => {
    if (!template || !id) return;
    const formExt = template.form as { unit_code?: string | null; unit_name?: string | null } | undefined;
    const unitName = formExt ? [formExt.unit_code, formExt.unit_name].filter(Boolean).join(' ').trim() : '';
    if (!unitName) return;
    const evalUnitNameQ = template.steps?.flatMap((st) => st.sections).flatMap((s) => s.questions).find((q) => q.code === 'evaluation.unitName');
    if (!evalUnitNameQ) return;
    const current = String(answers[getAnswerKey(evalUnitNameQ.id, null)] ?? '').trim();
    if (current) return;
    setAnswers((prev) => {
      const next = { ...prev };
      next[getAnswerKey(evalUnitNameQ.id, null)] = unitName;
      return next;
    });
    saveAnswer(id, evalUnitNameQ.id, null, { text: unitName });
    setPdfRefresh((r) => r + 1);
  }, [template, answers, id]);

  useEffect(() => {
    if (!template || !id) return;
    const taskResultSectionIds = buildTaskResultSections(template, resultsData)
      .map((e) => e.sectionId)
      .filter((id): id is number => id != null);
    const firstTaskSectionId = taskResultSectionIds[0] ?? getFirstPreSummaryTaskResultSectionId(template, resultsData);
    const firstTaskRd = firstTaskSectionId ? resultsData[firstTaskSectionId] : null;
    const raDateSource = firstTaskRd?.trainer_date ?? assessmentSummary?.trainer_date_1;
    if (!raDateSource) return;
    const raTrainerQ = template.steps?.flatMap((st) => st.sections).flatMap((s) => s.questions).find((q) => q.code === 'trainer.reasonableAdjustmentSignature');
    if (!raTrainerQ) return;
    const raVal = answers[getAnswerKey(raTrainerQ.id, null)];
    const raSigObj = raVal && typeof raVal === 'object' && !Array.isArray(raVal) ? (raVal as Record<string, unknown>) : null;
    const raDate = raSigObj ? String(raSigObj.date ?? raSigObj.signedAtDate ?? '') : '';
    if (raDate) return;
    const base = raSigObj && typeof raSigObj === 'object' ? { ...raSigObj } : (typeof raVal === 'string' ? { signature: raVal } : {});
    const newVal = { ...base, date: raDateSource };
    setAnswers((prev) => {
      const next = { ...prev };
      next[getAnswerKey(raTrainerQ.id, null)] = newVal as string | number | boolean | Record<string, unknown> | string[];
      return next;
    });
    saveAnswer(id, raTrainerQ.id, null, { json: newVal });
    setPdfRefresh((r) => r + 1);
  }, [template, answers, resultsData, assessmentSummary, id]);

  useEffect(() => {
    if (!template || !id) return;
    const taskResultSectionIds = buildTaskResultSections(template, resultsData)
      .map((e) => e.sectionId)
      .filter((id): id is number => id != null);
    const firstTaskSectionId = taskResultSectionIds[0] ?? getFirstPreSummaryTaskResultSectionId(template, resultsData);
    const firstTaskRd = firstTaskSectionId ? resultsData[firstTaskSectionId] : null;
    const raTrainerQ = template.steps?.flatMap((st) => st.sections).flatMap((s) => s.questions).find((q) => q.code === 'trainer.reasonableAdjustmentSignature');
    const raVal = raTrainerQ ? answers[getAnswerKey(raTrainerQ.id, null)] : undefined;
    const raSigObj = raVal && typeof raVal === 'object' && !Array.isArray(raVal) ? (raVal as Record<string, unknown>) : null;
    const raTrainerDate = raSigObj ? String(raSigObj.date ?? raSigObj.signedAtDate ?? '') : '';
    /** Only trainer-entered or copied from first task sheet — never auto-fill from student submit / today. 2nd/3rd attempts stay empty until the trainer records that attempt. */
    const firstAttemptSource = raTrainerDate || firstTaskRd?.first_attempt_date || '';
    const secondStartedOnFirstTask =
      !!(
        firstTaskRd?.second_attempt_date ||
        firstTaskRd?.second_attempt_satisfactory ||
        firstTaskRd?.second_attempt_feedback
      );
    const updates: { sectionId: number; field: 'trainer_date' | 'first_attempt_date'; value: string }[] = [];
    for (const sectionId of taskResultSectionIds) {
      const rd = resultsData[sectionId];
      const firstTaskData = firstTaskSectionId && firstTaskSectionId !== sectionId ? resultsData[firstTaskSectionId] : null;
      const trainerDateVal = raTrainerDate || firstTaskData?.trainer_date || '';
      const firstAttemptVal = firstAttemptSource;
      if (!rd?.trainer_date && trainerDateVal) updates.push({ sectionId, field: 'trainer_date', value: trainerDateVal });
      // Do not auto-fill first attempt date after a resubmission cycle or once 2nd attempt exists — avoids overwriting / cross-linking with 2nd attempt edits.
      if (
        !rd?.first_attempt_date &&
        firstAttemptVal &&
        submissionWave < 2 &&
        !secondStartedOnFirstTask
      ) {
        updates.push({ sectionId, field: 'first_attempt_date', value: firstAttemptVal });
      }
    }
    if (updates.length === 0) return;
    setResultsData((prev) => {
      const next = { ...prev };
      for (const u of updates) {
        const existing = prev[u.sectionId];
        next[u.sectionId] = {
          ...(existing ?? ({ section_id: u.sectionId } as import('../lib/formEngine').ResultsDataEntry)),
          [u.field]: u.value,
        } as import('../lib/formEngine').ResultsDataEntry;
        saveResultsData(id, u.sectionId, { [u.field]: u.value });
      }
      setPdfRefresh((r) => r + 1);
      return next;
    });
  }, [template, answers, resultsData, id, submissionWave]);

  /** When all marking for a task is Yes but Results S/NS was never set, persist S on attempt 1. */
  useEffect(() => {
    if (!template || !id) return;
    if (role !== 'trainer' && role !== 'office') return;
    if (submissionWave >= 2) return;

    const updates: { sectionId: number; value: 's' }[] = [];
    for (const entry of buildTaskResultSections(template, resultsData)) {
      if (entry.taskRowId == null) continue;
      const merged = getMergedResultsForTaskRow(template, entry.taskRowId, resultsData);
      if (merged?.first_attempt_satisfactory) continue;
      const derived = getEffectiveAttemptSat(
        template,
        entry.sectionId,
        entry.taskRowId,
        1,
        resultsData,
        answers,
        trainerAssessments
      );
      if (derived !== 's') continue;
      if (entry.sectionId != null && !resultsData[entry.sectionId]?.first_attempt_satisfactory) {
        updates.push({ sectionId: entry.sectionId, value: 's' });
      }
    }
    if (updates.length === 0) return;

    setResultsData((prev) => {
      const next = { ...prev };
      for (const u of updates) {
        const existing = prev[u.sectionId];
        next[u.sectionId] = {
          ...(existing ?? ({ section_id: u.sectionId } as import('../lib/formEngine').ResultsDataEntry)),
          first_attempt_satisfactory: u.value,
        } as import('../lib/formEngine').ResultsDataEntry;
        saveResultsData(id, u.sectionId, { first_attempt_satisfactory: u.value });
      }
      setPdfRefresh((r) => r + 1);
      return next;
    });
  }, [template, id, role, submissionWave, resultsData, answers, trainerAssessments]);

  useEffect(() => {
    if (!template || !id) return;
    const taskResultSectionIds = buildTaskResultSections(template, resultsData)
      .map((e) => e.sectionId)
      .filter((id): id is number => id != null);
    if (taskResultSectionIds.length === 0) return;

    const sumEntry = assessmentSummary ?? ({} as import('../lib/formEngine').AssessmentSummaryDataEntry);
    void sumEntry;

    // Clear later attempt columns when the student has not yet reached that submission wave.
    const updates: { sectionId: number; patch: Partial<import('../lib/formEngine').ResultsDataEntry> }[] = [];
    for (const sectionId of taskResultSectionIds) {
      const rd = resultsData[sectionId];
      if (!rd) continue;

      const hasSecondAny =
        rowAnswerHasContent(rd.second_attempt_satisfactory ?? undefined) ||
        rowAnswerHasContent(rd.second_attempt_date ?? undefined) ||
        rowAnswerHasContent(rd.second_attempt_feedback ?? undefined);
      const hasThirdAny =
        rowAnswerHasContent(rd.third_attempt_satisfactory ?? undefined) ||
        rowAnswerHasContent(rd.third_attempt_date ?? undefined) ||
        rowAnswerHasContent(rd.third_attempt_feedback ?? undefined);

      const patch: Partial<import('../lib/formEngine').ResultsDataEntry> = {};
      if (submissionCount < 2 && hasSecondAny) {
        patch.second_attempt_satisfactory = null;
        patch.second_attempt_date = null;
        patch.second_attempt_feedback = null;
      }
      if (submissionCount < 3 && hasThirdAny) {
        patch.third_attempt_satisfactory = null;
        patch.third_attempt_date = null;
        patch.third_attempt_feedback = null;
      }

      if (Object.keys(patch).length) updates.push({ sectionId, patch });
    }
    if (updates.length === 0) return;

    setResultsData((prev) => {
      const next = { ...prev };
      for (const u of updates) {
        next[u.sectionId] = { ...(next[u.sectionId] ?? ({ section_id: u.sectionId } as import('../lib/formEngine').ResultsDataEntry)), ...u.patch };
        saveResultsData(id, u.sectionId, u.patch);
      }
      setPdfRefresh((r) => r + 1);
      return next;
    });
  }, [template, id, resultsData, submissionCount, assessmentSummary]);

  // NOTE: We intentionally do not auto-bump the stored student declaration date on resubmissions.
  // The declaration is treated as historical evidence of when the student originally signed,
  // and minDate rules are enforced only when the student edits/re-signs.

  useEffect(() => {
    if (!template || !id || !assessmentSummary) return;
    const taskResultSectionIds = buildTaskResultSections(template, resultsData)
      .map((e) => e.sectionId)
      .filter((id): id is number => id != null);
    const firstTaskSectionId = taskResultSectionIds[0] ?? getFirstPreSummaryTaskResultSectionId(template, resultsData);
    const firstTaskRd = firstTaskSectionId ? resultsData[firstTaskSectionId] : null;
    const raTrainerQ = template.steps?.flatMap((st) => st.sections).flatMap((s) => s.questions).find((q) => q.code === 'trainer.reasonableAdjustmentSignature');
    const raVal = raTrainerQ ? answers[getAnswerKey(raTrainerQ.id, null)] : undefined;
    const raSigObj = raVal && typeof raVal === 'object' && !Array.isArray(raVal) ? (raVal as Record<string, unknown>) : null;
    const raTrainerDate = raSigObj ? String(raSigObj.date ?? raSigObj.signedAtDate ?? '') : '';
    const trainerRefDate = raTrainerDate || firstTaskRd?.trainer_date || '';
    const studentDeclQ = template.steps?.flatMap((st) => st.sections).flatMap((s) => s.questions).find((q) => q.code === 'student.declarationSignature');
    const studentDeclVal = studentDeclQ ? answers[getAnswerKey(studentDeclQ.id, null)] : undefined;
    const studentDeclSigObj = studentDeclVal && typeof studentDeclVal === 'object' && !Array.isArray(studentDeclVal) ? (studentDeclVal as Record<string, unknown>) : null;
    const studentDeclDate = studentDeclSigObj ? String(studentDeclSigObj.date ?? studentDeclSigObj.signedAtDate ?? '') : '';
    const sum = assessmentSummary;
    const updates: { field: keyof import('../lib/formEngine').AssessmentSummaryDataEntry; value: string }[] = [];
    if (!sum.trainer_date_1 && trainerRefDate) updates.push({ field: 'trainer_date_1', value: trainerRefDate });
    if (!sum.student_date_1 && studentDeclDate) updates.push({ field: 'student_date_1', value: studentDeclDate });
    if (updates.length === 0) return;
    setAssessmentSummary((prev) => {
      const next = prev ? { ...prev } : ({} as import('../lib/formEngine').AssessmentSummaryDataEntry);
      for (const u of updates) {
        (next as unknown as Record<string, unknown>)[u.field] = u.value;
        saveAssessmentSummaryData(id, { [u.field]: u.value });
      }
      setPdfRefresh((r) => r + 1);
      return next;
    });
  }, [template, answers, resultsData, assessmentSummary, id]);

  /** Enforce assessment summary date chain after auto-fill (clamp stored dates to S1→T1→S2→T2→S3→T3). */
  useEffect(() => {
    if (!template || !id || !assessmentSummary || staffBypassDateConstraints) return;
    const mins = getAssessmentSummaryDateChainMins(assessmentSummary, studentDeclarationDateMinIso);
    const patch: Partial<import('../lib/formEngine').AssessmentSummaryDataEntry> = {};
    const s = assessmentSummary;
    const bump = (k: keyof import('../lib/formEngine').AssessmentSummaryDataEntry, min: string | undefined) => {
      if (!min) return;
      const cur = (s as unknown as Record<string, unknown>)[k as string];
      const c = cur == null ? '' : String(cur).trim();
      if (c && isCalendarBefore(c, min)) (patch as unknown as Record<string, unknown>)[k as string] = min;
    };
    // Attempt 1 is historical after resubmission — do not bump from changing declaration / attempt 2 mins.
    if (submissionWave < 2) {
      bump('student_date_1', mins.minStudentDate1);
      bump('trainer_date_1', mins.minTrainerDate1);
    }
    if (submissionWave >= 2) {
      bump('student_date_2', mins.minStudentDate2);
      bump('trainer_date_2', mins.minTrainerDate2);
    }
    if (submissionWave >= 3) {
      bump('student_date_3', mins.minStudentDate3);
      bump('trainer_date_3', mins.minTrainerDate3);
    }
    if (Object.keys(patch).length === 0) return;
    setAssessmentSummary((prev) =>
      prev ? { ...prev, ...patch } : ({ ...patch } as import('../lib/formEngine').AssessmentSummaryDataEntry),
    );
    saveAssessmentSummaryData(id, patch);
    setPdfRefresh((r) => r + 1);
  }, [template, id, assessmentSummary, submissionWave, staffBypassDateConstraints]);

  useEffect(() => {
    if (!template || !id) return;
    if (!(role === 'trainer' || role === 'office')) return;
    if (!assessmentSummary) return;

    const taskResultSections = buildTaskResultSections(template, resultsData)
      .map((e) => (e.sectionId != null ? { id: e.sectionId } : null))
      .filter((e): e is { id: number } => e != null);
    if (taskResultSections.length === 0) return;

    const firstTaskSectionId = taskResultSections[0].id;
    const firstTaskRd = firstTaskSectionId ? resultsData[firstTaskSectionId] : null;

    const sum = assessmentSummary;
    const activeSummaryAttemptNum = getActiveMarkingAttemptNum(submissionCount, sum, firstTaskRd);
    const sumFirstEditable = isCurrentMarkingAttemptColumn(activeSummaryAttemptNum, 1);
    const sumSecondEditable = isCurrentMarkingAttemptColumn(activeSummaryAttemptNum, 2);
    const sumThirdEditable = isCurrentMarkingAttemptColumn(activeSummaryAttemptNum, 3);
    const patch: Partial<import('../lib/formEngine').AssessmentSummaryDataEntry> = {};
    const setIfEmpty = (field: keyof import('../lib/formEngine').AssessmentSummaryDataEntry, value: string | null) => {
      const cur = (sum as unknown as Record<string, unknown>)[field];
      const curStr = cur == null ? '' : String(cur).trim();
      if (!curStr && value) (patch as unknown as Record<string, unknown>)[field] = value;
    };

    /** Auto-sync Competent only — NYC must be chosen explicitly or set on trainer submit, not inferred mid-review. */
    const syncCompetentOnly = (
      field: 'final_attempt_1_result' | 'final_attempt_2_result' | 'final_attempt_3_result',
      attempt: 1 | 2 | 3,
    ) => {
      const derived = getTrainerAttemptOutcome(attempt);
      const cur = (sum as unknown as Record<string, unknown>)[field];
      const curVal = cur == null ? null : String(cur).trim();
      if (derived === 'competent') {
        if (curVal !== 'competent') (patch as unknown as Record<string, unknown>)[field] = 'competent';
      } else if (derived === null && curVal === 'competent') {
        (patch as unknown as Record<string, unknown>)[field] = null;
      }
    };

    if (sumFirstEditable) {
      syncCompetentOnly('final_attempt_1_result', 1);
      // Auto-fill attempt 1 signatures/dates from known sources (do not overwrite).
      const todayIso = new Date().toISOString().split('T')[0];
      const raTrainerQ = template.steps?.flatMap((st) => st.sections).flatMap((s) => s.questions).find((q) => q.code === 'trainer.reasonableAdjustmentSignature');
      const raVal = raTrainerQ ? answers[getAnswerKey(raTrainerQ.id, null)] : undefined;
      const raSigObj = raVal && typeof raVal === 'object' && !Array.isArray(raVal) ? (raVal as Record<string, unknown>) : null;
      const raTrainerSig = raSigObj ? (String(raSigObj.signature ?? raSigObj.imageDataUrl ?? '') || null) : (typeof raVal === 'string' ? raVal : null);
      const raTrainerDate = raSigObj ? String(raSigObj.date ?? raSigObj.signedAtDate ?? '') : '';

      const studentDeclQ = template.steps?.flatMap((st) => st.sections).flatMap((s) => s.questions).find((q) => q.code === 'student.declarationSignature');
      const studentDeclVal = studentDeclQ ? answers[getAnswerKey(studentDeclQ.id, null)] : undefined;
      const studentDeclSigObj = studentDeclVal && typeof studentDeclVal === 'object' && !Array.isArray(studentDeclVal) ? (studentDeclVal as Record<string, unknown>) : null;
      const studentDeclSig = studentDeclSigObj ? (String(studentDeclSigObj.signature ?? studentDeclSigObj.imageDataUrl ?? '') || null) : (typeof studentDeclVal === 'string' ? studentDeclVal : null);
      const studentDeclDate = studentDeclSigObj ? String(studentDeclSigObj.date ?? studentDeclSigObj.signedAtDate ?? '') : '';

      const trainerRefSig = raTrainerSig ?? firstTaskRd?.trainer_signature ?? null;
      const trainerRefDate = raTrainerSig ? (raTrainerDate || firstTaskRd?.trainer_date || todayIso) : (firstTaskRd?.trainer_date || todayIso);
      const studentRefSig = studentDeclSig ?? firstTaskRd?.student_signature ?? null;
      const studentRefDate = studentDeclDate || todayIso;

      setIfEmpty('trainer_sig_1', trainerRefSig);
      setIfEmpty('trainer_date_1', trainerRefDate || null);
      setIfEmpty('student_sig_1', studentRefSig);
      setIfEmpty('student_date_1', studentRefDate || null);
    }
    if (sumSecondEditable) {
      syncCompetentOnly('final_attempt_2_result', 2);
    }
    if (sumThirdEditable) {
      syncCompetentOnly('final_attempt_3_result', 3);
    }

    if (Object.keys(patch).length === 0) return;
    setAssessmentSummary((prev) => (prev ? { ...prev, ...patch } : ({ ...patch } as import('../lib/formEngine').AssessmentSummaryDataEntry)));
    saveAssessmentSummaryData(id, patch);
    setPdfRefresh((r) => r + 1);
  }, [template, id, role, resultsData, assessmentSummary, answers, submissionCount, getTrainerAttemptOutcome]);

  const valueToSavePayload = (value: string | number | boolean | Record<string, unknown> | string[]) => {
    let text: string | undefined;
    let num: number | undefined;
    let json: unknown;
    if (typeof value === 'string') text = value;
    else if (typeof value === 'number') num = value;
    else if (typeof value === 'boolean') text = value ? 'true' : 'false';
    else if (Array.isArray(value)) json = value;
    else if (value && typeof value === 'object') {
      const o = value as Record<string, unknown>;
      if (typeof o.text === 'string' && Object.keys(o).every((k) => k === 'text' || k === 'answerImageUrl')) {
        const url = typeof o.answerImageUrl === 'string' && o.answerImageUrl.trim() ? o.answerImageUrl : null;
        return { text: o.text, json: url ? { answerImageUrl: url } : null };
      }
      json = value;
    }
    return { text, number: num, json };
  };

  const clearPendingSave = useCallback((key: string) => {
    const t = saveTimeoutsRef.current.get(key);
    if (t) clearTimeout(t);
    saveTimeoutsRef.current.delete(key);
  }, []);

  useEffect(() => {
    return () => {
      // Cleanup any pending timeouts on unmount.
      for (const t of saveTimeoutsRef.current.values()) clearTimeout(t);
      saveTimeoutsRef.current.clear();
    };
  }, []);

  const debouncedSave = useCallback(
    (questionId: number, rowId: number | null, value: string | number | boolean | Record<string, unknown> | string[]) => {
      const key = getAnswerKey(questionId, rowId);
      clearPendingSave(key);
      const t = setTimeout(async () => {
        setQuestionSaveStatus((prev) => ({ ...prev, [questionId]: 'saving' }));
        try {
          const payload = valueToSavePayload(value);
          await saveAnswer(id, questionId, rowId, payload);
          setQuestionSaveStatus((prev) => ({ ...prev, [questionId]: 'saved' }));
          setPdfRefresh((r) => r + 1);
        } catch {
          setQuestionSaveStatus((prev) => ({ ...prev, [questionId]: 'error' }));
        } finally {
          saveTimeoutsRef.current.delete(key);
        }
      }, 300);
      saveTimeoutsRef.current.set(key, t);
    },
    [id, clearPendingSave]
  );

  const handleAnswerChange = useCallback(
    (questionId: number, rowId: number | null, value: string | number | boolean | Record<string, unknown> | string[], immediate = false) => {
      const key = getAnswerKey(questionId, rowId);
      setAnswers((prev) => ({ ...prev, [key]: value }));
      setErrors((prev) => {
        if (!prev[`q-${questionId}`] && Object.keys(prev).length === 0) return prev;
        const next = { ...prev };
        delete next[`q-${questionId}`];
        // Content-block children surface errors on the visible parent — clear that too.
        if (template) {
          for (const st of template.steps ?? []) {
            for (const sec of st.sections) {
              for (const pq of sec.questions) {
                const pm = (pq.pdf_meta as Record<string, unknown>) || {};
                const blocks = pm.contentBlocks as Array<{ questionId?: number }> | undefined;
                if (Array.isArray(blocks) && blocks.some((b) => Number(b?.questionId) === questionId)) {
                  delete next[`q-${pq.id}`];
                }
              }
            }
          }
        }
        return next;
      });
      setQuestionSaveStatus((prev) => {
        if (prev[questionId] === 'saved' || prev[questionId] === 'error') {
          return { ...prev, [questionId]: 'idle' };
        }
        return prev;
      });
      if (immediate) {
        clearPendingSave(key);
        setQuestionSaveStatus((prev) => ({ ...prev, [questionId]: 'saving' }));
        const payload = valueToSavePayload(value);
        saveAnswer(id, questionId, rowId, payload)
          .then(() => {
            setQuestionSaveStatus((prev) => ({ ...prev, [questionId]: 'saved' }));
            setPdfRefresh((r) => r + 1);
          })
          .catch(() => setQuestionSaveStatus((prev) => ({ ...prev, [questionId]: 'error' })));
      } else {
        debouncedSave(questionId, rowId, value);
      }
    },
    [debouncedSave, id, clearPendingSave, template]
  );

  const handleTrainerAssessmentChange = useCallback(
    (questionId: number, satisfactory: 'yes' | 'no') => {
      setTrainerAssessments((prev) => ({ ...prev, [questionId]: satisfactory }));
      saveTrainerAssessment(id, questionId, satisfactory);
      setPdfRefresh((r) => r + 1);
    },
    [id]
  );

  const checkAndAutoCompleteOffice = useCallback(
    async (
      nextOffice: Record<
        number,
        { entered_date: string | null; entered_by: string | null; initial_checked: boolean; updated_checked: boolean }
      >,
      nextSummary: import('../lib/formEngine').AssessmentSummaryDataEntry | null
    ) => {
      if (role !== 'office' || workflowStatus !== 'waiting_office' || !template) return;
      if (!nextSummary?.admin_initial_checked || !nextSummary?.admin_updated_checked) return;
      const taskSections = buildTaskResultSections(template, resultsData);
      for (const entry of taskSections) {
        if (entry.sectionId == null) continue;
        const o = nextOffice[entry.sectionId];
        if (!o?.initial_checked || !o?.updated_checked) return;
      }
      try {
        await updateInstanceWorkflowStatus(id, 'completed');
        setWorkflowStatus('completed');
        toast.success('Office admin complete. Assessment finalised.');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not finalise assessment.');
      }
    },
    [id, role, workflowStatus, template, resultsData]
  );

  const handleResultsOfficeChange = useCallback(
    (
      sectionId: number,
      field: 'entered_date' | 'entered_by' | 'initial_checked' | 'updated_checked',
      value: string | null | boolean
    ) => {
      setResultsOffice((prev) => {
        const next = { ...prev };
        if (!next[sectionId]) {
          next[sectionId] = { entered_date: null, entered_by: null, initial_checked: false, updated_checked: false };
        }
        next[sectionId] = { ...next[sectionId], [field]: value };
        void saveResultsOffice(id, sectionId, {
          entered_date: next[sectionId].entered_date,
          entered_by: next[sectionId].entered_by,
          initial_checked: next[sectionId].initial_checked,
          updated_checked: next[sectionId].updated_checked,
        })
          .then(() => {
            setPdfRefresh((r) => r + 1);
            if (field === 'initial_checked' || field === 'updated_checked') {
              void checkAndAutoCompleteOffice(next, assessmentSummary);
            }
          })
          .catch((err: unknown) => {
            toast.error(err instanceof Error ? err.message : 'Could not save office check. Try again.');
          });
        return next;
      });
    },
    [id, assessmentSummary, checkAndAutoCompleteOffice]
  );

  const handleAssessmentSummaryChange = useCallback(
    async (field: keyof import('../lib/formEngine').AssessmentSummaryDataEntry, value: string | null | boolean) => {
      const outcomeFields = new Set([
        'final_attempt_1_result',
        'final_attempt_2_result',
        'final_attempt_3_result',
      ]);
      if (outcomeFields.has(field) && (value === null || value === '')) {
        setAssessmentSummary((prev) => {
          const next: import('../lib/formEngine').AssessmentSummaryDataEntry = prev
            ? { ...prev, [field]: null }
            : ({ [field]: null } as unknown as import('../lib/formEngine').AssessmentSummaryDataEntry);
          void saveAssessmentSummaryData(id, { [field]: null }).then(() => setPdfRefresh((r) => r + 1));
          return next;
        });
        return;
      }

      if (value === 'competent') {
        const attempt: 1 | 2 | 3 | null =
          field === 'final_attempt_1_result' ? 1 : field === 'final_attempt_2_result' ? 2 : field === 'final_attempt_3_result' ? 3 : null;
        if (attempt != null && getTrainerAttemptOutcome(attempt) !== 'competent') {
          const msg = formatCompetentBlockerMessage(
            attempt,
            getTaskResultChecks(template, attempt, resultsData, answers, trainerAssessments)
          );
          if (competentBlockerToastRef.current !== msg) {
            competentBlockerToastRef.current = msg;
            toast.error(msg, 8000);
            window.setTimeout(() => {
              competentBlockerToastRef.current = null;
            }, 800);
          }
          return;
        }
      }

      const dateFields = new Set([
        'student_date_1',
        'student_date_2',
        'student_date_3',
        'trainer_date_1',
        'trainer_date_2',
        'trainer_date_3',
      ]);
      let normalizedValue: string | null | boolean = value;
      if (typeof value === 'string' && dateFields.has(field)) {
        if (!staffBypassDateConstraints) {
          const sumBase = assessmentSummary ?? ({} as import('../lib/formEngine').AssessmentSummaryDataEntry);
          const draft = { ...sumBase, [field]: value } as import('../lib/formEngine').AssessmentSummaryDataEntry;
          const mins = getAssessmentSummaryDateChainMins(draft, studentDeclarationDateMinIso);
          const minKey =
            field === 'student_date_1'
              ? 'minStudentDate1'
              : field === 'trainer_date_1'
                ? 'minTrainerDate1'
                : field === 'student_date_2'
                  ? 'minStudentDate2'
                  : field === 'trainer_date_2'
                    ? 'minTrainerDate2'
                    : field === 'student_date_3'
                      ? 'minStudentDate3'
                      : 'minTrainerDate3';
          const min = mins[minKey];
          normalizedValue = pickDateWithMin(value, min);
          const chainErr = validateAssessmentSummaryDateChain(
            { ...draft, [field]: normalizedValue as string },
            studentDeclarationDateMinIso,
          );
          if (chainErr) {
            toast.error(chainErr);
            return;
          }
        }
      }

      setAssessmentSummary((prev) => {
        const next: import('../lib/formEngine').AssessmentSummaryDataEntry = prev
          ? { ...prev, [field]: normalizedValue }
          : ({ [field]: normalizedValue } as unknown as import('../lib/formEngine').AssessmentSummaryDataEntry);
        void saveAssessmentSummaryData(id, { [field]: normalizedValue })
          .then(() => {
            setPdfRefresh((r) => r + 1);
            if (field === 'admin_initial_checked' || field === 'admin_updated_checked') {
              void checkAndAutoCompleteOffice(resultsOffice, next);
            }
          })
          .catch((err: unknown) => {
            toast.error(err instanceof Error ? err.message : 'Could not save summary. Try again.');
          });
        return next;
      });

      if (
        typeof normalizedValue === 'string' &&
        normalizedValue &&
        template &&
        (field === 'trainer_date_1' || field === 'trainer_date_2' || field === 'trainer_date_3')
      ) {
        const attemptField = SUMMARY_TRAINER_DATE_TO_RESULTS_ATTEMPT[field];
        const sectionIds = getPreSummaryTaskResultSectionIds(template);
        const patches: { sectionId: number; patch: Partial<import('../lib/formEngine').ResultsDataEntry> }[] = [];
        setResultsData((prev) => {
          const next = { ...prev };
          for (const sid of sectionIds) {
            const cur = next[sid] ?? ({ section_id: sid } as import('../lib/formEngine').ResultsDataEntry);
            const patch: Partial<import('../lib/formEngine').ResultsDataEntry> = { [attemptField]: normalizedValue };
            if (!String(cur.trainer_date ?? '').trim()) patch.trainer_date = normalizedValue;
            next[sid] = { ...cur, ...patch } as import('../lib/formEngine').ResultsDataEntry;
            patches.push({ sectionId: sid, patch });
          }
          return next;
        });
        await Promise.all(patches.map(({ sectionId, patch }) => saveResultsData(id, sectionId, patch)));
        setPdfRefresh((r) => r + 1);
      }
    },
    [
      id,
      getTrainerAttemptOutcome,
      template,
      resultsData,
      answers,
      trainerAssessments,
      resultsOffice,
      checkAndAutoCompleteOffice,
      assessmentSummary,
      studentDeclarationDateMinIso,
      staffBypassDateConstraints,
    ]
  );

  const handleSummaryOutcomeSelect = useCallback(
    (
      field: 'final_attempt_1_result' | 'final_attempt_2_result' | 'final_attempt_3_result',
      value: 'competent' | 'not_yet_competent',
      editable: boolean,
    ) => {
      if (!editable) return;
      const current = assessmentSummary?.[field] ?? null;
      void handleAssessmentSummaryChange(field, toggleOutcomeSelection(current, value));
    },
    [assessmentSummary, handleAssessmentSummaryChange],
  );

  /** Trainer may submit while waiting for trainer, or if sent to office prematurely while instance is still on trainer. */
  const trainerCanFinaliseReview = useMemo(
    () =>
      role === 'trainer' &&
      (workflowStatus === 'waiting_trainer' ||
        (workflowStatus === 'waiting_office' && instanceRoleContext === 'trainer' && instanceLegacyStatus !== 'locked')),
    [role, workflowStatus, instanceRoleContext, instanceLegacyStatus]
  );

  const canRoleEditCurrentWorkflow = useMemo(() => {
    if (role === 'office' && isAdminEditMode) return true;
    if (workflowStatus === 'completed' || workflowStatus === 'failed') return false;
    if (role === 'student') {
      if (!studentCourseMutationAllowed) return false;
      return workflowStatus === 'draft';
    }
    if (role === 'trainer') {
      if (workflowStatus === 'waiting_office' && instanceRoleContext !== 'trainer') return false;
      return true;
    }
    if (role === 'office') return workflowStatus === 'waiting_office';
    return false;
  }, [role, workflowStatus, isAdminEditMode, instanceRoleContext, studentCourseMutationAllowed]);

  /** Student declaration: editable on first cycle; staff may correct dates on later cycles. */
  const getStudentDeclarationEditable = useCallback(
    (baseEditable: boolean, questionCode: string | undefined) => {
      if (questionCode !== 'student.declarationSignature') return baseEditable;
      if (markingRound >= 2) {
        if (role === 'trainer' || role === 'office') {
          return canRoleEditCurrentWorkflow || isAdminEditMode;
        }
        return isAdminEditMode;
      }
      if (role === 'trainer' || role === 'office') {
        return canRoleEditCurrentWorkflow;
      }
      return baseEditable;
    },
    [markingRound, role, canRoleEditCurrentWorkflow, isAdminEditMode]
  );

  /** Office may edit admin fields (summary dates, SMS checkboxes) while waiting or after finalisation for corrections. */
  const canOfficeAdminEdit = useMemo(
    () => role === 'office' && (isAdminEditMode || workflowStatus === 'waiting_office' || workflowStatus === 'completed' || workflowStatus === 'failed'),
    [role, workflowStatus, isAdminEditMode]
  );

  /** Staff may correct dates on result/summary sheets even when attempt columns are workflow-locked. */
  const staffCanCorrectSheetDates = useMemo(
    () => staffBypassDateConstraints && (canRoleEditCurrentWorkflow || canOfficeAdminEdit),
    [staffBypassDateConstraints, canRoleEditCurrentWorkflow, canOfficeAdminEdit]
  );

  /** Flush debounced question saves so a refresh does not drop in-flight edits. */
  const flushPendingDebouncedAnswerSaves = useCallback(async () => {
    if (!id) return 0;
    const keys = [...saveTimeoutsRef.current.keys()];
    let flushed = 0;
    for (const key of keys) {
      clearPendingSave(key);
      const parsed = parseDebouncedAnswerKey(key);
      if (!parsed) continue;
      const raw = answers[key];
      if (raw === undefined) continue;
      setQuestionSaveStatus((prev) => ({ ...prev, [parsed.questionId]: 'saving' }));
      try {
        const payload = valueToSavePayload(raw);
        await saveAnswer(id, parsed.questionId, parsed.rowId, payload);
        setQuestionSaveStatus((prev) => ({ ...prev, [parsed.questionId]: 'saved' }));
        flushed += 1;
      } catch {
        setQuestionSaveStatus((prev) => ({ ...prev, [parsed.questionId]: 'error' }));
        throw new Error('flush failed');
      }
    }
    if (flushed > 0) setPdfRefresh((r) => r + 1);
    return flushed;
  }, [id, answers, clearPendingSave]);

  /** Save current step answers (all section types) before advancing — flush debounced + sequential persist. */
  const saveStepAnswersSequential = useCallback(
    async (stepSections: FormSectionWithQuestions[]): Promise<boolean> => {
      if (!template || !id || stepSections.length === 0) return true;

      try {
        await flushPendingDebouncedAnswerSaves();
      } catch {
        return false;
      }

      const orderedIds = collectOrderedQuestionIdsFromSections(stepSections);
      const targets = collectStepAnswerSaveTargets(template, stepSections, answers);
      const byQuestion = groupSaveTargetsByQuestion(targets);

      let anySaved = false;
      for (const qid of orderedIds) {
        const qTargets = byQuestion.get(qid);
        if (!qTargets?.length) continue;

        setQuestionSaveStatus((prev) => ({ ...prev, [qid]: 'saving' }));
        try {
          for (const t of qTargets) {
            const payload = valueToSavePayload(t.value);
            await saveAnswer(id, t.questionId, t.rowId, payload, { source: 'step-save' });
          }
          setQuestionSaveStatus((prev) => ({ ...prev, [qid]: 'saved' }));
          anySaved = true;
        } catch {
          setQuestionSaveStatus((prev) => ({ ...prev, [qid]: 'error' }));
          return false;
        }
      }

      if (anySaved) {
        setAnswers((prev) => {
          const incoming: Record<string, string | number | boolean | Record<string, unknown> | string[]> = {};
          for (const t of targets) {
            incoming[getAnswerKey(t.questionId, t.rowId)] = t.value;
          }
          const next = mergeFormAnswersPreservingExisting(prev, incoming, { source: 'step-save' }) as Record<
            string,
            string | number | boolean | Record<string, unknown> | string[]
          >;
          for (const t of targets) {
            if (t.rowId != null) delete next[getAnswerKey(t.questionId, null)];
          }
          return next;
        });
        setPdfRefresh((r) => r + 1);
      }
      return true;
    },
    [template, id, answers, flushPendingDebouncedAnswerSaves]
  );

  const handleManualSaveDraft = useCallback(async () => {
    if (!canRoleEditCurrentWorkflow) return;
    setManualSaveBusy(true);
    try {
      const flushed = await flushPendingDebouncedAnswerSaves();
      if (flushed > 0) {
        toast.success('Autosaved — pending answers are on the server.');
      } else {
        toast.success('All changes are already saved.');
      }
    } catch {
      toast.error('Could not save. Check your connection and try again.');
    } finally {
      setManualSaveBusy(false);
    }
  }, [canRoleEditCurrentWorkflow, flushPendingDebouncedAnswerSaves]);

  // Student declaration signature/date is rendered in the Declarations section (not duplicated inside submission method).

  /** True when student is resubmitting after trainer sent back; parts marked Satisfactory Yes become read-only */
  const isResubmissionAfterTrainer = useMemo(
    () =>
      role === 'student' &&
      workflowStatus === 'draft' &&
      (Object.keys(trainerAssessments).length > 0 || Object.keys(trainerRowAssessments).length > 0),
    [role, workflowStatus, trainerAssessments, trainerRowAssessments]
  );

  const isQuestionReadOnlyByTrainer = useCallback(
    (questionId: number) => isResubmissionAfterTrainer && trainerAssessments[questionId] === 'yes',
    [isResubmissionAfterTrainer, trainerAssessments]
  );

  const workflowLabel = useMemo(() => {
    if (workflowStatus === 'draft') return 'Draft';
    if (workflowStatus === 'waiting_trainer') return 'Waiting for trainer check';
    if (workflowStatus === 'waiting_office') return 'Waiting for office check';
    if (workflowStatus === 'awaiting_submission') return 'Not submitted by due date';
    if (workflowStatus === 'failed') return 'Failed';
    return 'Completed';
  }, [workflowStatus]);

  const sanitizeInstructionHtml = useCallback((html: string) => {
    // Remove common “word split” hints produced by some HTML generators.
    // This prevents things like "demon strating" and dangling "word-" at line end.
    return String(html || '')
      .replace(/\u00ad/g, '') // soft hyphen char
      .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, '') // zero-width spaces/joiners that allow mid-word wraps
      .replace(/&shy;/gi, '') // soft hyphen entity
      .replace(/&ZeroWidthSpace;|&#8203;|&#x200B;/gi, '') // zero-width space entities
      .replace(/<wbr\s*\/?>/gi, '') // word break tag
      .replace(/-\s*<br\s*\/?>/gi, '') // hyphen + line break
      .replace(/-\s*\r?\n\s*/g, '') // hyphen + newline
      // Sometimes the HTML includes explicit breaks inside a word (e.g. "prov<br>ide", "applicat\nion").
      // Only remove breaks when they are between letters to avoid altering real paragraph/line breaks.
      .replace(/([A-Za-z])\s*<br\s*\/?>\s*([A-Za-z])/gi, '$1$2')
      .replace(/([A-Za-z])\s*\r?\n\s*([A-Za-z])/g, '$1$2');
  }, []);

  /** Collect validation errors for one wizard step (matches Stepper visible steps, incl. Appendix A rules). */
  const getStepValidationErrors = useCallback(
    (stepNumber: number, options?: { forSubmit?: boolean }): Record<string, string> => {
      if (!template || stepNumber <= 1) return {};
      const visibleStepsForValidation = (template.steps ?? []).filter(
        (s) => role !== 'student' || !/Appendix\s*A/i.test((s.title || '').trim())
      );
      const stepData = visibleStepsForValidation[stepNumber - 2];
      if (!stepData) return {};
      if (isPostSummaryAssessmentTaskStep(template, stepData.id)) return {};
      const stepErrors: Record<string, string> = {};
      const questionErrorMetas: AssessmentQuestionErrorMeta[] = [];
      const assessmentSubmissionHasDeclSig = stepData.sections.some(
        (s) => s.pdf_render_mode === 'assessment_submission' && s.questions.some((q) => q.code === 'student.declarationSignature')
      );
      /** Trainer/office must finish result sheets + summary before leaving review or submitting. */
      const strictReviewCycle =
        (role === 'trainer' && trainerCanFinaliseReview) ||
        (workflowStatus === 'waiting_office' && role === 'office') ||
        (isAdminEditMode && (role === 'trainer' || role === 'office'));
      const resubmissionCycle = submissionWave;
      const taskResultIdsAppendixVal = buildTaskResultSections(template, resultsData)
        .map((e) => e.sectionId)
        .filter((id): id is number => id != null);
      const firstTaskSecAppendixVal = taskResultIdsAppendixVal[0] ?? getFirstPreSummaryTaskResultSectionId(template, resultsData);
      const firstTaskRdAppendixVal = firstTaskSecAppendixVal ? resultsData[firstTaskSecAppendixVal] : null;
      const secondOrThirdHasDataAppendixVal = !!(
        firstTaskRdAppendixVal?.second_attempt_date ||
        firstTaskRdAppendixVal?.second_attempt_satisfactory ||
        firstTaskRdAppendixVal?.third_attempt_date ||
        firstTaskRdAppendixVal?.third_attempt_satisfactory
      );
      const isAppendixAStepTitle = /Appendix\s*A/i.test((stepData.title || '').trim());

      for (const section of stepData.sections) {
        // `task_results` and `assessment_summary` are rendered from `resultsData` / `assessmentSummary`
        // state (not from `answers` + `section.questions`). So validate them explicitly here.
        if (section.pdf_render_mode === 'task_results') {
          if (!isPreSummarySection(template, section.id)) continue;
          const rd = resultsData[section.id];
          const trainerCanEdit = role === 'trainer' || role === 'office';

          if (role === 'student') {
            if (!rowAnswerHasContent(rd?.student_name ?? undefined)) {
              stepErrors[`task-results-${section.id}-student_name`] = 'Student name is required';
            }
            if (!rowAnswerHasContent(rd?.student_signature ?? undefined)) {
              stepErrors[`task-results-${section.id}-student_signature`] = 'Student signature is required';
            }
          }

          if (trainerCanEdit) {
            if (strictReviewCycle && !hasAtLeastOneValidResultSheetAttempt(rd)) {
              stepErrors[`task-results-${section.id}-minimum`] = ASSESSMENT_RESULT_PROGRESS_MESSAGE;
            }

            if (options?.forSubmit) {
              if (!rowAnswerHasContent(rd?.trainer_name ?? undefined)) {
                stepErrors[`task-results-${section.id}-trainer_name`] = 'Trainer name is required';
              }
              if (!rowAnswerHasContent(rd?.trainer_signature ?? undefined)) {
                stepErrors[`task-results-${section.id}-trainer_signature`] = 'Trainer signature is required';
              }
              if (!rowAnswerHasContent(rd?.trainer_date ?? undefined)) {
                stepErrors[`task-results-${section.id}-trainer_date`] = 'Trainer date is required';
              }
            }

            const resultsDateErr = validateResultsSheetDateChain(rd, assessmentSummary, studentDeclarationDateMinIso);
            if (resultsDateErr) {
              stepErrors[`task-results-${section.id}-date-chain`] = resultsDateErr;
            }
          }

          // Skip question-based validation for this section type.
          continue;
        }

        if (section.pdf_render_mode === 'assessment_summary') {
          const sum = assessmentSummary || ({} as import('../lib/formEngine').AssessmentSummaryDataEntry);

          const trainerCanEdit = role === 'trainer' || role === 'office';

          if (rowAnswerHasContent(sum.start_date ?? undefined) && rowAnswerHasContent(sum.end_date ?? undefined)) {
            const start = String(sum.start_date ?? '');
            const end = String(sum.end_date ?? '');
            if (isCalendarBefore(end, start)) {
              stepErrors['assessment-summary-end_date'] = 'End Date cannot be earlier than Start Date';
            }
          }

          const dateChainErr = validateAssessmentSummaryDateChain(sum, studentDeclarationDateMinIso);
          if (dateChainErr) {
            stepErrors['assessment-summary-date-chain'] = dateChainErr;
          }

          const taskResultSectionIds = buildTaskResultSections(template, resultsData)
            .map((e) => e.sectionId)
            .filter((id): id is number => id != null);
          const firstTaskSectionId = taskResultSectionIds[0] ?? getFirstPreSummaryTaskResultSectionId(template, resultsData);
          const firstTaskRd = firstTaskSectionId ? resultsData[firstTaskSectionId] : null;

          const staffSummaryActiveAttempt = getActiveMarkingAttemptNum(submissionCount, sum, firstTaskRd);
          const studentPrepAttempt =
            role === 'student' ? getStudentPrepAttemptNum(submissionCount, sum) : staffSummaryActiveAttempt;
          const sumStudentFirstEditable = studentPrepAttempt === 1;
          const sumStudentSecondEditable = studentPrepAttempt === 2;
          const sumStudentThirdEditable = studentPrepAttempt === 3;

          if (trainerCanEdit) {
            if (strictReviewCycle && !hasAtLeastOneValidSummaryAttempt(sum)) {
              stepErrors['assessment-summary-minimum'] = ASSESSMENT_RESULT_PROGRESS_MESSAGE;
            }

            if (options?.forSubmit && strictReviewCycle) {
              const sumTrainerAttempt1Complete =
                rowAnswerHasContent(sum.final_attempt_1_result ?? undefined) &&
                rowAnswerHasContent(sum.trainer_sig_1 ?? undefined) &&
                rowAnswerHasContent(sum.trainer_date_1 ?? undefined);
              const sumTrainerAttempt2Complete =
                rowAnswerHasContent(sum.final_attempt_2_result ?? undefined) &&
                rowAnswerHasContent(sum.trainer_sig_2 ?? undefined) &&
                rowAnswerHasContent(sum.trainer_date_2 ?? undefined);
              const sumTrainerAttempt3Complete =
                rowAnswerHasContent(sum.final_attempt_3_result ?? undefined) &&
                rowAnswerHasContent(sum.trainer_sig_3 ?? undefined) &&
                rowAnswerHasContent(sum.trainer_date_3 ?? undefined);

              if (resubmissionCycle >= 3 && !sumTrainerAttempt3Complete) {
                if (!rowAnswerHasContent(sum.final_attempt_3_result ?? undefined)) {
                  stepErrors['assessment-summary-final_attempt_3_result'] =
                    'Assessment summary: attempt 3 result (Competent / Not Yet Competent) is required';
                }
                if (!rowAnswerHasContent(sum.trainer_sig_3 ?? undefined)) {
                  stepErrors['assessment-summary-trainer_sig_3'] = 'Assessment summary: trainer signature (attempt 3) is required';
                }
                if (!rowAnswerHasContent(sum.trainer_date_3 ?? undefined)) {
                  stepErrors['assessment-summary-trainer_date_3'] = 'Assessment summary: trainer date (attempt 3) is required';
                }
              } else if (resubmissionCycle >= 2 && !sumTrainerAttempt2Complete) {
                if (!rowAnswerHasContent(sum.final_attempt_2_result ?? undefined)) {
                  stepErrors['assessment-summary-final_attempt_2_result'] =
                    'Assessment summary: attempt 2 result (Competent / Not Yet Competent) is required';
                }
                if (!rowAnswerHasContent(sum.trainer_sig_2 ?? undefined)) {
                  stepErrors['assessment-summary-trainer_sig_2'] = 'Assessment summary: trainer signature (attempt 2) is required';
                }
                if (!rowAnswerHasContent(sum.trainer_date_2 ?? undefined)) {
                  stepErrors['assessment-summary-trainer_date_2'] = 'Assessment summary: trainer date (attempt 2) is required';
                }
              } else if (resubmissionCycle >= 1 && !sumTrainerAttempt1Complete) {
                if (!rowAnswerHasContent(sum.final_attempt_1_result ?? undefined)) {
                  stepErrors['assessment-summary-final_attempt_1_result'] =
                    'Assessment summary: attempt 1 result (Competent / Not Yet Competent) is required';
                }
                if (!rowAnswerHasContent(sum.trainer_sig_1 ?? undefined)) {
                  stepErrors['assessment-summary-trainer_sig_1'] = 'Assessment summary: trainer signature (attempt 1) is required';
                }
                if (!rowAnswerHasContent(sum.trainer_date_1 ?? undefined)) {
                  stepErrors['assessment-summary-trainer_date_1'] = 'Assessment summary: trainer date (attempt 1) is required';
                }
              }
            } else if (options?.forSubmit) {
              const staffSummaryActiveAttempt = getActiveMarkingAttemptNum(submissionCount, sum, firstTaskRd);
              if (isCurrentMarkingAttemptColumn(staffSummaryActiveAttempt, 1)) {
                if (!rowAnswerHasContent(sum.final_attempt_1_result ?? undefined)) {
                  stepErrors['assessment-summary-final_attempt_1_result'] = 'Attempt 1 result (Competent / Not Yet Competent) is required';
                }
                if (!rowAnswerHasContent(sum.trainer_sig_1 ?? undefined)) {
                  stepErrors['assessment-summary-trainer_sig_1'] = 'Trainer signature (attempt 1) is required';
                }
                if (!rowAnswerHasContent(sum.trainer_date_1 ?? undefined)) {
                  stepErrors['assessment-summary-trainer_date_1'] = 'Trainer date (attempt 1) is required';
                }
              }
              if (isCurrentMarkingAttemptColumn(staffSummaryActiveAttempt, 2)) {
                if (!rowAnswerHasContent(sum.final_attempt_2_result ?? undefined)) {
                  stepErrors['assessment-summary-final_attempt_2_result'] = 'Attempt 2 result (Competent / Not Yet Competent) is required';
                }
                if (!rowAnswerHasContent(sum.trainer_sig_2 ?? undefined)) {
                  stepErrors['assessment-summary-trainer_sig_2'] = 'Trainer signature (attempt 2) is required';
                }
                if (!rowAnswerHasContent(sum.trainer_date_2 ?? undefined)) {
                  stepErrors['assessment-summary-trainer_date_2'] = 'Trainer date (attempt 2) is required';
                }
              }
              if (isCurrentMarkingAttemptColumn(staffSummaryActiveAttempt, 3)) {
                if (!rowAnswerHasContent(sum.final_attempt_3_result ?? undefined)) {
                  stepErrors['assessment-summary-final_attempt_3_result'] = 'Attempt 3 result (Competent / Not Yet Competent) is required';
                }
                if (!rowAnswerHasContent(sum.trainer_sig_3 ?? undefined)) {
                  stepErrors['assessment-summary-trainer_sig_3'] = 'Trainer signature (attempt 3) is required';
                }
                if (!rowAnswerHasContent(sum.trainer_date_3 ?? undefined)) {
                  stepErrors['assessment-summary-trainer_date_3'] = 'Trainer date (attempt 3) is required';
                }
              }
            }
          }

          if (role === 'student') {
            if (sumStudentFirstEditable) {
              if (!rowAnswerHasContent(sum.student_sig_1 ?? undefined)) {
                stepErrors['assessment-summary-student_sig_1'] = 'Student signature (attempt 1) is required';
              }
              if (!rowAnswerHasContent(sum.student_date_1 ?? undefined)) {
                stepErrors['assessment-summary-student_date_1'] = 'Student date (attempt 1) is required';
              }
            }
            if (sumStudentSecondEditable) {
              if (!rowAnswerHasContent(sum.student_sig_2 ?? undefined)) {
                stepErrors['assessment-summary-student_sig_2'] = 'Student signature (attempt 2) is required';
              }
              if (!rowAnswerHasContent(sum.student_date_2 ?? undefined)) {
                stepErrors['assessment-summary-student_date_2'] = 'Student date (attempt 2) is required';
              }
            }
            if (sumStudentThirdEditable) {
              if (!rowAnswerHasContent(sum.student_sig_3 ?? undefined)) {
                stepErrors['assessment-summary-student_sig_3'] = 'Student signature (attempt 3) is required';
              }
              if (!rowAnswerHasContent(sum.student_date_3 ?? undefined)) {
                stepErrors['assessment-summary-student_date_3'] = 'Student date (attempt 3) is required';
              }
            }
          }

          // Skip question-based validation for this section type.
          continue;
        }

        const appendixFirstCycleEditableForStep =
          !isAppendixAStepTitle || section.pdf_render_mode !== 'reasonable_adjustment'
            ? true
            : submissionWave < 2 && !secondOrThirdHasDataAppendixVal;

        const taskStyleSection =
          section.pdf_render_mode === 'task_questions' || section.pdf_render_mode === 'assessment_tasks';
        const qNumbers = taskStyleSection ? getTaskQuestionDisplayNumbers(section.questions) : null;

        for (const q of section.questions) {
          if (q.type === 'instruction_block' || q.type === 'page_break') continue;
          if ((q.pdf_meta as Record<string, unknown>)?.isAdditionalBlockOf) continue;
          if (!isQuestionVisibleForRole((q.role_visibility as Record<string, boolean>) || {})) continue;
          // If the submission section already renders the student declaration signature, don't require (or validate)
          // the duplicate declaration question on this step.
          if (
            assessmentSubmissionHasDeclSig &&
            section.pdf_render_mode === 'declarations' &&
            q.code === 'student.declarationSignature'
          ) {
            continue;
          }
          const baseEditable = isQuestionEditableForRole((q.role_editability as Record<string, boolean>) || {}) && canRoleEditCurrentWorkflow;
          const editable = baseEditable && !isQuestionReadOnlyByTrainer(q.id);
          const effectiveEditable = editable && appendixFirstCycleEditableForStep;
          const displayQn = qNumbers?.get(q.id) ?? null;
          const trainerSat = getTrainerSatisfactoryForQuestion(section, q.id, trainerAssessments);
          const trainerReviewingTaskQuestions =
            (role === 'trainer' || role === 'office') &&
            taskStyleSection &&
            workflowStatus !== 'completed' &&
            workflowStatus !== 'failed';

          const assignStudentRequiredError = (detail: {
            fieldLabel?: string | null;
            missingCount?: number | null;
          }) => {
            const message = formatAssessmentValidationError({
              questionNumber: displayQn,
              questionTitle: q.label,
              fieldLabel: detail.fieldLabel,
              missingCount: detail.missingCount,
            });
            stepErrors[`q-${q.id}`] = message;
            questionErrorMetas.push({
              errorKey: `q-${q.id}`,
              questionId: q.id,
              questionNumber: displayQn,
              questionTitle: q.label,
              message,
            });
          };

          // Trainer review on task questions: never require student fill; only Yes/No (or likert skip).
          if (trainerReviewingTaskQuestions && q.required) {
            if (q.type === 'likert_5' || section.pdf_render_mode === 'likert_table') {
              continue;
            }
            if (trainerSat === 'yes' || trainerSat === 'no') {
              continue;
            }
            stepErrors[`q-${q.id}`] = 'Mark Satisfactory (Yes or No) before continuing.';
            continue;
          }

          if (!q.required || !effectiveEditable) continue;

          const trainerHasChecked = role === 'trainer' && (trainerSat === 'yes' || trainerSat === 'no');

          if (q.type === 'grid_table' && q.rows?.length) {
            if (!trainerHasChecked && !isGridTableFilled(q, answers)) {
              assignStudentRequiredError(describeGridRequiredGap(q, answers));
            }
            continue;
          }
          if (q.type === 'likert_5' && q.rows?.length) {
            if (!trainerHasChecked && !isLikertFilled(q, answers)) {
              assignStudentRequiredError({ missingCount: 1 });
            }
            continue;
          }
          // Checklists are stored per-row (row_id) but are rendered as `single_choice` with rows.
          // Validate that every visible row has a selected option when required.
          if (q.type === 'single_choice' && q.rows?.length) {
            let missingRows = 0;
            let firstMissingRow = -1;
            for (let ri = 0; ri < q.rows.length; ri++) {
              const rowKey = getAnswerKey(q.id, q.rows[ri].id);
              if (!rowAnswerHasContent(answers[rowKey] as AnswersMap[string] | undefined)) {
                missingRows += 1;
                if (firstMissingRow < 0) firstMissingRow = ri;
              }
            }
            if (!trainerHasChecked && missingRows > 0) {
              assignStudentRequiredError(
                missingRows === 1
                  ? { fieldLabel: `Row ${firstMissingRow + 1}`, missingCount: 1 }
                  : { missingCount: missingRows }
              );
            }
            continue;
          }

          const byBlocks = isRequiredSatisfiedByContentBlocks(q, section, answers);
          if (byBlocks !== null) {
            if (!trainerHasChecked && !byBlocks) {
              const gaps = describeContentBlockRequiredGaps(
                q,
                section.questions,
                answers,
                (child, ans) => isGridTableFilled(child, ans as AnswersMap)
              );
              const summary = summarizeContentBlockGaps(gaps);
              assignStudentRequiredError(
                summary.missingCount > 0
                  ? summary
                  : { missingCount: 1 }
              );
            }
            continue;
          }

          const key = getAnswerKey(q.id, null);
          const val = answers[key];
          // For signatures, `val` is usually an object; `String(val)` becomes "[object Object]"
          // which incorrectly passes the "required" check. Use content-based validation instead.
          if (q.type === 'signature') {
            const obj = val && typeof val === 'object' && !Array.isArray(val) ? (val as Record<string, unknown>) : null;
            const sig = obj ? (obj.signature ?? obj.imageDataUrl ?? null) : (typeof val === 'string' ? val : null);
            const dateVal = obj ? String(obj.date ?? obj.signedAtDate ?? '') : '';
            const needsDate = ((q.pdf_meta as { showDateField?: boolean } | undefined)?.showDateField ?? false) === true;
            if (!trainerHasChecked && (!String(sig ?? '').trim() || (needsDate && !String(dateVal ?? '').trim()))) {
              assignStudentRequiredError(describeSignatureRequiredGap(q, answers));
            }
          } else if (!trainerHasChecked && !rowAnswerHasContent(val as AnswersMap[string] | undefined)) {
            assignStudentRequiredError({ missingCount: 1 });
          } else if (
            q.code === 'evaluation.evaluationDate' &&
            rowAnswerHasContent(val as AnswersMap[string] | undefined)
          ) {
            const trIds = (template?.steps ?? [])
              .flatMap((st) => st.sections)
              .filter((s) => s.pdf_render_mode === 'task_results')
              .map((s) => s.id);
            const firstRd = trIds[0] ? resultsData[trIds[0]] : null;
            const firstAttempt = firstRd?.first_attempt_date;
            const minEval = maxIsoDate(
              studentDeclarationDateMinIso,
              firstAttempt && String(firstAttempt).trim()
                ? normalizeCalendarDateToIso(String(firstAttempt)) ?? undefined
                : undefined,
            );
            if (minEval && isCalendarBefore(String(val), minEval)) {
              stepErrors[`q-${q.id}`] = 'Date of Evaluation cannot be before the student declaration date or first attempt date.';
            }
          }
        }
      }
      questionValidationMetaRef.current = questionErrorMetas;
      return stepErrors;
    },
    [
      template,
      role,
      workflowStatus,
      answers,
      resultsData,
      assessmentSummary,
      submissionCount,
      submissionWave,
      trainerAssessments,
      trainerCanFinaliseReview,
      canRoleEditCurrentWorkflow,
      isQuestionReadOnlyByTrainer,
      isQuestionEditableForRole,
      studentDeclarationDateMinIso,
      isAdminEditMode,
    ]
  );

  const presentStepValidationFeedback = useCallback(
    (stepErrors: Record<string, string>, metas?: AssessmentQuestionErrorMeta[]) => {
      setErrors(stepErrors);
      const questionMetas = metas ?? questionValidationMetaRef.current;
      if (questionMetas.length > 0) {
        toast.error(pickAssessmentValidationToast(questionMetas));
        scrollToAssessmentQuestion(questionMetas[0].questionId);
        return;
      }
      const first = Object.values(stepErrors)[0];
      if (first) toast.error(first);
    },
    []
  );

  /** Every content step must validate before trainer can submit (not only the last step). */
  const validateAllStepsForTrainerSubmit = useCallback((): boolean => {
    if (!template || role !== 'trainer') return true;
    const progressCheck = validateAssessmentBeforeProgress({
      template,
      resultsData,
      assessmentSummary,
    });
    if (!progressCheck.valid) {
      const merged: Record<string, string> = {};
      for (const sectionId of progressCheck.missingResultSheetSectionIds) {
        merged[`task-results-${sectionId}-minimum`] = ASSESSMENT_RESULT_PROGRESS_MESSAGE;
      }
      if (progressCheck.missingSummarySheet) {
        merged['assessment-summary-minimum'] = ASSESSMENT_RESULT_PROGRESS_MESSAGE;
      }
      setErrors(merged);
      toast.error(progressCheck.message ?? ASSESSMENT_RESULT_PROGRESS_MESSAGE);
      return false;
    }
    // Trainers see all template steps (Appendix A is only hidden for students in the stepper).
    const visibleStepsForValidation = template.steps ?? [];
    const totalSteps = 1 + visibleStepsForValidation.length;
    const merged: Record<string, string> = {};
    const allMetas: AssessmentQuestionErrorMeta[] = [];
    for (let stepNumber = 2; stepNumber <= totalSteps; stepNumber++) {
      Object.assign(merged, getStepValidationErrors(stepNumber, { forSubmit: true }));
      allMetas.push(...questionValidationMetaRef.current);
    }
    questionValidationMetaRef.current = allMetas;
    if (Object.keys(merged).length > 0) {
      presentStepValidationFeedback(merged, allMetas.length > 0 ? allMetas : undefined);
      return false;
    }
    return true;
  }, [template, role, getStepValidationErrors, resultsData, assessmentSummary, presentStepValidationFeedback]);

  const runFinalSubmitByRole = useCallback(async () => {
    if (!id) return;
    setWorkflowSubmitting(true);
    try {
      if (canRoleEditCurrentWorkflow) {
        try {
          await flushPendingDebouncedAnswerSaves();
        } catch {
          toast.error('Could not save pending answers before submit. Please try again.');
          return;
        }
      }
      if (role === 'student' && workflowStatus === 'draft') {
        const visibleStepsForValidation = getVisibleStepsForRole(template!, role);
        const totalSteps = 1 + visibleStepsForValidation.length;
        const merged: Record<string, string> = {};
        const allMetas: AssessmentQuestionErrorMeta[] = [];
        for (let stepNumber = 2; stepNumber <= totalSteps; stepNumber++) {
          Object.assign(merged, getStepValidationErrors(stepNumber, { forSubmit: true }));
          allMetas.push(...questionValidationMetaRef.current);
        }
        questionValidationMetaRef.current = allMetas;
        if (Object.keys(merged).length > 0) {
          presentStepValidationFeedback(merged, allMetas);
          // Jump to the step that contains the first incomplete question when possible.
          if (allMetas[0] && template) {
            const firstId = allMetas[0].questionId;
            const visible = getVisibleStepsForRole(template, role);
            const stepIdx = visible.findIndex((st) =>
              st.sections.some((sec) => sec.questions.some((q) => q.id === firstId))
            );
            if (stepIdx >= 0) {
              setCurrentStep(stepIdx + 2);
              window.setTimeout(() => scrollToAssessmentQuestion(firstId), 120);
            }
          }
          setWorkflowSubmitting(false);
          setConfirmConfig(null);
          return;
        }
        const requestId =
          submissionRequestIdRef.current ??
          globalThis.crypto?.randomUUID?.() ??
          `${id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        submissionRequestIdRef.current = requestId;
        const handoff = await submitInstanceToTrainerViaRpc(id, requestId);
        if (!handoff.ok) {
          toast.error(handoff.error ?? 'Could not submit. Check your connection and try again.');
          return;
        }
        submissionRequestIdRef.current = null;
        await revokeRoleAccessTokens(id, 'student');
        setWorkflowStatus('waiting_trainer');
        setInstanceRoleContext('trainer');
        setSubmissionCount((prev) => (prev <= 0 ? 1 : Math.min(Math.max(prev, 1) + 1, 3)));
        setShowPostSubmitThankYou(true);
        toast.success('Submitted successfully. Waiting for trainer checking.');
        void (async () => {
          const ctx = await getInstanceWorkflowNotificationContext(id);
          if (!ctx) return;
          const trainerIds = batchTrainerNotifyUserIds(ctx);
          if (trainerIds.length === 0) return;
          await invokeWorkflowSendNotification({
            userIds: trainerIds,
            title: `New submission: ${ctx.formName}`,
            message: 'A student submitted an assessment for your review.',
            url: '/admin/dashboard',
            type: 'workflow_student_submit',
          });
        })();
        setConfirmConfig(null);
        return;
      }
      if (role === 'trainer' && trainerCanFinaliseReview) {
      if (!validateAllStepsForTrainerSubmit()) {
        setWorkflowSubmitting(false);
        setConfirmConfig(null);
        return;
      }
      const latestAttempt = getTrainerSubmitAttemptNum(submissionCount, assessmentSummary);
      const latestResult = getTrainerAttemptOutcome(latestAttempt);
      const hasTaskResultSections = (template?.steps ?? []).some((st) =>
        st.sections.some((s) => s.pdf_render_mode === 'task_results')
      );
      if (hasTaskResultSections) {
        const progressCheck = validateAssessmentBeforeProgress({
          template,
          resultsData,
          assessmentSummary,
        });
        if (!progressCheck.valid) {
          const merged: Record<string, string> = {};
          for (const sectionId of progressCheck.missingResultSheetSectionIds) {
            merged[`task-results-${sectionId}-minimum`] = ASSESSMENT_RESULT_PROGRESS_MESSAGE;
          }
          if (progressCheck.missingSummarySheet) {
            merged['assessment-summary-minimum'] = ASSESSMENT_RESULT_PROGRESS_MESSAGE;
          }
          setErrors(merged);
          toast.error(progressCheck.message ?? ASSESSMENT_RESULT_PROGRESS_MESSAGE);
          setWorkflowSubmitting(false);
          setConfirmConfig(null);
          return;
        }
      }
      if (hasTaskResultSections && latestResult == null) {
        toast.error('Mark every task result sheet (S or NS) for the current attempt, and complete the assessment summary, before submitting.');
        setWorkflowSubmitting(false);
        setConfirmConfig(null);
        return;
      }

      // Not Yet Competent: allow up to 3 attempts.
      if (latestResult === 'not_yet_competent') {
        if (latestAttempt < 3) {
          try {
            const assessedOn = await recordTrainerNycAssessedOn(id, latestAttempt);
            const newEnd = studentResubmissionDeadlineFromAssessedOn(assessedOn);
            await extendInstanceAccessTokensToDate(id, 'student', newEnd);
            await updateInstanceWorkflowStatus(id, 'draft');
            await updateInstanceRole(id, 'student');
            setWorkflowStatus('draft');
            setInstanceRoleContext('student');
            setShowPostSubmitThankYou(true);
            toast.success(`Not Yet Competent. Attempt ${latestAttempt} complete. Resubmission opened until ${newEnd} (23:59 Melbourne).`);
            void (async () => {
              const ctx = await getInstanceWorkflowNotificationContext(id);
              if (!ctx?.studentNotificationUserId) return;
              await invokeWorkflowSendNotification({
                userIds: [ctx.studentNotificationUserId],
                title: `Resubmission required: ${ctx.formName}`,
                message: `Your trainer recorded Not Yet Competent for attempt ${latestAttempt}. A new submission window is open (until ${newEnd} Melbourne).`,
                url: '/student/dashboard',
                type: 'workflow_resubmit',
              });
            })();
          } finally {
            setWorkflowSubmitting(false);
          }
          setConfirmConfig(null);
          return;
        }

        await updateInstanceWorkflowStatus(id, 'failed');
        setWorkflowStatus('failed');
        await updateInstanceRole(id, 'office');
        setInstanceRoleContext('office');
        setShowPostSubmitThankYou(true);
        toast.error('Not Yet Competent after 3 attempts. Instance is now Failed.');
        void (async () => {
          const ctx = await getInstanceWorkflowNotificationContext(id);
          if (!ctx?.studentNotificationUserId) return;
          await invokeWorkflowSendNotification({
            userIds: [ctx.studentNotificationUserId],
            title: `Assessment outcome: ${ctx.formName}`,
            message: 'This assessment is recorded as not competent after 3 attempts. The instance is closed.',
            url: '/student/dashboard',
            type: 'workflow_failed',
          });
        })();
        setWorkflowSubmitting(false);
        setConfirmConfig(null);
        return;
      }

      await updateInstanceWorkflowStatus(id, 'waiting_office');
      setWorkflowStatus('waiting_office');
      await updateInstanceRole(id, 'office');
      setInstanceRoleContext('office');
      setShowPostSubmitThankYou(true);
      toast.success('Submitted successfully. Waiting for office checking.');
      void (async () => {
        const ctx = await getInstanceWorkflowNotificationContext(id);
        if (!ctx?.studentNotificationUserId) return;
        await invokeWorkflowSendNotification({
          userIds: [ctx.studentNotificationUserId],
          title: `Trainer review complete: ${ctx.formName}`,
          message: 'Your trainer has completed their review and sent this assessment for office processing.',
          url: '/student/dashboard',
          type: 'workflow_to_office',
        });
      })();
      setWorkflowSubmitting(false);
      setConfirmConfig(null);
      return;
    }
    if (role === 'office' && (workflowStatus === 'waiting_office' || isAdminEditMode)) {
      await updateInstanceWorkflowStatus(id, 'completed');
      setWorkflowStatus('completed');
      setShowPostSubmitThankYou(true);
      toast.success('Office check complete. Form is now completed.');
      void (async () => {
        const ctx = await getInstanceWorkflowNotificationContext(id);
        if (!ctx?.studentNotificationUserId) return;
        await invokeWorkflowSendNotification({
          userIds: [ctx.studentNotificationUserId],
          title: `Assessment finalised: ${ctx.formName}`,
          message: 'Office processing is complete. Your assessment is now finalised.',
          url: '/student/dashboard',
          type: 'workflow_completed',
        });
      })();
      setConfirmConfig(null);
    }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save. Try again.');
    } finally {
      setWorkflowSubmitting(false);
    }
  }, [
    id,
    role,
    workflowStatus,
    submissionCount,
    getTrainerAttemptOutcome,
    assessmentSummary,
    validateAllStepsForTrainerSubmit,
    template,
    trainerCanFinaliseReview,
    canRoleEditCurrentWorkflow,
    flushPendingDebouncedAnswerSaves,
    getStepValidationErrors,
    presentStepValidationFeedback,
  ]);

  const handleFinalSubmitByRole = useCallback(() => {
    if (role === 'student' && workflowStatus === 'draft') {
      setConfirmConfig({
        title: 'Final Submit',
        message: 'After submitting, you will not be able to edit this form again. Please verify all answers before continuing.',
        confirmLabel: 'Submit',
      });
      return;
    }
    if (role === 'trainer' && trainerCanFinaliseReview) {
      setConfirmConfig({
        title: 'Final Submit',
        message: 'After submitting, you will not be able to edit this form again. Please verify all answers before continuing.',
        confirmLabel: 'Submit',
      });
      return;
    }
    if (role === 'office' && (workflowStatus === 'waiting_office' || isAdminEditMode)) {
      setConfirmConfig({
        title: 'Office Check',
        message: 'Finalize office checking? Tick Initial and Updated on all task results and the summary sheet, or confirm to complete now.',
        confirmLabel: 'Finalize',
      });
    }
  }, [role, workflowStatus, isAdminEditMode, trainerCanFinaliseReview]);

  const advanceToNextStepWithoutSave = useCallback(() => {
    if (!template) return;
    cancelPendingDebouncedAnswerSaves();
    const visibleStepsForNav = getVisibleStepsForRole(template, role);
    const totalSteps = 1 + visibleStepsForNav.length;
    setErrors({});
    setCurrentStep((s) => Math.min(totalSteps, s + 1));
    formScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [template, role, cancelPendingDebouncedAnswerSaves]);

  const handlePreviousStep = useCallback(async () => {
    if (stepNavSaving || currentStep <= 1) return;
    if (canRoleEditCurrentWorkflow) {
      setStepNavSaving(true);
      try {
        await flushPendingDebouncedAnswerSaves();
      } catch {
        toast.error('Could not save answers. Please try again.');
        return;
      } finally {
        setStepNavSaving(false);
      }
    }
    setErrors({});
    setCurrentStep((s) => Math.max(1, s - 1));
  }, [stepNavSaving, currentStep, canRoleEditCurrentWorkflow, flushPendingDebouncedAnswerSaves]);

  const handleNextStep = useCallback(async () => {
    if (stepNavSaving || !template) return;

    const stepErrors = getStepValidationErrors(currentStep);
    if (Object.keys(stepErrors).length > 0) {
      if (isAdminEditMode) {
        setErrors(stepErrors);
        setAdminSkipSavePrompt('validation');
        return;
      }
      presentStepValidationFeedback(stepErrors);
      return;
    }

    const visibleStepsForNav = getVisibleStepsForRole(template, role);
    const totalSteps = 1 + visibleStepsForNav.length;
    const stepData = currentStep === 1 ? null : visibleStepsForNav[currentStep - 2];
    const stepSections = stepData?.sections ?? [];

    if (canRoleEditCurrentWorkflow) setStepNavSaving(true);
    try {
      if (canRoleEditCurrentWorkflow) {
        try {
          await flushPendingDebouncedAnswerSaves();
        } catch {
          if (isAdminEditMode) {
            setAdminSkipSavePrompt('save');
            return;
          }
          toast.error('Could not save answers. Please try again.');
          return;
        }
        if (stepSections.length > 0) {
          const ok = await saveStepAnswersSequential(stepSections);
          if (!ok) {
            if (isAdminEditMode) {
              setAdminSkipSavePrompt('save');
              return;
            }
            toast.error('Could not save answers. Please try again.');
            return;
          }
        }
      }

      setErrors({});
      questionValidationMetaRef.current = [];
      setCurrentStep((s) => Math.min(totalSteps, s + 1));
      formScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      if (canRoleEditCurrentWorkflow) setStepNavSaving(false);
    }
  }, [
    stepNavSaving,
    template,
    role,
    getStepValidationErrors,
    currentStep,
    isAdminEditMode,
    canRoleEditCurrentWorkflow,
    saveStepAnswersSequential,
    flushPendingDebouncedAnswerSaves,
    presentStepValidationFeedback,
  ]);

  if (loading) {
    return <Loader fullPage variant="dots" size="lg" message="Loading..." />;
  }
  if (accessDenied) {
    const isCourseMsg =
      accessDenied === MSG_COURSE_NOT_IN_PROGRESS ||
      accessDenied === MSG_COURSE_NOT_GOING_ON ||
      accessDenied === MSG_COURSE_TENTATIVE ||
      accessDenied === MSG_COURSE_SUSPENDED ||
      accessDenied === MSG_COURSE_CANCELLED ||
      accessDenied === MSG_COURSE_COMPLETED ||
      /course/i.test(accessDenied);
    return (
      <div className="min-h-screen bg-[var(--bg)] flex items-center justify-center px-4">
        <Card className="max-w-xl w-full border-amber-200 bg-amber-50/60">
          <h2 className="text-xl font-bold text-[var(--text)] mb-2">
            {isCourseMsg ? 'Course not available' : 'Access denied'}
          </h2>
          <p className="text-sm text-amber-950" role="alert">
            {accessDenied}
          </p>
        </Card>
      </div>
    );
  }
  if (!template) {
    return (
      <div className="min-h-screen bg-[var(--bg)] flex items-center justify-center px-4">
        <Card className="max-w-xl w-full">
          <h2 className="text-xl font-bold text-[var(--text)] mb-2">Instance unavailable</h2>
          <p className="text-sm text-gray-600">This assessment instance could not be loaded.</p>
        </Card>
      </div>
    );
  }

  const studentHasSubmitted = submissionCount > 0;

  const showStudentDidNotAttemptPage =
    role === 'student' &&
    !studentHasSubmitted &&
    (didNotAttempt || (workflowStatus === 'failed' && instanceLegacyStatus === 'locked'));

  const showSubmittedPage =
    !isAdminEditMode &&
    (showPostSubmitThankYou ||
      (role === 'student' && studentHasSubmitted && workflowStatus !== 'draft') ||
      (role === 'trainer' &&
        (workflowStatus === 'completed' ||
          workflowStatus === 'failed' ||
          (workflowStatus === 'waiting_office' && instanceRoleContext !== 'trainer'))));

  const canViewPdfPreview = role === 'office';

  const submittedTitle = 'Thank you';
  const submittedMessage = (() => {
    if (role === 'student') {
      return 'Your assessment has been submitted. Editing is now locked and downloading is disabled.';
    }
    if (role === 'trainer' && workflowStatus === 'draft') {
      return 'Your review has been submitted. The student has been notified and may resubmit for the next attempt.';
    }
    if (role === 'trainer' && workflowStatus === 'failed') {
      return 'This assessment is closed after 3 attempts. Editing is now locked.';
    }
    if (role === 'office') {
      return 'Office checking is complete. This assessment is now finalised.';
    }
    return 'Your trainer checking has been submitted. Editing is now locked and downloading is disabled.';
  })();

  if (showStudentDidNotAttemptPage) {
    return (
      <div className="min-h-screen bg-[var(--bg)]">
        <header className="bg-white border-b border-[var(--border)] shadow-sm sticky top-0 z-20">
          <div className="w-full min-w-0 px-4 md:px-6 py-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <h1 className="min-w-0 text-lg sm:text-xl font-bold text-[var(--text)] break-words">{template.form.name}</h1>
              <div className="flex items-center gap-2 flex-wrap justify-end">
                <span className="text-xs px-2.5 py-1 rounded-full bg-red-50 text-red-700 border border-red-200">Closed</span>
                <span className="text-sm font-semibold text-gray-700 capitalize">{role}</span>
              </div>
            </div>
          </div>
        </header>
        <div className="w-full px-4 md:px-6 py-8">
          <div className="max-w-3xl mx-auto">
            <Card>
              <h2 className="text-xl font-bold text-[var(--text)] mb-2">Assessment closed</h2>
              <p className="text-sm text-gray-600">
                You did not submit this assessment within the allowed attempt dates. If you believe this is an error,
                contact your trainer or admin.
              </p>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  if (showSubmittedPage) {
    return (
      <div className="min-h-screen bg-[var(--bg)]">
        <header className="bg-white border-b border-[var(--border)] shadow-sm sticky top-0 z-20">
          <div className="w-full min-w-0 px-4 md:px-6 py-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <h1 className="min-w-0 text-lg sm:text-xl font-bold text-[var(--text)] break-words">{template.form.name}</h1>
              <div className="flex items-center gap-2 flex-wrap justify-end">
                <span className="text-xs px-2.5 py-1 rounded-full bg-blue-50 text-blue-700 border border-blue-200">{workflowLabel}</span>
                <span className="text-sm font-semibold text-gray-700 capitalize">{role}</span>
              </div>
            </div>
          </div>
        </header>
        <div className="w-full px-4 md:px-6 py-8">
          <div className="max-w-3xl mx-auto">
            <Card>
              <h2 className="text-xl font-bold text-[var(--text)] mb-2">{submittedTitle}</h2>
              <p className="text-sm text-gray-600">{submittedMessage}</p>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  // Introduction step is always first, then form steps. Appendix A hidden from students.
  const visibleSteps = getVisibleStepsForRole(template, role);
  const steps = [
    { number: 1, label: 'Introduction', description: 'Student Pack overview' },
    ...visibleSteps.map((s, i) => ({
      number: i + 2,
      label: s.title,
      description: s.subtitle || '',
    })),
  ];

  const isIntroductionStep = currentStep === 1;
  const currentStepData = isIntroductionStep ? null : visibleSteps[currentStep - 2];
  const visibleQuestions: { q: typeof template.steps[0]['sections'][0]['questions'][0]; section: typeof template.steps[0]['sections'][0] }[] = [];

  if (currentStepData) {
    for (const section of currentStepData.sections) {
      for (const q of section.questions) {
        const rv = (q.role_visibility as Record<string, boolean>) || {};
        if (isRoleVisible(rv, role)) {
          visibleQuestions.push({ q, section });
        }
      }
    }
  }

  return (
    <div className="min-h-screen bg-[var(--bg)] overflow-x-clip">
      <header className="bg-white border-b border-[var(--border)] shadow-sm sticky top-0 z-20">
        <div className="w-full min-w-0 px-4 md:px-6 py-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <h1 className="min-w-0 text-lg sm:text-xl font-bold text-[var(--text)] break-words">{template.form.name}</h1>
            <div className="flex items-center gap-2 flex-wrap justify-end">
              <span className="text-xs px-2.5 py-1 rounded-full bg-blue-50 text-blue-700 border border-blue-200">{workflowLabel}</span>
              {isAdminEditMode ? (
                <span className="text-xs px-2.5 py-1 rounded-full bg-amber-50 text-amber-800 border border-amber-200">
                  Admin edit
                </span>
              ) : null}
              {canRoleEditCurrentWorkflow ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  title="Writes any answers still waiting to sync (about 300ms after you stop typing). Task result sheets already save immediately."
                  onClick={() => void handleManualSaveDraft()}
                  disabled={manualSaveBusy || stepNavSaving}
                >
                  {manualSaveBusy || stepNavSaving ? 'Saving…' : 'Autosave'}
                </Button>
              ) : null}
              <span className="text-sm font-semibold text-gray-700 capitalize">{role}</span>
            </div>
          </div>
        </div>
      </header>

      <div className="w-full min-w-0 max-w-[100vw] px-3 sm:px-4 md:px-6 py-4 sm:py-6 box-border">
        <div className="grid min-w-0 grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-6 relative">
          {stepNavSaving && (
            <div
              className="absolute inset-0 z-50 flex flex-col items-center justify-center rounded-lg bg-white/80 backdrop-blur-[2px]"
              role="status"
              aria-live="polite"
              aria-busy="true"
            >
              <Loader variant="dots" size="lg" message="Saving answers…" />
              <p className="mt-3 text-sm text-gray-600">Please wait — the form is locked while your answers are saved.</p>
            </div>
          )}
          <form
            ref={formScrollRef}
            className={
              (canViewPdfPreview ? 'lg:col-span-9' : 'lg:col-span-12') +
              ' min-w-0 space-y-6 pr-0 sm:pr-2 lg:max-h-[min(calc(100dvh-8rem),100vh)] lg:overflow-y-auto' +
              (stepNavSaving ? ' pointer-events-none' : '')
            }
            aria-busy={stepNavSaving}
            onSubmit={(e) => e.preventDefault()}
          >
            <fieldset disabled={stepNavSaving} className="min-w-0 space-y-6 border-0 p-0 m-0 disabled:opacity-60">
            <Card>
              <Stepper steps={steps} currentStep={currentStep} />
            </Card>
            {role === 'student' && courseRunningAccess && !studentCourseMutationAllowed ? (
              <div
                role="status"
                className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950"
              >
                <p className="font-semibold">Course not currently running</p>
                <p className="mt-1">{courseRunningAccess.message || MSG_COURSE_NOT_IN_PROGRESS}</p>
              </div>
            ) : null}
            {role === 'office' && workflowStatus === 'waiting_office' && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
                <p className="font-semibold">Office admin tasks</p>
                <p className="mt-1">
                  Tick <strong>Initial</strong> and <strong>Updated</strong> on each task Results sheet and on the Assessment Summary sheet.
                  When all are checked, this assessment finalises automatically. You can also use <strong>Office Checked</strong> on the last step.
                </p>
              </div>
            )}

            {isIntroductionStep ? (
              <Card>
                <h2 className="text-xl font-bold text-[var(--text)] mb-4">Student Pack</h2>
                <h3 className="text-lg font-semibold text-gray-700 mb-3">What is the purpose of this document?</h3>
                <p className="text-gray-700 mb-4">
                  The Student Pack is the document you, the student, needs to complete to demonstrate competency. This document includes the context and conditions of your assessment, the tasks to be completed by you and an outline of the evidence to be gathered.
                </p>
                <h4 className="font-semibold text-gray-700 mb-2">The information includes the following:</h4>
                <ul className="list-disc list-inside text-gray-700 mb-4 space-y-1">
                  <li>Information related to the unit of competency.</li>
                  <li>Guidelines and instructions to complete each task and activity.</li>
                  <li>A student evaluation form</li>
                </ul>
                <h4 className="font-semibold text-gray-700 mb-2">Student Evaluation Form</h4>
                <p className="text-gray-700 mb-4">
                  These documents are designed after conducting thorough industry consultation. Students are encouraged to evaluate this document and provide constructive feedback to their training organisation if they feel that this document can be improved.
                </p>
                <h4 className="font-semibold text-gray-700 mb-2">Link to other unit documents</h4>
                <ul className="list-disc list-inside text-gray-700 space-y-2">
                  <li>The Student Pack is a document for students to complete to demonstrate their competency. This document includes context and conditions of assessment, tasks to be administered to the student, and an outline of the evidence to be gathered from the student.</li>
                  <li>The Unit Mapping is a document that contains information and comprehensive mapping with the training package requirements.</li>
                </ul>
              </Card>
            ) : currentStepData ? (
              (() => {
                const assessmentSubmissionHasDeclSig = false;
                const filteredSections = currentStepData.sections.filter((section) => {
                  if (section.pdf_render_mode === 'reasonable_adjustment' && role === 'student') return false;
                  // Avoid duplicating the student declaration signature/date when it's already shown inside the
                  // Assessment Submission block on this step.
                  if (assessmentSubmissionHasDeclSig && section.pdf_render_mode === 'declarations') {
                    const visibleQs = section.questions
                      .filter((q) => q.type !== 'instruction_block' && isQuestionVisibleForRole((q.role_visibility as Record<string, boolean>) || {}));
                    if (visibleQs.length === 1 && visibleQs[0].code === 'student.declarationSignature') {
                      return false;
                    }
                  }
                  /* Hide Written Evidence Checklist section when it has no rows - avoids blank header */
                  if (isWrittenEvidenceChecklistSection(section.pdf_render_mode, section.questions)) {
                    if (getWrittenEvidenceChecklistQuestions(section.pdf_render_mode, section.questions).length === 0) return false;
                  }
                  /* Hide Assessment Marking Checklist section when it has no rows in either Evidence or Performance outcome */
                  if (section.pdf_render_mode === 'task_marking_checklist') {
                    const evidenceQ = section.questions.find((q) => q.code === 'assessment.marking.evidence_outcome' && q.type === 'single_choice');
                    const perfQ = section.questions.find((q) => q.code === 'assessment.marking.performance_outcome' && q.type === 'single_choice');
                    const evidenceRows = evidenceQ?.rows?.length ?? 0;
                    const perfRows = perfQ?.rows?.length ?? 0;
                    if (evidenceRows === 0 && perfRows === 0) return false;
                  }
                  const hasInteractive = section.questions.some(
                    (q) => q.type !== 'instruction_block' && isQuestionVisibleForRole((q.role_visibility as Record<string, boolean>) || {})
                  );
                  return hasInteractive || section.pdf_render_mode === 'assessment_tasks' || section.pdf_render_mode === 'assessment_submission' || section.pdf_render_mode === 'reasonable_adjustment' || section.pdf_render_mode === 'reasonable_adjustment_indicator' || section.pdf_render_mode === 'additional_instructions' || section.pdf_render_mode === 'task_instructions' || section.pdf_render_mode === 'task_questions' || section.pdf_render_mode === 'task_written_evidence_checklist' || section.pdf_render_mode === 'task_marking_checklist' || section.pdf_render_mode === 'task_results' || section.pdf_render_mode === 'assessment_summary';
                });
                if (filteredSections.length === 0) return null;
                return (
              <Card>
                <h2 className="text-xl font-bold text-[var(--text)] mb-4">
                  Step {currentStep}: {currentStepData.title}
                </h2>
                {filteredSections.map((section) => (
                  <div key={section.id} className="mb-8 last:mb-0">
                    {section.pdf_render_mode !== 'likert_table' && section.pdf_render_mode !== 'reasonable_adjustment' && section.pdf_render_mode !== 'reasonable_adjustment_indicator' && section.pdf_render_mode !== 'task_instructions' && section.pdf_render_mode !== 'additional_instructions' && section.pdf_render_mode !== 'task_questions' && section.pdf_render_mode !== 'task_written_evidence_checklist' && section.pdf_render_mode !== 'task_marking_checklist' && section.pdf_render_mode !== 'task_results' && section.pdf_render_mode !== 'assessment_summary' && (
                      <h3 className="text-lg font-semibold text-gray-700 mb-2">{section.title}</h3>
                    )}
                    <div className={section.pdf_render_mode === 'declarations' || section.pdf_render_mode === 'assessment_submission' ? 'border border-gray-200 rounded-lg p-4 bg-white space-y-4' : 'space-y-4'}>
                      {section.pdf_render_mode === 'reasonable_adjustment_indicator' ? (
                        <div className="text-sm text-gray-700">
                          <h3 className="text-lg font-semibold text-gray-700 mb-2">{section.title}</h3>
                          <p className="leading-relaxed">{section.description || section.questions.find((q) => q.type === 'instruction_block')?.help_text || 'See Appendix A – Reasonable Adjustments for details and to record any adjustments applied.'}</p>
                        </div>
                      ) : section.pdf_render_mode === 'reasonable_adjustment' ? (
                        (() => {
                          const isAppendixA = currentStepData && /Appendix\s*A/i.test((currentStepData.title || '').trim());
                          const formHasAppendixA = (template?.steps ?? []).some((s) => /Appendix\s*A/i.test((s.title ?? '').trim()));
                          if (!isAppendixA && formHasAppendixA) {
                            return (
                              <div className="text-sm text-gray-700">
                                <h3 className="text-lg font-semibold text-gray-700 mb-2">Reasonable Adjustment</h3>
                                <p className="leading-relaxed">Reasonable Adjustment: See Appendix A – Reasonable Adjustments for details and to record any adjustments applied.</p>
                              </div>
                            );
                          }
                          const taskResultSectionIds = (template?.steps ?? []).flatMap((st) => st.sections).filter((s) => s.pdf_render_mode === 'task_results').map((s) => s.id);
                          const firstTaskSectionId = taskResultSectionIds[0];
                          const firstTaskRdForRA = firstTaskSectionId ? resultsData[firstTaskSectionId] : null;
                          const sumForRA = assessmentSummary;
                          const raSigSuggestion = firstTaskRdForRA?.trainer_signature ?? sumForRA?.trainer_sig_1 ?? null;
                          const raDateSuggestion = firstTaskRdForRA?.trainer_date ?? sumForRA?.trainer_date_1 ?? new Date().toISOString().split('T')[0];
                          return (
                        <div className="border border-gray-300 rounded-lg overflow-hidden bg-white">
                          <div className="bg-[#5E5E5E] text-white font-bold px-4 py-3 flex items-center gap-2">
                            <span className="text-sm">&#9654;</span>
                            <span>{isAppendixA ? section.title : 'Reasonable Adjustment'}</span>
                          </div>
                          <div className="p-4 space-y-4">
                            {section.questions
                              .filter(
                                (q) =>
                                  isQuestionVisibleForRole((q.role_visibility as Record<string, boolean>) || {}) &&
                                  !(assessmentSubmissionHasDeclSig && section.pdf_render_mode === 'declarations' && q.code === 'student.declarationSignature')
                              )
                              .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
                              .map((q) => {
                                const re = (q.role_editability as Record<string, boolean>) || {};
                                const editable = isQuestionEditableForRole(re) && canRoleEditCurrentWorkflow;
                                const secondOrThirdHasDataAppendix = !!(
                                  firstTaskRdForRA?.second_attempt_date ||
                                  firstTaskRdForRA?.second_attempt_satisfactory ||
                                  firstTaskRdForRA?.third_attempt_date ||
                                  firstTaskRdForRA?.third_attempt_satisfactory
                                );
                                /** Appendix A is first-cycle RA content; lock when resubmission (submission_count ≥ 2) or later attempts exist on task results. */
                                const appendixFirstCycleEditable =
                                  editable && submissionWave < 2 && !secondOrThirdHasDataAppendix;
                                const key = getAnswerKey(q.id, null);
                                const val = answers[key];
                                if (isAppendixA) {
                                  const isTaskField = q.code === 'reasonable_adjustment_appendix.task' || (q.code === 'reasonable_adjustment.task' && q.type === 'short_text');
                                  const isExplanationField = q.code === 'reasonable_adjustment_appendix.explanation' || q.code === 'reasonable_adjustment.description';
                                  if (isTaskField) {
                                    return (
                                      <QuestionRenderer instanceId={id} key={q.id} question={q} value={(val as string) ?? null} onChange={(v) => handleAnswerChange(q.id, null, v as string)} disabled={!appendixFirstCycleEditable} error={errors[`q-${q.id}`]} highlightAsFill={appendixFirstCycleEditable} />
                                    );
                                  }
                                  if (isExplanationField) {
                                    return (
                                      <QuestionRenderer instanceId={id} key={q.id} question={q} value={(val as string) ?? null} onChange={(v) => handleAnswerChange(q.id, null, v as string)} disabled={!appendixFirstCycleEditable} error={errors[`q-${q.id}`]} highlightAsFill={appendixFirstCycleEditable} />
                                    );
                                  }
                                  if (q.code === 'reasonable_adjustment_appendix.matrix' || (q.pdf_meta as Record<string, unknown>)?.appendixMatrix) {
                                    const matrixVal = val && typeof val === 'object' && !Array.isArray(val) ? (val as Record<string, boolean>) : {};
                                    return (
                                      <AppendixAMatrixForm
                                        key={q.id}
                                        value={matrixVal}
                                        onChange={(v) => handleAnswerChange(q.id, null, v)}
                                        disabled={!appendixFirstCycleEditable}
                                      />
                                    );
                                  }
                                  if (q.type === 'short_text' && !isTaskField) {
                                    return (
                                      <QuestionRenderer instanceId={id} key={q.id} question={q} value={(val as string) ?? null} onChange={(v) => handleAnswerChange(q.id, null, v as string)} disabled={!appendixFirstCycleEditable} error={errors[`q-${q.id}`]} highlightAsFill={appendixFirstCycleEditable} />
                                    );
                                  }
                                  if (q.type === 'long_text' && !isExplanationField) {
                                    return (
                                      <QuestionRenderer instanceId={id} key={q.id} question={q} value={(val as string) ?? null} onChange={(v) => handleAnswerChange(q.id, null, v as string)} disabled={!appendixFirstCycleEditable} error={errors[`q-${q.id}`]} highlightAsFill={appendixFirstCycleEditable} />
                                    );
                                  }
                                  if (q.type === 'signature') {
                                    const sigVal = val;
                                    const sigObj = sigVal && typeof sigVal === 'object' && !Array.isArray(sigVal) ? (sigVal as Record<string, unknown>) : null;
                                    const dateVal = sigObj ? String(sigObj.date ?? sigObj.signedAtDate ?? '') : '';
                                    const imgVal = sigObj?.signature ?? sigObj?.imageDataUrl ?? (typeof sigVal === 'string' ? sigVal : null);
                                    return (
                                      <div key={q.id} className="flex items-center gap-4 flex-wrap pt-2">
                                        <div className="flex-1 min-w-[200px]">
                                          <div className="text-sm font-semibold text-gray-700 mb-1">{q.label}</div>
                                          <SignatureField value={(imgVal as string | null) ?? null} onChange={(v) => { const img = typeof v === 'string' ? v : null; const base = (sigObj && typeof sigObj === 'object' ? { ...sigObj } : {}) as Record<string, unknown>; handleAnswerChange(q.id, null, (img != null ? { ...base, signature: img } : { ...base, signature: null }) as string | number | boolean | Record<string, unknown> | string[]); }} disabled={!appendixFirstCycleEditable} highlight={(role === 'student' || role === 'trainer') && appendixFirstCycleEditable} suggestionFrom={raSigSuggestion} onSuggestionClick={raSigSuggestion && appendixFirstCycleEditable ? () => { const base = (sigObj && typeof sigObj === 'object' ? { ...sigObj } : {}) as Record<string, unknown>; handleAnswerChange(q.id, null, { ...base, signature: raSigSuggestion, date: raDateSuggestion } as string | number | boolean | Record<string, unknown> | string[], true); } : undefined} />
                                        </div>
                                        <div className="flex items-center gap-2 min-w-[140px]">
                                          <span className="text-sm font-semibold text-gray-700 shrink-0">Date:</span>
                                          <DatePicker value={dateVal} onChange={(newDate) => { const base = sigObj || (typeof sigVal === 'string' ? { signature: sigVal } : {}); handleAnswerChange(q.id, null, { ...base, date: newDate } as string | number | boolean | Record<string, unknown> | string[]); }} disabled={!appendixFirstCycleEditable} highlight={(role === 'student' || role === 'trainer') && appendixFirstCycleEditable} compact placement="above" className="flex-1 min-w-0" />
                                        </div>
                                      </div>
                                    );
                                  }
                                  if (q.type === 'yes_no') {
                                    return (
                                      <QuestionRenderer instanceId={id} key={q.id} question={q} value={(val as string | number | boolean) ?? null} onChange={(v) => handleAnswerChange(q.id, null, v as string | number | boolean)} disabled={!appendixFirstCycleEditable} error={errors[`q-${q.id}`]} highlightAsFill={appendixFirstCycleEditable} />
                                    );
                                  }
                                  return null;
                                }
                                if (q.type === 'yes_no') {
                                  return (
                                    <QuestionRenderer instanceId={id} key={q.id} question={q} value={(val as string | number | boolean) ?? null} onChange={(v) => handleAnswerChange(q.id, null, v as string | number | boolean)} disabled={!editable} error={errors[`q-${q.id}`]} highlightAsFill={editable} />
                                  );
                                }
                                if (q.code === 'reasonable_adjustment.task') {
                                  return (
                                    <QuestionRenderer instanceId={id} key={q.id} question={q} value={(val as string) ?? null} onChange={(v) => handleAnswerChange(q.id, null, v as string)} disabled={!editable} error={errors[`q-${q.id}`]} highlightAsFill={editable} />
                                  );
                                }
                                if (q.type === 'long_text') {
                                  return (
                                    <QuestionRenderer instanceId={id} key={q.id} question={q} value={(val as string) ?? null} onChange={(v) => handleAnswerChange(q.id, null, v as string)} disabled={!editable} error={errors[`q-${q.id}`]} highlightAsFill={editable} />
                                  );
                                }
                                if (q.type === 'signature') {
                                  const sigVal = val;
                                  const sigObj = sigVal && typeof sigVal === 'object' && !Array.isArray(sigVal) ? (sigVal as Record<string, unknown>) : null;
                                  const dateVal = sigObj ? String(sigObj.date ?? sigObj.signedAtDate ?? '') : '';
                                  const imgVal = sigObj?.signature ?? sigObj?.imageDataUrl ?? (typeof sigVal === 'string' ? sigVal : null);
                                  return (
                                    <div key={q.id} className="flex items-center gap-4 flex-wrap pt-2">
                                      <div className="flex-1 min-w-[200px]">
                                        <div className="text-sm font-semibold text-gray-700 mb-1">{q.label}</div>
                                        <SignatureField
                                          value={(imgVal as string | null) ?? null}
                                          onChange={(v) => {
                                            const img = typeof v === 'string' ? v : null;
                                            const base = (sigObj && typeof sigObj === 'object' ? { ...sigObj } : {}) as Record<string, unknown>;
                                            const merged = img != null ? { ...base, signature: img } : { ...base, signature: null };
                                            handleAnswerChange(q.id, null, merged as string | number | boolean | Record<string, unknown> | string[]);
                                          }}
                                          disabled={!editable}
                                          highlight={(role === 'student' || role === 'trainer') && editable}
                                          suggestionFrom={raSigSuggestion}
                                          onSuggestionClick={raSigSuggestion && editable ? () => {
                                            const base = (sigObj && typeof sigObj === 'object' ? { ...sigObj } : {}) as Record<string, unknown>;
                                            handleAnswerChange(q.id, null, { ...base, signature: raSigSuggestion, date: raDateSuggestion } as string | number | boolean | Record<string, unknown> | string[], true);
                                          } : undefined}
                                        />
                                      </div>
                                      <div className="flex items-center gap-2 min-w-[140px]">
                                        <span className="text-sm font-semibold text-gray-700 shrink-0">Date:</span>
                                        <DatePicker
                                          value={dateVal}
                                          onChange={(newDate) => {
                                            const base = sigObj || (typeof sigVal === 'string' ? { signature: sigVal } : {});
                                            handleAnswerChange(q.id, null, { ...base, date: newDate } as string | number | boolean | Record<string, unknown> | string[]);
                                          }}
                                          disabled={!editable}
                                          highlight={(role === 'student' || role === 'trainer') && editable}
                                          compact
                                          placement="above"
                                          className="flex-1 min-w-0"
                                        />
                                      </div>
                                    </div>
                                  );
                                }
                                return null;
                              })}
                          </div>
                        </div>
                          );
                        })()
                      ) : section.pdf_render_mode === 'assessment_tasks' ? (
                        (() => {
                          const taskQ = section.questions.find((q) => q.type === 'grid_table' && q.rows.length > 0);
                          if (!taskQ) return null;
                          return (
                            <div className="overflow-x-auto">
                              <table className="w-full border-collapse border border-black text-sm">
                                <thead>
                                  <tr>
                                    <th className="bg-[#5E5E5E] text-white font-bold p-3 text-left border border-black">Evidence number</th>
                                    <th className="bg-[#5E5E5E] text-white font-bold p-3 text-left border border-black">Assessment method/ Type of evidence</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {taskQ.rows.map((row, i) => (
                                    <tr key={row.id} className={i % 2 === 0 ? 'bg-white' : 'bg-[#F0F4FA]'}>
                                      <td className="p-3 font-semibold border border-black">{row.row_label}</td>
                                      <td className="p-3 border border-black whitespace-pre-line">{row.row_help || ''}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          );
                        })()
                      ) : isWrittenEvidenceChecklistSection(section.pdf_render_mode, section.questions) ? (
                        (() => {
                          /* Every checklist question (Task 3.1, 3.2, ...) renders with its own rows — not just the first. */
                          const checklistQs = getWrittenEvidenceChecklistQuestions(section.pdf_render_mode, section.questions);
                          if (checklistQs.length === 0) return null;
                          const renderChecklistQ = (checklistQ: (typeof checklistQs)[number]) => {
                          const re = (checklistQ.role_editability as Record<string, boolean>) || {};
                          const editable = isQuestionEditableForRole(re) && canRoleEditCurrentWorkflow;
                          return (
                            <div key={checklistQ.id} className="overflow-x-auto">
                              {checklistQs.length > 1 && <div className="font-semibold text-sm mb-2">{checklistQ.label}</div>}
                              <table className="w-full border-collapse border border-black text-sm">
                                <thead>
                                  <tr>
                                    <th className="bg-[#5E5E5E] text-white font-bold p-2 text-center border border-black w-[48px]" rowSpan={2}></th>
                                    <th className="bg-[#5E5E5E] text-white font-bold p-2 text-left border border-black" rowSpan={2}>Written Evidence</th>
                                    <th className="bg-[#5E5E5E] text-white font-bold p-2 text-center border border-black" colSpan={2}>Submitted</th>
                                  </tr>
                                  <tr>
                                    <th className="bg-[#5E5E5E] text-white font-bold p-2 text-center border border-black w-[70px]">Yes</th>
                                    <th className="bg-[#5E5E5E] text-white font-bold p-2 text-center border border-black w-[70px]">No</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {checklistQ.rows.map((row, idx) => {
                                    const key = getAnswerKey(checklistQ.id, row.id);
                                    const raw = answers[key];
                                    const val = typeof raw === 'string' ? raw : '';
                                    const yes = val === 'yes';
                                    const no = val === 'no';
                                    return (
                                      <tr key={row.id}>
                                        <td className="p-2 text-center border border-black">{idx + 1}</td>
                                        <td className="p-2 border border-black">{row.row_label}</td>
                                        <td className="p-2 text-center border border-black">
                                          <input
                                            type="radio"
                                            name={`written-check-${row.id}`}
                                            checked={yes}
                                            onChange={() => handleAnswerChange(checklistQ.id, row.id, yes ? '' : 'yes')}
                                            disabled={!editable}
                                            className="w-4 h-4 accent-black"
                                          />
                                        </td>
                                        <td className="p-2 text-center border border-black">
                                          <input
                                            type="radio"
                                            name={`written-check-${row.id}`}
                                            checked={no}
                                            onChange={() => handleAnswerChange(checklistQ.id, row.id, no ? '' : 'no')}
                                            disabled={!editable}
                                            className="w-4 h-4 accent-black"
                                          />
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          );
                          };
                          return <div className="space-y-6">{checklistQs.map(renderChecklistQ)}</div>;
                        })()
                      ) : section.pdf_render_mode === 'task_marking_checklist' ? (
                        (() => {
                          const evidenceQ = section.questions.find((q) => q.code === 'assessment.marking.evidence_outcome' && q.type === 'single_choice' && (q.rows?.length ?? 0) > 0);
                          const perfQ = section.questions.find((q) => q.code === 'assessment.marking.performance_outcome' && q.type === 'single_choice' && (q.rows?.length ?? 0) > 0);
                          if (!evidenceQ && !perfQ) return null;
                          const re = { student: false, trainer: true, office: true };
                          const editable = isQuestionEditableForRole(re) && canRoleEditCurrentWorkflow;
                          const renderChecklistTable = (checklistQ: typeof evidenceQ, title: string, questionText: string) => {
                            if (!checklistQ || !checklistQ.rows?.length) return null;
                            const setAll = (v: 'yes' | 'no') => {
                              if (!editable) return;
                              for (const r of checklistQ.rows) {
                                handleAnswerChange(checklistQ.id, r.id, v);
                              }
                            };
                            return (
                              <div key={checklistQ.id} className="mt-6 overflow-x-auto">
                                <div className="bg-[#5E5E5E] text-white font-bold px-4 py-2 flex items-center justify-between gap-3">
                                  <span>{title}</span>
                                  <div className="flex items-center gap-2">
                                    <button
                                      type="button"
                                      className="text-xs font-semibold bg-white/10 hover:bg-white/15 border border-white/20 rounded px-2 py-1 disabled:opacity-50 disabled:cursor-not-allowed"
                                      onClick={() => setAll('yes')}
                                      disabled={!editable}
                                      title="Mark all rows as Yes"
                                    >
                                      All Yes
                                    </button>
                                    <button
                                      type="button"
                                      className="text-xs font-semibold bg-white/10 hover:bg-white/15 border border-white/20 rounded px-2 py-1 disabled:opacity-50 disabled:cursor-not-allowed"
                                      onClick={() => setAll('no')}
                                      disabled={!editable}
                                      title="Mark all rows as No"
                                    >
                                      All No
                                    </button>
                                  </div>
                                </div>
                                <p className="text-sm text-gray-700 py-2">{questionText}</p>
                                <table className="w-full border-collapse border border-black text-sm">
                                  <thead>
                                    <tr>
                                      <th className="bg-[#5E5E5E] text-white font-bold p-2 text-center border border-black w-[48px]" rowSpan={2}></th>
                                      <th className="bg-[#5E5E5E] text-white font-bold p-2 text-left border border-black" rowSpan={2}>Criteria</th>
                                      <th className="bg-[#5E5E5E] text-white font-bold p-2 text-center border border-black" colSpan={2}>SATISFACTORY</th>
                                    </tr>
                                    <tr>
                                      <th className="bg-[#5E5E5E] text-white font-bold p-2 text-center border border-black w-[70px]">Yes</th>
                                      <th className="bg-[#5E5E5E] text-white font-bold p-2 text-center border border-black w-[70px]">No</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {checklistQ.rows.map((row, idx) => {
                                      const key = getAnswerKey(checklistQ.id, row.id);
                                      const raw = answers[key];
                                      const val = typeof raw === 'string' ? raw : '';
                                      const yes = val === 'yes';
                                      const no = val === 'no';
                                      return (
                                        <tr key={row.id}>
                                          <td className="p-2 text-center border border-black">{idx + 1}</td>
                                          <td className="p-2 border border-black">{row.row_label}</td>
                                          <td className="p-2 text-center border border-black">
                                            <input type="radio" name={`marking-${checklistQ.id}-${row.id}`} checked={yes} onChange={() => handleAnswerChange(checklistQ.id, row.id, yes ? '' : 'yes')} disabled={!editable} className="w-4 h-4 accent-black" />
                                          </td>
                                          <td className="p-2 text-center border border-black">
                                            <input type="radio" name={`marking-${checklistQ.id}-${row.id}`} checked={no} onChange={() => handleAnswerChange(checklistQ.id, row.id, no ? '' : 'no')} disabled={!editable} className="w-4 h-4 accent-black" />
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            );
                          };
                          return (
                            <div className="border border-gray-300 rounded-lg overflow-hidden bg-white">
                              <div className="bg-[#5E5E5E] text-white font-bold px-4 py-3">ASSESSMENT MARKING CHECKLIST</div>
                              <div className="p-4 space-y-4">
                                {evidenceQ && renderChecklistTable(evidenceQ, 'EVIDENCE OUTCOME', 'Did the candidate complete and submit the following while being observed?')}
                                {perfQ && renderChecklistTable(perfQ, 'PERFORMANCE OUTCOME', 'Did the candidate provide answers to the following questions with the required length and breadth consistently applying knowledge of vocational environment?')}
                              </div>
                            </div>
                          );
                        })()
                      ) : section.pdf_render_mode === 'assessment_submission' ? (
                        <div className="border border-black p-3 sm:p-4 bg-white min-w-0">
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
                            {section.questions
                              .filter((q) => isRoleVisible((q.role_visibility as Record<string, boolean>) || {}, role))
                              .map((q) =>
                                q.type === 'multi_choice' ? (
                                  <React.Fragment key={q.id}>
                                    {q.options?.map((opt) => {
                                      const isLms = /lms|learning management/i.test(opt.label);
                                      const isOther = opt.value === 'other';
                                      const spanFull = isLms || isOther;
                                      const rawVal = answers[getAnswerKey(q.id, null)];
                                      const currentArr = Array.isArray(rawVal) ? rawVal : (typeof rawVal === 'string' ? rawVal.split(',').map((s) => s.trim()).filter(Boolean) : []);
                                      const selected = currentArr.includes(opt.value);
                                      const submissionEditable = canRoleEditCurrentWorkflow;
                                      return (
                                        <label
                                          key={opt.id}
                                          className={`flex items-center gap-2 cursor-pointer ${spanFull ? 'sm:col-span-2' : ''} ${!submissionEditable ? 'opacity-60 cursor-not-allowed' : ''}`}
                                        >
                                          <input
                                            type="checkbox"
                                            checked={selected}
                                            onChange={() => {
                                              const next = selected
                                                ? currentArr.filter((v) => v !== opt.value)
                                                : [...currentArr, opt.value];
                                              handleAnswerChange(q.id, null, next);
                                            }}
                                            disabled={!submissionEditable}
                                            className="w-[18px] h-[18px] flex-shrink-0 cursor-pointer accent-black"
                                          />
                                          <span className="text-gray-700">{opt.label}</span>
                                          {isOther && (
                                            <span className="flex-1 border-b border-gray-600 min-w-[120px] min-h-[18px]" />
                                          )}
                                        </label>
                                      );
                                    })}
                                  </React.Fragment>
                                ) : q.type === 'short_text' ? (
                                  <div key={q.id} className="sm:col-span-2 mt-2 text-center">
                                    <input
                                      type="text"
                                      value={(answers[getAnswerKey(q.id, null)] as string) ?? ''}
                                      onChange={(e) => handleAnswerChange(q.id, null, e.target.value)}
                                      disabled={!canRoleEditCurrentWorkflow}
                                      className="w-full max-w-[300px] mx-auto border-0 border-b border-gray-600 bg-transparent px-2 py-1 text-center focus:outline-none focus:ring-0"
                                      placeholder=""
                                    />
                                    <div className="text-xs italic text-gray-500 mt-1">(Please describe here)</div>
                                  </div>
                                ) : null
                              )}
                          </div>
                        </div>
                      ) : section.pdf_render_mode === 'additional_instructions' ? (
                        (() => {
                          const instr = (section as unknown as { instructions_meta?: Record<string, unknown> | null }).instructions_meta as Record<string, unknown> | null | undefined;
                          if (!instr) return <div className="text-gray-500 italic">No additional instructions configured.</div>;
                          const customBlocks = Array.isArray((instr as { blocks?: unknown[] }).blocks)
                            ? ((instr as { blocks?: Array<{ id?: string; type?: string; heading?: string; content?: string; imageUrl?: string; imageFullWidth?: boolean; imageLayout?: 'above' | 'below' | 'side_by_side'; imageSide?: 'left' | 'right'; columnHeaders?: string[]; rows?: Array<{ heading?: string; content?: string; cells?: string[] }> }> }).blocks || [])
                            : [];
                          return (
                            <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
                              <div className="bg-[#5E5E5E] text-white font-bold px-4 py-3">
                                {section.title || 'Additional Instructions'}
                              </div>
                              <div className="p-4 space-y-4">
                                {customBlocks.length > 0 ? (
                                  customBlocks.map((b, idx) => {
                                    const heading = String(b.heading || '').trim();
                                    const imgUrl = String((b as { imageUrl?: string }).imageUrl || '').trim();
                                    const imageFullWidth = Boolean((b as { imageFullWidth?: boolean }).imageFullWidth);
                                    const imageLayout = String((b as { imageLayout?: string }).imageLayout || 'side_by_side') as 'above' | 'below' | 'side_by_side';
                                    const imageSide = (String((b as { imageSide?: string }).imageSide || 'right') as 'left' | 'right');
                                    const imgEl = imgUrl ? (
                                      <img
                                        src={imgUrl}
                                        alt=""
                                        className="max-w-full h-auto object-contain rounded border border-gray-200"
                                        style={{ maxHeight: imageFullWidth ? 520 : 280, width: imageFullWidth ? '100%' : undefined }}
                                      />
                                    ) : null;
                                    const withImage = (content: React.ReactNode) => {
                                      if (!imgEl) return content;
                                      if (imageFullWidth || imageLayout === 'above') {
                                        return <div><div className="mb-2">{imgEl}</div>{content}</div>;
                                      }
                                      if (imageLayout === 'below') {
                                        return <div>{content}<div className="mt-2">{imgEl}</div></div>;
                                      }
                                      // side_by_side
                                      const left = imageSide === 'left';
                                      return (
                                        <div className="flex flex-col sm:flex-row gap-3 items-start">
                                          {left ? <div className="sm:w-[40%] w-full shrink-0">{imgEl}</div> : null}
                                          <div className="flex-1 min-w-0">{content}</div>
                                          {!left ? <div className="sm:w-[40%] w-full shrink-0">{imgEl}</div> : null}
                                        </div>
                                      );
                                    };
                                    if (b.type === 'table') {
                                      const rows = Array.isArray(b.rows) ? b.rows : [];
                                      const columnHeaders = Array.isArray(b.columnHeaders) ? b.columnHeaders : [];
                                      return (
                                        <div key={String(b.id || idx)} className="border border-gray-200 rounded overflow-hidden">
                                          {heading ? <div className="bg-gray-600 text-white font-semibold text-sm px-3 py-2">{heading}</div> : null}
                                          <div className="overflow-x-auto">
                                            {withImage(
                                              <table className="w-full table-fixed border-collapse text-sm">
                                              {columnHeaders.length > 0 ? (
                                                <thead>
                                                  <tr className="bg-gray-200">
                                                    {columnHeaders.map((h, hi) => (
                                                      <th key={hi} className="border border-gray-300 p-2 text-left font-semibold text-gray-700 whitespace-normal break-normal align-top">
                                                        {h}
                                                      </th>
                                                    ))}
                                                  </tr>
                                                </thead>
                                              ) : null}
                                              <tbody>
                                                {rows.map((r, ri) => {
                                                  const cells = (r as { cells?: string[] }).cells;
                                                  const isMultiCol = Array.isArray(cells) && cells.length > 0;
                                                  return (
                                                    <tr key={ri} className={ri % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                                                      {isMultiCol ? (
                                                        cells.map((cell, ci) => (
                                                          <td key={ci} className="border border-gray-300 p-2 whitespace-normal break-normal align-top">
                                                            <div className="[overflow-wrap:break-word]">
                                                              <div lang="en" className="prose prose-sm max-w-none whitespace-normal break-normal" dangerouslySetInnerHTML={{ __html: normalizeRichTextForPage(String(cell || '')) }} />
                                                            </div>
                                                          </td>
                                                        ))
                                                      ) : (
                                                        <>
                                                          <td className="border border-gray-300 p-2 align-top font-semibold w-[24%] whitespace-normal break-normal">{String((r as { heading?: string }).heading || '')}</td>
                                                          <td className="border border-gray-300 border-r p-2 align-top w-[76%] whitespace-normal break-normal">
                                                            <div className="[overflow-wrap:break-word]">
                                                              <div lang="en" className="prose prose-sm max-w-none whitespace-normal break-normal" dangerouslySetInnerHTML={{ __html: normalizeRichTextForPage(String((r as { content?: string }).content || '')) }} />
                                                            </div>
                                                          </td>
                                                        </>
                                                      )}
                                                    </tr>
                                                  );
                                                })}
                                              </tbody>
                                            </table>
                                            )}
                                          </div>
                                        </div>
                                      );
                                    }
                                    const content = String(b.content || '');
                                    const hasText = !!content.replace(/<[^>]*>/g, '').trim();
                                    const hasImg = !!imgUrl;
                                    if (!hasText && !hasImg) return null;
                                    return (
                                      <div key={String(b.id || idx)} className="border border-gray-200 rounded overflow-hidden">
                                        {heading ? <div className="bg-gray-600 text-white font-semibold text-sm px-3 py-2">{heading}</div> : null}
                                        <div className="border-t border-gray-200 p-3 bg-gray-50">
                                          {withImage(
                                            hasText ? (
                                              <div className="overflow-x-hidden">
                                                <div
                                                  lang="en"
                                                  className="prose prose-sm max-w-none whitespace-normal break-normal [word-break:normal] [hyphens:none] [&_table]:w-full [&_table]:table-fixed [&_table]:border-collapse [&_th]:whitespace-normal [&_th]:break-normal [&_th]:align-top [&_td]:whitespace-normal [&_td]:break-normal [&_td]:align-top [&_td>div]:[overflow-wrap:break-word] [&_td>p]:[overflow-wrap:break-word] [&_td>span]:[overflow-wrap:break-word]"
                                                  dangerouslySetInnerHTML={{ __html: normalizeRichTextForPage(String(content || '')) }}
                                                />
                                              </div>
                                            ) : (
                                              <div />
                                            )
                                          )}
                                        </div>
                                      </div>
                                    );
                                  })
                                ) : (
                                  <div className="text-gray-500 italic">No instruction blocks.</div>
                                )}
                              </div>
                            </div>
                          );
                        })()
                      ) : section.pdf_render_mode === 'task_instructions' ? (
                        (() => {
                          const taskRow = (section as { taskRow?: { row_label: string; row_help: string | null; row_meta?: { instructions?: Record<string, string | string[]> } } }).taskRow;
                          const instr = taskRow?.row_meta?.instructions;
                          if (!instr) return <div className="text-gray-500 italic">No instructions configured for this task.</div>;
                          const customBlocks = Array.isArray((instr as { blocks?: unknown[] }).blocks)
                            ? ((instr as { blocks?: Array<{ id?: string; type?: string; heading?: string; content?: string; imageUrl?: string; imageFullWidth?: boolean; imageLayout?: 'above' | 'below' | 'side_by_side'; imageSide?: 'left' | 'right'; columnHeaders?: string[]; rows?: Array<{ heading?: string; content?: string; cells?: string[] }> }> }).blocks || [])
                            : [];
                          const sanitizeInstructionHtml = (html: string) => {
                            // Normalize HTML that may contain hidden word-break hints (soft hyphens, zero-width spaces, <wbr>, etc.)
                            // so words wrap cleanly like the PDF output.
                            return String(html || '')
                              .replace(/\u00ad/g, '') // soft hyphen char
                              .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, '') // zero-width spaces/joiners
                              .replace(/&shy;/gi, '') // soft hyphen entity
                              .replace(/&ZeroWidthSpace;|&#8203;|&#x200B;/gi, '') // zero-width space entities
                              .replace(/<wbr\s*\/?>/gi, '') // word break tag
                              .replace(/-\s*<br\s*\/?>/gi, '') // hyphen + line break
                              .replace(/-\s*\r?\n\s*/g, '') // hyphen + newline
                              // Remove explicit breaks inside a word, but only when between letters.
                              .replace(/([A-Za-z])\s*<br\s*\/?>\s*([A-Za-z])/gi, '$1$2')
                              .replace(/([A-Za-z])\s*\r?\n\s*([A-Za-z])/g, '$1$2');
                          };
                          if (customBlocks.length > 0) {
                            const instrTyped = instr as { assessment_type?: string };
                            return (
                              <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
                                <div className="bg-[#5E5E5E] text-white font-bold px-4 py-3">
                                  Student Instructions: {taskRow?.row_label || section.title}
                                </div>
                                <div className="p-4 space-y-4">
                                  {instrTyped.assessment_type && (
                                    <div>
                                      <div className="bg-gray-600 text-white font-semibold text-sm px-3 py-2 rounded-t">Assessment type</div>
                                      <div className="border border-gray-200 border-t-0 rounded-b p-3 bg-gray-50 prose prose-sm max-w-none whitespace-pre-line">{instrTyped.assessment_type}</div>
                                    </div>
                                  )}
                                  {customBlocks.map((b, idx) => (
                                    <div key={String(b.id || idx)}>
                                      {b.type === 'table' && !!String(b.heading || '').trim() && (
                                        <div className="bg-gray-600 text-white font-semibold text-sm px-3 py-2 rounded-t">{String(b.heading)}</div>
                                      )}
                                      {b.type === 'table' ? (
                                        <div className={`border border-gray-200 ${String(b.heading || '').trim() ? 'border-t-0 rounded-b' : 'rounded'} overflow-x-hidden`}>
                                          <table className="w-full table-fixed border-collapse text-sm">
                                            {Array.isArray(b.columnHeaders) && b.columnHeaders.length > 0 && (
                                              <thead>
                                                <tr className="bg-gray-200">
                                                  {b.columnHeaders.map((h, hi) => (
                                                    <th key={hi} className="border border-gray-300 p-2 text-left font-semibold text-gray-700 whitespace-normal break-normal align-top">
                                                      {h}
                                                    </th>
                                                  ))}
                                                </tr>
                                              </thead>
                                            )}
                                            <tbody>
                                              {(Array.isArray(b.rows) ? b.rows : []).map((r, ri) => {
                                                const cells = r.cells;
                                                const isMultiCol = Array.isArray(cells) && cells.length > 0;
                                                return (
                                                  <tr key={ri} className={ri % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                                                    {isMultiCol ? (
                                                      cells.map((cell, ci) => (
                                                        <td key={ci} className="border border-gray-300 p-2 whitespace-normal break-normal align-top">
                                                          <div className="[overflow-wrap:break-word]">
                                                            <div lang="en" className="prose prose-sm max-w-none whitespace-normal break-normal" dangerouslySetInnerHTML={{ __html: normalizeRichTextForPage(sanitizeInstructionHtml(String(cell || '')).replace(/\n/g, '<br/>')) }} />
                                                          </div>
                                                        </td>
                                                      ))
                                                    ) : (
                                                      <>
                                                        <td className="border border-gray-300 p-2 align-top font-semibold w-[24%] whitespace-normal break-normal">{String(r.heading || '')}</td>
                                                        <td className="border border-gray-300 border-r p-2 align-top w-[76%] whitespace-normal break-normal">
                                                          <div className="[overflow-wrap:break-word]">
                                                            <div lang="en" className="prose prose-sm max-w-none whitespace-normal break-normal" dangerouslySetInnerHTML={{ __html: normalizeRichTextForPage(sanitizeInstructionHtml(String(r.content || ''))) }} />
                                                          </div>
                                                        </td>
                                                      </>
                                                    )}
                                                  </tr>
                                                );
                                              })}
                                            </tbody>
                                          </table>
                                          {(() => {
                                            const imgUrl = String((b as { imageUrl?: string }).imageUrl || '').trim();
                                            if (!imgUrl) return null;
                                            const imageFullWidth = Boolean((b as { imageFullWidth?: boolean }).imageFullWidth);
                                            const imageLayout = String((b as { imageLayout?: string }).imageLayout || 'below') as 'above' | 'below' | 'side_by_side';
                                            const imgEl = (
                                              <img
                                                src={imgUrl}
                                                alt=""
                                                className="max-w-full h-auto object-contain rounded border border-gray-200"
                                                style={{ maxHeight: imageFullWidth ? 520 : 280, width: imageFullWidth ? '100%' : undefined }}
                                              />
                                            );
                                            // For tables, always render image below to keep layout stable.
                                            if (imageFullWidth || imageLayout === 'above' || imageLayout === 'side_by_side') return <div className="p-3 pt-2">{imgEl}</div>;
                                            return <div className="p-3 pt-2">{imgEl}</div>;
                                          })()}
                                        </div>
                                      ) : (
                                        <div className="overflow-x-hidden">
                                          <div
                                            lang="en"
                                            className="prose prose-sm max-w-none whitespace-normal break-normal [word-break:normal] [hyphens:none] [&_table]:w-full [&_table]:table-fixed [&_table]:border-collapse [&_th]:whitespace-normal [&_th]:break-normal [&_th]:align-top [&_th]:[word-break:normal] [&_th]:[hyphens:none] [&_td]:whitespace-normal [&_td]:break-normal [&_td]:align-top [&_td]:[word-break:normal] [&_td]:[hyphens:none] [&_td>div]:[overflow-wrap:break-word] [&_td>p]:[overflow-wrap:break-word] [&_td>span]:[overflow-wrap:break-word]"
                                            dangerouslySetInnerHTML={{ __html: normalizeRichTextForPage(sanitizeInstructionHtml(String(b.content || ''))) }}
                                          />
                                          {(() => {
                                            const imgUrl = String((b as { imageUrl?: string }).imageUrl || '').trim();
                                            if (!imgUrl) return null;
                                            const imageFullWidth = Boolean((b as { imageFullWidth?: boolean }).imageFullWidth);
                                            const imageLayout = String((b as { imageLayout?: string }).imageLayout || 'below') as 'above' | 'below' | 'side_by_side';
                                            const imageSide = (String((b as { imageSide?: string }).imageSide || 'right') as 'left' | 'right');
                                            const imgEl = (
                                              <img
                                                src={imgUrl}
                                                alt=""
                                                className="max-w-full h-auto object-contain rounded border border-gray-200"
                                                style={{ maxHeight: imageFullWidth ? 520 : 280, width: imageFullWidth ? '100%' : undefined }}
                                              />
                                            );
                                            if (imageFullWidth || imageLayout === 'above') return <div className="mt-2">{imgEl}</div>;
                                            if (imageLayout === 'below') return <div className="mt-2">{imgEl}</div>;
                                            const left = imageSide === 'left';
                                            return (
                                              <div className="mt-2 flex flex-col sm:flex-row gap-3 items-start">
                                                {left ? <div className="sm:w-[40%] w-full shrink-0">{imgEl}</div> : null}
                                                <div className="flex-1 min-w-0" />
                                                {!left ? <div className="sm:w-[40%] w-full shrink-0">{imgEl}</div> : null}
                                              </div>
                                            );
                                          })()}
                                        </div>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            );
                          }
                          const escapeAndNlToBr = (s: string) =>
                            String(s || '')
                              .replace(/&/g, '&amp;')
                              .replace(/</g, '&lt;')
                              .replace(/>/g, '&gt;')
                              .replace(/\n/g, '<br/>');
                          const blocks: { title: string; content: string }[] = [
                            { title: 'Assessment type', content: escapeAndNlToBr(String(instr.assessment_type || '')) },
                            { title: 'Instructions provided to the student:', content: String(instr.task_description || '') },
                            { title: 'Applicable conditions:', content: String(instr.applicable_conditions || '') },
                            { title: 'Resubmissions and reattempts:', content: String(instr.resubmissions || '') },
                            { title: 'Location:', content: String(instr.location_intro || '') + (Array.isArray(instr.location_options) ? '<ul><li>' + instr.location_options.join('</li><li>') + '</li></ul>' : '') + String(instr.location_note || '') },
                            { title: 'Instructions for answering the written questions:', content: String(instr.answering_instructions || '') },
                            { title: 'Purpose of the assessment', content: String(instr.purpose_intro || '') + String(instr.purpose_bullets || '') },
                            { title: 'Task instructions', content: String(instr.task_instructions || '') },
                          ];
                          return (
                            <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
                              <div className="bg-[#5E5E5E] text-white font-bold px-4 py-3">
                                Student Instructions: {taskRow?.row_label || section.title}
                              </div>
                              <div className="p-4 space-y-4">
                                {blocks.filter((b) => b.content.replace(/<[^>]*>/g, '').trim()).map((b, i) => (
                                  <div key={i}>
                                    <div className="bg-gray-600 text-white font-semibold text-sm px-3 py-2 rounded-t">{b.title}</div>
                                    <div className="border border-gray-200 border-t-0 rounded-b p-3 bg-gray-50">
                                      <div className="overflow-x-hidden">
                                        <div
                                          lang="en"
                                          className="prose prose-sm max-w-none whitespace-normal break-normal [word-break:normal] [hyphens:none] [&_table]:w-full [&_table]:table-fixed [&_table]:border-collapse [&_th]:whitespace-normal [&_th]:break-normal [&_th]:align-top [&_th]:[word-break:normal] [&_th]:[hyphens:none] [&_td]:whitespace-normal [&_td]:break-normal [&_td]:align-top [&_td]:[word-break:normal] [&_td]:[hyphens:none] [&_td>div]:[overflow-wrap:break-word] [&_td>p]:[overflow-wrap:break-word] [&_td>span]:[overflow-wrap:break-word]"
                                          dangerouslySetInnerHTML={{ __html: normalizeRichTextForPage(sanitizeInstructionHtml(b.content)) }}
                                        />
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })()
                      ) : section.pdf_render_mode === 'task_questions' ? (
                        (() => {
                          const taskRowsOrderedForQuestions: { id: number }[] = [];
                          for (const step of template?.steps || []) {
                            for (const sec of step.sections) {
                              if (sec.pdf_render_mode === 'assessment_tasks') {
                                const taskQ = sec.questions.find((q) => q.type === 'grid_table' && q.rows.length > 0);
                                if (taskQ) for (const r of taskQ.rows) taskRowsOrderedForQuestions.push({ id: r.id });
                              }
                            }
                          }
                          const taskRowId = (section as { assessment_task_row_id?: number | null }).assessment_task_row_id;
                          const assessmentTaskIndex = taskRowId ? taskRowsOrderedForQuestions.findIndex((r) => r.id === taskRowId) + 1 : 1;
                          const isAssessment2Plus = assessmentTaskIndex >= 2;
                          const taskQNumbers = getTaskQuestionDisplayNumbers(section.questions);

                          if (isAssessment2Plus) {
                            return (
                              <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
                                <div className="bg-[#5E5E5E] text-white font-bold px-4 py-3">
                                  {section.title}
                                </div>
                                <div className="bg-[#6b7280] text-white text-sm px-4 py-2">
                                  Provide your response to each question in the box below.
                                </div>
                                <div className="p-4 space-y-6">
                                  {section.questions
                                    .filter((q) => q.type !== 'page_break' && !(q.pdf_meta as Record<string, unknown>)?.isAdditionalBlockOf && isRoleVisible((q.role_visibility as Record<string, boolean>) || {}, role))
                                    .map((q) => {
                                      if (q.type === 'instruction_block') {
                                        const instr = getQuestionInstructionsData(q.pdf_meta);
                                        return (
                                          <div key={q.id}>
                                            {instr ? (
                                              <TaskInstructionsBlocksDisplay instructions={instr} />
                                            ) : (
                                              <QuestionRenderer question={q} value={null} onChange={() => {}} disabled />
                                            )}
                                          </div>
                                        );
                                      }
                                      const re = (q.role_editability as Record<string, boolean>) || {};
                                      const baseEditable = isQuestionEditableForRole(re) && canRoleEditCurrentWorkflow;
                                      const editable = baseEditable && !isQuestionReadOnlyByTrainer(q.id);
                                      const trainerEditable = role === 'trainer' || role === 'office';
                                      const pm = (q.pdf_meta as Record<string, unknown>) || {};
                                      const textAboveHeader = String(pm.textAboveHeader ?? '').trim();
                                      const legacyAb = pm.additionalBlock as Record<string, unknown> | undefined;
                                      const contentBlocks: Array<{ type: string; content?: string; questionId?: number; headerText?: string; imageUrl?: string; imageLayout?: string; imageWidthPercent?: number }> = Array.isArray(pm.contentBlocks)
                                        ? (pm.contentBlocks as Array<{ type: string; content?: string; questionId?: number; headerText?: string; imageUrl?: string; imageLayout?: string; imageWidthPercent?: number }>)
                                        : legacyAb ? [{ type: String(legacyAb.type ?? 'instruction_block'), content: legacyAb.content as string | undefined, questionId: legacyAb.questionId as number | undefined }] : [];
                                      const wrapWithHeader = (key: string, headerText: string | undefined, content: React.ReactNode) => (
                                        <div key={key} className="mt-3">
                                          {headerText && <div className="font-bold text-gray-900 mb-2">{headerText}</div>}
                                          {content}
                                        </div>
                                      );
                                      const renderBlock = (block: { type: string; content?: string; questionId?: number; headerText?: string; imageUrl?: string; imageLayout?: string; imageWidthPercent?: number; imageFullWidth?: boolean }, key: string) => {
                                        if (block.type === 'instruction_block' && (block.content || (block as { imageUrl?: string }).imageUrl)) {
                                            const content = block.content ? (
                                              <div className="overflow-x-hidden">
                                                <div
                                                  className="text-sm text-gray-700 prose prose-sm max-w-none whitespace-normal break-normal [word-break:normal] [hyphens:none] [&_table]:w-full [&_table]:table-fixed [&_table]:border-collapse [&_th]:whitespace-normal [&_th]:break-normal [&_th]:align-top [&_th]:[word-break:normal] [&_th]:[hyphens:none] [&_td]:whitespace-normal [&_td]:break-normal [&_td]:align-top [&_td]:[word-break:normal] [&_td]:[hyphens:none] [&_td>div]:[overflow-wrap:break-word] [&_td>p]:[overflow-wrap:break-word] [&_td>span]:[overflow-wrap:break-word]"
                                                  dangerouslySetInnerHTML={{ __html: normalizeRichTextForPage(sanitizeInstructionHtml(String(block.content))) }}
                                                />
                                              </div>
                                            ) : null;
                                          const imgUrl = (block as { imageUrl?: string }).imageUrl;
                                          const full = !!(block as { imageFullWidth?: boolean }).imageFullWidth;
                                          const layout = full ? 'above' : ((block as { imageLayout?: string }).imageLayout || 'side_by_side');
                                          const pct = Math.max(20, Math.min(80, (block as { imageWidthPercent?: number }).imageWidthPercent || 50));
                                          const imgEl = imgUrl ? <img src={imgUrl} alt="" className="max-w-full h-auto object-contain rounded border border-gray-200" style={{ maxHeight: full ? 520 : 280, width: full ? '100%' : undefined, display: full ? 'block' : undefined, margin: full ? '0 auto' : undefined }} /> : null;
                                          let blockContent: React.ReactNode;
                                          if (!imgEl) blockContent = content;
                                          else if (layout === 'above') blockContent = <div><div className="mb-2">{imgEl}</div>{content}</div>;
                                          else if (layout === 'below') blockContent = <div>{content}<div className="mt-2">{imgEl}</div></div>;
                                          else blockContent = (
                                            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                                              <div className="order-2 min-w-0 flex-1 sm:order-1">{content}</div>
                                              <div
                                                className="order-1 w-full max-w-full shrink-0 sm:order-2 sm:w-[var(--side-img-pct)] sm:max-w-[min(100%,var(--side-img-pct))]"
                                                style={{ ['--side-img-pct' as string]: `${pct}%` } as React.CSSProperties}
                                              >
                                                {imgEl}
                                              </div>
                                            </div>
                                          );
                                          return wrapWithHeader(key, block.headerText, blockContent);
                                        }
                                        if (block.type === 'image' && block.imageUrl) {
                                          const imgUrl = block.imageUrl;
                                          const layout = block.imageFullWidth ? 'above' : (block.imageLayout || 'above');
                                          const pct = Math.max(20, Math.min(80, block.imageWidthPercent || 50));
                                          const imgEl = (
                                            <img
                                              src={imgUrl}
                                              alt=""
                                              className="max-w-full h-auto object-contain rounded border border-gray-200"
                                              style={{
                                                maxHeight: 280,
                                                width: block.imageFullWidth ? '100%' : undefined,
                                                display: block.imageFullWidth ? 'block' : undefined,
                                                margin: block.imageFullWidth ? '0 auto' : undefined,
                                              }}
                                            />
                                          );
                                          let blockContent: React.ReactNode;
                                          if (layout === 'above') blockContent = <div className="mb-2">{imgEl}</div>;
                                          else if (layout === 'below') blockContent = <div className="mt-2">{imgEl}</div>;
                                          else
                                            blockContent = (
                                              <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                                                <div className="order-2 min-w-0 flex-1 sm:order-1" />
                                                <div
                                                  className="order-1 w-full max-w-full shrink-0 sm:order-2 sm:w-[var(--side-img-pct)] sm:max-w-[min(100%,var(--side-img-pct))]"
                                                  style={{ ['--side-img-pct' as string]: `${pct}%` } as React.CSSProperties}
                                                >
                                                  {imgEl}
                                                </div>
                                              </div>
                                            );
                                          return wrapWithHeader(key, block.headerText, blockContent);
                                        }
                                        const childQ = block.questionId ? section.questions.find((x) => x.id === block.questionId) : null;
                                        if (!childQ) return null;
                                        if (block.type === 'grid_table' && childQ.rows?.length) {
                                          const merged = mergeGridTableAnswers(childQ, answers);
                                          const onGridChange = (v: string | number | boolean | Record<string, unknown> | string[]) => {
                                            const o = v as Record<string, string>;
                                            if (!o || typeof o !== 'object') return;
                                            const byRow = new Map<number, Record<string, string>>();
                                            for (const [k, val] of Object.entries(o)) {
                                              const match = /^r(\d+)_c/.exec(k);
                                              if (match) {
                                                const rowId = Number(match[1]);
                                                if (!byRow.has(rowId)) byRow.set(rowId, {});
                                                byRow.get(rowId)![k] = String(val);
                                              }
                                            }
                                            for (const [rowId, rowData] of byRow.entries()) {
                                              handleAnswerChange(childQ.id, rowId, rowData);
                                            }
                                          };
                                          const childSat = trainerAssessments[childQ.id];
                                          const childSatYes = childSat === 'yes';
                                          const childSatNo = childSat === 'no';
                                          return wrapWithHeader(key, block.headerText, (
                                            <div className="flex gap-2 items-start">
                                              <AnswerSaveStatusIcon status={questionSaveStatus[childQ.id]} />
                                              <div className="flex-1 min-w-0">
                                              <div className="mb-3 py-2 px-3 rounded bg-gray-50 border-b border-gray-200 flex flex-wrap items-center justify-end gap-2">
                                                <span className="text-sm font-semibold text-gray-700">Satisfactory response:</span>
                                                <button
                                                  type="button"
                                                  onClick={() => trainerEditable && handleTrainerAssessmentChange(childQ.id, 'yes')}
                                                  disabled={!trainerEditable}
                                                  className={`px-3 py-1.5 rounded-md border text-xs font-semibold ${
                                                    childSatYes
                                                      ? 'bg-emerald-100 border-emerald-600 text-emerald-900'
                                                      : 'border-gray-300 text-gray-600 hover:border-gray-500 hover:text-gray-800'
                                                  }`}
                                                >
                                                  Yes
                                                </button>
                                                <button
                                                  type="button"
                                                  onClick={() => trainerEditable && handleTrainerAssessmentChange(childQ.id, 'no')}
                                                  disabled={!trainerEditable}
                                                  className={`px-3 py-1.5 rounded-md border text-xs font-semibold ${
                                                    childSatNo
                                                      ? 'bg-rose-100 border-rose-600 text-rose-900'
                                                      : 'border-gray-300 text-gray-600 hover:border-gray-500 hover:text-gray-800'
                                                  }`}
                                                >
                                                  No
                                                </button>
                                              </div>
                                              <QuestionRenderer
                                                question={childQ}
                                                value={Object.keys(merged).length ? merged : null}
                                                onChange={onGridChange}
                                                disabled={!editable}
                                                error={errors[`q-${childQ.id}`]}
                                                highlightAsFill={editable}
                                                showRowAssessmentColumn={false}
                                                studentResubmissionReadOnlyForSatisfactoryRows={isResubmissionAfterTrainer}
                                              />
                                              </div>
                                            </div>
                                          ));
                                        }
                                        if (block.type === 'short_text' || block.type === 'long_text') {
                                          const val = answers[getAnswerKey(childQ.id, null)] as string | undefined;
                                          return wrapWithHeader(key, block.headerText, (
                                            <div className="flex gap-2 items-start">
                                              <AnswerSaveStatusIcon status={questionSaveStatus[childQ.id]} />
                                              <div className="flex-1 min-w-0">
                                                <QuestionRenderer instanceId={id} question={childQ} value={val ?? null} onChange={(v) => handleAnswerChange(childQ.id, null, v as string | number | boolean | Record<string, unknown> | string[])} disabled={!editable} error={errors[`q-${childQ.id}`]} highlightAsFill={editable} />
                                              </div>
                                            </div>
                                          ));
                                        }
                                        return null;
                                      };
                                      return (
                                        <div
                                          key={q.id}
                                          data-question-id={q.id}
                                          data-question-number={taskQNumbers.get(q.id) ?? undefined}
                                          className={`border border-gray-200 rounded-lg overflow-hidden ${
                                            errors[`q-${q.id}`] ? 'ring-2 ring-red-400 bg-red-50/40' : ''
                                          }`}
                                        >
                                          {errors[`q-${q.id}`] ? (
                                            <p className="bg-red-50 text-red-700 text-sm px-4 py-2 border-b border-red-200" role="alert">
                                              {errors[`q-${q.id}`]}
                                            </p>
                                          ) : null}
                                          <div className="bg-gray-100 font-semibold text-gray-800 px-4 py-2 border-b border-gray-200">
                                            {(() => {
                                              const qn = taskQNumbers.get(q.id);
                                              const inner = (() => {
                                                const qPm = (q.pdf_meta as Record<string, unknown>) || {};
                                                const imgUrl = qPm.imageUrl as string | undefined;
                                                const layout = (qPm.imageLayout as string) || 'side_by_side';
                                                const pct = Math.max(20, Math.min(80, (qPm.imageWidthPercent as number) || 50));
                                                const fullWidth = (qPm.imageFullWidth as boolean | undefined) === true;
                                                const imgEl = imgUrl ? (
                                                  <img
                                                    src={imgUrl}
                                                    alt=""
                                                    className="max-w-full h-auto object-contain rounded border border-gray-200"
                                                    style={{
                                                      maxHeight: fullWidth ? 520 : 280,
                                                      width: fullWidth ? '100%' : undefined,
                                                      display: fullWidth ? 'block' : undefined,
                                                      margin: fullWidth ? '0 auto' : undefined,
                                                    }}
                                                  />
                                                ) : null;
                                                if (!imgEl) return <>{q.label}</>;
                                                if (layout === 'above') return <><div className="mb-2">{imgEl}</div><div>{q.label}</div></>;
                                                if (layout === 'below') return <><div>{q.label}</div><div className="mt-2">{imgEl}</div></>;
                                                return (
                                                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                                                    <div className="order-2 min-w-0 flex-1 sm:order-1">{q.label}</div>
                                                    <div
                                                      className="order-1 w-full max-w-full shrink-0 sm:order-2 sm:w-[var(--side-img-pct)] sm:max-w-[min(100%,var(--side-img-pct))]"
                                                      style={{ ['--side-img-pct' as string]: `${pct}%` } as React.CSSProperties}
                                                    >
                                                      {imgEl}
                                                    </div>
                                                  </div>
                                                );
                                              })();
                                              return qn != null ? (
                                                <div className="flex gap-2 items-start">
                                                  <AnswerSaveStatusIcon status={questionSaveStatus[q.id]} />
                                                  <span className="font-semibold text-gray-900 shrink-0">Q{qn}:</span>
                                                  <div className="flex-1 min-w-0 font-semibold text-gray-800">{inner}</div>
                                                </div>
                                              ) : (
                                                <div className="flex gap-2 items-start">
                                                  <AnswerSaveStatusIcon status={questionSaveStatus[q.id]} />
                                                  <div className="flex-1 min-w-0 font-semibold text-gray-800">{inner}</div>
                                                </div>
                                              );
                                            })()}
                                          </div>
                                          <div className="p-4">
                                            {textAboveHeader && <div className="font-bold text-gray-900 mb-2">{textAboveHeader}</div>}
                                            {q.type === 'grid_table' && q.rows.length > 0 ? (
                                              (() => {
                                                const merged = mergeGridTableAnswers(q, answers);
                                                const onGridChange = (v: string | number | boolean | Record<string, unknown> | string[]) => {
                                                  const o = v as Record<string, string>;
                                                  if (!o || typeof o !== 'object') return;
                                                  // Only save rows that actually changed (GridTableQuestion emits the whole grid object on each keystroke).
                                                  const prevMerged: Record<string, string> = {};
                                                  for (const r of q.rows) {
                                                    const prev = answers[getAnswerKey(q.id, r.id)];
                                                    if (prev && typeof prev === 'object') Object.assign(prevMerged, prev as Record<string, string>);
                                                  }
                                                  const changedByRow = new Map<number, Record<string, string>>();
                                                  for (const [k, val] of Object.entries(o)) {
                                                    if (String(prevMerged[k] ?? '') === String(val ?? '')) continue;
                                                    const match = /^r(\d+)_c/.exec(k);
                                                    if (!match) continue;
                                                    const rowId = Number(match[1]);
                                                    if (!changedByRow.has(rowId)) changedByRow.set(rowId, {});
                                                    changedByRow.get(rowId)![k] = String(val ?? '');
                                                  }
                                                  for (const [rowId, patch] of changedByRow.entries()) {
                                                    const existing = answers[getAnswerKey(q.id, rowId)];
                                                    const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? (existing as Record<string, string>) : {};
                                                    handleAnswerChange(q.id, rowId, { ...base, ...patch });
                                                  }
                                                };
                                                const satQ = trainerAssessments[q.id];
                                                const satQYes = satQ === 'yes';
                                                const satQNo = satQ === 'no';
                                                return (
                                                  <div>
                                                    <div className="mb-3 py-2 px-3 rounded bg-gray-50 border-b border-gray-200 flex flex-wrap items-center justify-end gap-2">
                                                      <span className="text-sm font-semibold text-gray-700">Satisfactory response:</span>
                                                      <button
                                                        type="button"
                                                        onClick={() => trainerEditable && handleTrainerAssessmentChange(q.id, 'yes')}
                                                        disabled={!trainerEditable}
                                                        className={`px-3 py-1.5 rounded-md border text-xs font-semibold ${
                                                          satQYes
                                                            ? 'bg-emerald-100 border-emerald-600 text-emerald-900'
                                                            : 'border-gray-300 text-gray-600 hover:border-gray-500 hover:text-gray-800'
                                                        }`}
                                                      >
                                                        Yes
                                                      </button>
                                                      <button
                                                        type="button"
                                                        onClick={() => trainerEditable && handleTrainerAssessmentChange(q.id, 'no')}
                                                        disabled={!trainerEditable}
                                                        className={`px-3 py-1.5 rounded-md border text-xs font-semibold ${
                                                          satQNo
                                                            ? 'bg-rose-100 border-rose-600 text-rose-900'
                                                            : 'border-gray-300 text-gray-600 hover:border-gray-500 hover:text-gray-800'
                                                        }`}
                                                      >
                                                        No
                                                      </button>
                                                    </div>
                                                    <QuestionRenderer
                                                      question={q}
                                                      value={Object.keys(merged).length ? merged : null}
                                                      onChange={onGridChange}
                                                      disabled={!editable}
                                                      error={errors[`q-${q.id}`]}
                                                      highlightAsFill={editable}
                                                      showRowAssessmentColumn={false}
                                                      studentResubmissionReadOnlyForSatisfactoryRows={isResubmissionAfterTrainer}
                                                      hideQuestionLabel
                                                    />
                                                  </div>
                                                );
                                              })()
                                            ) : (
                                              <div>
                                                <div className="mb-3 py-2 px-3 rounded bg-gray-50 border-b border-gray-200 flex flex-wrap items-center justify-end gap-2">
                                                  <span className="text-sm font-semibold text-gray-700">Satisfactory response:</span>
                                                  <button
                                                    type="button"
                                                    onClick={() => trainerEditable && handleTrainerAssessmentChange(q.id, 'yes')}
                                                    disabled={!trainerEditable}
                                                    className={`px-3 py-1.5 rounded-md border text-xs font-semibold ${
                                                      trainerAssessments[q.id] === 'yes'
                                                        ? 'bg-emerald-100 border-emerald-600 text-emerald-900'
                                                        : 'border-gray-300 text-gray-600 hover:border-gray-500 hover:text-gray-800'
                                                    }`}
                                                  >
                                                    Yes
                                                  </button>
                                                  <button
                                                    type="button"
                                                    onClick={() => trainerEditable && handleTrainerAssessmentChange(q.id, 'no')}
                                                    disabled={!trainerEditable}
                                                    className={`px-3 py-1.5 rounded-md border text-xs font-semibold ${
                                                      trainerAssessments[q.id] === 'no'
                                                        ? 'bg-rose-100 border-rose-600 text-rose-900'
                                                        : 'border-gray-300 text-gray-600 hover:border-gray-500 hover:text-gray-800'
                                                    }`}
                                                  >
                                                    No
                                                  </button>
                                                </div>
                                                <QuestionRenderer instanceId={id} question={q} value={(answers[getAnswerKey(q.id, null)] as string | number | boolean | Record<string, unknown> | string[] | undefined) ?? null} onChange={(v) => handleAnswerChange(q.id, null, v as string | number | boolean | Record<string, unknown> | string[])} disabled={!editable} error={errors[`q-${q.id}`]} highlightAsFill={editable} />
                                              </div>
                                            )}
                                            {contentBlocks.map((block, bi) => renderBlock(block, String(block.questionId ?? `block-${bi}`)))}
                                          </div>
                                        </div>
                                      );
                                    })}
                                </div>
                              </div>
                            );
                          }

                          return (
                        <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
                          <div className="bg-[#5E5E5E] text-white font-bold px-4 py-3">
                            {section.title}
                          </div>
                          <div className="bg-[#6b7280] text-white text-sm px-4 py-2">
                            Provide your response to each question in the box below.
                          </div>
                          <div className="w-full overflow-x-auto">
                            <table className="w-full border-collapse text-sm table-fixed">
                              <thead>
                                <tr>
                                  <th className="bg-gray-200 font-semibold text-gray-700 p-3 border border-gray-300 text-left align-top" style={{ width: 'calc(100% - 9rem)' }}>
                                    Question
                                  </th>
                                  <th className="bg-gray-200 font-semibold text-gray-700 p-2 border border-gray-300 text-center align-top break-words" style={{ width: '9rem', minWidth: 0 }}>
                                    Satisfactory response
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {section.questions
                                  .filter((q) => q.type !== 'page_break' && !(q.pdf_meta as Record<string, unknown>)?.isAdditionalBlockOf && isRoleVisible((q.role_visibility as Record<string, boolean>) || {}, role))
                                  .map((q, qIdx) => {
                                    if (q.type === 'instruction_block') {
                                      const instr = getQuestionInstructionsData(q.pdf_meta);
                                      return (
                                        <tr key={q.id} className="bg-white">
                                          <td colSpan={2} className="p-4 border border-gray-300 align-top">
                                            {instr ? (
                                              <TaskInstructionsBlocksDisplay instructions={instr} />
                                            ) : (
                                              <QuestionRenderer question={q} value={null} onChange={() => {}} disabled />
                                            )}
                                          </td>
                                        </tr>
                                      );
                                    }
                                    const re = (q.role_editability as Record<string, boolean>) || {};
                                    const baseEditable = isQuestionEditableForRole(re) && canRoleEditCurrentWorkflow;
                                    const editable = baseEditable && !isQuestionReadOnlyByTrainer(q.id);
                                    const trainerEditable = role === 'trainer' || role === 'office';
                                    const sat = trainerAssessments[q.id];
                                    const satYes = sat === 'yes';
                                    const satNo = sat === 'no';
                                      return (
                                        <tr
                                          key={q.id}
                                          data-question-id={q.id}
                                          data-question-number={taskQNumbers.get(q.id) ?? undefined}
                                          className={`${qIdx % 2 === 0 ? 'bg-white' : 'bg-gray-50'} ${
                                            errors[`q-${q.id}`] ? 'ring-2 ring-inset ring-red-400' : ''
                                          }`}
                                        >
                                        <td className="p-3 border border-gray-300 align-top">
                                          {(() => {
                                            const pm = (q.pdf_meta as Record<string, unknown>) || {};
                                            const textAboveHeader = String(pm.textAboveHeader ?? '').trim();
                                            const legacyAb = pm.additionalBlock as Record<string, unknown> | undefined;
                                            const contentBlocks: Array<{ type: string; content?: string; questionId?: number; headerText?: string; imageUrl?: string; imageLayout?: string; imageWidthPercent?: number }> = Array.isArray(pm.contentBlocks)
                                              ? (pm.contentBlocks as Array<{ type: string; content?: string; questionId?: number; headerText?: string; imageUrl?: string; imageLayout?: string; imageWidthPercent?: number }>)
                                              : legacyAb ? [{
                                                  type: String(legacyAb.type ?? 'instruction_block'),
                                                  content: legacyAb.content as string | undefined,
                                                  questionId: legacyAb.questionId as number | undefined,
                                                }] : [];
                                            const wrapWithHeader = (key: string, headerText: string | undefined, content: React.ReactNode) => (
                                              <div key={key} className="mt-3">
                                                {headerText && <div className="font-bold text-gray-900 mb-2">{headerText}</div>}
                                                {content}
                                              </div>
                                            );
                                            const renderBlock = (block: { type: string; content?: string; questionId?: number; headerText?: string; imageUrl?: string; imageLayout?: string; imageWidthPercent?: number; imageFullWidth?: boolean }, key: string) => {
                                              if (block.type === 'instruction_block' && (block.content || block.imageUrl)) {
                                                const content = block.content ? (
                                                  <div className="overflow-x-auto">
                                                    <div
                                                      className="text-sm text-gray-700 prose prose-sm max-w-none whitespace-normal overflow-visible hyphens-none [&_table]:w-full [&_table]:max-w-full [&_table]:table-fixed [&_th]:break-keep [&_th]:whitespace-normal [&_th]:align-top [&_th]:hyphens-none [&_td]:break-keep [&_td]:whitespace-normal [&_td]:align-top [&_td]:hyphens-none [&_td]:min-w-0 [&_td>*]:min-w-0"
                                                      dangerouslySetInnerHTML={{ __html: normalizeRichTextForPage(sanitizeInstructionHtml(String(block.content))) }}
                                                    />
                                                  </div>
                                                ) : null;
                                                const imgUrl = block.imageUrl;
                                                const layout = block.imageFullWidth ? 'above' : (block.imageLayout || 'side_by_side');
                                                const pct = Math.max(20, Math.min(80, block.imageWidthPercent || 50));
                                                const imgEl = imgUrl ? <img src={imgUrl} alt="" className="max-w-full h-auto object-contain rounded border border-gray-200" style={{ maxHeight: (block.imageFullWidth ? 520 : 280), width: block.imageFullWidth ? '100%' : undefined, display: block.imageFullWidth ? 'block' : undefined, margin: block.imageFullWidth ? '0 auto' : undefined }} /> : null;
                                                let blockContent: React.ReactNode;
                                                if (!imgEl) blockContent = content;
                                                else if (layout === 'above') blockContent = <div><div className="mb-2">{imgEl}</div>{content}</div>;
                                                else if (layout === 'below') blockContent = <div>{content}<div className="mt-2">{imgEl}</div></div>;
                                                else blockContent = (
                                            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                                              <div className="order-2 min-w-0 flex-1 sm:order-1">{content}</div>
                                              <div
                                                className="order-1 w-full max-w-full shrink-0 sm:order-2 sm:w-[var(--side-img-pct)] sm:max-w-[min(100%,var(--side-img-pct))]"
                                                style={{ ['--side-img-pct' as string]: `${pct}%` } as React.CSSProperties}
                                              >
                                                {imgEl}
                                              </div>
                                            </div>
                                          );
                                                return wrapWithHeader(key, block.headerText, blockContent);
                                              }
                                              if (block.type === 'image' && block.imageUrl) {
                                                const imgUrl = block.imageUrl;
                                                const layout = block.imageFullWidth ? 'above' : (block.imageLayout || 'above');
                                                const pct = Math.max(20, Math.min(80, block.imageWidthPercent || 50));
                                                const imgEl = (
                                                  <img
                                                    src={imgUrl}
                                                    alt=""
                                                    className="max-w-full h-auto object-contain rounded border border-gray-200"
                                                    style={{
                                                      maxHeight: 280,
                                                      width: block.imageFullWidth ? '100%' : undefined,
                                                      display: block.imageFullWidth ? 'block' : undefined,
                                                      margin: block.imageFullWidth ? '0 auto' : undefined,
                                                    }}
                                                  />
                                                );
                                                let blockContent: React.ReactNode;
                                                if (layout === 'above') blockContent = <div className="mb-2">{imgEl}</div>;
                                                else if (layout === 'below') blockContent = <div className="mt-2">{imgEl}</div>;
                                                else
                                                  blockContent = (
                                                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                                                      <div className="order-2 min-w-0 flex-1 sm:order-1" />
                                                      <div
                                                        className="order-1 w-full max-w-full shrink-0 sm:order-2 sm:w-[var(--side-img-pct)] sm:max-w-[min(100%,var(--side-img-pct))]"
                                                        style={{ ['--side-img-pct' as string]: `${pct}%` } as React.CSSProperties}
                                                      >
                                                        {imgEl}
                                                      </div>
                                                    </div>
                                                  );
                                                return wrapWithHeader(key, block.headerText, blockContent);
                                              }
                                              const childQ = block.questionId ? section.questions.find((x) => x.id === block.questionId) : null;
                                              if (!childQ) return null;
                                              if (block.type === 'grid_table' && childQ.rows?.length) {
                                                const merged = mergeGridTableAnswers(childQ, answers);
                                                const onGridChange = (v: string | number | boolean | Record<string, unknown> | string[]) => {
                                                  const o = v as Record<string, string>;
                                                  if (!o || typeof o !== 'object') return;
                                                  const prevMerged: Record<string, string> = {};
                                                  for (const r of childQ.rows) {
                                                    const prev = answers[getAnswerKey(childQ.id, r.id)];
                                                    if (prev && typeof prev === 'object') Object.assign(prevMerged, prev as Record<string, string>);
                                                  }
                                                  const changedByRow = new Map<number, Record<string, string>>();
                                                  for (const [k, val] of Object.entries(o)) {
                                                    if (String(prevMerged[k] ?? '') === String(val ?? '')) continue;
                                                    const match = /^r(\d+)_c/.exec(k);
                                                    if (!match) continue;
                                                    const rowId = Number(match[1]);
                                                    if (!changedByRow.has(rowId)) changedByRow.set(rowId, {});
                                                    changedByRow.get(rowId)![k] = String(val ?? '');
                                                  }
                                                  for (const [rowId, patch] of changedByRow.entries()) {
                                                    const existing = answers[getAnswerKey(childQ.id, rowId)];
                                                    const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? (existing as Record<string, string>) : {};
                                                    handleAnswerChange(childQ.id, rowId, { ...base, ...patch });
                                                  }
                                                };
                                                return wrapWithHeader(key, block.headerText, (
                                                  <div className="flex gap-2 items-start">
                                                    <AnswerSaveStatusIcon status={questionSaveStatus[childQ.id]} />
                                                    <div className="flex-1 min-w-0">
                                                      <QuestionRenderer instanceId={id} question={childQ} value={Object.keys(merged).length ? merged : null} onChange={onGridChange} disabled={!editable} error={errors[`q-${childQ.id}`]} studentResubmissionReadOnlyForSatisfactoryRows={isResubmissionAfterTrainer} taskQuestionDisplayNumber={taskQNumbers.get(childQ.id)} highlightAsFill={editable} />
                                                    </div>
                                                  </div>
                                                ));
                                              }
                                              if (block.type === 'short_text' || block.type === 'long_text') {
                                                const val = answers[getAnswerKey(childQ.id, null)] as string | undefined;
                                                return wrapWithHeader(key, block.headerText, (
                                                  <div className="flex gap-2 items-start">
                                                    <AnswerSaveStatusIcon status={questionSaveStatus[childQ.id]} />
                                                    <div className="flex-1 min-w-0">
                                                      <QuestionRenderer instanceId={id} question={childQ} value={val ?? null} onChange={(v) => handleAnswerChange(childQ.id, null, v as string | number | boolean | Record<string, unknown> | string[])} disabled={!editable} error={errors[`q-${childQ.id}`]} taskQuestionDisplayNumber={taskQNumbers.get(childQ.id)} highlightAsFill={editable} />
                                                    </div>
                                                  </div>
                                                ));
                                              }
                                              return null;
                                            };
                                            return (
                                              <div className="space-y-3">
                                                <div className="flex items-start gap-2">
                                                  <AnswerSaveStatusIcon status={questionSaveStatus[q.id]} />
                                                  <div className="flex-1 min-w-0 space-y-3">
                                                {textAboveHeader && <div className="font-bold text-gray-900">{textAboveHeader}</div>}
                                                {q.type === 'grid_table' && q.rows.length > 0 ? (
                                                  (() => {
                                                    const merged = mergeGridTableAnswers(q, answers);
                                                    const onGridChange = (v: string | number | boolean | Record<string, unknown> | string[]) => {
                                                      const o = v as Record<string, string>;
                                                      if (!o || typeof o !== 'object') return;
                                                      const prevMerged: Record<string, string> = {};
                                                      for (const r of q.rows) {
                                                        const prev = answers[getAnswerKey(q.id, r.id)];
                                                        if (prev && typeof prev === 'object') Object.assign(prevMerged, prev as Record<string, string>);
                                                      }
                                                      const changedByRow = new Map<number, Record<string, string>>();
                                                      for (const [k, val] of Object.entries(o)) {
                                                        if (String(prevMerged[k] ?? '') === String(val ?? '')) continue;
                                                        const match = /^r(\d+)_c/.exec(k);
                                                        if (!match) continue;
                                                        const rowId = Number(match[1]);
                                                        if (!changedByRow.has(rowId)) changedByRow.set(rowId, {});
                                                        changedByRow.get(rowId)![k] = String(val ?? '');
                                                      }
                                                      for (const [rowId, patch] of changedByRow.entries()) {
                                                        const existing = answers[getAnswerKey(q.id, rowId)];
                                                        const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? (existing as Record<string, string>) : {};
                                                        handleAnswerChange(q.id, rowId, { ...base, ...patch });
                                                      }
                                                    };
                                                    return (
                                                      <QuestionRenderer instanceId={id} question={q} value={Object.keys(merged).length ? merged : null} onChange={onGridChange} disabled={!editable} error={errors[`q-${q.id}`]} studentResubmissionReadOnlyForSatisfactoryRows={isResubmissionAfterTrainer} taskQuestionDisplayNumber={taskQNumbers.get(q.id)} highlightAsFill={editable} />
                                                    );
                                                  })()
                                                ) : (
                                                  <QuestionRenderer instanceId={id} question={q} value={(answers[getAnswerKey(q.id, null)] as string | number | boolean | Record<string, unknown> | string[] | undefined) ?? null} onChange={(v) => handleAnswerChange(q.id, null, v as string | number | boolean | Record<string, unknown> | string[])} disabled={!editable} error={errors[`q-${q.id}`]} taskQuestionDisplayNumber={taskQNumbers.get(q.id)} highlightAsFill={editable} />
                                                )}
                                                {contentBlocks.map((block, bi) => renderBlock(block, String(block.questionId ?? `block-${bi}`)))}
                                                  </div>
                                                </div>
                                              </div>
                                            );
                                          })()}
                                        </td>
                                        <td className="p-2 border border-gray-300 align-top" style={{ width: '9.5rem' }}>
                                          <div className="flex flex-row items-center justify-center gap-3">
                                            <label className="flex items-center gap-1.5 cursor-pointer">
                                              <input
                                                type="radio"
                                                name={`trainer-sat-${q.id}`}
                                                checked={satYes}
                                                onChange={() => trainerEditable && handleTrainerAssessmentChange(q.id, 'yes')}
                                                disabled={!trainerEditable}
                                                className="w-4 h-4 border-gray-600"
                                              />
                                              <span>Yes</span>
                                            </label>
                                            <label className="flex items-center gap-1.5 cursor-pointer">
                                              <input
                                                type="radio"
                                                name={`trainer-sat-${q.id}`}
                                                checked={satNo}
                                                onChange={() => trainerEditable && handleTrainerAssessmentChange(q.id, 'no')}
                                                disabled={!trainerEditable}
                                                className="w-4 h-4 border-gray-600"
                                              />
                                              <span>No</span>
                                            </label>
                                          </div>
                                        </td>
                                      </tr>
                                    );
                                  })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                          );
                        })()
                      ) : section.pdf_render_mode === 'task_results' ? (
                        (() => {
                          const rd = resultsData[section.id];
                          const adminOverride = canOfficeAdminEdit;
                          const studentCanEdit =
                            role === 'student' || role === 'office' || (role === 'trainer' && canRoleEditCurrentWorkflow);
                          const taskResultSectionIds = (template?.steps || []).flatMap((st) => st.sections).filter((s) => s.pdf_render_mode === 'task_results').map((s) => s.id);
                          const firstTaskSectionId = taskResultSectionIds[0];
                          const firstTaskData = firstTaskSectionId && firstTaskSectionId !== section.id ? resultsData[firstTaskSectionId] : null;
                          const raTrainerQForResults = template?.steps?.flatMap((st) => st.sections).flatMap((s) => s.questions).find((q) => q.code === 'trainer.reasonableAdjustmentSignature');
                          const raValForResults = raTrainerQForResults ? answers[getAnswerKey(raTrainerQForResults.id, null)] : undefined;
                          const raSigObjForResults = raValForResults && typeof raValForResults === 'object' && !Array.isArray(raValForResults) ? (raValForResults as Record<string, unknown>) : null;
                          const raTrainerSigForResults = raSigObjForResults ? (String(raSigObjForResults.signature ?? raSigObjForResults.imageDataUrl ?? '') || null) : (typeof raValForResults === 'string' ? raValForResults : null);
                          const raTrainerDateForResults = raSigObjForResults ? String(raSigObjForResults.date ?? raSigObjForResults.signedAtDate ?? '') : '';
                          const trainerSuggestionSig = raTrainerSigForResults ?? firstTaskData?.trainer_signature ?? null;
                          const todayForResults = new Date().toISOString().split('T')[0];
                          const trainerSuggestionDate = raTrainerDateForResults || (firstTaskData?.trainer_date ?? todayForResults);
                          const studentDeclQ = template?.steps?.flatMap((st) => st.sections).flatMap((s) => s.questions).find((q) => q.code === 'student.declarationSignature');
                          const studentDeclVal = studentDeclQ ? answers[getAnswerKey(studentDeclQ.id, null)] : undefined;
                          const studentDeclSigObj = studentDeclVal && typeof studentDeclVal === 'object' && !Array.isArray(studentDeclVal) ? (studentDeclVal as Record<string, unknown>) : null;
                          const studentDeclSig = studentDeclSigObj ? (String(studentDeclSigObj.signature ?? studentDeclSigObj.imageDataUrl ?? '') || null) : (typeof studentDeclVal === 'string' ? studentDeclVal : null);
                          const minFirstAttempt = getResultsMinFirstAttemptDate(assessmentSummary, studentDeclarationDateMinIso);
                          const minSecondAttempt = getResultsMinSecondAttemptDate(rd, assessmentSummary);
                          const minThirdAttempt = getResultsMinThirdAttemptDate(rd, assessmentSummary);
                          const minTrainerDate = getResultsTrainerFooterDateMin(rd);
                          const resultsFieldDateErrors = getResultsSheetFieldDateErrors(
                            rd,
                            assessmentSummary,
                            studentDeclarationDateMinIso,
                          );
                          const fieldDateError = (key: string) => resultsFieldDateErrors[`results-${section.id}-${key}`];
                          const trainerCanEditResults =
                            (role === 'trainer' && canRoleEditCurrentWorkflow) ||
                            (role === 'office' && (canRoleEditCurrentWorkflow || canOfficeAdminEdit));
                          const activeResultsAttemptNum = getActiveMarkingAttemptNum(submissionCount, assessmentSummary, rd);
                          const firstAttemptEditable =
                            adminOverride ||
                            (trainerCanEditResults && isStaffAttemptColumnEditable(activeResultsAttemptNum, 1));
                          const secondAttemptEditable =
                            adminOverride ||
                            (trainerCanEditResults && isStaffAttemptColumnEditable(activeResultsAttemptNum, 2));
                          const thirdAttemptEditable =
                            adminOverride ||
                            (trainerCanEditResults && isStaffAttemptColumnEditable(activeResultsAttemptNum, 3));
                          /** Trainer footer sign-off must stay editable whenever the trainer is actively reviewing. */
                          const trainerFooterEditable =
                            adminOverride ||
                            (trainerCanEditResults &&
                              (firstAttemptEditable ||
                                secondAttemptEditable ||
                                thirdAttemptEditable ||
                                (role === 'trainer' && trainerCanFinaliseReview) ||
                                !rowAnswerHasContent(rd?.trainer_signature ?? undefined)));
                          /** Only current + prior attempt columns may set dates; staff date override applies to footer only. */
                          const firstAttemptDateEditable = firstAttemptEditable;
                          const secondAttemptDateEditable = secondAttemptEditable;
                          const thirdAttemptDateEditable = thirdAttemptEditable;
                          const trainerFooterDateEditable = trainerFooterEditable || staffCanCorrectSheetDates;
                          const studentSuggestionSig = studentDeclSig ?? firstTaskData?.student_signature ?? null;
                          const studentNameQ = template?.steps?.flatMap((st) => st.sections).flatMap((s) => s.questions).find((q) => q.code === 'student.fullName');
                          const trainerNameQ = template?.steps?.flatMap((st) => st.sections).flatMap((s) => s.questions).find((q) => q.code === 'trainer.fullName');
                          const suggestedStudentName = !rd?.student_name && studentNameQ ? String(answers[getAnswerKey(studentNameQ.id, null)] ?? '') : null;
                          const suggestedTrainerName = !rd?.trainer_name && trainerNameQ ? String(answers[getAnswerKey(trainerNameQ.id, null)] ?? '') : null;
                          return (
                        <div className={`border border-gray-200 rounded-lg overflow-hidden bg-white ${errors[`task-results-${section.id}-minimum`] ? 'ring-2 ring-red-400' : ''}`}>
                          {errors[`task-results-${section.id}-minimum`] && (
                            <p className="bg-red-50 text-red-700 text-sm px-4 py-2 border-b border-red-200">
                              {errors[`task-results-${section.id}-minimum`]}
                            </p>
                          )}
                          <div className="bg-[#5E5E5E] text-white font-bold px-4 py-3">
                            {((section as { taskRow?: { row_label: string } }).taskRow?.row_label || section.title) + ' – Results Sheet'}
                          </div>
                          <div className="overflow-x-auto">
                            <table className="w-full border-collapse text-sm">
                              <tbody>
                                <tr>
                                  <td className="w-1/4 bg-gray-200 font-semibold text-gray-700 p-3 border border-gray-300 align-top" rowSpan={3}>
                                    Outcome
                                  </td>
                                  <td className="bg-white p-3 border border-gray-300 align-top">
                                    <div className="font-semibold mb-2">First attempt:</div>
                                    <div className="mb-2">Outcome (make sure to tick the correct checkbox):</div>
                                    <div className="flex flex-wrap gap-3 sm:gap-4 mb-2 items-center">
                                      <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                          type="radio"
                                          name={`results-${section.id}-first`}
                                          checked={rd?.first_attempt_satisfactory === 's'}
                                          onClick={() => {
                                            if (firstAttemptEditable && rd?.first_attempt_satisfactory === 's') {
                                              void handleResultsDataChange(section.id, 'first_attempt_satisfactory', null);
                                            }
                                          }}
                                          onChange={() => handleResultsOutcomeSelect(section.id, 'first_attempt_satisfactory', 's', firstAttemptEditable)}
                                          disabled={!firstAttemptEditable}
                                          className="w-4 h-4"
                                        />
                                        <span>Satisfactory (S)</span>
                                      </label>
                                      <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                          type="radio"
                                          name={`results-${section.id}-first`}
                                          checked={rd?.first_attempt_satisfactory === 'ns'}
                                          onClick={() => {
                                            if (firstAttemptEditable && rd?.first_attempt_satisfactory === 'ns') {
                                              void handleResultsDataChange(section.id, 'first_attempt_satisfactory', null);
                                            }
                                          }}
                                          onChange={() => handleResultsOutcomeSelect(section.id, 'first_attempt_satisfactory', 'ns', firstAttemptEditable)}
                                          disabled={!firstAttemptEditable}
                                          className="w-4 h-4"
                                        />
                                        <span>Not Satisfactory (NS)</span>
                                      </label>
                                      {firstAttemptEditable && rd?.first_attempt_satisfactory && (
                                        <button
                                          type="button"
                                          className="text-xs text-gray-500 underline"
                                          onClick={() => void handleResultsDataChange(section.id, 'first_attempt_satisfactory', null)}
                                        >
                                          Clear outcome
                                        </button>
                                      )}
                                    </div>
                                    <div className="mb-2"><span className="font-medium">Date:</span>{' '}
                                      <DatePicker
                                        value={rd?.first_attempt_date ?? ''}
                                        onChange={(v) => handleResultsDataChange(section.id, 'first_attempt_date', v || null)}
                                        disabled={!firstAttemptDateEditable}
                                        compact
                                        placement="above"
                                        className="inline-block min-w-[120px]"
                                        minDate={staffDatePickerMin(minFirstAttempt, staffBypassDateConstraints)}
                                        error={fieldDateError('first_attempt_date')}
                                      />
                                    </div>
                                    <div><span className="font-medium">Feedback:</span>
                                      <textarea
                                        value={rd?.first_attempt_feedback ?? ''}
                                        onChange={(e) => handleResultsDataChange(section.id, 'first_attempt_feedback', e.target.value || null)}
                                        disabled={!firstAttemptEditable}
                                        className="block w-full border border-gray-300 min-h-[60px] p-2 mt-1 bg-gray-50 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400 disabled:bg-gray-100 disabled:cursor-not-allowed"
                                      />
                                    </div>
                                  </td>
                                </tr>
                                <tr>
                                  <td className="bg-white p-3 border border-gray-300 align-top">
                                    <div className="font-semibold mb-2">Second attempt:</div>
                                    <div className="mb-2">Outcome (make sure to tick the correct checkbox):</div>
                                    <div className="flex flex-wrap gap-3 sm:gap-4 mb-2 items-center">
                                      <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                          type="radio"
                                          name={`results-${section.id}-second`}
                                          checked={rd?.second_attempt_satisfactory === 's'}
                                          onClick={() => {
                                            if (secondAttemptEditable && rd?.second_attempt_satisfactory === 's') {
                                              void handleResultsDataChange(section.id, 'second_attempt_satisfactory', null);
                                            }
                                          }}
                                          onChange={() => handleResultsOutcomeSelect(section.id, 'second_attempt_satisfactory', 's', secondAttemptEditable)}
                                          disabled={!secondAttemptEditable}
                                          className="w-4 h-4"
                                        />
                                        <span>Satisfactory (S)</span>
                                      </label>
                                      <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                          type="radio"
                                          name={`results-${section.id}-second`}
                                          checked={rd?.second_attempt_satisfactory === 'ns'}
                                          onClick={() => {
                                            if (secondAttemptEditable && rd?.second_attempt_satisfactory === 'ns') {
                                              void handleResultsDataChange(section.id, 'second_attempt_satisfactory', null);
                                            }
                                          }}
                                          onChange={() => handleResultsOutcomeSelect(section.id, 'second_attempt_satisfactory', 'ns', secondAttemptEditable)}
                                          disabled={!secondAttemptEditable}
                                          className="w-4 h-4"
                                        />
                                        <span>Not Satisfactory (NS)</span>
                                      </label>
                                      {secondAttemptEditable && rd?.second_attempt_satisfactory && (
                                        <button
                                          type="button"
                                          className="text-xs text-gray-500 underline"
                                          onClick={() => void handleResultsDataChange(section.id, 'second_attempt_satisfactory', null)}
                                        >
                                          Clear outcome
                                        </button>
                                      )}
                                    </div>
                                    <div className="mb-2"><span className="font-medium">Date:</span>{' '}
                                      <DatePicker
                                        value={rd?.second_attempt_date ?? ''}
                                        onChange={(v) => handleResultsDataChange(section.id, 'second_attempt_date', v || null)}
                                        disabled={!secondAttemptDateEditable}
                                        compact
                                        placement="above"
                                        className="inline-block min-w-[120px]"
                                        minDate={staffDatePickerMin(minSecondAttempt, staffBypassDateConstraints)}
                                        error={fieldDateError('second_attempt_date')}
                                      />
                                    </div>
                                    <div><span className="font-medium">Feedback:</span>
                                      <textarea
                                        value={rd?.second_attempt_feedback ?? ''}
                                        onChange={(e) => handleResultsDataChange(section.id, 'second_attempt_feedback', e.target.value || null)}
                                        disabled={!secondAttemptEditable}
                                        className="block w-full border border-gray-300 min-h-[60px] p-2 mt-1 bg-gray-50 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400 disabled:bg-gray-100 disabled:cursor-not-allowed"
                                      />
                                    </div>
                                  </td>
                                </tr>
                                <tr>
                                  <td className="bg-white p-3 border border-gray-300 align-top">
                                    <div className="font-semibold mb-2">Third attempt:</div>
                                    <div className="mb-2">Outcome (make sure to tick the correct checkbox):</div>
                                    <div className="flex flex-wrap gap-3 sm:gap-4 mb-2 items-center">
                                      <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                          type="radio"
                                          name={`results-${section.id}-third`}
                                          checked={rd?.third_attempt_satisfactory === 's'}
                                          onClick={() => {
                                            if (thirdAttemptEditable && rd?.third_attempt_satisfactory === 's') {
                                              void handleResultsDataChange(section.id, 'third_attempt_satisfactory', null);
                                            }
                                          }}
                                          onChange={() => handleResultsOutcomeSelect(section.id, 'third_attempt_satisfactory', 's', thirdAttemptEditable)}
                                          disabled={!thirdAttemptEditable}
                                          className="w-4 h-4"
                                        />
                                        <span>Satisfactory (S)</span>
                                      </label>
                                      <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                          type="radio"
                                          name={`results-${section.id}-third`}
                                          checked={rd?.third_attempt_satisfactory === 'ns'}
                                          onClick={() => {
                                            if (thirdAttemptEditable && rd?.third_attempt_satisfactory === 'ns') {
                                              void handleResultsDataChange(section.id, 'third_attempt_satisfactory', null);
                                            }
                                          }}
                                          onChange={() => handleResultsOutcomeSelect(section.id, 'third_attempt_satisfactory', 'ns', thirdAttemptEditable)}
                                          disabled={!thirdAttemptEditable}
                                          className="w-4 h-4"
                                        />
                                        <span>Not Satisfactory (NS)</span>
                                      </label>
                                      {thirdAttemptEditable && rd?.third_attempt_satisfactory && (
                                        <button
                                          type="button"
                                          className="text-xs text-gray-500 underline"
                                          onClick={() => void handleResultsDataChange(section.id, 'third_attempt_satisfactory', null)}
                                        >
                                          Clear outcome
                                        </button>
                                      )}
                                    </div>
                                    <div className="mb-2"><span className="font-medium">Date:</span>{' '}
                                      <DatePicker
                                        value={rd?.third_attempt_date ?? ''}
                                        onChange={(v) => handleResultsDataChange(section.id, 'third_attempt_date', v || null)}
                                        disabled={!thirdAttemptDateEditable}
                                        compact
                                        placement="above"
                                        className="inline-block min-w-[120px]"
                                        minDate={staffDatePickerMin(minThirdAttempt, staffBypassDateConstraints)}
                                        error={fieldDateError('third_attempt_date')}
                                      />
                                    </div>
                                    <div><span className="font-medium">Feedback:</span>
                                      <textarea
                                        value={rd?.third_attempt_feedback ?? ''}
                                        onChange={(e) => handleResultsDataChange(section.id, 'third_attempt_feedback', e.target.value || null)}
                                        disabled={!thirdAttemptEditable}
                                        className="block w-full border border-gray-300 min-h-[60px] p-2 mt-1 bg-gray-50 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400 disabled:bg-gray-100 disabled:cursor-not-allowed"
                                      />
                                    </div>
                                  </td>
                                </tr>
                                <tr>
                                  <td className="bg-gray-200 font-semibold text-gray-700 p-3 border border-gray-300 align-top">
                                    Student Declaration
                                  </td>
                                  <td className="bg-white p-3 pb-2 border border-gray-300 align-top">
                                    <ul className="list-disc pl-5 space-y-1 text-sm mb-2">
                                      <li>I declare that the answers I have provided are my own work.</li>
                                      <li>I have kept a copy of all relevant notes and reference material.</li>
                                      <li>I have provided references for all sources where the information is not my own.</li>
                                      <li>For the purposes of assessment, I give the trainer/assessor permission to:
                                        <ul className="list-disc pl-5 mt-1 space-y-1">
                                          <li>i. Reproduce this assessment and provide a copy to another member of the RTO for the purposes of assessment.</li>
                                          <li>ii. Take steps to authenticate the assessment, including conducting a plagiarism check.</li>
                                        </ul>
                                      </li>
                                    </ul>
                                    <p className="mt-3 font-semibold text-sm">I understand that if I disagree with the assessment outcome, I can appeal the assessment process, and either re-submit additional evidence undertake gap training and or have my submission re-assessed.</p>
                                    <p className="font-semibold text-sm">All appeal options have been explained to me.</p>
                                  </td>
                                </tr>
                                <tr>
                                  <td className="bg-gray-200 font-semibold text-gray-700 p-3 border border-gray-300">Student Name</td>
                                  <td className="bg-white p-3 border border-gray-300">
                                    <input
                                      type="text"
                                      value={rd?.student_name ?? ''}
                                      onChange={(e) => handleResultsDataChange(section.id, 'student_name', e.target.value || null)}
                                      disabled={!studentCanEdit}
                                      placeholder="Enter student name"
                                      className={`w-full border-b border-gray-400 min-h-[18px] px-1 py-0.5 text-sm ${
                                        studentCanEdit ? 'bg-blue-50/70' : 'bg-transparent'
                                      } focus:outline-none focus:ring-1 focus:ring-gray-400 disabled:bg-gray-100 disabled:cursor-not-allowed`}
                                    />
                                    {suggestedStudentName && !rd?.student_name && studentCanEdit && (
                                      <button type="button" onClick={() => handleResultsDataChange(section.id, 'student_name', suggestedStudentName)} className="text-xs text-blue-600 hover:underline mt-0.5">Use {suggestedStudentName}</button>
                                    )}
                                  </td>
                                </tr>
                                <tr>
                                  <td className="bg-gray-200 font-semibold text-gray-700 p-3 border border-gray-300">Student Signature</td>
                                  <td className="bg-white p-3 border border-gray-300">
                                    <SignatureField
                                      value={rd?.student_signature ?? null}
                                      onChange={(v) => handleResultsDataChange(section.id, 'student_signature', v)}
                                      disabled={!studentCanEdit}
                                      highlight={studentCanEdit}
                                      suggestionFrom={studentSuggestionSig}
                                      onSuggestionClick={studentSuggestionSig ? () => handleResultsDataChange(section.id, 'student_signature', studentSuggestionSig) : undefined}
                                    />
                                  </td>
                                </tr>
                                <tr>
                                  <td className="bg-gray-200 font-semibold text-gray-700 p-3 border border-gray-300">Trainer/Assessor Name</td>
                                  <td className="bg-white p-3 border border-gray-300">
                                    <input
                                      type="text"
                                      value={rd?.trainer_name ?? ''}
                                      onChange={(e) => handleResultsDataChange(section.id, 'trainer_name', e.target.value || null)}
                                      disabled={!trainerFooterEditable}
                                      placeholder="Enter trainer name"
                                      className={`w-full border-b border-gray-400 min-h-[18px] px-1 py-0.5 text-sm ${
                                        trainerFooterEditable ? 'bg-blue-50/70' : 'bg-transparent'
                                      } focus:outline-none focus:ring-1 focus:ring-gray-400 disabled:bg-gray-100 disabled:cursor-not-allowed`}
                                    />
                                    {suggestedTrainerName && !rd?.trainer_name && trainerFooterEditable && (
                                      <button type="button" onClick={() => handleResultsDataChange(section.id, 'trainer_name', suggestedTrainerName)} className="text-xs text-blue-600 hover:underline mt-0.5">Use {suggestedTrainerName}</button>
                                    )}
                                  </td>
                                </tr>
                                <tr>
                                  <td className="bg-gray-200 font-semibold text-gray-700 p-3 border border-gray-300">Trainer/Assessor Signature</td>
                                  <td className="bg-white p-3 border border-gray-300">
                                    <SignatureField
                                      value={rd?.trainer_signature ?? null}
                                      onChange={(v) => handleResultsDataChange(section.id, 'trainer_signature', v)}
                                      disabled={!trainerFooterEditable}
                                      highlight={trainerFooterEditable}
                                      suggestionFrom={trainerSuggestionSig}
                                      onSuggestionClick={
                                        trainerFooterEditable && trainerSuggestionSig
                                          ? () => {
                                              handleResultsDataChange(section.id, 'trainer_signature', trainerSuggestionSig);
                                              handleResultsDataChange(section.id, 'trainer_date', trainerSuggestionDate || null);
                                            }
                                          : undefined
                                      }
                                    />
                                  </td>
                                </tr>
                                <tr>
                                  <td className="bg-gray-200 font-semibold text-gray-700 p-3 border border-gray-300">Date</td>
                                  <td className="bg-white p-3 border border-gray-300">
                                    <DatePicker
                                      value={rd?.trainer_date ?? ''}
                                      onChange={(v) => handleResultsDataChange(section.id, 'trainer_date', v || null)}
                                      disabled={!trainerFooterDateEditable}
                                      highlight={trainerFooterDateEditable}
                                      compact
                                      placement="above"
                                      className="min-w-[120px]"
                                      minDate={staffDatePickerMin(trainerFooterDateEditable ? minTrainerDate || undefined : undefined, staffBypassDateConstraints)}
                                      error={fieldDateError('trainer_date')}
                                    />
                                  </td>
                                </tr>
                                <tr>
                                  <td className="bg-[#f5f0e6] font-semibold italic text-gray-700 p-3 border border-gray-300">Office Use Only</td>
                                  <td className="bg-white p-3 border border-gray-300 text-sm min-w-0">
                                    <p className="mb-2 text-gray-700">
                                      The outcome of this assessment has been entered into the Student Management System.
                                    </p>
                                    <div className="flex flex-wrap items-center gap-4">
                                      <label className="inline-flex items-center gap-2 cursor-pointer">
                                        <input
                                          type="checkbox"
                                          checked={Boolean(resultsOffice[section.id]?.initial_checked)}
                                          onChange={(e) => handleResultsOfficeChange(section.id, 'initial_checked', e.target.checked)}
                                          disabled={!canOfficeAdminEdit}
                                          className="w-4 h-4 rounded border-gray-400"
                                        />
                                        <span className="font-medium">Initial</span>
                                      </label>
                                      <label className="inline-flex items-center gap-2 cursor-pointer">
                                        <input
                                          type="checkbox"
                                          checked={Boolean(resultsOffice[section.id]?.updated_checked)}
                                          onChange={(e) => handleResultsOfficeChange(section.id, 'updated_checked', e.target.checked)}
                                          disabled={!canOfficeAdminEdit}
                                          className="w-4 h-4 rounded border-gray-400"
                                        />
                                        <span className="font-medium">Updated</span>
                                      </label>
                                    </div>
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                        </div>
                          );
                        })()
                      ) : section.pdf_render_mode === 'assessment_summary' ? (
                        (() => {
                          const sum = assessmentSummary || ({} as import('../lib/formEngine').AssessmentSummaryDataEntry);
                          const trainerCanEdit = role === 'trainer' || role === 'office';
                          const adminOverride = canOfficeAdminEdit;
                          const studentCanEdit =
                            role === 'student' || role === 'office' || (role === 'trainer' && canRoleEditCurrentWorkflow);
                          const officeCanEdit = canOfficeAdminEdit;
                          const canEditSummaryCoverDates =
                            canOfficeAdminEdit || (role === 'trainer' && canRoleEditCurrentWorkflow);
                          const taskResultEntries = buildTaskResultSections(template, resultsData);
                          const taskResultSectionIds = taskResultEntries
                            .map((e) => e.sectionId)
                            .filter((id): id is number => id != null);
                          const firstTaskSectionId = taskResultSectionIds[0];
                          const firstTaskRd = firstTaskSectionId ? resultsData[firstTaskSectionId] : null;
                          const todayIso = new Date().toISOString().split('T')[0];
                          const raTrainerQ = template?.steps?.flatMap((st) => st.sections).flatMap((s) => s.questions).find((q) => q.code === 'trainer.reasonableAdjustmentSignature');
                          const raVal = raTrainerQ ? answers[getAnswerKey(raTrainerQ.id, null)] : undefined;
                          const raSigObj = raVal && typeof raVal === 'object' && !Array.isArray(raVal) ? (raVal as Record<string, unknown>) : null;
                          const raTrainerSig = raSigObj ? (String(raSigObj.signature ?? raSigObj.imageDataUrl ?? '') || null) : (typeof raVal === 'string' ? raVal : null);
                          const raTrainerDate = raSigObj ? String(raSigObj.date ?? raSigObj.signedAtDate ?? '') : '';
                          const trainerRefSig = raTrainerSig ?? firstTaskRd?.trainer_signature ?? undefined;
                          const trainerRefDate = raTrainerSig ? (raTrainerDate || firstTaskRd?.trainer_date || todayIso) : (firstTaskRd?.trainer_date || todayIso);
                          const studentDeclQForSum = template?.steps?.flatMap((st) => st.sections).flatMap((s) => s.questions).find((q) => q.code === 'student.declarationSignature');
                          const studentDeclValForSum = studentDeclQForSum ? answers[getAnswerKey(studentDeclQForSum.id, null)] : undefined;
                          const studentDeclSigObjForSum = studentDeclValForSum && typeof studentDeclValForSum === 'object' && !Array.isArray(studentDeclValForSum) ? (studentDeclValForSum as Record<string, unknown>) : null;
                          const studentDeclSigForSum = studentDeclSigObjForSum ? (String(studentDeclSigObjForSum.signature ?? studentDeclSigObjForSum.imageDataUrl ?? '') || null) : (typeof studentDeclValForSum === 'string' ? studentDeclValForSum : null);
                          const studentDeclDateForSum = studentDeclSigObjForSum ? String(studentDeclSigObjForSum.date ?? studentDeclSigObjForSum.signedAtDate ?? '') : '';
                          const studentRefSig = studentDeclSigForSum ?? firstTaskRd?.student_signature ?? undefined;
                          const studentRefDate = studentDeclSigForSum ? (studentDeclDateForSum || todayIso) : todayIso;
                          const {
                            minStudentDate1,
                            minTrainerDate1,
                            minStudentDate2,
                            minTrainerDate2,
                            minStudentDate3,
                            minTrainerDate3,
                          } = getAssessmentSummaryDateChainMins(sum, studentDeclarationDateMinIso);
                          const summaryFieldDateErrors = getSummarySheetFieldDateErrors(sum, studentDeclarationDateMinIso);
                          const summaryDateError = (key: string) => summaryFieldDateErrors[`summary-${key}`];
                          const staffSummaryActiveAttempt = getActiveMarkingAttemptNum(submissionCount, sum, firstTaskRd);
                          const studentPrepAttempt = getStudentPrepAttemptNum(submissionCount, sum);
                          const sumTrainerFirstEditable =
                            adminOverride ||
                            (trainerCanEdit && isStaffAttemptColumnEditable(staffSummaryActiveAttempt, 1));
                          const sumTrainerSecondEditable =
                            adminOverride ||
                            (trainerCanEdit && isStaffAttemptColumnEditable(staffSummaryActiveAttempt, 2));
                          const sumTrainerThirdEditable =
                            adminOverride ||
                            (trainerCanEdit && isStaffAttemptColumnEditable(staffSummaryActiveAttempt, 3));
                          const sumStudentFirstEditable = studentPrepAttempt === 1;
                          const sumStudentSecondEditable = studentPrepAttempt === 2;
                          const sumStudentThirdEditable = studentPrepAttempt === 3;
                          const sumFirstDateEditable = sumTrainerFirstEditable;
                          const sumSecondDateEditable = sumTrainerSecondEditable;
                          const sumThirdDateEditable = sumTrainerThirdEditable;
                          const sumStudentFirstDateEditable = sumStudentFirstEditable;
                          const sumStudentSecondDateEditable = sumStudentSecondEditable;
                          const sumStudentThirdDateEditable = sumStudentThirdEditable;
                          const sumFirstAttemptChecks = getTaskResultChecks(
                            template,
                            1,
                            resultsData,
                            answers,
                            trainerAssessments
                          );
                          const sumSecondAttemptChecks = getTaskResultChecks(
                            template,
                            2,
                            resultsData,
                            answers,
                            trainerAssessments
                          );
                          const sumThirdAttemptChecks = getTaskResultChecks(
                            template,
                            3,
                            resultsData,
                            answers,
                            trainerAssessments
                          );
                          const activeAttemptChecks =
                            staffSummaryActiveAttempt === 3
                              ? sumThirdAttemptChecks
                              : staffSummaryActiveAttempt === 2
                                ? sumSecondAttemptChecks
                                : sumFirstAttemptChecks;
                          const activeAttemptNum: 1 | 2 | 3 = staffSummaryActiveAttempt;
                          const competentBlockers = activeAttemptChecks.filter((c) => c.status !== 'satisfactory');
                          const finalDate1 =
                            sum.trainer_date_1?.trim() ||
                            maxTaskAttemptDate(template, taskResultEntries, resultsData, 1);
                          const finalDate2 =
                            sum.trainer_date_2?.trim() ||
                            maxTaskAttemptDate(template, taskResultEntries, resultsData, 2);
                          const finalDate3 =
                            sum.trainer_date_3?.trim() ||
                            maxTaskAttemptDate(template, taskResultEntries, resultsData, 3);
                          const studentNameQ = template?.steps?.flatMap((st) => st.sections).flatMap((s) => s.questions).find((q) => q.code === 'student.fullName');
                          const studentIdQ = template?.steps?.flatMap((st) => st.sections).flatMap((s) => s.questions).find((q) => q.code === 'student.id');
                          const studentName = studentNameQ ? String(answers[getAnswerKey(studentNameQ.id, null)] ?? '') : '';
                          const studentId = studentIdQ ? String(answers[getAnswerKey(studentIdQ.id, null)] ?? '') : '';
                          const unitCode = String(template?.form?.unit_code ?? '');
                          const unitName = String(template?.form?.unit_name ?? '');
                          const unitCodeName = [unitCode, unitName].filter(Boolean).join(' ');
                          return (
                            <div className={`border border-gray-200 rounded-lg overflow-hidden bg-white ${errors['assessment-summary-minimum'] ? 'ring-2 ring-red-400' : ''}`}>
                              {errors['assessment-summary-minimum'] && (
                                <p className="bg-red-50 text-red-700 text-sm px-4 py-2 border-b border-red-200">
                                  {errors['assessment-summary-minimum']}
                                </p>
                              )}
                              <div className="bg-[#374151] text-white font-bold text-center px-3 sm:px-4 py-3 sm:py-4 text-base sm:text-lg leading-tight">
                                ASSESSMENT SUMMARY SHEET
                              </div>
                              <div className="bg-[#6b7280] text-white text-sm px-4 py-3 space-y-1">
                                <p className="font-medium">This form is to be completed by the assessor and used as a final record of student competency.</p>
                                <p className="text-sm">All student submissions including any associated checklists (outlined below) are to be attached to this cover sheet before placing on the student&apos;s file.</p>
                                <p className="text-sm">Student results are not to be entered onto the Student Database unless all relevant paperwork is completed and attached to this form.</p>
                              </div>
                              <div className="p-3 sm:p-4 space-y-4 min-w-0 overflow-x-auto overscroll-x-contain">
                                <table className="w-full border-collapse border border-gray-400 text-xs">
                                  <tbody>
                                    <tr><td className="border border-gray-400 bg-gray-100 font-semibold p-1.5 w-1/4 text-xs">Student Name:</td><td className="border border-gray-400 p-1.5 text-xs">{studentName || '—'}</td></tr>
                                    <tr><td className="border border-gray-400 bg-gray-100 font-semibold p-1.5 text-xs">Student ID:</td><td className="border border-gray-400 p-1.5 text-xs">{studentId || '—'}</td></tr>
                                    <tr>
                                      <td className="border border-gray-400 bg-gray-100 font-semibold p-1.5 text-xs">Start date:</td>
                                      <td className="border border-gray-400 p-1.5">
                                        <DatePicker value={sum.start_date ?? ''} onChange={(v) => handleAssessmentSummaryChange('start_date', v || null)} disabled={!canEditSummaryCoverDates} compact placement="above" className="max-w-[120px]" />
                                      </td>
                                      <td className="border border-gray-400 bg-gray-100 font-semibold p-1.5 text-right text-xs">End Date:</td>
                                      <td className="border border-gray-400 p-1.5">
                                        <DatePicker
                                          value={sum.end_date ?? ''}
                                          onChange={(v) => {
                                            const start = String(sum.start_date ?? '').trim();
                                            const next = String(v ?? '').trim();
                                            // Clamp: End Date cannot be earlier than Start Date.
                                            if (start && next && isCalendarBefore(next, start)) {
                                              handleAssessmentSummaryChange('end_date', start);
                                              return;
                                            }
                                            handleAssessmentSummaryChange('end_date', v || null);
                                          }}
                                          disabled={!canEditSummaryCoverDates}
                                          compact
                                          placement="above"
                                          className="max-w-[120px]"
                                          minDate={sum.start_date ?? undefined}
                                        />
                                      </td>
                                    </tr>
                                    <tr><td className="border border-gray-400 bg-gray-100 font-semibold p-1.5 text-xs">Unit Code & Name:</td><td className="border border-gray-400 p-1.5 text-xs" colSpan={3}>{unitCodeName || '—'}</td></tr>
                                  </tbody>
                                </table>
                                <div className="bg-gray-200 font-semibold text-gray-700 px-4 py-1.5 text-xs">Please attach the following evidence to this form</div>
                                <table className="w-full min-w-[520px] border-collapse border border-gray-400 text-xs">
                                  <thead>
                                    <tr><th className="border border-gray-400 bg-gray-200 p-1.5 text-left w-1/4 text-xs"></th><th colSpan={3} className="border border-gray-400 bg-[#5E5E5E] text-white font-bold p-1.5 text-center text-xs">Result</th></tr>
                                    <tr><th className="border border-gray-400 bg-gray-200 p-1.5"></th><th className="border border-gray-400 bg-[#5E5E5E] text-white font-bold p-1.5 text-center text-xs">1st Attempt</th><th className="border border-gray-400 bg-[#5E5E5E] text-white font-bold p-1.5 text-center text-xs">2nd Attempt</th><th className="border border-gray-400 bg-[#5E5E5E] text-white font-bold p-1.5 text-center text-xs">3rd Attempt</th></tr>
                                  </thead>
                                  <tbody>
                                    {taskResultEntries.length === 0 ? (
                                      <tr>
                                        <td className="border border-gray-400 bg-gray-100 font-semibold p-1.5 text-xs">Assessment tasks</td>
                                        <td className="border border-gray-400 p-1.5 text-center text-[10px] text-amber-800" colSpan={3}>
                                          No task Results sections found in this form.
                                        </td>
                                      </tr>
                                    ) : (
                                      taskResultEntries.map((entry) => {
                                        const rd =
                                          entry.taskRowId != null
                                            ? getMergedResultsForTaskRow(template, entry.taskRowId, resultsData)
                                            : entry.sectionId != null
                                              ? resultsData[entry.sectionId]
                                              : null;
                                        const sat1 = getEffectiveAttemptSat(
                                          template,
                                          entry.sectionId,
                                          entry.taskRowId,
                                          1,
                                          resultsData,
                                          answers,
                                          trainerAssessments
                                        );
                                        const sat2 = getEffectiveAttemptSat(
                                          template,
                                          entry.sectionId,
                                          entry.taskRowId,
                                          2,
                                          resultsData,
                                          answers,
                                          trainerAssessments
                                        );
                                        const sat3 = getEffectiveAttemptSat(
                                          template,
                                          entry.sectionId,
                                          entry.taskRowId,
                                          3,
                                          resultsData,
                                          answers,
                                          trainerAssessments
                                        );
                                        const check1 = sumFirstAttemptChecks.find((c) => c.label === entry.label);
                                        const check2 = sumSecondAttemptChecks.find((c) => c.label === entry.label);
                                        const check3 = sumThirdAttemptChecks.find((c) => c.label === entry.label);
                                        const cellClass = (status: typeof check1) =>
                                          status?.status === 'unmarked'
                                            ? 'text-amber-800 font-semibold'
                                            : status?.status === 'not_satisfactory'
                                              ? 'text-rose-800 font-semibold'
                                              : '';
                                        return (
                                          <tr key={entry.taskRowId ?? entry.sectionId ?? entry.label}>
                                            <td className="border border-gray-400 bg-gray-100 font-semibold p-1.5 text-xs">{entry.label}</td>
                                            <td className={`border border-gray-400 p-1.5 text-center ${cellClass(check1)}`}>
                                              <div className="flex flex-col gap-0.5 items-center"><span className="text-[10px]">{formatAttemptSatLabel(sat1)}</span><span className="text-[10px]">Date: {formatSummaryDisplayDate(rd?.first_attempt_date)}</span></div>
                                            </td>
                                            <td className={`border border-gray-400 p-1.5 text-center ${cellClass(check2)}`}>
                                              <div className="flex flex-col gap-0.5 items-center"><span className="text-[10px]">{formatAttemptSatLabel(sat2)}</span><span className="text-[10px]">Date: {formatSummaryDisplayDate(rd?.second_attempt_date)}</span></div>
                                            </td>
                                            <td className={`border border-gray-400 p-1.5 text-center ${cellClass(check3)}`}>
                                              <div className="flex flex-col gap-0.5 items-center"><span className="text-[10px]">{formatAttemptSatLabel(sat3)}</span><span className="text-[10px]">Date: {formatSummaryDisplayDate(rd?.third_attempt_date)}</span></div>
                                            </td>
                                          </tr>
                                        );
                                      })
                                    )}
                                    {competentBlockers.length > 0 && trainerCanEdit && (
                                      <tr>
                                        <td colSpan={4} className="border border-amber-300 bg-amber-50 p-2 text-[10px] text-amber-950">
                                          <span className="font-semibold">Before marking Competent ({activeAttemptNum === 1 ? '1st' : activeAttemptNum === 2 ? '2nd' : '3rd'} attempt):</span>
                                          <ul className="mt-1 list-disc pl-4 space-y-0.5">
                                            {competentBlockers.map((b) => (
                                              <li key={b.label}>
                                                <span className="font-medium">{b.label}</span> — {b.detail}
                                              </li>
                                            ))}
                                          </ul>
                                        </td>
                                      </tr>
                                    )}
                                    <tr className="border-t-2 border-gray-500">
                                      <td className="border border-gray-400 bg-gray-100 font-semibold p-1.5 text-xs">Final Assessment result for this unit</td>
                                      <td className="border border-gray-400 p-1.5">
                                        <div className="flex flex-col gap-0.5">
                                          <label className="flex items-center gap-1.5 cursor-pointer text-[10px]"><input type="radio" name="final-1" checked={sum.final_attempt_1_result === 'competent'} onClick={() => { if (trainerCanEdit && sumTrainerFirstEditable && sum.final_attempt_1_result === 'competent') void handleAssessmentSummaryChange('final_attempt_1_result', null); }} onChange={() => handleSummaryOutcomeSelect('final_attempt_1_result', 'competent', trainerCanEdit && sumTrainerFirstEditable)} disabled={!trainerCanEdit || !sumTrainerFirstEditable} className="w-3.5 h-3.5" /> Competent</label>
                                          <label className="flex items-center gap-1.5 cursor-pointer text-[10px]"><input type="radio" name="final-1" checked={sum.final_attempt_1_result === 'not_yet_competent'} onClick={() => { if (trainerCanEdit && sumTrainerFirstEditable && sum.final_attempt_1_result === 'not_yet_competent') void handleAssessmentSummaryChange('final_attempt_1_result', null); }} onChange={() => handleSummaryOutcomeSelect('final_attempt_1_result', 'not_yet_competent', trainerCanEdit && sumTrainerFirstEditable)} disabled={!trainerCanEdit || !sumTrainerFirstEditable} className="w-3.5 h-3.5" /> Not Yet Competent</label>
                                          {trainerCanEdit && sumTrainerFirstEditable && sum.final_attempt_1_result && (
                                            <button type="button" className="text-[10px] text-gray-500 underline text-left" onClick={() => void handleAssessmentSummaryChange('final_attempt_1_result', null)}>Clear outcome</button>
                                          )}
                                          <span className="text-[10px] text-gray-700">Date: {formatSummaryDisplayDate(finalDate1)}</span>
                                        </div>
                                      </td>
                                      <td className="border border-gray-400 p-1.5">
                                        <div className="flex flex-col gap-0.5">
                                          <label className="flex items-center gap-1.5 cursor-pointer text-[10px]"><input type="radio" name="final-2" checked={sum.final_attempt_2_result === 'competent'} onClick={() => { if (trainerCanEdit && sumTrainerSecondEditable && sum.final_attempt_2_result === 'competent') void handleAssessmentSummaryChange('final_attempt_2_result', null); }} onChange={() => handleSummaryOutcomeSelect('final_attempt_2_result', 'competent', trainerCanEdit && sumTrainerSecondEditable)} disabled={!trainerCanEdit || !sumTrainerSecondEditable} className="w-3.5 h-3.5" /> Competent</label>
                                          <label className="flex items-center gap-1.5 cursor-pointer text-[10px]"><input type="radio" name="final-2" checked={sum.final_attempt_2_result === 'not_yet_competent'} onClick={() => { if (trainerCanEdit && sumTrainerSecondEditable && sum.final_attempt_2_result === 'not_yet_competent') void handleAssessmentSummaryChange('final_attempt_2_result', null); }} onChange={() => handleSummaryOutcomeSelect('final_attempt_2_result', 'not_yet_competent', trainerCanEdit && sumTrainerSecondEditable)} disabled={!trainerCanEdit || !sumTrainerSecondEditable} className="w-3.5 h-3.5" /> Not Yet Competent</label>
                                          {trainerCanEdit && sumTrainerSecondEditable && sum.final_attempt_2_result && (
                                            <button type="button" className="text-[10px] text-gray-500 underline text-left" onClick={() => void handleAssessmentSummaryChange('final_attempt_2_result', null)}>Clear outcome</button>
                                          )}
                                          <span className="text-[10px] text-gray-700">Date: {formatSummaryDisplayDate(finalDate2)}</span>
                                        </div>
                                      </td>
                                      <td className="border border-gray-400 p-1.5">
                                        <div className="flex flex-col gap-0.5">
                                          <label className="flex items-center gap-1.5 cursor-pointer text-[10px]"><input type="radio" name="final-3" checked={sum.final_attempt_3_result === 'competent'} onClick={() => { if (trainerCanEdit && sumTrainerThirdEditable && sum.final_attempt_3_result === 'competent') void handleAssessmentSummaryChange('final_attempt_3_result', null); }} onChange={() => handleSummaryOutcomeSelect('final_attempt_3_result', 'competent', trainerCanEdit && sumTrainerThirdEditable)} disabled={!trainerCanEdit || !sumTrainerThirdEditable} className="w-3.5 h-3.5" /> Competent</label>
                                          <label className="flex items-center gap-1.5 cursor-pointer text-[10px]"><input type="radio" name="final-3" checked={sum.final_attempt_3_result === 'not_yet_competent'} onClick={() => { if (trainerCanEdit && sumTrainerThirdEditable && sum.final_attempt_3_result === 'not_yet_competent') void handleAssessmentSummaryChange('final_attempt_3_result', null); }} onChange={() => handleSummaryOutcomeSelect('final_attempt_3_result', 'not_yet_competent', trainerCanEdit && sumTrainerThirdEditable)} disabled={!trainerCanEdit || !sumTrainerThirdEditable} className="w-3.5 h-3.5" /> Not Yet Competent</label>
                                          {trainerCanEdit && sumTrainerThirdEditable && sum.final_attempt_3_result && (
                                            <button type="button" className="text-[10px] text-gray-500 underline text-left" onClick={() => void handleAssessmentSummaryChange('final_attempt_3_result', null)}>Clear outcome</button>
                                          )}
                                          <span className="text-[10px] text-gray-700">Date: {formatSummaryDisplayDate(finalDate3)}</span>
                                        </div>
                                      </td>
                                    </tr>
                                    <tr>
                                      <td className="border border-gray-400 bg-gray-100 font-semibold p-1.5 text-xs">Trainer/Assessor Signature</td>
                                      <td colSpan={3} className="border border-gray-400 p-1.5">
                                        <p className="text-[10px] text-gray-600 mb-1.5">I declare that I have conducted a fair, valid, reliable, and flexible assessment with this student, and I have provided appropriate feedback</p>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 min-w-0">
                                          <div className="min-w-0"><span className="text-xs font-medium">Signature:</span> <SignatureField value={sum.trainer_sig_1 ?? null} onChange={(v) => { handleAssessmentSummaryChange('trainer_sig_1', v); const cur = String(sum.trainer_date_1 ?? '').trim(); if ((!cur || (minTrainerDate1 && isCalendarBefore(cur, minTrainerDate1)))) handleAssessmentSummaryChange('trainer_date_1', minTrainerDate1 ?? null); }} disabled={!trainerCanEdit || !sumTrainerFirstEditable} className="mt-0.5" highlight={(role === 'trainer' && sumTrainerFirstEditable) || adminOverride} suggestionFrom={trainerRefSig} onSuggestionClick={trainerRefSig ? () => { handleAssessmentSummaryChange('trainer_sig_1', trainerRefSig); const next = staffBypassDateConstraints ? trainerRefDate : (maxIsoDate(trainerRefDate, minTrainerDate1) ?? minTrainerDate1 ?? trainerRefDate); handleAssessmentSummaryChange('trainer_date_1', next || null); } : undefined} /></div>
                                          <div className="min-w-0"><span className="text-xs font-medium">Signature:</span> <SignatureField value={sum.trainer_sig_2 ?? null} onChange={(v) => { handleAssessmentSummaryChange('trainer_sig_2', v); const cur = String(sum.trainer_date_2 ?? '').trim(); if ((!cur || (minTrainerDate2 && isCalendarBefore(cur, minTrainerDate2)))) handleAssessmentSummaryChange('trainer_date_2', minTrainerDate2 ?? null); }} disabled={!trainerCanEdit || !sumTrainerSecondEditable} className="mt-0.5" highlight={(role === 'trainer' && sumTrainerSecondEditable) || adminOverride} suggestionFrom={sumTrainerSecondEditable ? (sum.trainer_sig_1 ?? undefined) : undefined} onSuggestionClick={sumTrainerSecondEditable && sum.trainer_sig_1 ? () => { handleAssessmentSummaryChange('trainer_sig_2', sum.trainer_sig_1); const next = staffBypassDateConstraints ? (sum.trainer_date_1 ?? sum.student_date_2 ?? null) : (maxIsoDate(sum.trainer_date_1, sum.student_date_2, minTrainerDate2) ?? minTrainerDate2 ?? sum.trainer_date_1 ?? sum.student_date_2); handleAssessmentSummaryChange('trainer_date_2', next || null); } : undefined} /></div>
                                          <div className="min-w-0"><span className="text-xs font-medium">Signature:</span> <SignatureField value={sum.trainer_sig_3 ?? null} onChange={(v) => { handleAssessmentSummaryChange('trainer_sig_3', v); const cur = String(sum.trainer_date_3 ?? '').trim(); if ((!cur || (minTrainerDate3 && isCalendarBefore(cur, minTrainerDate3)))) handleAssessmentSummaryChange('trainer_date_3', minTrainerDate3 ?? null); }} disabled={!trainerCanEdit || !sumTrainerThirdEditable} className="mt-0.5" highlight={(role === 'trainer' && sumTrainerThirdEditable) || adminOverride} suggestionFrom={sumTrainerThirdEditable ? (sum.trainer_sig_1 ?? undefined) : undefined} onSuggestionClick={sumTrainerThirdEditable && sum.trainer_sig_1 ? () => { handleAssessmentSummaryChange('trainer_sig_3', sum.trainer_sig_1); const next = staffBypassDateConstraints ? (sum.trainer_date_2 ?? sum.student_date_3 ?? null) : (maxIsoDate(sum.trainer_date_2, sum.student_date_3, minTrainerDate3) ?? minTrainerDate3 ?? sum.trainer_date_2 ?? sum.student_date_3); handleAssessmentSummaryChange('trainer_date_3', next || null); } : undefined} /></div>
                                          <div className="min-w-0"><span className="text-xs font-medium">Date:</span> <DatePicker value={sum.trainer_date_1 ?? ''} onChange={(v) => handleAssessmentSummaryChange('trainer_date_1', pickDateWithMinForStaff(v || null, minTrainerDate1, staffBypassDateConstraints))} disabled={!trainerCanEdit || !sumFirstDateEditable} highlight={(role === 'trainer' && sumFirstDateEditable) || adminOverride} compact placement="above" className="w-full" minDate={staffDatePickerMin(minTrainerDate1, staffBypassDateConstraints)} error={summaryDateError('trainer_date_1')} /></div>
                                          <div className="min-w-0"><span className="text-xs font-medium">Date:</span> <DatePicker value={sum.trainer_date_2 ?? ''} onChange={(v) => handleAssessmentSummaryChange('trainer_date_2', pickDateWithMinForStaff(v || null, minTrainerDate2, staffBypassDateConstraints))} disabled={!trainerCanEdit || !sumSecondDateEditable} highlight={(role === 'trainer' && sumSecondDateEditable) || adminOverride} compact placement="above" className="w-full" minDate={staffDatePickerMin(minTrainerDate2, staffBypassDateConstraints)} error={summaryDateError('trainer_date_2')} /></div>
                                          <div className="min-w-0"><span className="text-xs font-medium">Date:</span> <DatePicker value={sum.trainer_date_3 ?? ''} onChange={(v) => handleAssessmentSummaryChange('trainer_date_3', pickDateWithMinForStaff(v || null, minTrainerDate3, staffBypassDateConstraints))} disabled={!trainerCanEdit || !sumThirdDateEditable} highlight={(role === 'trainer' && sumThirdDateEditable) || adminOverride} compact placement="above" className="w-full" minDate={staffDatePickerMin(minTrainerDate3, staffBypassDateConstraints)} error={summaryDateError('trainer_date_3')} /></div>
                                        </div>
                                      </td>
                                    </tr>
                                    <tr>
                                      <td className="border border-gray-400 bg-gray-100 font-semibold p-1.5 text-xs">Student:</td>
                                      <td colSpan={3} className="border border-gray-400 p-1.5">
                                        <p className="text-[10px] text-gray-600 mb-1.5">I declare that I have been assessed in this unit, and I have been advised of my result. I also am aware of my appeal rights.</p>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 min-w-0">
                                          <div className="min-w-0"><span className="text-xs font-medium">Signature:</span> <SignatureField value={sum.student_sig_1 ?? null} onChange={(v) => { handleAssessmentSummaryChange('student_sig_1', v); const cur = String(sum.student_date_1 ?? '').trim(); if ((!cur || (minStudentDate1 && isCalendarBefore(cur, minStudentDate1)))) handleAssessmentSummaryChange('student_date_1', minStudentDate1 ?? null); }} disabled={!studentCanEdit || !sumStudentFirstEditable} className="mt-0.5" highlight={studentCanEdit && sumStudentFirstEditable} suggestionFrom={studentRefSig} onSuggestionClick={studentRefSig ? () => { handleAssessmentSummaryChange('student_sig_1', studentRefSig); const next = staffBypassDateConstraints ? studentRefDate : (maxIsoDate(studentRefDate, minStudentDate1) ?? minStudentDate1 ?? studentRefDate); handleAssessmentSummaryChange('student_date_1', next || null); } : undefined} /></div>
                                          <div className="min-w-0"><span className="text-xs font-medium">Signature:</span> <SignatureField value={sum.student_sig_2 ?? null} onChange={(v) => { handleAssessmentSummaryChange('student_sig_2', v); const cur = String(sum.student_date_2 ?? '').trim(); if ((!cur || (minStudentDate2 && isCalendarBefore(cur, minStudentDate2)))) handleAssessmentSummaryChange('student_date_2', minStudentDate2 ?? null); }} disabled={!studentCanEdit || !sumStudentSecondEditable} className="mt-0.5" highlight={studentCanEdit && sumStudentSecondEditable} suggestionFrom={sumStudentSecondEditable ? (sum.student_sig_1 ?? undefined) : undefined} onSuggestionClick={sumStudentSecondEditable && sum.student_sig_1 ? () => { handleAssessmentSummaryChange('student_sig_2', sum.student_sig_1); const next = staffBypassDateConstraints ? (sum.student_date_1 ?? null) : (maxIsoDate(sum.student_date_1, minStudentDate2) ?? minStudentDate2 ?? sum.student_date_1); handleAssessmentSummaryChange('student_date_2', next || null); } : undefined} /></div>
                                          <div className="min-w-0"><span className="text-xs font-medium">Signature:</span> <SignatureField value={sum.student_sig_3 ?? null} onChange={(v) => { handleAssessmentSummaryChange('student_sig_3', v); const cur = String(sum.student_date_3 ?? '').trim(); if ((!cur || (minStudentDate3 && isCalendarBefore(cur, minStudentDate3)))) handleAssessmentSummaryChange('student_date_3', minStudentDate3 ?? null); }} disabled={!studentCanEdit || !sumStudentThirdEditable} className="mt-0.5" highlight={studentCanEdit && sumStudentThirdEditable} suggestionFrom={sumStudentThirdEditable ? (sum.student_sig_1 ?? undefined) : undefined} onSuggestionClick={sumStudentThirdEditable && sum.student_sig_1 ? () => { handleAssessmentSummaryChange('student_sig_3', sum.student_sig_1); const next = staffBypassDateConstraints ? (sum.student_date_2 ?? null) : (maxIsoDate(sum.student_date_2, minStudentDate3) ?? minStudentDate3 ?? sum.student_date_2); handleAssessmentSummaryChange('student_date_3', next || null); } : undefined} /></div>
                                          <div className="min-w-0"><span className="text-xs font-medium">Date:</span> <DatePicker value={sum.student_date_1 ?? ''} onChange={(v) => handleAssessmentSummaryChange('student_date_1', pickDateWithMinForStaff(v || null, minStudentDate1, staffBypassDateConstraints))} disabled={!(studentCanEdit && sumStudentFirstDateEditable) && !(staffCanCorrectSheetDates && sumTrainerFirstEditable)} highlight={(studentCanEdit && sumStudentFirstDateEditable) || (staffCanCorrectSheetDates && sumTrainerFirstEditable)} compact placement="above" className="w-full" minDate={staffDatePickerMin(minStudentDate1, staffBypassDateConstraints)} error={summaryDateError('student_date_1')} /></div>
                                          <div className="min-w-0"><span className="text-xs font-medium">Date:</span> <DatePicker value={sum.student_date_2 ?? ''} onChange={(v) => handleAssessmentSummaryChange('student_date_2', pickDateWithMinForStaff(v || null, minStudentDate2, staffBypassDateConstraints))} disabled={!(studentCanEdit && sumStudentSecondDateEditable) && !(staffCanCorrectSheetDates && sumTrainerSecondEditable)} highlight={(studentCanEdit && sumStudentSecondDateEditable) || (staffCanCorrectSheetDates && sumTrainerSecondEditable)} compact placement="above" className="w-full" minDate={staffDatePickerMin(minStudentDate2, staffBypassDateConstraints)} error={summaryDateError('student_date_2')} /></div>
                                          <div className="min-w-0"><span className="text-xs font-medium">Date:</span> <DatePicker value={sum.student_date_3 ?? ''} onChange={(v) => handleAssessmentSummaryChange('student_date_3', pickDateWithMinForStaff(v || null, minStudentDate3, staffBypassDateConstraints))} disabled={!(studentCanEdit && sumStudentThirdDateEditable) && !(staffCanCorrectSheetDates && sumTrainerThirdEditable)} highlight={(studentCanEdit && sumStudentThirdDateEditable) || (staffCanCorrectSheetDates && sumTrainerThirdEditable)} compact placement="above" className="w-full" minDate={staffDatePickerMin(minStudentDate3, staffBypassDateConstraints)} error={summaryDateError('student_date_3')} /></div>
                                        </div>
                                      </td>
                                    </tr>
                                    <tr>
                                      <td className="border border-gray-400 bg-gray-100 font-semibold p-1.5 text-xs">Student overall Feedback:</td>
                                      <td colSpan={3} className="border border-gray-400 p-1.5">
                                        <textarea
                                          value={sum.student_overall_feedback ?? ''}
                                          onChange={(e) => handleAssessmentSummaryChange('student_overall_feedback', e.target.value || null)}
                                          disabled={!trainerCanEdit}
                                          className={`w-full border border-gray-400 min-h-[60px] p-1.5 text-xs ${
                                            role === 'student' ? 'bg-blue-50/70' : ''
                                          }`}
                                        />
                                      </td>
                                    </tr>
                                    <tr>
                                      <td colSpan={2} className="border border-gray-400 bg-[#f5f0e6] font-semibold italic p-1.5 text-xs">Administrative use only - Entered onto Student Management Database</td>
                                      <td colSpan={2} className="border border-gray-400 bg-[#f5f0e6] p-1.5">
                                        <div className="flex flex-wrap items-center gap-4">
                                          <label className="inline-flex items-center gap-2 cursor-pointer text-xs">
                                            <input
                                              type="checkbox"
                                              checked={Boolean(sum.admin_initial_checked)}
                                              onChange={(e) => handleAssessmentSummaryChange('admin_initial_checked', e.target.checked)}
                                              disabled={!officeCanEdit}
                                              className="w-4 h-4 rounded border-gray-400"
                                            />
                                            <span className="font-medium">Initial</span>
                                          </label>
                                          <label className="inline-flex items-center gap-2 cursor-pointer text-xs">
                                            <input
                                              type="checkbox"
                                              checked={Boolean(sum.admin_updated_checked)}
                                              onChange={(e) => handleAssessmentSummaryChange('admin_updated_checked', e.target.checked)}
                                              disabled={!officeCanEdit}
                                              className="w-4 h-4 rounded border-gray-400"
                                            />
                                            <span className="font-medium">Updated</span>
                                          </label>
                                        </div>
                                      </td>
                                    </tr>
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          );
                        })()
                      ) : section.pdf_render_mode === 'likert_table' ? (
                        <>
                          <SectionLikertTable
                            section={section}
                            getAnswer={(qId, rId) => {
                              const v = answers[getAnswerKey(qId, rId)];
                              return v != null ? String(v) : null;
                            }}
                            onChange={(qId, rId, val) => handleAnswerChange(qId, rId, val)}
                            disabled={
                              !canRoleEditCurrentWorkflow ||
                              !section.questions.some((q) =>
                                isQuestionEditableForRole((q.role_editability as Record<string, boolean>) || {})
                              )
                            }
                          />
                          {section.questions
                            .filter(
                              (q) =>
                                q.type !== 'likert_5' &&
                                isQuestionVisibleForRole((q.role_visibility as Record<string, boolean>) || {}) &&
                                !(assessmentSubmissionHasDeclSig && section.pdf_render_mode === 'declarations' && q.code === 'student.declarationSignature')
                            )
                            .map((q) => {
                              const re = (q.role_editability as Record<string, boolean>) || {};
                              const editable = isQuestionEditableForRole(re) && canRoleEditCurrentWorkflow;
                              const key = getAnswerKey(q.id, null);
                              const val = answers[key];
                              if (q.type === 'signature' && (q.code === 'student.declarationSignature' || String(q.code || '').startsWith('student.'))) {
                                const taskResultSectionIds = (template?.steps ?? []).flatMap((st) => st.sections).filter((s) => s.pdf_render_mode === 'task_results').map((s) => s.id);
                                const firstTaskSectionId = taskResultSectionIds[0];
                                const firstTaskRdForDecl = firstTaskSectionId ? resultsData[firstTaskSectionId] : null;
                                const studentSigSuggestion = firstTaskRdForDecl?.student_signature ?? null;
                                const sigVal = val;
                                const sigObj = sigVal && typeof sigVal === 'object' && !Array.isArray(sigVal) ? (sigVal as Record<string, unknown>) : null;
                                const imgVal = sigObj?.signature ?? sigObj?.imageDataUrl ?? (typeof sigVal === 'string' ? sigVal : null);
                                const dateVal = sigObj ? String(sigObj.date ?? sigObj.signedAtDate ?? '') : '';
                                const todayIsoDecl = new Date().toISOString().split('T')[0];
                                const hasDateField = (q.pdf_meta as { showDateField?: boolean } | undefined)?.showDateField;
                                const minDeclDate = getStudentResubDeclarationMinDate(firstTaskRdForDecl, submissionCount);
                                const effectiveEditable = getStudentDeclarationEditable(editable, q.code ?? undefined);
                                return (
                                  <div
                                    key={q.id}
                                    data-question-id={q.id}
                                    className={`space-y-2 rounded-md ${errors[`q-${q.id}`] ? 'ring-2 ring-red-400 bg-red-50/40 p-2' : ''}`}
                                  >
                                    <div className="text-sm font-semibold text-gray-700">{q.label}{q.required ? ' *' : ''}</div>
                                    {errors[`q-${q.id}`] ? (
                                      <p className="text-sm text-red-700" role="alert">{errors[`q-${q.id}`]}</p>
                                    ) : null}
                                    <div className="flex items-center gap-4 flex-wrap">
                                      <div className="flex-1 min-w-[200px]">
                                        <SignatureField
                                          value={(imgVal as string | null) ?? null}
                                          onChange={(v) => {
                                            const img = typeof v === 'string' ? v : null;
                                            const base = (sigObj && typeof sigObj === 'object' ? { ...sigObj } : {}) as Record<string, unknown>;
                                            const merged = img != null ? { ...base, signature: img } : { ...base, signature: null };
                                            handleAnswerChange(q.id, null, merged as string | number | boolean | Record<string, unknown> | string[]);
                                          }}
                                          disabled={!effectiveEditable}
                                          highlight={(role === 'student' || role === 'trainer') && editable}
                                          suggestionFrom={studentSigSuggestion}
                                          onSuggestionClick={studentSigSuggestion && effectiveEditable ? () => {
                                            const base = (sigObj && typeof sigObj === 'object' ? { ...sigObj } : {}) as Record<string, unknown>;
                                            const nextDate = staffBypassDateConstraints
                                              ? todayIsoDecl
                                              : minDeclDate && isCalendarBefore(todayIsoDecl, minDeclDate)
                                                ? minDeclDate
                                                : todayIsoDecl;
                                            handleAnswerChange(q.id, null, { ...base, signature: studentSigSuggestion, date: nextDate } as string | number | boolean | Record<string, unknown> | string[], true);
                                          } : undefined}
                                        />
                                      </div>
                                      {hasDateField && (
                                        <div className="flex items-center gap-2 min-w-[140px]">
                                          <span className="text-sm font-semibold text-gray-700 shrink-0">Date:</span>
                                          <DatePicker
                                            value={dateVal}
                                            onChange={(newDate) => {
                                              const base = sigObj || (typeof sigVal === 'string' ? { signature: sigVal } : {});
                                              const nextDate = staffBypassDateConstraints
                                                ? newDate
                                                : minDeclDate && newDate && isCalendarBefore(newDate, minDeclDate)
                                                  ? minDeclDate
                                                  : newDate;
                                              handleAnswerChange(q.id, null, { ...base, date: nextDate } as string | number | boolean | Record<string, unknown> | string[]);
                                            }}
                                            disabled={!effectiveEditable}
                                            highlight={(role === 'student' || role === 'trainer') && editable}
                                            compact
                                            placement="above"
                                            className="flex-1 min-w-0"
                                            minDate={staffDatePickerMin(minDeclDate, staffBypassDateConstraints)}
                                          />
                                        </div>
                                      )}
                                    </div>
                                    {errors[`q-${q.id}`] && <p className="text-sm text-red-600">{errors[`q-${q.id}`]}</p>}
                                  </div>
                                );
                              }
                              return (
                                <QuestionRenderer
                                  instanceId={id}
                                  key={q.id}
                                  question={q}
                                  value={(val as string | number | boolean | Record<string, unknown> | string[]) ?? null}
                                  onChange={(v) => handleAnswerChange(q.id, null, v as string | number | boolean | Record<string, unknown> | string[])}
                                  disabled={!editable}
                                  error={errors[`q-${q.id}`]}
                                  declarationStyle={section.pdf_render_mode === 'declarations'}
                                  highlightAsFill={editable}
                                />
                              );
                            })}
                        </>
                      ) : (
                        section.questions
                        .filter(
                          (q) =>
                            q.type !== 'instruction_block' &&
                            isQuestionVisibleForRole((q.role_visibility as Record<string, boolean>) || {}) &&
                            !(assessmentSubmissionHasDeclSig && section.pdf_render_mode === 'declarations' && q.code === 'student.declarationSignature')
                        )
                        .map((q) => {
                          const taskResultSectionIdsForEval = (template?.steps ?? [])
                            .flatMap((st) => st.sections)
                            .filter((s) => s.pdf_render_mode === 'task_results')
                            .map((s) => s.id);
                          const firstTaskRdForEvalDate = taskResultSectionIdsForEval[0]
                            ? resultsData[taskResultSectionIdsForEval[0]]
                            : null;
                          const minEvaluationDateIso = maxIsoDate(
                            studentDeclarationDateMinIso,
                            firstTaskRdForEvalDate?.first_attempt_date != null &&
                              String(firstTaskRdForEvalDate.first_attempt_date).trim()
                              ? normalizeCalendarDateToIso(String(firstTaskRdForEvalDate.first_attempt_date)) ?? undefined
                              : undefined,
                          );
                          const re = (q.role_editability as Record<string, boolean>) || {};
                          const isQualUnitField = q.code === 'qualification.code' || q.code === 'qualification.name' || q.code === 'unit.code' || q.code === 'unit.name';
                          const isEvalUnitName = q.code === 'evaluation.unitName';
                          const isEvalTrainerName = q.code === 'evaluation.trainerName';
                          const isEvalEmployer = q.code === 'evaluation.employer';
                          const isEvalTrainingDates = q.code === 'evaluation.trainingDates';
                          const isEvalEvaluationDate = q.code === 'evaluation.evaluationDate';
                          const trainerCanEditHere = role === 'trainer' || role === 'office';
                          const baseEditable = isQualUnitField || isEvalUnitName
                            ? false
                            : isEvalTrainerName || isEvalEmployer || isEvalTrainingDates || isEvalEvaluationDate
                              ? (trainerCanEditHere && canRoleEditCurrentWorkflow)
                              : (isQuestionEditableForRole(re) && canRoleEditCurrentWorkflow);
                          const editable = baseEditable;
                          if (q.type === 'likert_5' && q.rows.length > 0) {
                            const val =
                              q.rows.length === 1
                                ? (answers[getAnswerKey(q.id, q.rows[0].id)] as string) ?? null
                                : (() => {
                                    const m: Record<string, string> = {};
                                    for (const r of q.rows) {
                                      const v = answers[getAnswerKey(q.id, r.id)];
                                      if (v != null) m[`row-${r.id}`] = String(v);
                                    }
                                    return Object.keys(m).length ? m : null;
                                  })();
                            const onLikertChange = (v: string | number | boolean | Record<string, unknown> | string[]) => {
                              if (q.rows.length === 1) {
                                handleAnswerChange(q.id, q.rows[0].id, typeof v === 'string' ? v : String(v));
                              } else {
                                const o = v as Record<string, string>;
                                if (o && typeof o === 'object') {
                                  for (const r of q.rows) {
                                    const rv = o[`row-${r.id}`];
                                    if (rv != null) handleAnswerChange(q.id, r.id, rv);
                                  }
                                }
                              }
                            };
                            return (
                              <QuestionRenderer
                                instanceId={id}
                                key={q.id}
                                question={q}
                                value={val}
                                onChange={onLikertChange}
                                disabled={!editable}
                                error={errors[`q-${q.id}`]}
                                highlightAsFill={editable}
                              />
                            );
                          }
                          if (q.type === 'grid_table' && q.rows.length > 0) {
                            const merged = mergeGridTableAnswers(q, answers);
                            const onGridChange = (v: string | number | boolean | Record<string, unknown> | string[]) => {
                              const byRow = new Map<number, Record<string, string>>();
                              const o = v as Record<string, string>;
                              if (!o || typeof o !== 'object') return;
                              for (const [k, val] of Object.entries(o)) {
                                const match = /^r(\d+)_c/.exec(k);
                                if (match) {
                                  const rowId = Number(match[1]);
                                  if (!byRow.has(rowId)) byRow.set(rowId, {});
                                  byRow.get(rowId)![k] = String(val);
                                }
                              }
                              for (const [rowId, rowData] of byRow.entries()) {
                                handleAnswerChange(q.id, rowId, rowData);
                              }
                            };
                            return (
                              <QuestionRenderer
                                instanceId={id}
                                key={q.id}
                                question={q}
                                value={Object.keys(merged).length ? merged : null}
                                onChange={onGridChange}
                                disabled={!editable}
                                error={errors[`q-${q.id}`]}
                                highlightAsFill={editable}
                              />
                            );
                          }
                          const key = getAnswerKey(q.id, null);
                          let val = answers[key];
                          if (q.type === 'signature' && (q.code === 'student.declarationSignature' || String(q.code || '').startsWith('student.'))) {
                            const taskResultSectionIds = (template?.steps ?? []).flatMap((st) => st.sections).filter((s) => s.pdf_render_mode === 'task_results').map((s) => s.id);
                            const firstTaskSectionId = taskResultSectionIds[0];
                            const firstTaskRdForDecl = firstTaskSectionId ? resultsData[firstTaskSectionId] : null;
                            const studentSigSuggestion = firstTaskRdForDecl?.student_signature ?? null;
                            const sigVal = val;
                            const sigObj = sigVal && typeof sigVal === 'object' && !Array.isArray(sigVal) ? (sigVal as Record<string, unknown>) : null;
                            const imgVal = sigObj?.signature ?? sigObj?.imageDataUrl ?? (typeof sigVal === 'string' ? sigVal : null);
                            const dateVal = sigObj ? String(sigObj.date ?? sigObj.signedAtDate ?? '') : '';
                            const todayIsoDecl = new Date().toISOString().split('T')[0];
                            const hasDateField = (q.pdf_meta as { showDateField?: boolean } | undefined)?.showDateField;
                            const minDeclDate = getStudentResubDeclarationMinDate(firstTaskRdForDecl, submissionCount);
                            const effectiveEditable = getStudentDeclarationEditable(editable, q.code ?? undefined);
                            return (
                              <div
                                key={q.id}
                                data-question-id={q.id}
                                className={`space-y-2 rounded-md ${errors[`q-${q.id}`] ? 'ring-2 ring-red-400 bg-red-50/40 p-2' : ''}`}
                              >
                                <div className="text-sm font-semibold text-gray-700">{q.label}{q.required ? ' *' : ''}</div>
                                {errors[`q-${q.id}`] ? (
                                  <p className="text-sm text-red-700" role="alert">{errors[`q-${q.id}`]}</p>
                                ) : null}
                                <div className="flex items-center gap-4 flex-wrap">
                                  <div className="flex-1 min-w-[200px]">
                                    <SignatureField
                                      value={(imgVal as string | null) ?? null}
                                      onChange={(v) => {
                                        const img = typeof v === 'string' ? v : null;
                                        const base = (sigObj && typeof sigObj === 'object' ? { ...sigObj } : {}) as Record<string, unknown>;
                                        const merged = img != null ? { ...base, signature: img } : { ...base, signature: null };
                                        handleAnswerChange(q.id, null, merged as string | number | boolean | Record<string, unknown> | string[]);
                                      }}
                                      disabled={!effectiveEditable}
                                      suggestionFrom={studentSigSuggestion}
                                      onSuggestionClick={studentSigSuggestion && effectiveEditable ? () => {
                                        const base = (sigObj && typeof sigObj === 'object' ? { ...sigObj } : {}) as Record<string, unknown>;
                                        const nextDate = staffBypassDateConstraints
                                          ? todayIsoDecl
                                          : minDeclDate && isCalendarBefore(todayIsoDecl, minDeclDate)
                                            ? minDeclDate
                                            : todayIsoDecl;
                                        handleAnswerChange(q.id, null, { ...base, signature: studentSigSuggestion, date: nextDate } as string | number | boolean | Record<string, unknown> | string[], true);
                                      } : undefined}
                                    />
                                  </div>
                                  {hasDateField && (
                                    <div className="flex items-center gap-2 min-w-[140px]">
                                      <span className="text-sm font-semibold text-gray-700 shrink-0">Date:</span>
                                      <DatePicker
                                        value={dateVal}
                                        onChange={(newDate) => {
                                          const base = sigObj || (typeof sigVal === 'string' ? { signature: sigVal } : {});
                                          const nextDate = staffBypassDateConstraints
                                            ? newDate
                                            : minDeclDate && newDate && isCalendarBefore(newDate, minDeclDate)
                                              ? minDeclDate
                                              : newDate;
                                          handleAnswerChange(q.id, null, { ...base, date: nextDate } as string | number | boolean | Record<string, unknown> | string[]);
                                        }}
                                        disabled={!effectiveEditable}
                                        compact
                                        placement="above"
                                        className="flex-1 min-w-0"
                                        minDate={staffDatePickerMin(minDeclDate, staffBypassDateConstraints)}
                                      />
                                    </div>
                                  )}
                                </div>
                                {errors[`q-${q.id}`] && <p className="text-sm text-red-600">{errors[`q-${q.id}`]}</p>}
                              </div>
                            );
                          }
                          const formExt = template?.form as { qualification_code?: string | null; qualification_name?: string | null; unit_code?: string | null; unit_name?: string | null } | undefined;
                          if ((isQualUnitField || isEvalUnitName) && (val == null || val === '') && formExt) {
                            const fallback =
                              q.code === 'qualification.code' ? formExt.qualification_code
                              : q.code === 'qualification.name' ? formExt.qualification_name
                              : q.code === 'unit.code' ? formExt.unit_code
                              : q.code === 'unit.name' ? formExt.unit_name
                              : q.code === 'evaluation.unitName' ? [formExt.unit_code, formExt.unit_name].filter(Boolean).join(' ').trim() || null
                              : null;
                            val = fallback ?? '';
                          }
                          return (
                            <QuestionRenderer
                              instanceId={id}
                              key={q.id}
                              question={q}
                              value={(val as string | number | boolean | Record<string, unknown> | string[]) ?? null}
                              onChange={(v) => handleAnswerChange(q.id, null, v as string | number | boolean | Record<string, unknown> | string[])}
                              disabled={!editable}
                              error={errors[`q-${q.id}`]}
                              declarationStyle={section.pdf_render_mode === 'declarations'}
                              highlightAsFill={editable}
                              minDate={
                                q.code === 'evaluation.evaluationDate'
                                  ? staffDatePickerMin(minEvaluationDateIso, staffBypassDateConstraints)
                                  : undefined
                              }
                            />
                          );
                        })
                      )}
                    </div>
                  </div>
                ))}
              </Card>
            );
          })()
            ) : null}

            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
              <Button
                variant="outline"
                className="w-full sm:w-auto shrink-0"
                onClick={() => void handlePreviousStep()}
                disabled={currentStep <= 1 || stepNavSaving}
              >
                Back
              </Button>
              <Button
                variant="primary"
                className="w-full sm:w-auto shrink-0"
                onClick={() => void handleNextStep()}
                disabled={currentStep >= steps.length || stepNavSaving}
              >
                {stepNavSaving ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving…
                  </span>
                ) : (
                  'Next'
                )}
              </Button>
              {currentStep >= steps.length && role === 'student' && workflowStatus === 'draft' && (
                <Button variant="primary" className="w-full sm:w-auto shrink-0" onClick={handleFinalSubmitByRole} disabled={workflowSubmitting || stepNavSaving}>
                  Final Submit
                </Button>
              )}
              {currentStep >= steps.length && role === 'trainer' && trainerCanFinaliseReview && (
                <Button variant="primary" className="w-full sm:w-auto shrink-0" onClick={handleFinalSubmitByRole} disabled={workflowSubmitting || stepNavSaving}>
                  Trainer Checked (Submit)
                </Button>
              )}
              {currentStep >= steps.length && role === 'trainer' && !trainerCanFinaliseReview && (
                <Button
                  variant="primary"
                  className="w-full sm:w-auto shrink-0 opacity-60 cursor-not-allowed"
                  disabled
                  title={
                    workflowStatus === 'waiting_office'
                      ? 'This assessment is already with office for checking.'
                      : workflowStatus === 'completed' || instanceLegacyStatus === 'locked'
                        ? 'This assessment is already completed.'
                        : 'Trainer submit is not available in the current workflow state.'
                  }
                >
                  Trainer Checked (Submit)
                </Button>
              )}
              {currentStep >= steps.length && role === 'office' && (workflowStatus === 'waiting_office' || isAdminEditMode) && (
                <Button variant="primary" className="w-full sm:w-auto shrink-0" onClick={handleFinalSubmitByRole} disabled={workflowSubmitting || stepNavSaving}>
                  Office Checked
                </Button>
              )}
            </div>
            </fieldset>
          </form>

          {canViewPdfPreview && (
            <div className={`min-w-0 lg:col-span-3${stepNavSaving ? ' pointer-events-none opacity-60' : ''}`}>
              <div className="lg:sticky lg:top-3">
                <StoredPdfPanel
                  key={pdfRefresh}
                  instanceId={id}
                  role={role}
                  workflowStatus={workflowStatus}
                  legacyStatus={instanceLegacyStatus}
                  showLiveFallback={isAdminEditMode}
                />
              </div>
            </div>
          )}
        </div>
      </div>
      <ConfirmDialog
        isOpen={!!confirmConfig}
        onClose={() => setConfirmConfig(null)}
        onConfirm={runFinalSubmitByRole}
        title={confirmConfig?.title || 'Confirm'}
        message={confirmConfig?.message || ''}
        confirmLabel={confirmConfig?.confirmLabel || 'Confirm'}
        cancelLabel="Cancel"
        variant="default"
      />
      <ConfirmDialog
        isOpen={adminSkipSavePrompt != null}
        onClose={() => setAdminSkipSavePrompt(null)}
        onConfirm={() => {
          setAdminSkipSavePrompt(null);
          advanceToNextStepWithoutSave();
        }}
        title="Proceed without saving?"
        message={
          adminSkipSavePrompt === 'save'
            ? 'Changes on this step could not be saved. Proceed to the next step without writing them to the database?'
            : 'This step has incomplete required fields. Proceed to the next step without saving changes on this step?'
        }
        confirmLabel="Proceed without saving"
        cancelLabel="Stay on this step"
        variant="default"
      />
    </div>
  );
};
