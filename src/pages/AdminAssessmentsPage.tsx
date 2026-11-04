import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { Copy, ExternalLink, Send, RefreshCw, Ban, CheckCircle, User, Download, FileDown, PencilLine } from 'lucide-react';
import {
  listSubmittedInstancesPaged,
  updateInstanceRole,
  updateInstanceWorkflowStatus,
  repairInstanceTrainerHandoff,
  issueInstanceAccessLink,
  getOrIssueInstanceAccessLink,
  revokeRoleAccessTokens,
  extendInstanceAccessTokens,
  allowStudentResubmission,
  listTrainers,
  listCoursesPaged,
  listFormsPaged,
  fetchAssessmentSummaries,
} from '../lib/formEngine';
import type { AssessmentDirectoryWorkflowFilter, SubmittedInstanceRow, Trainer } from '../lib/formEngine';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { DatePicker } from '../components/ui/DatePicker';
import { mirrorExtensionDate, validateExtensionDate } from '../utils/assessmentDeadline';
import { SelectAsync } from '../components/ui/SelectAsync';
import { Loader } from '../components/ui/Loader';
import { Modal } from '../components/ui/Modal';
import { toast } from '../utils/toast';
import { AdminListPagination } from '../components/admin/AdminListPagination';
import type { SortDirection } from '../components/admin/SortableTh';
import { SortableTh } from '../components/admin/SortableTh';
import { supabase } from '../lib/supabase';
import {
  computeRowUi,
  getInstanceWorkflowBadgeClass,
  getInstanceWorkflowLabel,
  getMissedAttemptWindowText,
  getStudentAttemptDoneText,
  getTrainerAttemptFailedText,
  calculateAssessmentFinalStatus,
  TERMINAL_DID_NOT_ATTEMPT_ROW_CLASS,
  maskCompetentWhileAwaitingTrainer,
  withinInstanceAccessWindow,
  getAssessmentOutcomeDisplay,
  type AttemptResult,
} from '../utils/assessmentRowUi';
import { FormDocumentsPanel } from '../components/documents/FormDocumentsPanel';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { AdminQuickEditModal } from '../components/admin/AdminQuickEditModal';
import {
  commitAssessmentDateChange,
  END_DATE_RESET_DIALOG_MESSAGE,
  END_DATE_RESET_DIALOG_TITLE,
  resolveNeedsResetPrompt,
} from '../utils/assessmentDateChange';
import { useAuth } from '../contexts/AuthContext';
import {
  rowMatchesTrainerHighlightCourse,
  TRAINER_HIGHLIGHT_ROW_EXTRA_CLASS,
  useTrainerHighlightCourseId,
} from '../utils/trainerCourseHighlight';
import { useInstancePdfDownload } from '../hooks/useInstancePdfDownload';
import { LivePdfGenerateConfirmDialog } from '../components/pdf/LivePdfGenerateConfirmDialog';

const getWorkflowRowInput = (row: SubmittedInstanceRow) => ({
  status: row.status,
  role_context: row.role_context,
  did_not_attempt: (row as unknown as { did_not_attempt?: boolean | null }).did_not_attempt ?? null,
  no_attempt_rollovers: (row as unknown as { no_attempt_rollovers?: number | null }).no_attempt_rollovers ?? null,
  submission_count: row.submission_count,
  submitted_at: row.submitted_at,
});

const pad2 = (n: number) => String(n).padStart(2, '0');

const formatDDMMYYYY = (value: string | null): string => {
  const v = (value ?? '').trim();
  if (!v) return '-';
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const dt = new Date(v);
  if (Number.isNaN(dt.getTime())) return v;
  return `${pad2(dt.getDate())}/${pad2(dt.getMonth() + 1)}/${dt.getFullYear()}`;
};


const getAttemptOutcomeLabel = (
  attemptResults: AttemptResult[],
  row: Pick<SubmittedInstanceRow, 'status' | 'role_context' | 'submission_count' | 'submitted_at'>,
): string => {
  const display = getAssessmentOutcomeDisplay({
    status: row.status,
    role_context: row.role_context,
    attemptResults,
    submissionCount: Number(row.submission_count ?? 0) || (row.submitted_at ? 1 : 0),
    submittedAt: row.submitted_at ?? null,
  });
  if (display.label === 'Not competent') return 'Competency Not Achieved';
  if (display.label === 'Completed' || display.label === 'Competent') {
    return display.label === 'Completed' ? 'Completed' : 'Competent';
  }
  return display.label;
};

const getExportStatusText = (row: SubmittedInstanceRow, rawAttemptResults: AttemptResult[]): string => {
  const finalStatus = calculateAssessmentFinalStatus({
    ...row,
    attempt_results: rawAttemptResults,
  });
  if (finalStatus.status === 'completed') return 'Completed';
  const submittedCount = Math.min(
    3,
    Math.max(0, Number(row.submission_count ?? 0) || (row.submitted_at ? 1 : 0))
  );

  const missedAttemptTextRaw = getMissedAttemptWindowText({
    noAttemptRollovers: (row as unknown as { no_attempt_rollovers?: number | null }).no_attempt_rollovers ?? null,
    didNotAttempt: (row as unknown as { did_not_attempt?: boolean | null }).did_not_attempt ?? null,
    status: row.status,
    submissionCount: row.submission_count,
    submittedAt: row.submitted_at,
  });
  const missedAll = missedAttemptTextRaw === "Didn't attempt any";
  if (missedAll) return "Didn't attempt any";

  // If the student has already submitted attempt 1/2/3, do not show "Missed 1st/2nd/3rd attempt" for those.
  const normalizeMissedAttemptText = (text: string | null): string | null => {
    const t = String(text ?? '').trim();
    if (!t) return null;
    if (!t.startsWith('Missed ')) return t;
    const parts = t
      .slice('Missed '.length)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const kept = parts.filter((p) => {
      if (submittedCount >= 1 && p.startsWith('1st attempt')) return false;
      if (submittedCount >= 2 && p.startsWith('2nd attempt')) return false;
      if (submittedCount >= 3 && p.startsWith('3rd attempt')) return false;
      return true;
    });
    if (kept.length === 0) return null;
    return `Missed ${kept.join(', ')}`;
  };

  const masked = maskCompetentWhileAwaitingTrainer(row, rawAttemptResults);
  const outcomeLabel = getAttemptOutcomeLabel(masked, row);

  const attemptDoneText = getStudentAttemptDoneText({
    submissionCount: submittedCount,
    submittedAt: row.submitted_at ?? null,
    attemptResults: rawAttemptResults,
    status: row.status,
    role_context: row.role_context,
    no_attempt_rollovers: (row as unknown as { no_attempt_rollovers?: number | null }).no_attempt_rollovers ?? null,
    did_not_attempt: (row as unknown as { did_not_attempt?: boolean | null }).did_not_attempt ?? null,
  });
  const trainerAttemptFailedText = getTrainerAttemptFailedText(rawAttemptResults, row);
  const missedAttemptText = normalizeMissedAttemptText(missedAttemptTextRaw);

  const accessRole = row.role_context === 'trainer' ? 'trainer' : row.role_context === 'office' ? 'office' : 'student';
  const ui = computeRowUi({
    row: {
      start_date: row.start_date,
      end_date: row.end_date,
      extension_date: row.extension_date ?? null,
      did_not_attempt: (row as unknown as { did_not_attempt?: boolean | null }).did_not_attempt ?? null,
      no_attempt_rollovers: (row as unknown as { no_attempt_rollovers?: number | null }).no_attempt_rollovers ?? null,
      status: row.status,
      role_context: row.role_context,
      workflow_status: row.workflow_status,
      office_assessment_completed: row.office_assessment_completed,
    },
    attemptResults: masked,
    ignoreEndDateForAccess: accessRole !== 'student',
    submissionCount: submittedCount,
    submittedAt: row.submitted_at ?? null,
  });
  const win = withinInstanceAccessWindow(
    { start_date: row.start_date, end_date: row.end_date, extension_date: row.extension_date ?? null },
    accessRole
  );
  const studentOpenDisabled = accessRole === 'student' && (!win.ok || ui.disabled);

  const parts: string[] = [outcomeLabel];
  if (trainerAttemptFailedText) parts.push(trainerAttemptFailedText);
  if (attemptDoneText) parts.push(attemptDoneText);
  // Only show missed attempt messaging when it doesn't contradict submitted attempts.
  if (ui.kind === 'in_progress' && missedAttemptText) parts.push(missedAttemptText);
  if (!finalStatus.suppressExpiry && studentOpenDisabled && (ui.kind === 'future' || ui.kind === 'expired') && ui.reason) parts.push(ui.reason);
  else if (!finalStatus.suppressExpiry && !win.ok && win.reason) parts.push(win.reason);

  return parts.filter((p) => String(p || '').trim().length > 0).join(' | ');
};

