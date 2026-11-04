import React, { useEffect, useState, useCallback } from 'react';
import { RefreshCw, ClipboardCheck, LayoutDashboard, ChevronDown } from 'lucide-react';
import {
  listDashboardInstances,
  listTrainerBatches,
  listBatches,
  issueInstanceAccessLink,
  fetchAssessmentSummaries,
} from '../lib/formEngine';
import type { SubmittedInstanceRow, Batch } from '../lib/formEngine';
import { useAuth } from '../contexts/AuthContext';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { Loader } from '../components/ui/Loader';
import { toast } from '../utils/toast';
import { AdminListPagination } from '../components/admin/AdminListPagination';
import {
  computeRowUi,
  formatDDMMYYYY,
  getInstanceWorkflowBadgeClass,
  getInstanceWorkflowLabel,
  getStudentAttemptDoneText,
  getTrainerAttemptFailedText,
  getMissedAttemptWindowText,
  maskCompetentWhileAwaitingTrainer,
  withinInstanceAccessWindow,
  getAssessmentOutcomeDisplay,
  calculateAssessmentFinalStatus,
  type AttemptResult,
} from '../utils/assessmentRowUi';
import { getEffectiveEndDate, hasActiveExtension } from '../utils/assessmentDeadline';
import { FormDocumentsPanel } from '../components/documents/FormDocumentsPanel';
import { cn } from '../components/utils/cn';
import {
  rowMatchesTrainerHighlightCourse,
  TRAINER_HIGHLIGHT_ROW_EXTRA_CLASS,
  useTrainerHighlightCourseId,
} from '../utils/trainerCourseHighlight';
import { TrainerGradeMePanel } from '../components/trainer/TrainerGradeMePanel';
import { getAssessmentBatchName } from '../utils/assessmentBatchDisplay';

function getOutcomeLabel(
  summary: {
    final_attempt_1_result: AttemptResult;
    final_attempt_2_result: AttemptResult;
    final_attempt_3_result: AttemptResult;
  } | null,
  row?: Pick<SubmittedInstanceRow, 'status' | 'role_context' | 'submission_count' | 'submitted_at'>,
): { label: string; className: string } {
  const display = getAssessmentOutcomeDisplay({
    status: row?.status,
    role_context: row?.role_context,
    attemptResults: summary
      ? [summary.final_attempt_1_result, summary.final_attempt_2_result, summary.final_attempt_3_result]
      : [],
    submissionCount: Number(row?.submission_count ?? 0) || (row?.submitted_at ? 1 : 0),
    submittedAt: row?.submitted_at ?? null,
  });
  return { label: display.label, className: display.className };
}

