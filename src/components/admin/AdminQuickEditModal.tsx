import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, PencilLine, RefreshCw, RotateCcw } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { DatePicker } from '../ui/DatePicker';
import { Input } from '../ui/Input';
import { SignatureField } from '../form-fill/SignatureField';
import { DeclarationSignatureWithDate } from '../form-fill/DeclarationSignatureWithDate';
import { Loader } from '../ui/Loader';
import { toast } from '../../utils/toast';
import { cn } from '../utils/cn';
import { formatDDMMYYYY, getInstanceWorkflowLabel } from '../../utils/assessmentRowUi';
import type { SubmittedInstanceRow } from '../../lib/formEngine';
import { fetchInstance, syncStudentTokenExpiryToDeadline, updateFormInstanceDates } from '../../lib/formEngine';
import { validateExtensionDate } from '../../utils/assessmentDeadline';
import type { AssessmentSummaryDataEntry, ResultsDataEntry, ResultsOfficeEntry } from '../../lib/formEngine';
import {
  cloneQuickEditData,
  getAnswerKey,
  loadQuickEditData,
  parseSignatureDisplay,
  recalculateQuickEditCompletionStatus,
  getQuickEditStudentDeclarationIso,
  saveQuickEditChanges,
  type IntroQuestionField,
  type QuickEditAnswerValue,
  type QuickEditData,
} from '../../lib/adminQuickEdit';
import {
  collectQuickEditDateValidationErrors,
  extractStudentDeclarationIso,
  getAssessmentSummaryDateChainMins,
  getResultsMinFirstAttemptDate,
  getResultsMinSecondAttemptDate,
  getResultsMinThirdAttemptDate,
  getResultsTrainerFooterDateMin,
} from '../../utils/assessmentAttemptDates';
import {
  applyResultsStudentSignatureConvenience,
  applyResultsTrainerSignatureConvenience,
  applySummaryStudentSignatureConvenience,
  applySummaryTrainerSignatureConvenience,
} from '../../utils/assessmentSignatureConvenience';

type TabId = 'introduction' | 'results' | 'summary' | 'admin';

const TABS: { id: TabId; label: string }[] = [
  { id: 'introduction', label: 'Introduction' },
  { id: 'results', label: 'Results' },
  { id: 'summary', label: 'Summary Sheet' },
  { id: 'admin', label: 'Admin Notes' },
];

const SAT_OPTIONS = [
  { value: '', label: '— Unset —' },
  { value: 's', label: 'Satisfactory (S)' },
  { value: 'ns', label: 'Not Satisfactory (NS)' },
];

const OUTCOME_OPTIONS = [
  { value: '', label: '— Unset —' },
  { value: 'competent', label: 'Competent' },
  { value: 'not_yet_competent', label: 'Not Yet Competent' },
];

type Props = {
  isOpen: boolean;
  onClose: () => void;
  row: SubmittedInstanceRow | null;
  onSaved?: (instanceId: number, statusUpdated: boolean) => void;
};