const WORKFLOW_FILTER_OPTIONS: { value: AssessmentDirectoryWorkflowFilter; label: string }[] = [
  { value: 'all', label: 'All workflows' },
  { value: 'awaiting_student', label: 'Awaiting student' },
  { value: 'awaiting_trainer', label: 'Waiting trainer' },
  { value: 'awaiting_office', label: 'Waiting office' },
  { value: 'did_not_attempt', label: 'Did not attempt' },
  { value: 'completed', label: 'Completed' },
];


const getDirectoryRowClass = (row: SubmittedInstanceRow, trainerHighlightCourseId: number | null = null): string => {
  // Match dashboards:
  // - Open window => yellow
  // - Completed => green
  // - Missed all (did_not_attempt) => strong red
  // - Otherwise keep neutral gray but hover with theme
  let base: string;
  const didNotAttempt = (row as unknown as { did_not_attempt?: boolean | null }).did_not_attempt ?? null;
  const noAttemptRollovers = (row as unknown as { no_attempt_rollovers?: number | null }).no_attempt_rollovers ?? null;
  const finalStatus = calculateAssessmentFinalStatus({
    ...row,
    did_not_attempt: didNotAttempt,
    no_attempt_rollovers: noAttemptRollovers,
  });
  if (finalStatus.status === 'completed') {
    base = 'bg-emerald-50/70 hover:bg-[var(--brand)]/10 focus-within:bg-[var(--brand)]/10 transition-colors';
  } else if (finalStatus.terminalDidNotAttempt) {
    base = TERMINAL_DID_NOT_ATTEMPT_ROW_CLASS;
  } else if (row.status === 'locked') {
    base = 'bg-emerald-50/70 hover:bg-[var(--brand)]/10 focus-within:bg-[var(--brand)]/10 transition-colors';
  } else {
    const ui = computeRowUi({
      row: {
        start_date: row.start_date,
        end_date: row.end_date,
        extension_date: row.extension_date ?? null,
        did_not_attempt: (row as unknown as { did_not_attempt?: boolean | null }).did_not_attempt ?? null,
        status: row.status,
        role_context: row.role_context,
        workflow_status: row.workflow_status,
        office_assessment_completed: row.office_assessment_completed,
      },
      ignoreEndDateForAccess: row.role_context === 'trainer' || row.role_context === 'office',
      submissionCount: Number(row.submission_count ?? 0) || (row.submitted_at ? 1 : 0),
      submittedAt: row.submitted_at ?? null,
    });
    base = ui.rowClassName || 'hover:bg-[var(--brand)]/10 focus-within:bg-[var(--brand)]/10 transition-colors';
  }
  if (trainerHighlightCourseId != null && rowMatchesTrainerHighlightCourse(row, trainerHighlightCourseId)) {
    return `${base} ${TRAINER_HIGHLIGHT_ROW_EXTRA_CLASS}`;
  }
  return base;
};