export const DashboardPage: React.FC = () => {
  const { user } = useAuth();
  const role = user?.role === 'trainer' ? 'trainer' : 'office';
  const PAGE_SIZE = 20;
  const [rows, setRows] = useState<SubmittedInstanceRow[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [searchTerm, setSearchTerm] = useState('');
  const [trainerBatches, setTrainerBatches] = useState<Batch[]>([]);
  const [allBatches, setAllBatches] = useState<Batch[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<string>('');
  const [queueFilter, setQueueFilter] = useState<'pending' | 'all'>('pending');

  const [expandedId, setExpandedId] = useState<number | null>(null);
  const trainerHighlightCourseId = useTrainerHighlightCourseId();
  const [attemptSummaryByInstanceId, setAttemptSummaryByInstanceId] = useState<
    Record<number, {
      final_attempt_1_result: AttemptResult;
      final_attempt_2_result: AttemptResult;
      final_attempt_3_result: AttemptResult;
      admin_initial_checked?: boolean;
      admin_updated_checked?: boolean;
    }>
  >({});

  const loadData = useCallback(
    async (page: number, search: string, opts?: { silent?: boolean }) => {
      if (!user?.id) return;
      if (!opts?.silent) setLoading(true);
      const batchId = selectedBatchId ? Number(selectedBatchId) : null;
      const [listRes, pendingListRes, trainerBatchesRes, batchesRes] = await Promise.all([
        listDashboardInstances(role, user.id, page, PAGE_SIZE, search, queueFilter === 'pending', batchId),
        queueFilter === 'pending'
          ? Promise.resolve(null)
          : listDashboardInstances(role, user.id, 1, 1, search, true, batchId),
        role === 'trainer' ? listTrainerBatches(user.id) : Promise.resolve([]),
        role === 'office' ? listBatches() : Promise.resolve([]),
      ]);
      setPendingCount(queueFilter === 'pending' ? listRes.total : (pendingListRes?.total ?? 0));
      setTrainerBatches(trainerBatchesRes ?? []);
      setAllBatches(batchesRes ?? []);
      setRows(listRes.data);
      setTotalRows(listRes.total);
      setLoading(false);
    },
    [user?.id, role, selectedBatchId, queueFilter]
  );

  useEffect(() => {
    const t = setTimeout(() => loadData(currentPage, searchTerm), 250);
    return () => clearTimeout(t);
  }, [currentPage, searchTerm, loadData]);

  useEffect(() => {
    if (rows.length === 0) {
      setAttemptSummaryByInstanceId({});
      return;
    }
    const ids = rows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0);
    let cancelled = false;
    void (async () => {
      const m = await fetchAssessmentSummaries(ids);
      if (cancelled) return;
      setAttemptSummaryByInstanceId(
        m as Record<number, {
          final_attempt_1_result: AttemptResult;
          final_attempt_2_result: AttemptResult;
          final_attempt_3_result: AttemptResult;
          admin_initial_checked?: boolean;
          admin_updated_checked?: boolean;
        }>
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [rows]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadData(currentPage, searchTerm, { silent: true });
    setRefreshing(false);
    toast.success('Dashboard refreshed');
  };

  const handleOpen = async (row: SubmittedInstanceRow) => {
    const targetRole =
      row.role_context === 'trainer'
        ? 'trainer'
        : row.role_context === 'office'
          ? 'office'
          : row.status === 'locked'
            ? role === 'office'
              ? 'office'
              : 'trainer'
            : 'student';
    const win = withinInstanceAccessWindow(row, targetRole);
    if (!win.ok) {
      toast.error(win.reason || 'This assessment is not available right now.');
      return;
    }
    const url = await issueInstanceAccessLink(row.id, targetRole);
    if (!url) {
      toast.error('Failed to open secure link');
      return;
    }
    window.open(url, '_blank');
  };

  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <div className="w-full px-4 md:px-6 lg:px-8 py-6">
        <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-[var(--text)] flex items-center gap-2">
              <LayoutDashboard className="w-7 h-7 text-[var(--brand)]" />
              Dashboard
            </h1>
            <p className="text-sm text-gray-600 mt-1">
              {role === 'trainer'
                ? 'Pending assessments awaiting your review'
                : 'Pending assessments awaiting office processing'}
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-end sm:gap-3">
            <div className="min-w-0 sm:w-[220px]">
              <div className="text-xs text-gray-600 mb-1">Search</div>
              <Input
                value={searchTerm}
                onChange={(e) => {
                  setSearchTerm(e.target.value);
                  setCurrentPage(1);
                }}
                placeholder="Search student, ID, batch, unit, or ID + Unit Code"
              />
            </div>
            <div className="sm:w-[170px]">
              <div className="text-xs text-gray-600 mb-1">Queue</div>
              <Select
                value={queueFilter}
                onChange={(v) => {
                  setQueueFilter(v as 'pending' | 'all');
                  setCurrentPage(1);
                }}
                options={[
                  { value: 'pending', label: 'Pending only' },
                  { value: 'all', label: 'All' },
                ]}
              />
            </div>
            <div className="sm:w-[220px]">
              <div className="text-xs text-gray-600 mb-1">Batch</div>
              <Select
                value={selectedBatchId}
                onChange={(v) => {
                  setSelectedBatchId(v);
                  setCurrentPage(1);
                }}
                options={[
                  { value: '', label: 'All batches' },
                  ...((role === 'trainer' ? trainerBatches : allBatches) || []).map((b) => ({
                    value: String(b.id),
                    label: `${b.name}${b.trainer_name ? ` — ${b.trainer_name}` : ''}`,
                  })),
                ]}
              />
            </div>
            <Button type="button" variant="outline" onClick={handleRefresh} disabled={refreshing} className="sm:mb-[1px]">
              <RefreshCw className={`w-4 h-4 mr-2 inline ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        {/* Pending and role cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
          <Card className="bg-gradient-to-br from-[var(--brand)] to-[#ea580c] text-white overflow-hidden relative">
            <div className="absolute top-0 right-0 w-24 h-24 -mt-4 -mr-4 rounded-full bg-white/10" />
            <div className="relative">
              <p className="text-white/90 text-sm font-medium">Pending</p>
              <p className="text-4xl font-bold mt-1">{pendingCount}</p>
              <p className="text-white/80 text-xs mt-1">
                {role === 'trainer' ? 'Awaiting your review' : 'Awaiting office check'}
              </p>
            </div>
          </Card>
          <Card className="border border-[var(--border)]">
            <p className="text-gray-600 text-sm font-medium">Role</p>
            <p className="text-xl font-bold text-[var(--text)] mt-1 capitalize">{role}</p>
            <p className="text-gray-500 text-xs mt-1">{user?.full_name}</p>
          </Card>
        </div>

        {role === 'trainer' && user?.id ? (
          <TrainerGradeMePanel
            trainerUserId={user.id}
            batchId={selectedBatchId ? Number(selectedBatchId) : null}
            search={searchTerm}
          />
        ) : null}

        <Card>
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-4">
            <div>
              <h2 className="text-lg font-bold text-[var(--text)]">Pending assessments</h2>
              <p className="text-sm text-gray-600 mt-1">Open follows the same activity window as the student view (end date 23:59 AEDT).</p>
            </div>
            {/* Filters moved to header */}
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
              itemLabel="items"
            />
          )}
          {loading ? (
            <Loader variant="dots" size="lg" message="Loading assessments..." />
          ) : rows.length === 0 ? (
            <div className="py-12 text-center text-gray-500">
              <ClipboardCheck className="w-12 h-12 mx-auto text-[var(--icon-muted)] mb-3" />
              <p>No pending assessments.</p>
              <p className="text-sm mt-1">
                {role === 'trainer'
                  ? 'Pending items will appear when students submit for your review.'
                  : 'Pending items will appear once trainers submit them for office review.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-[960px] w-full text-sm border border-[var(--border)] rounded-lg overflow-hidden">
                <thead className="bg-gray-50 text-gray-700">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold border-b border-[var(--border)] min-w-[12rem]">Student</th>
                    <th className="text-left px-3 py-2 font-semibold border-b border-[var(--border)] min-w-[12rem]">Batch</th>
                    <th className="text-left px-3 py-2 font-semibold border-b border-[var(--border)] min-w-[11rem]">Assessment</th>
                    <th className="hidden md:table-cell text-left px-3 py-2 font-semibold border-b border-[var(--border)] w-[6.5rem] whitespace-nowrap">
                      Start
                    </th>
                    <th className="hidden md:table-cell text-left px-3 py-2 font-semibold border-b border-[var(--border)] w-[6.5rem] whitespace-nowrap">End</th>
                    <th className="text-left px-3 py-2 font-semibold border-b border-[var(--border)] min-w-[12rem]">Progress</th>
                    <th className="text-right px-3 py-2 font-semibold border-b border-[var(--border)] whitespace-nowrap">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const sum = attemptSummaryByInstanceId[row.id] ?? null;
                    const rawAttemptResults: AttemptResult[] = [
                      sum?.final_attempt_1_result ?? null,
                      sum?.final_attempt_2_result ?? null,
                      sum?.final_attempt_3_result ?? null,
                    ];
                    const officeAssessmentCompleted =
                      Boolean(row.office_assessment_completed) ||
                      (Boolean(sum?.admin_initial_checked) && Boolean(sum?.admin_updated_checked));
                    const finalStatus = calculateAssessmentFinalStatus({
                      ...row,
                      attempt_results: rawAttemptResults,
                      office_assessment_completed: officeAssessmentCompleted,
                    });
                    const attemptResults = maskCompetentWhileAwaitingTrainer(row, rawAttemptResults);
                    const displaySum = sum
                      ? {
                          ...sum,
                          final_attempt_1_result: attemptResults[0] ?? null,
                          final_attempt_2_result: attemptResults[1] ?? null,
                          final_attempt_3_result: attemptResults[2] ?? null,
                        }
                      : null;
                    const attemptDoneText = getStudentAttemptDoneText({
                      submissionCount: Number(row.submission_count ?? 0) || (row.submitted_at ? 1 : 0),
                      submittedAt: row.submitted_at ?? null,
                      attemptResults: rawAttemptResults,
                      status: row.status,
                      role_context: row.role_context,
                      no_attempt_rollovers: row.no_attempt_rollovers ?? null,
                      did_not_attempt: row.did_not_attempt ?? null,
                    });
                    const trainerAttemptFailedText = getTrainerAttemptFailedText(rawAttemptResults, row);
                    const missedAttemptText = getMissedAttemptWindowText({
                      noAttemptRollovers: row.no_attempt_rollovers ?? null,
                      didNotAttempt: row.did_not_attempt ?? null,
                      status: row.status,
                      submissionCount: row.submission_count,
                      submittedAt: row.submitted_at,
                      answerCount: row.answer_count,
                      attemptResults: rawAttemptResults,
                      trainerAssessmentExists: row.trainer_assessment_exists,
                      endDate: getEffectiveEndDate(row) || row.end_date,
                    });
                    const ui = computeRowUi({
                      row: {
                        ...row,
                        did_not_attempt: row.did_not_attempt ?? null,
                        status: row.status,
                        role_context: row.role_context,
                        workflow_status: row.workflow_status,
                        office_assessment_completed: officeAssessmentCompleted,
                      },
                      attemptResults,
                      ignoreEndDateForAccess: true,
                      submissionCount: Number(row.submission_count ?? 0) || (row.submitted_at ? 1 : 0),
                      submittedAt: row.submitted_at ?? null,
                    });
                    const disabled = ui.disabled;
                    const win = withinInstanceAccessWindow(row, role);
                    const outcome = getOutcomeLabel(displaySum, row);
                    const trainerHighlightExtra = rowMatchesTrainerHighlightCourse(row, trainerHighlightCourseId)
                      ? TRAINER_HIGHLIGHT_ROW_EXTRA_CLASS
                      : '';
                    return (
                      <React.Fragment key={row.id}>
                        <tr
                          className={cn(ui.rowClassName, 'cursor-pointer', trainerHighlightExtra)}
                          onClick={() => setExpandedId((prev) => (prev === row.id ? null : row.id))}
                          title="Click to expand"
                        >
                          <td className="px-3 py-2 border-b border-[var(--border)] align-top">
                            <div className="font-medium text-[var(--text)] break-words">{row.student_name}</div>
                            <div className="text-xs text-gray-500 break-all">{row.student_email || '—'}</div>
                            <div className="mt-1 text-[11px] text-gray-600">
                              <span className="text-gray-500">Trainer</span>{' '}
                              {row.trainer_name?.trim() ? row.trainer_name : '—'}
                            </div>
                            <div className="md:hidden mt-1 text-xs text-gray-600 tabular-nums flex flex-wrap gap-x-3 gap-y-0.5">
                              <span>
                                <span className="text-gray-500">Start</span> {formatDDMMYYYY(row.start_date)}
                              </span>
                              <span>
                                <span className="text-gray-500">End</span> {formatDDMMYYYY(row.end_date)}
                              </span>
                              {hasActiveExtension(row) ? (
                                <span>
                                  <span className="text-gray-500">Extended to</span> {formatDDMMYYYY(row.extension_date ?? null)}
                                </span>
                              ) : null}
                            </div>
                          </td>
                          <td className="px-3 py-2 border-b border-[var(--border)] align-top text-gray-700 break-words">
                            {getAssessmentBatchName(row)}
                          </td>
                          <td className="px-3 py-2 border-b border-[var(--border)] align-top">
                            <div className="font-medium text-[var(--text)] break-words">{row.form_name}</div>
                            <div className="text-xs text-gray-500">v{row.form_version ?? '1.0.0'}</div>
                          </td>
                          <td className="hidden md:table-cell px-3 py-2 border-b border-[var(--border)] text-gray-700 whitespace-nowrap tabular-nums align-top">
                            {formatDDMMYYYY(row.start_date)}
                          </td>
                          <td className="hidden md:table-cell px-3 py-2 border-b border-[var(--border)] text-gray-700 whitespace-nowrap tabular-nums align-top">
                            {formatDDMMYYYY(row.end_date)}
                            {hasActiveExtension(row) ? (
                              <div className="text-xs text-amber-700">Extended to {formatDDMMYYYY(row.extension_date ?? null)}</div>
                            ) : null}
                          </td>
                          <td className="px-3 py-2 border-b border-[var(--border)] align-top min-w-[12rem]">
                            <div className="flex flex-col gap-1">
                              <span
                                className={`inline-flex w-fit rounded-full px-2.5 py-1 text-xs font-medium ${getInstanceWorkflowBadgeClass({
                                  status: row.status,
                                  role_context: row.role_context,
                                  workflow_status: row.workflow_status,
                                  did_not_attempt: row.did_not_attempt ?? null,
                                  no_attempt_rollovers: row.no_attempt_rollovers ?? null,
                                  submission_count: row.submission_count,
                                  submitted_at: row.submitted_at,
                                  answer_count: row.answer_count,
                                  attempt_results: rawAttemptResults,
                                  office_assessment_completed: officeAssessmentCompleted,
                                })}`}
                              >
                                {getInstanceWorkflowLabel({
                                  status: row.status,
                                  role_context: row.role_context,
                                  workflow_status: row.workflow_status,
                                  did_not_attempt: row.did_not_attempt ?? null,
                                  no_attempt_rollovers: row.no_attempt_rollovers ?? null,
                                  submission_count: row.submission_count,
                                  submitted_at: row.submitted_at,
                                  answer_count: row.answer_count,
                                  attempt_results: rawAttemptResults,
                                  office_assessment_completed: officeAssessmentCompleted,
                                })}
                              </span>
                              <div
                                className={`text-xs font-medium ${
                                  ui.kind === 'past_not_competent'
                                    ? ui.outcomeClassName ?? ''
                                    : ui.kind === 'past_competent'
                                      ? ui.outcomeClassName ?? ''
                                      : outcome.className
                                }`}
                              >
                                {finalStatus.status === 'completed'
                                  ? 'Completed'
                                  : ui.kind === 'past_not_competent'
                                  ? ui.outcomeLabel
                                  : ui.kind === 'past_competent'
                                    ? ui.outcomeLabel
                                    : outcome.label}
                              </div>
                              {finalStatus.status !== 'completed' && attemptDoneText ? <div className="text-[11px] text-gray-600">{attemptDoneText}</div> : null}
                              {finalStatus.status !== 'completed' && ui.kind === 'in_progress' && missedAttemptText ? (
                                <div className="text-[11px] font-medium text-amber-700">{missedAttemptText}</div>
                              ) : null}
                              {finalStatus.status !== 'completed' && trainerAttemptFailedText ? (
                                <div className="text-[11px] font-medium text-red-700">{trainerAttemptFailedText}</div>
                              ) : null}
                              {!finalStatus.suppressExpiry && disabled && (ui.kind === 'future' || ui.kind === 'expired') ? (
                                <div className="text-xs text-amber-700">{ui.reason}</div>
                              ) : !finalStatus.suppressExpiry && !win.ok ? (
                                <div className="text-xs text-amber-700">{win.reason}</div>
                              ) : null}
                            </div>
                          </td>
                          <td className="px-3 py-2 border-b border-[var(--border)] text-right align-top">
                            <div className="inline-flex w-full justify-end">
                              <ChevronDown
                                className={cn(
                                  'h-4 w-4 text-gray-400 transition-transform',
                                  expandedId === row.id && 'rotate-180'
                                )}
                                aria-hidden="true"
                              />
                            </div>
                          </td>
                        </tr>
                        {expandedId === row.id ? (
                          <tr className={cn(ui.rowClassName, trainerHighlightExtra)}>
                            <td className="px-3 py-3 border-b border-[var(--border)]" colSpan={7} onClick={(e) => e.stopPropagation()}>
                              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                                <FormDocumentsPanel
                                  formId={Number(row.form_id)}
                                  formName={String(row.form_name ?? 'Assessment')}
                                  canUpload={false}
                                  showTrainerSection={role === 'trainer'}
                                />
                                <button
                                  type="button"
                                  className="rounded-lg border border-[var(--border)] bg-white p-4 text-left hover:bg-[var(--brand)]/10 focus-visible:bg-[var(--brand)]/10 transition-colors"
                                  onClick={() => void handleOpen(row)}
                                  disabled={disabled}
                                  title="Open assessment"
                                >
                                  <div className="text-sm font-semibold text-[var(--text)]">Assessment</div>
                                  <div className="mt-1 text-xs text-gray-600 break-words">{row.form_name}</div>
                                  <div className="mt-3 inline-flex items-center rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700">
                                    Open
                                  </div>
                                </button>
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
              itemLabel="items"
            />
          )}
        </Card>
      </div>
    </div>
  );
};