function ContextHeader({ data }: { data: QuickEditData }) {
  const c = data.context;
  const items = [
    { label: 'Student', value: c.studentName },
    { label: 'Email', value: c.studentEmail },
    ...(c.studentIdLabel ? [{ label: 'Student ID', value: c.studentIdLabel }] : []),
    { label: 'Unit code', value: c.unitCode || '—' },
    { label: 'Unit title', value: c.unitTitle || '—' },
    {
      label: 'Assessment',
      value: [c.formName, c.formVersion ? `v${c.formVersion}` : null].filter(Boolean).join(' · '),
    },
    { label: 'Start date', value: formatDDMMYYYY(c.startDate) },
    { label: 'Due date', value: formatDDMMYYYY(c.endDate) },
    { label: 'Status', value: c.statusLabel },
  ];

  return (
    <div className="mb-4 rounded-lg border border-[var(--border)] bg-gray-50/80 p-3 sm:p-4">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <div key={item.label} className="min-w-0 text-xs">
            <span className="font-semibold text-gray-600">{item.label}: </span>
            <span className="text-gray-900 break-words">{item.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SignatureStatus({ value }: { value: QuickEditAnswerValue | string | null | undefined }) {
  const meta = parseSignatureDisplay(value);
  if (!meta.signed) {
    return <p className="text-xs text-gray-500">Not signed</p>;
  }
  return (
    <div className="space-y-1 text-xs text-gray-600">
      <p className="font-medium text-emerald-700">Signed</p>
      {meta.signedBy ? <p>Signed by: {meta.signedBy}</p> : null}
      {meta.signedAt ? <p>Signed at: {formatDDMMYYYY(meta.signedAt)}</p> : null}
      {meta.preview ? (
        <img src={meta.preview} alt="Signature preview" className="mt-1 h-10 max-w-[140px] rounded border border-gray-200 bg-white object-contain" />
      ) : null}
    </div>
  );
}

function IntroFieldEditor({
  field,
  value,
  onChange,
}: {
  field: IntroQuestionField;
  value: QuickEditAnswerValue;
  onChange: (v: QuickEditAnswerValue) => void;
}) {
  const isEvalDate =
    field.code === 'evaluation.trainingDates' ||
    field.code === 'evaluation.evaluationDate' ||
    field.type === 'date';

  if (field.type === 'signature' && field.showDateField) {
    return (
      <DeclarationSignatureWithDate
        label={field.label}
        required={field.required}
        value={value}
        onChange={(merged) => onChange(merged)}
        showMetadata
      />
    );
  }

  if (field.type === 'signature') {
    const sigVal =
      typeof value === 'string'
        ? value
        : value && typeof value === 'object' && !Array.isArray(value)
          ? String((value as Record<string, unknown>).signature ?? (value as Record<string, unknown>).imageDataUrl ?? (value as Record<string, unknown>).typedText ?? '') || null
          : null;
    return <SignatureField value={sigVal} onChange={(v) => onChange(v)} />;
  }

  if (isEvalDate) {
    return (
      <DatePicker
        value={typeof value === 'string' ? value : ''}
        onChange={(v) => onChange(v || null)}
        compact
        placement="above"
      />
    );
  }

  if (field.type === 'long_text') {
    return (
      <textarea
        rows={3}
        className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-[var(--brand)] focus:outline-none focus:ring-1 focus:ring-[var(--brand)]/30"
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value || null)}
      />
    );
  }

  return (
    <Input
      value={value == null ? '' : String(value)}
      onChange={(e) => onChange(e.target.value || null)}
      className="text-sm"
    />
  );
}

function ResultsSectionEditor({
  sectionId,
  label,
  data,
  office,
  summary,
  studentDeclarationIso,
  dateErrors,
  studentName,
  trainerName,
  onChange,
  onOfficeChange,
}: {
  sectionId: number;
  label: string;
  data: ResultsDataEntry;
  office: ResultsOfficeEntry;
  summary: AssessmentSummaryDataEntry;
  studentDeclarationIso?: string;
  dateErrors: Record<string, string>;
  studentName: string | null;
  trainerName: string | null;
  onChange: (patch: Partial<ResultsDataEntry>) => void;
  onOfficeChange: (patch: Partial<ResultsOfficeEntry>) => void;
}) {
  const minFirst = getResultsMinFirstAttemptDate(summary, studentDeclarationIso);
  const minSecond = getResultsMinSecondAttemptDate(data, summary);
  const minThird = getResultsMinThirdAttemptDate(data, summary);
  const minTrainer = getResultsTrainerFooterDateMin(data);
  const fieldError = (key: string) => dateErrors[`results-${sectionId}-${key}`];

  const attemptBlock = (
    attempt: 1 | 2 | 3,
    satKey: 'first_attempt_satisfactory' | 'second_attempt_satisfactory' | 'third_attempt_satisfactory',
    dateKey: 'first_attempt_date' | 'second_attempt_date' | 'third_attempt_date',
    feedbackKey: 'first_attempt_feedback' | 'second_attempt_feedback' | 'third_attempt_feedback',
    minDate?: string,
  ) => (
    <div className="rounded-md border border-gray-200 bg-white p-3 space-y-2">
      <p className="text-xs font-semibold text-gray-700">{attempt === 1 ? '1st' : attempt === 2 ? '2nd' : '3rd'} attempt</p>
      <div>
        <label className="text-xs text-gray-600">Result / status</label>
        <select
          className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm"
          value={data[satKey] ?? ''}
          onChange={(e) => onChange({ [satKey]: (e.target.value || null) as ResultsDataEntry[typeof satKey] })}
        >
          {SAT_OPTIONS.map((o) => (
            <option key={o.value || 'unset'} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="text-xs text-gray-600">Attempt date</label>
        <DatePicker
          value={data[dateKey] ?? ''}
          onChange={(v) => onChange({ [dateKey]: v || null })}
          compact
          placement="above"
          className="mt-1"
          minDate={minDate}
          error={fieldError(dateKey)}
        />
      </div>
      <div>
        <label className="text-xs text-gray-600">Feedback</label>
        <textarea
          rows={2}
          className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          value={data[feedbackKey] ?? ''}
          onChange={(e) => onChange({ [feedbackKey]: e.target.value || null })}
        />
      </div>
    </div>
  );

  return (
    <div className="space-y-4 rounded-lg border border-gray-200 p-3 sm:p-4">
      <h4 className="text-sm font-semibold text-gray-800">{label}</h4>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {attemptBlock(1, 'first_attempt_satisfactory', 'first_attempt_date', 'first_attempt_feedback', minFirst)}
        {attemptBlock(2, 'second_attempt_satisfactory', 'second_attempt_date', 'second_attempt_feedback', minSecond)}
        {attemptBlock(3, 'third_attempt_satisfactory', 'third_attempt_date', 'third_attempt_feedback', minThird)}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-700">Student signature</p>
          <SignatureStatus value={data.student_signature} />
          <SignatureField
            value={data.student_signature ?? null}
            onChange={(v) => {
              const patch = applyResultsStudentSignatureConvenience(data, { student_signature: v }, studentName);
              onChange(patch);
            }}
          />
          <Input
            label="Student name"
            value={data.student_name ?? ''}
            onChange={(e) => onChange({ student_name: e.target.value || null })}
          />
        </div>
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-700">Trainer / assessor signature</p>
          <SignatureStatus value={data.trainer_signature} />
          <SignatureField
            value={data.trainer_signature ?? null}
            onChange={(v) => {
              const patch = applyResultsTrainerSignatureConvenience(data, { trainer_signature: v }, trainerName);
              onChange(patch);
            }}
          />
          <Input
            label="Trainer name"
            value={data.trainer_name ?? ''}
            onChange={(e) => onChange({ trainer_name: e.target.value || null })}
          />
          <div>
            <label className="text-xs text-gray-600">Trainer date</label>
            <DatePicker
              value={data.trainer_date ?? ''}
              onChange={(v) => onChange({ trainer_date: v || null })}
              compact
              placement="above"
              className="mt-1"
              minDate={minTrainer}
              error={fieldError('trainer_date')}
            />
          </div>
        </div>
      </div>
      <div className="rounded-md border border-amber-200 bg-amber-50/60 p-3 space-y-2">
        <p className="text-xs font-semibold text-amber-900">Office use only</p>
        <div className="flex flex-wrap gap-4">
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={Boolean(office.initial_checked)}
              onChange={(e) => onOfficeChange({ initial_checked: e.target.checked })}
            />
            Initial
          </label>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={Boolean(office.updated_checked)}
              onChange={(e) => onOfficeChange({ updated_checked: e.target.checked })}
            />
            Updated
          </label>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Input
            label="Entered by"
            value={office.entered_by ?? ''}
            onChange={(e) => onOfficeChange({ entered_by: e.target.value || null })}
          />
          <div>
            <label className="text-xs text-gray-600">Entered date</label>
            <DatePicker
              value={office.entered_date ?? ''}
              onChange={(v) => onOfficeChange({ entered_date: v || null })}
              compact
              placement="above"
              className="mt-1"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryAttemptColumn({
  attempt,
  resultKey,
  resultValue,
  trainerSigKey,
  trainerDateKey,
  studentSigKey,
  studentDateKey,
  summary,
  dateErrors,
  chainMins,
  onChange,
}: {
  attempt: 1 | 2 | 3;
  resultKey: 'final_attempt_1_result' | 'final_attempt_2_result' | 'final_attempt_3_result';
  resultValue: string | null;
  trainerSigKey: 'trainer_sig_1' | 'trainer_sig_2' | 'trainer_sig_3';
  trainerDateKey: 'trainer_date_1' | 'trainer_date_2' | 'trainer_date_3';
  studentSigKey: 'student_sig_1' | 'student_sig_2' | 'student_sig_3';
  studentDateKey: 'student_date_1' | 'student_date_2' | 'student_date_3';
  summary: AssessmentSummaryDataEntry;
  dateErrors: Record<string, string>;
  chainMins: ReturnType<typeof getAssessmentSummaryDateChainMins>;
  onChange: (patch: Partial<AssessmentSummaryDataEntry>) => void;
}) {
  const attemptLabel = attempt === 1 ? '1st' : attempt === 2 ? '2nd' : '3rd';
  const minStudent =
    attempt === 1 ? chainMins.minStudentDate1 : attempt === 2 ? chainMins.minStudentDate2 : chainMins.minStudentDate3;
  const minTrainer =
    attempt === 1 ? chainMins.minTrainerDate1 : attempt === 2 ? chainMins.minTrainerDate2 : chainMins.minTrainerDate3;
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3 space-y-3">
      <p className="text-xs font-bold text-gray-800">{attemptLabel} attempt / event</p>
      <div>
        <label className="text-xs text-gray-600">Result / status</label>
        <select
          className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm"
          value={resultValue ?? ''}
          onChange={(e) =>
            onChange({
              [resultKey]: (e.target.value || null) as AssessmentSummaryDataEntry[typeof resultKey],
            })
          }
        >
          {OUTCOME_OPTIONS.map((o) => (
            <option key={o.value || 'unset'} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <p className="text-xs font-semibold text-gray-700">Trainer signature</p>
        <SignatureStatus value={summary[trainerSigKey]} />
        <SignatureField
          value={summary[trainerSigKey] ?? null}
          onChange={(v) => {
            const patch = applySummaryTrainerSignatureConvenience(summary, trainerSigKey, trainerDateKey, v);
            onChange(patch);
          }}
          className="mt-1"
        />
        <label className="mt-2 block text-xs text-gray-600">Trainer / assessor date</label>
        <DatePicker
          value={summary[trainerDateKey] ?? ''}
          onChange={(v) => onChange({ [trainerDateKey]: v || null })}
          compact
          placement="above"
          className="mt-1"
          minDate={minTrainer}
          error={dateErrors[`summary-${trainerDateKey}`]}
        />
      </div>
      <div>
        <p className="text-xs font-semibold text-gray-700">Student signature</p>
        <SignatureStatus value={summary[studentSigKey]} />
        <SignatureField
          value={summary[studentSigKey] ?? null}
          onChange={(v) => {
            const patch = applySummaryStudentSignatureConvenience(summary, studentSigKey, studentDateKey, v);
            onChange(patch);
          }}
          className="mt-1"
        />
        <label className="mt-2 block text-xs text-gray-600">Student date</label>
        <DatePicker
          value={summary[studentDateKey] ?? ''}
          onChange={(v) => onChange({ [studentDateKey]: v || null })}
          compact
          placement="above"
          className="mt-1"
          minDate={minStudent}
          error={dateErrors[`summary-${studentDateKey}`]}
        />
      </div>
    </div>
  );
}

export const AdminQuickEditModal: React.FC<Props> = ({ isOpen, onClose, row, onSaved }) => {
  const [activeTab, setActiveTab] = useState<TabId>('introduction');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<QuickEditData | null>(null);
  const [draft, setDraft] = useState<QuickEditData | null>(null);

  const hasChanges = useMemo(() => {
    if (!baseline || !draft) return false;
    return JSON.stringify(baseline) !== JSON.stringify(draft);
  }, [baseline, draft]);

  const declarationQuestionId = useMemo(() => {
    const q = draft?.template?.steps
      ?.flatMap((st) => st.sections)
      .flatMap((s) => s.questions)
      .find((item) => item.code === 'student.declarationSignature');
    return q?.id ?? null;
  }, [draft?.template]);

  const studentDeclarationIso = useMemo(() => {
    if (!draft || declarationQuestionId == null) return undefined;
    return extractStudentDeclarationIso(draft.answers, getAnswerKey, declarationQuestionId);
  }, [draft, declarationQuestionId]);

  const dateValidationErrors = useMemo(() => {
    if (!draft) return {};
    return collectQuickEditDateValidationErrors({
      resultsSections: draft.resultsSections,
      resultsData: draft.resultsData,
      assessmentSummary: draft.assessmentSummary,
      studentDeclarationIso,
    });
  }, [draft, studentDeclarationIso]);

  const hasDateValidationErrors = Object.keys(dateValidationErrors).length > 0;

  const summaryChainMins = useMemo(() => {
    if (!draft) {
      return {
        minStudentDate1: undefined,
        minTrainerDate1: undefined,
        minStudentDate2: undefined,
        minTrainerDate2: undefined,
        minStudentDate3: undefined,
        minTrainerDate3: undefined,
      };
    }
    return getAssessmentSummaryDateChainMins(draft.assessmentSummary, studentDeclarationIso);
  }, [draft, studentDeclarationIso]);

  const loadData = useCallback(async () => {
    if (!row) return;
    setLoading(true);
    setError(null);
    try {
      const data = await loadQuickEditData(row);
      setBaseline(data);
      setDraft(cloneQuickEditData(data));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load assessment fields');
      setBaseline(null);
      setDraft(null);
    } finally {
      setLoading(false);
    }
  }, [row]);

  useEffect(() => {
    if (!isOpen || !row) {
      setBaseline(null);
      setDraft(null);
      setError(null);
      setActiveTab('introduction');
      return;
    }
    void loadData();
  }, [isOpen, row, loadData]);

  const handleReset = () => {
    if (!baseline) return;
    setDraft(cloneQuickEditData(baseline));
    toast.success('Unsaved changes reset');
  };

  const handleSave = async () => {
    if (!baseline || !draft || !row) return;
    if (hasDateValidationErrors) {
      const firstError = Object.values(dateValidationErrors)[0];
      toast.error(firstError ?? 'Fix date validation errors before saving.');
      return;
    }
    // Extension date lives on the instance (not in the form answers), so it is saved separately and only when changed.
    const nextExtension = String(draft.context.extensionDate ?? '').trim() || null;
    const baseExtension = String(baseline.context.extensionDate ?? '').trim() || null;
    const extensionChanged = nextExtension !== baseExtension;
    if (extensionChanged) {
      const extensionError = validateExtensionDate(draft.context.endDate, nextExtension);
      if (extensionError) {
        toast.error(extensionError);
        return;
      }
    }
    setSaving(true);
    const res = await saveQuickEditChanges({ baseline, draft });
    if (!res.ok) {
      setSaving(false);
      toast.error(res.error);
      return;
    }
    if (extensionChanged) {
      try {
        await updateFormInstanceDates(row.id, { extension_date: nextExtension });
        await syncStudentTokenExpiryToDeadline(row.id);
      } catch (err) {
        setSaving(false);
        toast.error(err instanceof Error ? err.message : 'Failed to save extension date');
        return;
      }
    }

    const refreshed = await loadQuickEditData(row);
    const completion = await recalculateQuickEditCompletionStatus({
      row,
      data: refreshed,
      studentDeclarationIso: getQuickEditStudentDeclarationIso(refreshed),
    });

    const inst = await fetchInstance(row.id);
    if (inst) {
      refreshed.context = {
        ...refreshed.context,
        statusLabel: getInstanceWorkflowLabel({
          status: inst.status,
          role_context: inst.role_context,
          did_not_attempt: (inst as { did_not_attempt?: boolean | null }).did_not_attempt ?? null,
          no_attempt_rollovers: (inst as { no_attempt_rollovers?: number | null }).no_attempt_rollovers ?? null,
          submission_count: inst.submission_count,
          submitted_at: inst.submitted_at,
        }),
        workflowStatus: (inst as { workflow_status?: string | null }).workflow_status ?? null,
      };
    }

    setSaving(false);
    setBaseline(refreshed);
    setDraft(cloneQuickEditData(refreshed));

    if (completion.updated) {
      toast.success('Assessment saved and finalised (Completed / Locked).');
    } else if (completion.missingFields.length > 0 || Object.keys(completion.validationErrors).length > 0) {
      const detail =
        completion.missingFields[0] ??
        Object.values(completion.validationErrors)[0] ??
        'Complete required fields and office checks to finalise.';
      toast.success('Assessment fields saved');
      toast.error(`Not finalised: ${detail}`);
    } else {
      toast.success('Assessment fields saved');
    }

    onSaved?.(row.id, completion.updated);
    onClose();
  };

  const updateAnswer = (questionId: number, rowId: number | null, value: QuickEditAnswerValue) => {
    const key = getAnswerKey(questionId, rowId);
    setDraft((prev) => {
      if (!prev) return prev;
      return { ...prev, answers: { ...prev.answers, [key]: value } };
    });
  };

  const updateResults = (sectionId: number, patch: Partial<ResultsDataEntry>) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const current = prev.resultsData[sectionId] ?? ({ section_id: sectionId } as ResultsDataEntry);
      return {
        ...prev,
        resultsData: { ...prev.resultsData, [sectionId]: { ...current, ...patch } },
      };
    });
  };

  const updateResultsOffice = (sectionId: number, patch: Partial<ResultsOfficeEntry>) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const current = prev.resultsOffice[sectionId] ?? ({ section_id: sectionId } as ResultsOfficeEntry);
      return {
        ...prev,
        resultsOffice: { ...prev.resultsOffice, [sectionId]: { ...current, ...patch } },
      };
    });
  };

  const updateSummary = (patch: Partial<AssessmentSummaryDataEntry>) => {
    setDraft((prev) => {
      if (!prev) return prev;
      return { ...prev, assessmentSummary: { ...prev.assessmentSummary, ...patch } };
    });
  };

  if (!isOpen) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Admin Quick Edit - Assessment Fields"
      size="xl"
      overlayClassName="!z-[55]"
    >
      <div className="flex min-h-[60vh] flex-col">
        {loading ? (
          <div className="flex flex-1 flex-col items-center justify-center py-16">
            <Loader variant="dots" size="lg" />
            <p className="mt-3 text-sm text-gray-600">Loading assessment fields…</p>
          </div>
        ) : error ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-12 text-center">
            <p className="text-sm text-red-700">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void loadData()}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Retry
            </Button>
          </div>
        ) : draft ? (
          <>
            <ContextHeader data={draft} />

            <div className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-[var(--border)] bg-white p-3">
              <div className="min-w-[200px]">
                <label className="mb-1 block text-xs font-semibold text-gray-600">Extension date (optional)</label>
                <DatePicker
                  value={draft.context.extensionDate ?? ''}
                  onChange={(v) =>
                    setDraft((prev) => (prev ? { ...prev, context: { ...prev.context, extensionDate: v || null } } : prev))
                  }
                  compact
                  placement="below"
                  minDate={draft.context.endDate || undefined}
                  disabled={saving}
                />
              </div>
              <p className="max-w-md text-xs text-gray-500">
                A later deadline for this student. The deadline is the extension when set, otherwise the end date. The end date is not changed.
              </p>
            </div>

            {hasDateValidationErrors ? (
              <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                <p className="font-semibold">Date validation errors</p>
                <ul className="mt-1 list-disc pl-5 space-y-0.5 text-xs">
                  {Array.from(new Set(Object.values(dateValidationErrors))).map((msg) => (
                    <li key={msg}>{msg}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="mb-4 flex flex-wrap gap-1 border-b border-[var(--border)] pb-1">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'rounded-t-md px-3 py-2 text-xs font-semibold transition-colors sm:text-sm',
                    activeTab === tab.id
                      ? 'bg-[var(--brand)]/10 text-[var(--brand)] border border-b-white border-[var(--brand)]/30 -mb-px'
                      : 'text-gray-600 hover:bg-gray-100',
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="min-h-0 flex-1 space-y-4 pb-4">
              {activeTab === 'introduction' ? (
                draft.introQuestions.length === 0 ? (
                  <p className="text-sm text-gray-500">No introduction-page fields found for this form template.</p>
                ) : (
                  <div className="space-y-4">
                    {draft.introQuestions.map((field) => {
                      const key = getAnswerKey(field.questionId, field.rowId);
                      const isDeclarationSignature = field.type === 'signature' && field.showDateField;
                      return (
                        <div key={key} className="rounded-lg border border-gray-200 p-3 sm:p-4">
                          <p className="text-[10px] font-medium uppercase tracking-wide text-gray-500">{field.sectionTitle}</p>
                          {!isDeclarationSignature ? (
                            <label className="mt-1 block text-sm font-semibold text-gray-800">
                              {field.label}
                              {field.required ? ' *' : ''}
                            </label>
                          ) : null}
                          {field.code && !isDeclarationSignature ? (
                            <p className="text-[10px] text-gray-400">{field.code}</p>
                          ) : null}
                          <div className={isDeclarationSignature ? 'mt-1' : 'mt-2'}>
                            <IntroFieldEditor
                              field={field}
                              value={draft.answers[key] ?? null}
                              onChange={(v) => updateAnswer(field.questionId, field.rowId, v)}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )
              ) : null}

              {activeTab === 'results' ? (
                draft.resultsSections.length === 0 ? (
                  <p className="text-sm text-gray-500">No task results sections found for this form.</p>
                ) : (
                  <div className="space-y-4">
                    {draft.resultsSections.map((entry) => {
                      if (entry.sectionId == null) {
                        return (
                          <div key={entry.label} className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                            {entry.label}: no linked results section in template.
                          </div>
                        );
                      }
                      const sectionId = entry.sectionId;
                      return (
                        <ResultsSectionEditor
                          key={sectionId}
                          sectionId={sectionId}
                          label={entry.label}
                          data={draft.resultsData[sectionId] ?? ({ section_id: sectionId } as ResultsDataEntry)}
                          office={draft.resultsOffice[sectionId] ?? ({ section_id: sectionId } as ResultsOfficeEntry)}
                          summary={draft.assessmentSummary}
                          studentDeclarationIso={studentDeclarationIso}
                          dateErrors={dateValidationErrors}
                          studentName={draft.context.studentName}
                          trainerName={draft.context.trainerName}
                          onChange={(patch) => updateResults(sectionId, patch)}
                          onOfficeChange={(patch) => updateResultsOffice(sectionId, patch)}
                        />
                      );
                    })}
                  </div>
                )
              ) : null}

              {activeTab === 'summary' ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="text-xs text-gray-600">Summary start date</label>
                      <DatePicker
                        value={draft.assessmentSummary.start_date ?? ''}
                        onChange={(v) => updateSummary({ start_date: v || null })}
                        compact
                        placement="above"
                        className="mt-1"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-600">Summary end date</label>
                      <DatePicker
                        value={draft.assessmentSummary.end_date ?? ''}
                        onChange={(v) => updateSummary({ end_date: v || null })}
                        compact
                        placement="above"
                        className="mt-1"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                    <SummaryAttemptColumn
                      attempt={1}
                      resultKey="final_attempt_1_result"
                      resultValue={draft.assessmentSummary.final_attempt_1_result}
                      trainerSigKey="trainer_sig_1"
                      trainerDateKey="trainer_date_1"
                      studentSigKey="student_sig_1"
                      studentDateKey="student_date_1"
                      summary={draft.assessmentSummary}
                      dateErrors={dateValidationErrors}
                      chainMins={summaryChainMins}
                      onChange={updateSummary}
                    />
                    <SummaryAttemptColumn
                      attempt={2}
                      resultKey="final_attempt_2_result"
                      resultValue={draft.assessmentSummary.final_attempt_2_result}
                      trainerSigKey="trainer_sig_2"
                      trainerDateKey="trainer_date_2"
                      studentSigKey="student_sig_2"
                      studentDateKey="student_date_2"
                      summary={draft.assessmentSummary}
                      dateErrors={dateValidationErrors}
                      chainMins={summaryChainMins}
                      onChange={updateSummary}
                    />
                    <SummaryAttemptColumn
                      attempt={3}
                      resultKey="final_attempt_3_result"
                      resultValue={draft.assessmentSummary.final_attempt_3_result}
                      trainerSigKey="trainer_sig_3"
                      trainerDateKey="trainer_date_3"
                      studentSigKey="student_sig_3"
                      studentDateKey="student_date_3"
                      summary={draft.assessmentSummary}
                      dateErrors={dateValidationErrors}
                      chainMins={summaryChainMins}
                      onChange={updateSummary}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-600">Student overall feedback</label>
                    <textarea
                      rows={3}
                      className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                      value={draft.assessmentSummary.student_overall_feedback ?? ''}
                      onChange={(e) => updateSummary({ student_overall_feedback: e.target.value || null })}
                    />
                  </div>
                </div>
              ) : null}

              {activeTab === 'admin' ? (
                <div className="space-y-4">
                  <div>
                    <label className="text-sm font-semibold text-gray-800">Admin reference</label>
                    <p className="text-xs text-gray-500 mb-2">Internal admin reference — not visible to students.</p>
                    <textarea
                      rows={4}
                      className="w-full rounded-md border border-[#ea580c]/30 bg-[#fffbeb] px-3 py-2 text-sm text-gray-800 focus:border-[#ea580c] focus:outline-none focus:ring-1 focus:ring-[#ea580c]/40"
                      placeholder="Admin reference note…"
                      value={draft.adminReferenceNote}
                      onChange={(e) =>
                        setDraft((prev) => (prev ? { ...prev, adminReferenceNote: e.target.value } : prev))
                      }
                    />
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Input
                      label="Admin initials"
                      value={draft.assessmentSummary.admin_initials ?? ''}
                      onChange={(e) => updateSummary({ admin_initials: e.target.value || null })}
                    />
                    <div className="flex flex-wrap items-end gap-4">
                      <label className="inline-flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={Boolean(draft.assessmentSummary.admin_initial_checked)}
                          onChange={(e) => updateSummary({ admin_initial_checked: e.target.checked })}
                        />
                        Admin initial checked
                      </label>
                      <label className="inline-flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={Boolean(draft.assessmentSummary.admin_updated_checked)}
                          onChange={(e) => updateSummary({ admin_updated_checked: e.target.checked })}
                        />
                        Admin updated checked
                      </label>
                    </div>
                    <p className="text-xs text-amber-800 sm:col-span-2">
                      To finalise this assessment, tick both checkboxes above and every task Results sheet Initial/Updated
                      check (Results tab). Admin initials alone do not complete the assessment.
                    </p>
                  </div>
                </div>
              ) : null}
            </div>
          </>
        ) : null}

        <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] bg-white px-4 py-3 sm:-mx-5 sm:px-5">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button variant="outline" size="sm" onClick={() => void loadData()} disabled={loading || saving || !row}>
              <RefreshCw className={cn('mr-2 h-4 w-4', loading && 'animate-spin')} />
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={handleReset} disabled={!hasChanges || saving || loading}>
              <RotateCcw className="mr-2 h-4 w-4" />
              Reset changes
            </Button>
          </div>
          <Button
            size="sm"
            onClick={() => void handleSave()}
            disabled={!hasChanges || saving || loading || !draft || hasDateValidationErrors}
          >
            {saving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <PencilLine className="mr-2 h-4 w-4" />
                Save changes
              </>
            )}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