export const AdminAssessmentsPage: React.FC = () => {
  const { user } = useAuth();
  const trainerHighlightCourseId = useTrainerHighlightCourseId();
  const viewerIsSuperadmin = user?.role === 'superadmin';
  const PAGE_SIZE = 20;
  const [rows, setRows] = useState<SubmittedInstanceRow[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sendingId, setSendingId] = useState<number | null>(null);
  const [managingId, setManagingId] = useState<number | null>(null);
  const { downloadingId: downloadingPdfId, downloadInstancePdf, liveGenerateDialogProps } = useInstancePdfDownload('office');
  const [searchTerm, setSearchTerm] = useState('');
  const [courseFilter, setCourseFilter] = useState('');
  const [formFilter, setFormFilter] = useState('');
  const [workflowFilter, setWorkflowFilter] = useState<AssessmentDirectoryWorkflowFilter>('all');
  const [startFromFilter, setStartFromFilter] = useState<string>('');
  const [endDateToFilter, setEndDateToFilter] = useState<string>('');
  const [sendToTrainerRow, setSendToTrainerRow] = useState<SubmittedInstanceRow | null>(null);
  const [quickEditRow, setQuickEditRow] = useState<SubmittedInstanceRow | null>(null);
  const [trainers, setTrainers] = useState<Trainer[]>([]);
  const [trainersLoading, setTrainersLoading] = useState(false);
  const [selectedTrainerId, setSelectedTrainerId] = useState<number | null>(null);
  const [editingDateCell, setEditingDateCell] = useState<{ id: number; field: 'start' | 'end' | 'extension' } | null>(null);
  const [savingDateId, setSavingDateId] = useState<number | null>(null);
  /** Pending start/end/extension edits until user clicks Apply or Mass apply */
  const [dateDrafts, setDateDrafts] = useState<Record<number, { start?: string | null; end?: string | null; extension?: string | null }>>({});
  const [massApplying, setMassApplying] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [endDateResetConfirm, setEndDateResetConfirm] = useState<{
    row: SubmittedInstanceRow;
    nextStart: string | null;
    nextEnd: string | null;
    extensionPatch: { extension_date: string | null } | null;
  } | null>(null);
  const endDateResetPendingRef = useRef<{
    row: SubmittedInstanceRow;
    nextStart: string | null;
    nextEnd: string | null;
    extensionPatch: { extension_date: string | null } | null;
  } | null>(null);

  type DirectorySortKey = 'student' | 'form' | 'start' | 'end' | 'created' | 'workflow';
  const [directorySort, setDirectorySort] = useState<{ key: DirectorySortKey; dir: SortDirection }>({
    key: 'student',
    dir: 'asc',
  });

  const loadRows = useCallback(async (page: number, search: string, opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    const courseId = courseFilter ? Number(courseFilter) : undefined;
    const formId = formFilter ? Number(formFilter) : undefined;
    const startFrom = startFromFilter.trim() || null;
    const endDateTo = endDateToFilter.trim() || null;
    const res = await listSubmittedInstancesPaged(
      page,
      PAGE_SIZE,
      search,
      courseId,
      formId,
      undefined,
      {
        key: directorySort.key,
        dir: directorySort.dir,
      },
      null,
      workflowFilter,
      startFrom,
      endDateTo
    );
    setRows(res.data);
    setTotalRows(res.total);
    setLoading(false);
  }, [courseFilter, formFilter, directorySort, workflowFilter, startFromFilter, endDateToFilter]);

  const loadCoursesOptions = useCallback(async (page: number, search: string) => {
    const res = await listCoursesPaged(page, 20, search ? search.trim() : undefined);
    const opts = res.data.map((c) => ({ value: String(c.id), label: c.name }));
    const withAll = page === 1 && !search?.trim() ? [{ value: '', label: 'All courses' }, ...opts] : opts;
    return { options: withAll, hasMore: page * 20 < res.total };
  }, []);

  const loadFormsOptions = useCallback(async (page: number, search: string) => {
    const cid = courseFilter ? Number(courseFilter) : undefined;
    const res = await listFormsPaged(page, 20, undefined, cid, search || undefined, { asAdmin: true });
    const opts = res.data.map((f) => ({ value: String(f.id), label: `${f.name} (v${f.version ?? '1.0.0'})` }));
    const withAll = page === 1 && !search?.trim() ? [{ value: '', label: 'All forms' }, ...opts] : opts;
    return { options: withAll, hasMore: page * 20 < res.total };
  }, [courseFilter]);

  useEffect(() => {
    const t = setTimeout(() => {
      loadRows(currentPage, searchTerm);
    }, 250);
    return () => clearTimeout(t);
  }, [currentPage, searchTerm, courseFilter, formFilter, loadRows]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, courseFilter, formFilter, workflowFilter, startFromFilter, endDateToFilter]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadRows(currentPage, searchTerm, { silent: true });
    setRefreshing(false);
    toast.success('Assessments refreshed');
  };

  const handleCopyLink = async (instanceId: number, roleContext: 'student' | 'trainer' | 'office') => {
    const url = await getOrIssueInstanceAccessLink(instanceId, roleContext);
    if (!url) {
      toast.error('Failed to create secure link');
      return;
    }
    await navigator.clipboard.writeText(url);
    toast.success('Instance link copied');
  };

  const handleExpireLink = async (instanceId: number, roleContext: 'student' | 'trainer' | 'office') => {
    setManagingId(instanceId);
    await revokeRoleAccessTokens(instanceId, roleContext);
    setManagingId(null);
    await loadRows(currentPage, searchTerm, { silent: true });
    toast.success('Link expired. Student/trainer will not be able to access until you enable it.');
  };

  const handleEnableLink = async (instanceId: number, roleContext: 'student' | 'trainer' | 'office') => {
    setManagingId(instanceId);
    await extendInstanceAccessTokens(instanceId, roleContext, 30);
    setManagingId(null);
    await loadRows(currentPage, searchTerm, { silent: true });
    toast.success('Link re-enabled for 30 days.');
  };

  const openSendToTrainer = (row: SubmittedInstanceRow) => {
    // If this student's batch has a trainer, auto-send immediately (no manual modal).
    const instanceId = Number(row.id);
    const sid = Number(row.student_id);
    if (Number.isFinite(instanceId) && instanceId > 0 && Number.isFinite(sid) && sid > 0) {
      void (async () => {
        try {
          const { data: sRow } = await supabase
            .from('skyline_students')
            .select('batch_id')
            .eq('id', sid)
            .maybeSingle();
          const bid = Number((sRow as { batch_id?: number | null } | null)?.batch_id ?? 0);
          if (!Number.isFinite(bid) || bid <= 0) throw new Error('No batch');
          const { data: bRow } = await supabase
            .from('skyline_batches')
            .select('trainer_id, skyline_users(full_name, email)')
            .eq('id', bid)
            .maybeSingle();
          const tid = Number((bRow as { trainer_id?: number | null } | null)?.trainer_id ?? 0);
          if (!Number.isFinite(tid) || tid <= 0) throw new Error('No trainer');

          const u = (bRow as unknown as { skyline_users?: { full_name?: string | null; email?: string | null } | null } | null)?.skyline_users;
          const trainerName = String(u?.full_name ?? '').trim() || 'trainer';

          // Ensure trainer sees editable form (trainer can only edit in waiting_trainer workflow).
          setSendingId(instanceId);
          const alreadySubmitted =
            (Number(row.submission_count ?? 0) || (row.submitted_at ? 1 : 0)) > 0;
          if (row.status === 'draft' || row.role_context !== 'trainer') {
            if (alreadySubmitted) {
              const repaired = await repairInstanceTrainerHandoff(instanceId);
              if (!repaired.ok) {
                setSendingId(null);
                toast.error(repaired.error ?? 'Could not send to trainer');
                return;
              }
            } else if (row.status === 'draft') {
              await updateInstanceWorkflowStatus(instanceId, 'waiting_trainer');
            }
            setRows((prev) =>
              prev.map((r) =>
                r.id === instanceId ? { ...r, status: 'submitted', role_context: 'trainer' } : r
              )
            );
          }
          if (row.role_context !== 'trainer') {
            await updateInstanceRole(instanceId, 'trainer');
          }
          const url = await issueInstanceAccessLink(instanceId, 'trainer');
          setSendingId(null);
          if (!url) {
            toast.error('Failed to create secure link');
            return;
          }
          await navigator.clipboard.writeText(url);
          await loadRows(currentPage, searchTerm, { silent: true });
          toast.success(`Link copied for ${trainerName}. Share it with them.`);
          return;
        } catch {
          // Fallback to manual selection modal (no batch trainer configured)
        }

        setSendToTrainerRow(row);
        setSelectedTrainerId(null);
        setTrainersLoading(true);
        listTrainers().then((list) => {
          setTrainers(list);
          setTrainersLoading(false);
        });
      })();
      return;
    }

    // Fallback: manual selection modal
    setSendToTrainerRow(row);
    setSelectedTrainerId(null);
    setTrainersLoading(true);
    listTrainers().then((list) => {
      setTrainers(list);
      setTrainersLoading(false);
    });
  };

  const getEffectiveStart = useCallback(
    (row: SubmittedInstanceRow) => {
      const d = dateDrafts[row.id];
      if (d && 'start' in d) return String(d.start ?? '').trim();
      return String(row.start_date ?? '').trim();
    },
    [dateDrafts]
  );

  const getEffectiveEnd = useCallback(
    (row: SubmittedInstanceRow) => {
      const d = dateDrafts[row.id];
      if (d && 'end' in d) return String(d.end ?? '').trim();
      return String(row.end_date ?? '').trim();
    },
    [dateDrafts]
  );

  /** Extension shown/validated in the UI: an explicit draft, else what the DB trigger will make of it when end moves. */
  const getEffectiveExtension = useCallback(
    (row: SubmittedInstanceRow) => {
      const d = dateDrafts[row.id];
      if (d && 'extension' in d) return String(d.extension ?? '').trim();
      return (
        mirrorExtensionDate({
          oldEnd: row.end_date,
          newEnd: getEffectiveEnd(row),
          extension: row.extension_date,
        }) ?? ''
      );
    },
    [dateDrafts, getEffectiveEnd]
  );

  /** Only an explicitly edited extension is sent; otherwise the DB trigger keeps it in step with end_date. */
  const getExtensionPatch = useCallback(
    (row: SubmittedInstanceRow): { extension_date: string | null } | null => {
      const d = dateDrafts[row.id];
      if (!d || !('extension' in d)) return null;
      const next = String(d.extension ?? '').trim() || null;
      const current = String(row.extension_date ?? '').trim() || null;
      return next === current ? null : { extension_date: next };
    },
    [dateDrafts]
  );

  const hasRowDateChanges = useCallback(
    (row: SubmittedInstanceRow) => {
      const es = getEffectiveStart(row);
      const ee = getEffectiveEnd(row);
      const rs = String(row.start_date ?? '').trim();
      const re = String(row.end_date ?? '').trim();
      return es !== rs || ee !== re || getExtensionPatch(row) !== null;
    },
    [getEffectiveStart, getEffectiveEnd, getExtensionPatch]
  );

  const executeApplyRowDates = useCallback(
    async (
      row: SubmittedInstanceRow,
      nextStart: string | null,
      nextEnd: string | null,
      resetAttempts: boolean,
      opts?: { silent?: boolean },
      extensionPatch: { extension_date: string | null } | null = null
    ) => {
      try {
        setSavingDateId(row.id);
        await commitAssessmentDateChange(
          row.id,
          { start_date: nextStart, end_date: nextEnd, ...(extensionPatch ?? {}) },
          { resetAttempts }
        );
        setDateDrafts((prev) => {
          const next = { ...prev };
          delete next[row.id];
          return next;
        });
        setEditingDateCell(null);
        await loadRows(currentPage, searchTerm, { silent: true });
        if (!opts?.silent) {
          toast.success(resetAttempts ? 'Dates updated and assessment reset to attempt 1' : 'Dates updated');
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to update dates');
      } finally {
        setSavingDateId(null);
      }
    },
    [currentPage, loadRows, searchTerm]
  );

  const applyRowDates = useCallback(
    async (row: SubmittedInstanceRow, opts?: { silent?: boolean }) => {
      const nextStart = getEffectiveStart(row) || null;
      const nextEnd = getEffectiveEnd(row) || null;
      if (nextStart && nextEnd && nextStart > nextEnd) {
        toast.error('Start date cannot be later than end date');
        return;
      }
      const extensionError = validateExtensionDate(nextEnd, getEffectiveExtension(row));
      if (extensionError) {
        toast.error(extensionError);
        return;
      }
      const extensionPatch = getExtensionPatch(row);
      if (await resolveNeedsResetPrompt(row, nextEnd)) {
        const pending = { row, nextStart, nextEnd, extensionPatch };
        endDateResetPendingRef.current = pending;
        setEndDateResetConfirm(pending);
        return;
      }
      await executeApplyRowDates(row, nextStart, nextEnd, false, opts, extensionPatch);
    },
    [executeApplyRowDates, getEffectiveEnd, getEffectiveExtension, getEffectiveStart, getExtensionPatch]
  );

  const confirmEndDateReset = useCallback(async () => {
    const pending = endDateResetPendingRef.current;
    endDateResetPendingRef.current = null;
    setEndDateResetConfirm(null);
    if (!pending) return;
    await executeApplyRowDates(pending.row, pending.nextStart, pending.nextEnd, true, undefined, pending.extensionPatch);
  }, [executeApplyRowDates]);

  const cancelEndDateReset = useCallback(() => {
    endDateResetPendingRef.current = null;
    setEndDateResetConfirm(null);
  }, []);

  const massApplyDates = useCallback(async () => {
    const targets = rows.filter(hasRowDateChanges);
    if (targets.length === 0) return;
    setMassApplying(true);
    let ok = 0;
    let skippedReset = 0;
    try {
      for (const row of targets) {
        const nextStart = getEffectiveStart(row) || null;
        const nextEnd = getEffectiveEnd(row) || null;
        if (nextStart && nextEnd && nextStart > nextEnd) {
          toast.error(`Skipped ${row.form_name}: start cannot be after end`);
          continue;
        }
        const extensionError = validateExtensionDate(nextEnd, getEffectiveExtension(row));
        if (extensionError) {
          toast.error(`Skipped ${row.form_name}: ${extensionError}`);
          continue;
        }
        if (await resolveNeedsResetPrompt(row, nextEnd)) {
          skippedReset++;
          continue;
        }
        await commitAssessmentDateChange(
          row.id,
          { start_date: nextStart, end_date: nextEnd, ...(getExtensionPatch(row) ?? {}) },
          { resetAttempts: false }
        );
        setDateDrafts((prev) => {
          const n = { ...prev };
          delete n[row.id];
          return n;
        });
        ok++;
      }
      setEditingDateCell(null);
      await loadRows(currentPage, searchTerm, { silent: true });
      if (skippedReset > 0) {
        toast.info(
          `${skippedReset} assessment${skippedReset !== 1 ? 's' : ''} skipped — use Apply on each row to confirm reset`
        );
      }
      if (ok > 0) toast.success(`Updated ${ok} assessment${ok !== 1 ? 's' : ''}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Mass apply failed');
    } finally {
      setMassApplying(false);
    }
  }, [rows, currentPage, getEffectiveEnd, getEffectiveExtension, getEffectiveStart, getExtensionPatch, hasRowDateChanges, loadRows, searchTerm]);

  const handleExport = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    setExportProgress(0);

    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = 'Export is in progress. If you leave, the export will be lost.';
    };
    window.addEventListener('beforeunload', beforeUnload);

    const toastId = toast.persistent('Preparing export… 0%', 'info');

    try {
      const BATCH = 500;
      const allRows: SubmittedInstanceRow[] = [];
      const courseId = courseFilter ? Number(courseFilter) : undefined;
      const fId = formFilter ? Number(formFilter) : undefined;
      const startFrom = startFromFilter.trim() || null;
      const endDateTo = endDateToFilter.trim() || null;
      const first = await listSubmittedInstancesPaged(1, BATCH, searchTerm || undefined, courseId, fId, undefined, { key: directorySort.key, dir: directorySort.dir }, null, workflowFilter, startFrom, endDateTo);
      allRows.push(...first.data);
      const total = first.total;
      const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 100);
      setExportProgress(pct(allRows.length));
      toast.update(toastId, `Exporting… ${pct(allRows.length)}% (${allRows.length} / ${total})`);

      const totalPages = Math.ceil(total / BATCH);
      for (let p = 2; p <= totalPages; p++) {
        const batch = await listSubmittedInstancesPaged(p, BATCH, searchTerm || undefined, courseId, fId, undefined, { key: directorySort.key, dir: directorySort.dir }, null, workflowFilter, startFrom, endDateTo);
        allRows.push(...batch.data);
        const progress = pct(allRows.length);
        setExportProgress(progress);
        toast.update(toastId, `Exporting… ${progress}% (${allRows.length} / ${total})`);
      }
      setExportProgress(100);
      toast.update(toastId, 'Loading assessment attempt status…');

      const summaryById: Record<number, { final_attempt_1_result: AttemptResult; final_attempt_2_result: AttemptResult; final_attempt_3_result: AttemptResult }> = {};
      const ids = allRows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0);
      const CHUNK = 500;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const part = await fetchAssessmentSummaries(ids.slice(i, i + CHUNK));
        Object.assign(summaryById, part as typeof summaryById);
      }

      toast.update(toastId, 'Generating file…');

      const sheetData = allRows.map((r) => ({
        'Name': r.student_name,
        'Student ID': r.student_email || '-',
        'Form Name': r.form_name,
        'Start Date': formatDDMMYYYY(r.start_date),
        'End Date': formatDDMMYYYY(r.end_date),
        'Status': (() => {
          const sum = summaryById[r.id] ?? null;
          const rawAttemptResults: AttemptResult[] = [
            sum?.final_attempt_1_result ?? null,
            sum?.final_attempt_2_result ?? null,
            sum?.final_attempt_3_result ?? null,
          ];
          return getExportStatusText(r, rawAttemptResults);
        })(),
      }));

      const ws = XLSX.utils.json_to_sheet(sheetData);
      ws['!cols'] = [
        { wch: 40 },
        { wch: 42 },
        { wch: 60 },
        { wch: 20 },
        { wch: 20 },
        { wch: 70 }, // Status (wraps)
      ];

      // Wrap Status column text so long statuses are readable.
      try {
        const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
        const statusCol = 5; // 0-based (A=0 ... F=5)
        for (let r = range.s.r; r <= range.e.r; r++) {
          const addr = XLSX.utils.encode_cell({ r, c: statusCol });
          const cell = ws[addr] as { s?: unknown } | undefined;
          if (!cell) continue;
          (cell as unknown as { s: { alignment: { wrapText: boolean; vertical?: string } } }).s = {
            alignment: { wrapText: true, vertical: 'top' },
          };
        }
      } catch {
        // styling is best-effort (xlsx style support varies by environment)
      }
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Assessments');
      const today = new Date();
      const exportDateStr = `${pad2(today.getDate())}-${pad2(today.getMonth() + 1)}-${today.getFullYear()}`;
      XLSX.writeFile(wb, `Assessments_Export_${exportDateStr}.xlsx`, { cellStyles: true });

      toast.remove(toastId);
      toast.success(`Exported ${allRows.length} assessments`);
    } catch (err) {
      console.error('Export error', err);
      toast.remove(toastId);
      toast.error(err instanceof Error ? err.message : 'Export failed');
    } finally {
      window.removeEventListener('beforeunload', beforeUnload);
      setExporting(false);
      setExportProgress(0);
    }
  }, [exporting, courseFilter, formFilter, searchTerm, directorySort, workflowFilter, startFromFilter, endDateToFilter]);

  const handleSendToTrainerConfirm = async () => {
    if (!sendToTrainerRow || !selectedTrainerId) return;
    const trainer = trainers.find((t) => t.id === selectedTrainerId);
    setSendingId(sendToTrainerRow.id);
    const alreadySubmitted =
      (Number(sendToTrainerRow.submission_count ?? 0) || (sendToTrainerRow.submitted_at ? 1 : 0)) > 0;
    if (sendToTrainerRow.status === 'draft' || sendToTrainerRow.role_context !== 'trainer') {
      if (alreadySubmitted) {
        const repaired = await repairInstanceTrainerHandoff(sendToTrainerRow.id);
        if (!repaired.ok) {
          setSendingId(null);
          toast.error(repaired.error ?? 'Could not send to trainer');
          return;
        }
      } else if (sendToTrainerRow.status === 'draft') {
        await updateInstanceWorkflowStatus(sendToTrainerRow.id, 'waiting_trainer');
      }
      setRows((prev) =>
        prev.map((r) =>
          r.id === sendToTrainerRow.id ? { ...r, status: 'submitted', role_context: 'trainer' } : r
        )
      );
    }
    if (sendToTrainerRow.role_context !== 'trainer') {
      await updateInstanceRole(sendToTrainerRow.id, 'trainer');
    }
    const url = await issueInstanceAccessLink(sendToTrainerRow.id, 'trainer');
    setSendingId(null);
    setSendToTrainerRow(null);
    setSelectedTrainerId(null);
    if (!url) {
      toast.error('Failed to create secure link');
      return;
    }
    await navigator.clipboard.writeText(url);
    await loadRows(currentPage, searchTerm, { silent: true });
    toast.success(`Link copied for ${trainer?.full_name ?? 'trainer'}. Share it with them.`);
  };

  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));

  const toggleDirectorySort = (key: DirectorySortKey) => {
    setDirectorySort((prev) => {
      if (prev.key !== key) return { key, dir: 'asc' };
      return { key: prev.key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
    });
    setCurrentPage(1);
  };

  const sortedRows = rows;

  const handleDownloadStoredPdf = useCallback(
    (instanceId: number) => downloadInstancePdf(instanceId, 'office'),
    [downloadInstancePdf],
  );

  const renderAssessmentActions = (row: SubmittedInstanceRow, mode: 'toolbar' | 'stack') => {
    const role = row.role_context === 'trainer' ? 'trainer' : row.role_context === 'office' ? 'office' : 'student';
    // Admin "Open" should always unlock all fields (admin edit mode),
    // so we always open the office link (which supports admin override in the fill page).
    const openRole: 'office' = 'office';
    const submissionCount = Number((row as unknown as { submission_count?: number }).submission_count ?? 0);
    const showResubmit =
      row.status !== 'locked' &&
      (row.role_context === 'trainer' || row.role_context === 'office') &&
      (submissionCount > 0 || !!row.submitted_at) &&
      submissionCount < 3;

    const actionBtn =
      'relative group inline-flex h-8 w-8 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-600 hover:bg-[var(--brand)]/10 hover:border-[var(--brand)]/40 hover:text-[var(--brand)] transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-white disabled:hover:border-gray-200 disabled:hover:text-gray-600';
    const actionIcon = 'w-4 h-4 shrink-0';
    // 3D-style hover label (tooltip) for icon-only buttons.
    const actionText =
      'pointer-events-none absolute -top-2 left-1/2 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] font-medium text-gray-800 shadow-[0_10px_20px_rgba(0,0,0,0.15)] opacity-0 scale-95 transition-all duration-150 group-hover:opacity-100 group-hover:scale-100';

    const openLinkAs = async (targetRole: 'student' | 'trainer' | 'office') => {
      const url = await getOrIssueInstanceAccessLink(row.id, targetRole);
      if (!url) {
        toast.error('Failed to open secure link');
        return;
      }
      // When opening from Admin, we want an "admin edit mode" that unlocks *all* fields.
      // This is a UI-only flag; auth/role is still enforced by the signed token.
      const nextUrl = (() => {
        try {
          const u = new URL(url, window.location.origin);
          if (targetRole === 'office') u.searchParams.set('admin', '1');
          return u.toString();
        } catch {
          return url;
        }
      })();
      window.open(nextUrl, '_blank');
    };
    const openLink = async () => openLinkAs(openRole);
    const pdfDownloading = downloadingPdfId === row.id;

    if (mode === 'stack') {
      return (
        <div className="mt-3 flex flex-col gap-2">
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-center border-[#ea580c]/40 text-[#c2410c] hover:bg-[#fff7ed]"
            onClick={() => void applyRowDates(row)}
            disabled={!hasRowDateChanges(row) || savingDateId === row.id || massApplying}
          >
            Apply dates
          </Button>
          <Button variant="outline" size="sm" className="w-full justify-center" onClick={() => setQuickEditRow(row)}>
            <PencilLine className="mr-2 h-4 w-4 shrink-0" />
            Quick Edit
          </Button>
          <Button variant="outline" size="sm" className="w-full justify-center" onClick={openLink}>
            <ExternalLink className="mr-2 h-4 w-4 shrink-0" />
            Open
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-center"
            onClick={() => void handleDownloadStoredPdf(row.id)}
            disabled={pdfDownloading}
            title="Download stored PDF from SharePoint"
          >
            <Download className="mr-2 h-4 w-4 shrink-0" />
            {pdfDownloading ? 'Opening…' : 'Download PDF'}
          </Button>
          <Button variant="outline" size="sm" className="w-full justify-center" onClick={() => void handleCopyLink(row.id, role)}>
            <Copy className="mr-2 h-4 w-4 shrink-0" />
            Copy link
          </Button>
          {!row.link_expired && (
            <Button variant="outline" size="sm" className="w-full justify-center" onClick={() => void handleExpireLink(row.id, role)} disabled={managingId === row.id}>
              <Ban className="mr-2 h-4 w-4 shrink-0" />
              Expire link
            </Button>
          )}
          {row.link_expired && (
            <Button variant="outline" size="sm" className="w-full justify-center" onClick={() => void handleEnableLink(row.id, role)} disabled={managingId === row.id}>
              <CheckCircle className="mr-2 h-4 w-4 shrink-0" />
              Enable link
            </Button>
          )}
          {showResubmit && (
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-center"
              onClick={async () => {
                setManagingId(row.id);
                await allowStudentResubmission(row.id);
                setManagingId(null);
                await loadRows(currentPage, searchTerm, { silent: true });
                const url = `${window.location.origin}/forms/${row.form_id}/student-access`;
                await navigator.clipboard.writeText(url);
                toast.success('Resubmission allowed. Generic link copied—student uses email and OTP.');
              }}
              disabled={managingId === row.id}
            >
              <CheckCircle className="mr-2 h-4 w-4 shrink-0" />
              Allow resubmission
            </Button>
          )}
          {(row.status === 'submitted' || row.status === 'draft') && (
            <Button variant="outline" size="sm" className="w-full justify-center" onClick={() => openSendToTrainer(row)} disabled={sendingId === row.id}>
              <Send className="mr-2 h-4 w-4 shrink-0" />
              {sendingId === row.id ? 'Sending...' : row.role_context === 'trainer' ? 'Resend to Trainer' : 'Send to Trainer'}
            </Button>
          )}
        </div>
      );
    }

    return (
      <div className="flex flex-wrap items-center justify-end gap-1">
        <button
          type="button"
          onClick={() => void applyRowDates(row)}
          disabled={!hasRowDateChanges(row) || savingDateId === row.id || massApplying}
          className="relative group inline-flex h-8 min-w-[3.25rem] shrink-0 items-center justify-center rounded-md border border-[#ea580c]/40 bg-white px-2 text-xs font-semibold text-[#c2410c] hover:bg-[#fff7ed] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white"
          aria-label="Apply date changes"
        >
          Apply
        </button>
        <button
          type="button"
          onClick={() => setQuickEditRow(row)}
          className={actionBtn}
          aria-label="Quick edit assessment fields"
          title="Quick edit assessment fields"
        >
          <PencilLine className={actionIcon} />
          <span className={actionText}>Quick Edit</span>
        </button>
        <button type="button" onClick={openLink} className={actionBtn} aria-label="Open">
          <ExternalLink className={actionIcon} />
          <span className={actionText}>Open</span>
        </button>
        <button
          type="button"
          onClick={() => void handleDownloadStoredPdf(row.id)}
          className={actionBtn}
          disabled={pdfDownloading}
          aria-label="Download PDF"
          title="Download stored PDF from SharePoint"
        >
          <Download className={actionIcon} />
          <span className={actionText}>{pdfDownloading ? 'Opening…' : 'Download PDF'}</span>
        </button>
        <button type="button" onClick={() => void handleCopyLink(row.id, role)} className={actionBtn} aria-label="Copy link">
          <Copy className={actionIcon} />
          <span className={actionText}>Copy link</span>
        </button>
        {!row.link_expired && (
          <button type="button" onClick={() => void handleExpireLink(row.id, role)} disabled={managingId === row.id} className={actionBtn} aria-label="Expire link">
            <Ban className={actionIcon} />
            <span className={actionText}>Expire</span>
          </button>
        )}
        {row.link_expired && (
          <button type="button" onClick={() => void handleEnableLink(row.id, role)} disabled={managingId === row.id} className={actionBtn} aria-label="Enable link">
            <CheckCircle className={actionIcon} />
            <span className={actionText}>Enable</span>
          </button>
        )}
        {showResubmit && (
          <button
            type="button"
            onClick={async () => {
              setManagingId(row.id);
              await allowStudentResubmission(row.id);
              setManagingId(null);
              await loadRows(currentPage, searchTerm, { silent: true });
              const url = `${window.location.origin}/forms/${row.form_id}/student-access`;
              await navigator.clipboard.writeText(url);
              toast.success('Resubmission allowed. Generic link copied—student uses email and OTP.');
            }}
            disabled={managingId === row.id}
            className={actionBtn}
            aria-label="Allow resubmission"
          >
            <CheckCircle className={actionIcon} />
            <span className={actionText}>Allow resubmission</span>
          </button>
        )}
        {(row.status === 'submitted' || row.status === 'draft') && (
          <button type="button" onClick={() => openSendToTrainer(row)} disabled={sendingId === row.id} className={actionBtn} aria-label={row.role_context === 'trainer' ? 'Resend to trainer' : 'Send to trainer'}>
            <Send className={actionIcon} />
            <span className={actionText}>
              {sendingId === row.id ? 'Sending…' : row.role_context === 'trainer' ? 'Resend to trainer' : 'Send to trainer'}
            </span>
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <div className="w-full px-4 md:px-6 lg:px-8 py-6">
        <Card className="mb-6">
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-bold text-[var(--text)]">Assessments</h2>
              <p className="text-sm text-gray-600 mt-1">
                View all assessments sent to students (pending and submitted) and send completed ones to trainer.
              </p>
            </div>
            <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
              {/* Search + filters: stay grouped on the left; wrap on smaller viewports */}
              <div className="flex min-w-0 flex-1 flex-wrap items-end gap-2 sm:gap-3">
                <Input
                  value={searchTerm}
                  onChange={(e) => {
                    setSearchTerm(e.target.value);
                    setCurrentPage(1);
                  }}
                  placeholder="Search student, Student ID, unit code, or Student ID + Unit Code"
                  className="w-full min-w-0 sm:max-w-[min(100%,280px)] sm:flex-[1_1_200px]"
                />
                <div className="w-full min-w-0 sm:w-[13rem] sm:max-w-[14rem] sm:flex-shrink-0">
                  <SelectAsync
                    value={courseFilter}
                    onChange={(v) => {
                      setCourseFilter(v);
                      setFormFilter('');
                    }}
                    loadOptions={loadCoursesOptions}
                    placeholder="All courses"
                    selectedLabel={courseFilter ? undefined : 'All courses'}
                  />
                </div>
                <div className="w-full min-w-0 sm:w-[15rem] sm:max-w-[16rem] sm:flex-shrink-0">
                  <SelectAsync
                    value={formFilter}
                    onChange={(v) => setFormFilter(v)}
                    loadOptions={loadFormsOptions}
                    placeholder="All forms"
                    selectedLabel={formFilter ? undefined : 'All forms'}
                  />
                </div>
                {/* Not compact: compact mode caps dropdown menu at ~120px wide and truncates labels */}
                <div className="w-full min-w-[12rem] sm:w-[min(100%,18rem)] sm:min-w-[14rem] sm:flex-shrink-0">
                  <Select
                    label="Workflow"
                    value={workflowFilter}
                    onChange={(v) => {
                      setWorkflowFilter(v as AssessmentDirectoryWorkflowFilter);
                      setCurrentPage(1);
                    }}
                    options={WORKFLOW_FILTER_OPTIONS}
                    className="w-full min-w-0"
                  />
                </div>
                <div className="w-full min-w-0 sm:w-[13rem] sm:flex-shrink-0">
                  <div className="text-xs font-medium text-gray-600 mb-1">Start from</div>
                  <DatePicker
                    value={startFromFilter}
                    onChange={(v) => {
                      setStartFromFilter(v || '');
                      setCurrentPage(1);
                    }}
                    compact
                    placement="below"
                  />
                </div>
                <div className="w-full min-w-0 sm:w-[13rem] sm:flex-shrink-0">
                  <div className="text-xs font-medium text-gray-600 mb-1">End date</div>
                  <DatePicker
                    value={endDateToFilter}
                    onChange={(v) => {
                      setEndDateToFilter(v || '');
                      setCurrentPage(1);
                    }}
                    compact
                    placement="below"
                  />
                </div>
              </div>
              <div className="flex w-full shrink-0 justify-end gap-2 xl:w-auto xl:pl-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setSearchTerm('');
                    setCourseFilter('');
                    setFormFilter('');
                    setWorkflowFilter('all');
                    setStartFromFilter('');
                    setEndDateToFilter('');
                    setCurrentPage(1);
                  }}
                  disabled={loading || exporting || refreshing}
                  className="inline-flex h-10 min-h-[40px] w-full items-center justify-center gap-2 whitespace-nowrap sm:w-auto"
                >
                  Clear
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleExport()}
                  disabled={exporting || loading}
                  className="inline-flex h-10 min-h-[40px] w-full items-center justify-center gap-2 whitespace-nowrap sm:w-auto"
                >
                  {exporting ? (
                    <>
                      <Loader variant="dots" size="sm" inline className="mr-0.5" />
                      <span>Exporting {exportProgress}%</span>
                    </>
                  ) : (
                    <>
                      <FileDown className="h-4 w-4" />
                      <span>Export</span>
                    </>
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleRefresh}
                  disabled={refreshing}
                  className="inline-flex h-10 min-h-[40px] w-full items-center justify-center gap-2 whitespace-nowrap sm:w-auto"
                >
                  <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
                  <span>Refresh</span>
                </Button>
              </div>
            </div>

          </div>
        </Card>

        <Card>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
            <h2 className="text-lg font-bold text-[var(--text)]">Assessment directory</h2>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 border-[#ea580c]/40 text-[#c2410c] hover:bg-[#fff7ed] sm:ml-auto"
              onClick={() => void massApplyDates()}
              disabled={massApplying || rows.length === 0 || !rows.some(hasRowDateChanges)}
            >
              {massApplying ? 'Applying…' : 'Mass apply'}
            </Button>
          </div>
          {!loading && (
            <AdminListPagination
              placement="top"
              totalItems={totalRows}
              pageSize={PAGE_SIZE}
              currentPage={currentPage}
              totalPages={totalPages}
              onPrev={() => setCurrentPage((p) => Math.max(1, p - 1))}
              onNext={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              onGoToPage={(p) => setCurrentPage(p)}
              itemLabel="assessments"
            />
          )}
          {loading ? (
            <Loader variant="dots" size="lg" message="Loading assessments..." />
          ) : rows.length === 0 ? (
            <div className="py-12 text-center text-sm text-gray-500">
              No assessments sent to students yet.
            </div>
          ) : (
            <>
              <div className="space-y-3 lg:hidden">
                {sortedRows.map((row) => {
                  const missedAttemptText = getMissedAttemptWindowText({
                    noAttemptRollovers: (row as unknown as { no_attempt_rollovers?: number | null }).no_attempt_rollovers ?? null,
                    didNotAttempt: (row as unknown as { did_not_attempt?: boolean | null }).did_not_attempt ?? null,
                    status: row.status,
                    submissionCount: row.submission_count,
                    submittedAt: row.submitted_at,
                  });
                  return (
                  <div
                    key={row.id}
                    className={`rounded-lg border border-[var(--border)] p-4 shadow-sm ${getDirectoryRowClass(row, trainerHighlightCourseId)} cursor-pointer`}
                    onClick={() => setExpandedId((p) => (p === row.id ? null : row.id))}
                    title="Click to view documents"
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-600">
                        <User className="h-5 w-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-[var(--text)] break-words">{row.student_name}</div>
                        <div className="text-xs text-gray-500 break-all">{row.student_email || '—'}</div>
                        <div className="mt-2 font-medium text-gray-900 break-words">{row.form_name}</div>
                        <div className="text-xs text-gray-500">Version {row.form_version ?? '1.0.0'}</div>
                        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs text-gray-600">
                          <dt className="text-gray-500">Start</dt>
                          <dd className="min-w-0">
                            {editingDateCell?.id === row.id && editingDateCell.field === 'start' ? (
                              <DatePicker
                                value={getEffectiveStart(row)}
                                onChange={(v) =>
                                  setDateDrafts((prev) => ({
                                    ...prev,
                                    [row.id]: { ...prev[row.id], start: v || null },
                                  }))
                                }
                                compact
                                placement="below"
                                className="max-w-[160px]"
                                disabled={savingDateId === row.id || massApplying}
                                maxDate={getEffectiveEnd(row) || undefined}
                              />
                            ) : (
                              <button
                                type="button"
                                className="text-gray-800 hover:underline text-left"
                                onClick={() => setEditingDateCell({ id: row.id, field: 'start' })}
                                disabled={savingDateId === row.id || massApplying}
                              >
                                {formatDDMMYYYY(getEffectiveStart(row) || row.start_date)}
                              </button>
                            )}
                          </dd>
                          <dt className="text-gray-500">End</dt>
                          <dd className="min-w-0">
                            {editingDateCell?.id === row.id && editingDateCell.field === 'end' ? (
                              <DatePicker
                                value={getEffectiveEnd(row)}
                                onChange={(v) =>
                                  setDateDrafts((prev) => ({
                                    ...prev,
                                    [row.id]: { ...prev[row.id], end: v || null },
                                  }))
                                }
                                compact
                                placement="below"
                                className="max-w-[160px]"
                                disabled={savingDateId === row.id || massApplying}
                                minDate={getEffectiveStart(row) || undefined}
                              />
                            ) : (
                              <button
                                type="button"
                                className="text-gray-800 hover:underline text-left"
                                onClick={() => setEditingDateCell({ id: row.id, field: 'end' })}
                                disabled={savingDateId === row.id || massApplying}
                              >
                                {formatDDMMYYYY(getEffectiveEnd(row) || row.end_date)}
                              </button>
                            )}
                          </dd>
                          <dt className="text-gray-500">Extension</dt>
                          <dd className="min-w-0">
                            {editingDateCell?.id === row.id && editingDateCell.field === 'extension' ? (
                              <DatePicker
                                value={getEffectiveExtension(row)}
                                onChange={(v) =>
                                  setDateDrafts((prev) => ({
                                    ...prev,
                                    [row.id]: { ...prev[row.id], extension: v || null },
                                  }))
                                }
                                compact
                                placement="below"
                                className="max-w-[160px]"
                                disabled={savingDateId === row.id || massApplying}
                                minDate={getEffectiveEnd(row) || undefined}
                              />
                            ) : getEffectiveExtension(row) ? (
                              <button
                                type="button"
                                className="text-gray-800 hover:underline text-left"
                                onClick={() => setEditingDateCell({ id: row.id, field: 'extension' })}
                                disabled={savingDateId === row.id || massApplying}
                                title="Edit extension date (the deadline is the extension when set)"
                              >
                                {formatDDMMYYYY(getEffectiveExtension(row))}
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="text-gray-400 hover:text-[var(--brand)] hover:underline text-left"
                                onClick={() => setEditingDateCell({ id: row.id, field: 'extension' })}
                                disabled={savingDateId === row.id || massApplying}
                                title="Add an extension date (later deadline)"
                              >
                                — <span className="ml-1">+ Add extension</span>
                              </button>
                            )}
                          </dd>
                          <dt className="text-gray-500">Created</dt>
                          <dd>{formatDDMMYYYY(row.created_at)}</dd>
                          <dt className="text-gray-500">Submitted</dt>
                          <dd>{formatDDMMYYYY(row.submitted_at)}</dd>
                        </dl>
                        <div className="mt-2">
                          <span className={`inline-flex rounded-md px-2.5 py-1 text-xs font-medium ${getInstanceWorkflowBadgeClass(getWorkflowRowInput(row), { withBorder: true })}`}>
                            {getInstanceWorkflowLabel(getWorkflowRowInput(row), { submittedFallback: 'Submitted (Not Sent)' })}
                          </span>
                        </div>
                        {missedAttemptText ? (
                          <div className="mt-1 text-[11px] font-medium text-amber-700">{missedAttemptText}</div>
                        ) : null}
                        {renderAssessmentActions(row, 'stack')}
                        {expandedId === row.id ? (
                          <div className="mt-3" onClick={(e) => e.stopPropagation()}>
                            <FormDocumentsPanel
                              formId={Number(row.form_id)}
                              formName={String(row.form_name ?? 'Assessment')}
                              canUpload
                              canDelete={viewerIsSuperadmin}
                            />
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  );
                })}
              </div>
              <div className="hidden overflow-x-auto lg:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                      <SortableTh
                        label="Student"
                        className="py-3 pr-3 text-left"
                        active={directorySort.key === 'student'}
                        direction={directorySort.dir}
                        onToggle={() => toggleDirectorySort('student')}
                      />
                      <SortableTh
                        label="Form"
                        className="py-3 pr-3 text-left"
                        active={directorySort.key === 'form'}
                        direction={directorySort.dir}
                        onToggle={() => toggleDirectorySort('form')}
                      />
                      <SortableTh
                        label="Start"
                        className="py-3 pr-3 text-left w-[120px]"
                        active={directorySort.key === 'start'}
                        direction={directorySort.dir}
                        onToggle={() => toggleDirectorySort('start')}
                      />
                      <SortableTh
                        label="End"
                        className="py-3 pr-3 text-left w-[120px]"
                        active={directorySort.key === 'end'}
                        direction={directorySort.dir}
                        onToggle={() => toggleDirectorySort('end')}
                      />
                      <th className="py-3 pr-3 text-left w-[140px] whitespace-nowrap font-semibold">Extension</th>
                      <SortableTh
                        label="Created"
                        className="py-3 pr-3 text-left w-[120px]"
                        active={directorySort.key === 'created'}
                        direction={directorySort.dir}
                        onToggle={() => toggleDirectorySort('created')}
                      />
                      <SortableTh
                        label="Workflow"
                        className="py-3 pr-3 text-left w-[140px]"
                        active={directorySort.key === 'workflow'}
                        direction={directorySort.dir}
                        onToggle={() => toggleDirectorySort('workflow')}
                      />
                      <th className="py-3 text-right min-w-[220px] font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map((row) => {
                      const missedAttemptText = getMissedAttemptWindowText({
                        noAttemptRollovers: (row as unknown as { no_attempt_rollovers?: number | null }).no_attempt_rollovers ?? null,
                        didNotAttempt: (row as unknown as { did_not_attempt?: boolean | null }).did_not_attempt ?? null,
                        status: row.status,
                        submissionCount: row.submission_count,
                        submittedAt: row.submitted_at,
                      });
                      return (
                        <React.Fragment key={row.id}>
                          <tr
                            className={`border-b border-gray-100 ${getDirectoryRowClass(row, trainerHighlightCourseId)} cursor-pointer`}
                            onClick={() => setExpandedId((p) => (p === row.id ? null : row.id))}
                            title="Click to view documents"
                          >
                            <td className="py-3 pr-3">
                              <div className="font-medium text-gray-900">{row.student_name}</div>
                              <div className="text-xs text-gray-500">{row.student_email || '-'}</div>
                            </td>
                        <td className="py-3 pr-3 w-[220px] max-w-[220px] align-top">
                          <div className="font-medium text-gray-900 break-words whitespace-normal leading-snug">
                            {row.form_name}
                          </div>
                          <div className="text-xs text-gray-500 break-words whitespace-normal">Version {row.form_version ?? '1.0.0'}</div>
                        </td>
                        <td className="py-3 pr-3 text-gray-700">
                          {editingDateCell?.id === row.id && editingDateCell.field === 'start' ? (
                            <DatePicker
                              value={getEffectiveStart(row)}
                              onChange={(v) =>
                                setDateDrafts((prev) => ({
                                  ...prev,
                                  [row.id]: { ...prev[row.id], start: v || null },
                                }))
                              }
                              compact
                              placement="below"
                              className="max-w-[160px]"
                              disabled={savingDateId === row.id || massApplying}
                              maxDate={getEffectiveEnd(row) || undefined}
                            />
                          ) : (
                            <button
                              type="button"
                              className="text-gray-700 hover:underline"
                              onClick={() => setEditingDateCell({ id: row.id, field: 'start' })}
                              disabled={savingDateId === row.id || massApplying}
                            >
                              {formatDDMMYYYY(getEffectiveStart(row) || row.start_date)}
                            </button>
                          )}
                        </td>
                        <td className="py-3 pr-3 text-gray-700">
                          {editingDateCell?.id === row.id && editingDateCell.field === 'end' ? (
                            <DatePicker
                              value={getEffectiveEnd(row)}
                              onChange={(v) =>
                                setDateDrafts((prev) => ({
                                  ...prev,
                                  [row.id]: { ...prev[row.id], end: v || null },
                                }))
                              }
                              compact
                              placement="below"
                              className="max-w-[160px]"
                              disabled={savingDateId === row.id || massApplying}
                              minDate={getEffectiveStart(row) || undefined}
                            />
                          ) : (
                            <button
                              type="button"
                              className="text-gray-700 hover:underline"
                              onClick={() => setEditingDateCell({ id: row.id, field: 'end' })}
                              disabled={savingDateId === row.id || massApplying}
                            >
                              {formatDDMMYYYY(getEffectiveEnd(row) || row.end_date)}
                            </button>
                          )}
                        </td>
                        <td className="py-3 pr-3 text-gray-700 whitespace-nowrap">
                          {editingDateCell?.id === row.id && editingDateCell.field === 'extension' ? (
                            <DatePicker
                              value={getEffectiveExtension(row)}
                              onChange={(v) =>
                                setDateDrafts((prev) => ({
                                  ...prev,
                                  [row.id]: { ...prev[row.id], extension: v || null },
                                }))
                              }
                              compact
                              placement="below"
                              className="max-w-[160px]"
                              disabled={savingDateId === row.id || massApplying}
                              minDate={getEffectiveEnd(row) || undefined}
                            />
                          ) : getEffectiveExtension(row) ? (
                            <button
                              type="button"
                              className="text-gray-700 hover:underline"
                              onClick={() => setEditingDateCell({ id: row.id, field: 'extension' })}
                              disabled={savingDateId === row.id || massApplying}
                              title="Edit extension date (the deadline is the extension when set)"
                            >
                              {formatDDMMYYYY(getEffectiveExtension(row))}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="text-xs text-gray-400 hover:text-[var(--brand)] hover:underline"
                              onClick={() => setEditingDateCell({ id: row.id, field: 'extension' })}
                              disabled={savingDateId === row.id || massApplying}
                              title="Add an extension date (later deadline)"
                            >
                              — <span className="ml-1">+ Add extension</span>
                            </button>
                          )}
                        </td>
                        <td className="py-3 pr-3 text-gray-700">{formatDDMMYYYY(row.created_at)}</td>
                        <td className="py-3 pr-3">
                          <span className={`inline-flex rounded-md px-2.5 py-1 text-xs font-medium ${getInstanceWorkflowBadgeClass(getWorkflowRowInput(row), { withBorder: true })}`}>
                            {getInstanceWorkflowLabel(getWorkflowRowInput(row), { submittedFallback: 'Submitted (Not Sent)' })}
                          </span>
                          {missedAttemptText ? (
                            <div className="mt-1 text-[11px] font-medium text-amber-700">{missedAttemptText}</div>
                          ) : null}
                        </td>
                            <td className="py-3 align-middle" onClick={(e) => e.stopPropagation()}>
                              {renderAssessmentActions(row, 'toolbar')}
                            </td>
                          </tr>
                          {expandedId === row.id ? (
                            <tr className={getDirectoryRowClass(row, trainerHighlightCourseId)}>
                              <td colSpan={8} className="pb-4" onClick={(e) => e.stopPropagation()}>
                                <div className="px-3">
                                  <FormDocumentsPanel
                                    formId={Number(row.form_id)}
                                    formName={String(row.form_name ?? 'Assessment')}
                                    canUpload
                                    canDelete={viewerIsSuperadmin}
                                  />
                                </div>
                              </td>
                            </tr>
                          ) : null}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {!loading && (
            <AdminListPagination
              placement="bottom"
              totalItems={totalRows}
              pageSize={PAGE_SIZE}
              currentPage={currentPage}
              totalPages={totalPages}
              onPrev={() => setCurrentPage((p) => Math.max(1, p - 1))}
              onNext={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              onGoToPage={(p) => setCurrentPage(p)}
              itemLabel="assessments"
            />
          )}
        </Card>

        <Modal
          isOpen={!!sendToTrainerRow}
          onClose={() => {
            setSendToTrainerRow(null);
            setSelectedTrainerId(null);
          }}
          title="Send to Trainer"
          size="md"
        >
          {sendToTrainerRow && (
            <div className="space-y-4">
              <p className="text-sm text-gray-600">
                Select a trainer. The assessment link will be copied to your clipboard for you to share with them.
              </p>
              {trainersLoading ? (
                <Loader variant="dots" size="sm" message="Loading trainers..." />
              ) : trainers.length === 0 ? (
                <p className="text-sm text-gray-500 py-4">No trainers found. Add trainers first.</p>
              ) : (
                <div className="max-h-[280px] overflow-y-auto border border-[var(--border)] rounded-lg divide-y divide-[var(--border)]">
                  {trainers.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setSelectedTrainerId(selectedTrainerId === t.id ? null : t.id)}
                      className={`w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[var(--brand)]/10 focus-visible:bg-[var(--brand)]/10 transition-colors ${
                        selectedTrainerId === t.id ? 'bg-[var(--brand)]/10 ring-1 ring-[var(--brand)]' : ''
                      }`}
                    >
                      <div
                        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                          selectedTrainerId === t.id ? 'border-[var(--brand)] bg-[var(--brand)]' : 'border-gray-300'
                        }`}
                      >
                        {selectedTrainerId === t.id && (
                          <div className="w-2 h-2 rounded-full bg-white" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-gray-900 truncate">{t.full_name}{t.role && <span className="ml-2 text-xs font-normal text-gray-500 capitalize">({t.role})</span>}</div>
                        <div className="text-xs text-gray-500 truncate">{t.email}</div>
                      </div>
                      <User className="w-4 h-4 text-gray-400 shrink-0" />
                    </button>
                  ))}
                </div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => { setSendToTrainerRow(null); setSelectedTrainerId(null); }}>
                  Cancel
                </Button>
                <Button
                  onClick={handleSendToTrainerConfirm}
                  disabled={!selectedTrainerId || sendingId === sendToTrainerRow.id}
                  className="inline-flex items-center gap-2"
                >
                  {sendingId === sendToTrainerRow.id ? (
                    <Loader variant="dots" size="sm" inline />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                  <span>{sendingId === sendToTrainerRow.id ? 'Copying...' : 'Copy Link & Close'}</span>
                </Button>
              </div>
            </div>
          )}
        </Modal>

        <ConfirmDialog
          isOpen={!!endDateResetConfirm}
          onClose={cancelEndDateReset}
          onConfirm={() => void confirmEndDateReset()}
          title={END_DATE_RESET_DIALOG_TITLE}
          message={END_DATE_RESET_DIALOG_MESSAGE}
          confirmLabel="Yes"
          cancelLabel="No"
          variant="danger"
        />
        <LivePdfGenerateConfirmDialog {...liveGenerateDialogProps} />
        <AdminQuickEditModal
          isOpen={!!quickEditRow}
          onClose={() => setQuickEditRow(null)}
          row={quickEditRow}
          onSaved={() => void loadRows(currentPage, searchTerm, { silent: true })}
        />
      </div>
    </div>
  );
};
