import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { LayoutDashboard, RefreshCw, Search, Mail, Phone, CheckCircle, ChevronDown } from 'lucide-react';
import { listStudentAssessmentsPaged, issueInstanceAccessLink, listStudentCourseEnrollments, type StudentCourseEnrollment } from '../lib/formEngine';
import type { Student, SubmittedInstanceRow } from '../lib/formEngine';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Loader } from '../components/ui/Loader';
import { toast } from '../utils/toast';
import { supabase } from '../lib/supabase';
import { useNavigate } from 'react-router-dom';
import {
  computeRowUi,
  getStudentAttemptDoneText,
  getTrainerAttemptFailedText,
  getMissedAttemptWindowText,
  computeAttemptTones,
  getAdminOfficeDotTone,
  getAssessmentOutcomeDisplay,
  maskCompetentWhileAwaitingTrainer,
  melDateString,
  type WorkflowStageState,
  withinInstanceAccessWindow,
  type AttemptResult,
  type AttemptDotTone,
  calculateAssessmentDisplayStatus,
  calculateAssessmentFinalStatus,
} from '../utils/assessmentRowUi';
import { getEffectiveEndDate, hasActiveExtension } from '../utils/assessmentDeadline';
import { FormDocumentsPanel } from '../components/documents/FormDocumentsPanel';
import { NotificationBell } from '../components/NotificationBell';
import {
  evaluateStudentCourseRunningAccess,
  studentMayMutateAssessment,
  studentMayOpenAssessment,
  MSG_COURSE_NOT_IN_PROGRESS,
} from '../lib/studentAssessmentAccess';
import { NotificationAcknowledgmentGate } from '../components/NotificationAcknowledgmentGate';
import { STUDENT_DASHBOARD_AUTH_STORAGE_KEY } from '../lib/formEngine';
import { cn } from '../components/utils/cn';
import { StudentQualificationsPanel } from '../components/students/StudentQualificationsPanel';
import { groupAssessmentsByCourse } from '../lib/studentCourseEnrollment';
import {
  rowMatchesTrainerHighlightCourse,
  TRAINER_HIGHLIGHT_ROW_EXTRA_CLASS,
  useTrainerHighlightCourseId,
} from '../utils/trainerCourseHighlight';

const formatDDMMYYYY = (value: string | null): string => {
  const v = (value ?? '').trim();
  if (!v) return '—';
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return v;
};

function SingleDot({ tone, title }: { tone: AttemptDotTone; title: string }) {
  return (
    <div
      className={`h-2.5 w-2.5 rounded-full border ${dotToneClass[tone]}`}
      title={title}
    />
  );
}

function WorkflowProgressColumns({
  row,
  attemptResults,
  submissionCount,
}: {
  row: SubmittedInstanceRow;
  attemptResults: AttemptResult[];
  submissionCount: number;
}) {
  const finalStatus = calculateAssessmentFinalStatus({
    ...row,
    attempt_results: attemptResults,
  });
  const terminalFailed = finalStatus.terminalDidNotAttempt;
  const stageInput = { status: row.status, role_context: row.role_context, attemptResults };
  const calculatedTones = computeAttemptTones({
    submissionCount,
    results: attemptResults,
    terminalDidNotAttempt: terminalFailed,
    role_context: row.role_context,
    status: row.status,
    did_not_attempt: (row as unknown as { did_not_attempt?: boolean | null }).did_not_attempt ?? null,
    no_attempt_rollovers: (row as unknown as { no_attempt_rollovers?: number | null }).no_attempt_rollovers ?? null,
  });
  const tones =
    finalStatus.status === 'completed'
      ? { student: ['green', 'green', 'green'] as AttemptDotTone[], trainer: ['green', 'green', 'green'] as AttemptDotTone[] }
      : calculatedTones;
  const adminDot =
    finalStatus.status === 'completed'
      ? 'green'
      : getAdminOfficeDotTone({ ...stageInput, terminalDidNotAttempt: terminalFailed });

  const StageItem = ({ label, state }: { label: string; state: WorkflowStageState }) => {
    const iconClass = terminalFailed
      ? 'text-red-600'
      : state === 'done'
        ? 'text-emerald-600'
        : state === 'pending'
          ? 'text-amber-500'
          : 'text-[var(--icon-muted)]';
    const textClass = terminalFailed
      ? 'text-red-700 font-semibold'
      : state === 'done'
        ? 'text-emerald-700 font-medium'
        : state === 'pending'
          ? 'text-amber-700 font-medium'
          : 'text-[var(--text-muted)]';
    return (
      <div className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap">
        <CheckCircle className={`w-4 h-4 shrink-0 ${iconClass}`} />
        <span className={textClass}>{label}</span>
      </div>
    );
  };

  const studentStageState: WorkflowStageState = finalStatus.studentProgress;
  const trainerStageState: WorkflowStageState = finalStatus.trainerProgress;
  const adminStageState: WorkflowStageState = finalStatus.officeProgress;

  return (
    <div className="flex items-start gap-6">
      <div className="flex flex-col gap-1 items-start min-w-[4.5rem]">
        <StageItem label="Student" state={studentStageState} />
        <AttemptDots tones={tones.student} titlePrefix="Student" />
      </div>
      <div className="flex flex-col gap-1 items-start min-w-[4.5rem]">
        <StageItem label="Trainer" state={trainerStageState} />
        <AttemptDots tones={tones.trainer} titlePrefix="Trainer" />
      </div>
      <div className="flex flex-col gap-1 items-start min-w-[4.5rem]">
        <StageItem label="Office" state={adminStageState} />
        <SingleDot
          tone={adminDot}
          title={terminalFailed ? 'Failed — no attempts' : adminDot === 'green' ? 'Office finalised' : adminDot === 'yellow' ? 'Awaiting office' : 'Office not started'}
        />
      </div>
    </div>
  );
}

const dotToneClass: Record<AttemptDotTone, string> = {
  green: 'bg-emerald-500 border-emerald-600',
  red: 'bg-red-500 border-red-600',
  yellow: 'bg-amber-400 border-amber-500',
  gray: 'bg-gray-200 border-gray-300',
};

function AttemptDots({ tones, titlePrefix }: { tones: AttemptDotTone[]; titlePrefix: string }) {
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className={`h-2.5 w-2.5 rounded-full border ${dotToneClass[tones[i] ?? 'gray']}`}
          title={`${titlePrefix} attempt ${i + 1}`}
        />
      ))}
    </div>
  );
}

function getOutcomeLabel(
  summary: { final_attempt_1_result: AttemptResult; final_attempt_2_result: AttemptResult; final_attempt_3_result: AttemptResult } | null,
  row?: Pick<SubmittedInstanceRow, 'status' | 'role_context' | 'submission_count' | 'submitted_at'>
): { label: string; className: string; subtext: string | null; subtextClassName: string } {
  return getAssessmentOutcomeDisplay({
    status: row?.status,
    role_context: row?.role_context,
    attemptResults: summary
      ? [summary.final_attempt_1_result, summary.final_attempt_2_result, summary.final_attempt_3_result]
      : [],
    submissionCount: Number(row?.submission_count ?? 0) || (row?.submitted_at ? 1 : 0),
    submittedAt: row?.submitted_at ?? null,
  });
}

const STORAGE_KEY = STUDENT_DASHBOARD_AUTH_STORAGE_KEY;

export const StudentDashboardPage: React.FC = () => {
  const navigate = useNavigate();
  // Student dashboard is single-page (no pagination).
  const PAGE_SIZE = 500;
  const [studentId, setStudentId] = useState<number | null>(null);
  const [studentEmail, setStudentEmail] = useState<string>('');
  const [student, setStudent] = useState<Student | null>(null);
  const [studentCourses, setStudentCourses] = useState<StudentCourseEnrollment[]>([]);
  const [studentLoading, setStudentLoading] = useState(false);

  const [rows, setRows] = useState<SubmittedInstanceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const attemptSummaryByInstanceId = useMemo(
    () =>
      Object.fromEntries(
        rows.map((row) => [
          row.id,
          {
            final_attempt_1_result: row.attempt_results?.[0] ?? null,
            final_attempt_2_result: row.attempt_results?.[1] ?? null,
            final_attempt_3_result: row.attempt_results?.[2] ?? null,
          },
        ]),
      ) as Record<number, { final_attempt_1_result: AttemptResult; final_attempt_2_result: AttemptResult; final_attempt_3_result: AttemptResult }>,
    [rows],
  );
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const trainerHighlightCourseId = useTrainerHighlightCourseId();

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const j = JSON.parse(raw) as { studentId?: number; email?: string; at?: number };
      const sid = Number(j?.studentId);
      if (Number.isFinite(sid) && sid > 0) {
        setStudentId(sid);
        setStudentEmail(String(j?.email ?? ''));
      }
    } catch {
      // ignore
    }
  }, []);

  const loadRows = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!studentId) return;
      if (!opts?.silent) setLoading(true);
      const res = await listStudentAssessmentsPaged(studentId, 1, PAGE_SIZE);
      const debugRow = res.data.find((row) => row.id === 10970);
      if (debugRow) {
        console.info('[assessment-debug:10970] StudentDashboard final UI object', {
          ...debugRow,
          calculated_display_status: calculateAssessmentDisplayStatus({
            ...debugRow,
            attempt_results: debugRow.attempt_results ?? [],
          }),
          calculated_final_status: calculateAssessmentFinalStatus({
            ...debugRow,
            attempt_results: debugRow.attempt_results ?? [],
          }),
        });
      }
      setRows(res.data);
      setLoading(false);
    },
    [studentId]
  );

  const loadStudentProfile = useCallback(async () => {
    if (!studentId) return;
    setStudentLoading(true);
    try {
      const { data: sRow, error: sErr } = await supabase
        .from('skyline_students')
        .select('*, skyline_batches(name)')
        .eq('id', studentId)
        .single();
      if (sErr) throw sErr;
      const batch = (sRow as Record<string, unknown>).skyline_batches as { name?: string } | null;
      const st: Student = {
        id: Number((sRow as Record<string, unknown>).id),
        student_id: (sRow as Record<string, unknown>).student_id ? String((sRow as Record<string, unknown>).student_id) : null,
        name: String((sRow as Record<string, unknown>).name ?? ''),
        first_name: (sRow as Record<string, unknown>).first_name ? String((sRow as Record<string, unknown>).first_name) : null,
        last_name: (sRow as Record<string, unknown>).last_name ? String((sRow as Record<string, unknown>).last_name) : null,
        email: String((sRow as Record<string, unknown>).email ?? ''),
        phone: (sRow as Record<string, unknown>).phone ? String((sRow as Record<string, unknown>).phone) : null,
        batch_id: (sRow as Record<string, unknown>).batch_id != null ? Number((sRow as Record<string, unknown>).batch_id) : null,
        batch_name: batch?.name ?? null,
        date_of_birth: (sRow as Record<string, unknown>).date_of_birth ? String((sRow as Record<string, unknown>).date_of_birth) : null,
        address_line_1: null,
        address_line_2: null,
        city: null,
        state: null,
        postal_code: null,
        country: null,
        guardian_name: null,
        guardian_phone: null,
        notes: null,
        status: (sRow as Record<string, unknown>).status ? String((sRow as Record<string, unknown>).status) : null,
        created_at: String((sRow as Record<string, unknown>).created_at ?? ''),
      };
      setStudent(st);

      const courseList = await listStudentCourseEnrollments(studentId);
      setStudentCourses(courseList);
    } catch (e) {
      console.error('StudentDashboardPage load profile error', e);
      setStudent(null);
      setStudentCourses([]);
    } finally {
      setStudentLoading(false);
    }
  }, [studentId]);

  useEffect(() => {
    if (!studentId) return;
    void loadRows();
  }, [studentId, loadRows]);

  useEffect(() => {
    if (!studentId) {
      setStudent(null);
      setStudentCourses([]);
      return;
    }
    void loadStudentProfile();
  }, [studentId, loadStudentProfile]);

  const filterCourseRows = useCallback(
    (courseRows: SubmittedInstanceRow[]) => {
      const q = searchTerm.trim().toLowerCase();
      if (!q) return courseRows;
      return courseRows.filter((r) => String(r.form_name ?? '').toLowerCase().includes(q));
    },
    [searchTerm]
  );

  const handleRefresh = async () => {
    if (!studentId) return;
    setRefreshing(true);
    await Promise.all([loadRows({ silent: true }), loadStudentProfile()]);
    setRefreshing(false);
    toast.success('Refreshed');
  };

  const handleOpen = async (row: SubmittedInstanceRow, course?: StudentCourseEnrollment) => {
    const courseAccess = course
      ? evaluateStudentCourseRunningAccess({
          linkStatus: course.link_status,
          enrollmentStatus: course.enrollment_status,
          startDate: course.start_date,
          endDate: course.end_date,
          todayMelbourneIso: melDateString(),
          courseId: course.course_id,
          studentId: row.student_id,
          formId: row.form_id,
        })
      : null;
    if (courseAccess && !studentMayOpenAssessment(courseAccess)) {
      toast.error(courseAccess.message || MSG_COURSE_NOT_IN_PROGRESS);
      return;
    }
    const win = withinInstanceAccessWindow(row, 'student');
    if (!win.ok) {
      toast.error(win.reason || 'This assessment is not available right now.');
      return;
    }
    if (courseAccess && !studentMayMutateAssessment(courseAccess)) {
      toast.error(courseAccess.message || MSG_COURSE_NOT_IN_PROGRESS);
      return;
    }
    const url = await issueInstanceAccessLink(row.id, 'student');
    if (!url) {
      toast.error(
        courseAccess && !studentMayOpenAssessment(courseAccess)
          ? courseAccess.message
          : 'Could not open. This assessment may be outside the allowed window.',
      );
      return;
    }
    window.open(url, '_blank');
  };

  const renderCourseAssessments = (course: StudentCourseEnrollment, courseRows: SubmittedInstanceRow[]) => {
    const courseAccess = evaluateStudentCourseRunningAccess({
      linkStatus: course.link_status,
      enrollmentStatus: course.enrollment_status,
      startDate: course.start_date,
      endDate: course.end_date,
      todayMelbourneIso: melDateString(),
      courseId: course.course_id,
    });
    const lifecycleBlocksOpen = !studentMayOpenAssessment(courseAccess);
    const lifecycleBlocksMutate = !studentMayMutateAssessment(courseAccess);
    const filteredRows = filterCourseRows(courseRows);
    return (
      <>
        {lifecycleBlocksMutate ? (
          <div
            role="status"
            className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950"
          >
            {courseAccess.message || MSG_COURSE_NOT_IN_PROGRESS}
          </div>
        ) : null}
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <p className="text-sm text-gray-600">
            {filteredRows.length} unit{filteredRows.length === 1 ? '' : 's'}
            {searchTerm.trim() ? ` matching “${searchTerm.trim()}”` : ''}
          </p>
          <div className="relative w-full sm:w-[320px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
            <Input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search unit or status…"
              className="!pl-10 w-full"
            />
          </div>
        </div>

        {loading ? (
          <div className="py-10">
            <Loader variant="dots" size="lg" message="Loading assessments..." />
          </div>
        ) : courseRows.length === 0 ? (
          <p className="text-sm text-gray-500">No assessments for this course yet.</p>
        ) : filteredRows.length === 0 ? (
          <p className="text-sm text-gray-500">No assessments match your search.</p>
        ) : (
          <div className="min-w-0 overflow-x-auto">
            <table className="min-w-[940px] w-full text-sm border border-[var(--border)] rounded-lg overflow-hidden">
              <thead className="bg-gray-50 text-gray-700">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold border-b border-[var(--border)] w-[300px]">Unit</th>
                  <th className="hidden md:table-cell text-left px-3 py-2 font-semibold border-b border-[var(--border)] w-[100px] whitespace-nowrap">Start</th>
                  <th className="hidden md:table-cell text-left px-3 py-2 font-semibold border-b border-[var(--border)] w-[100px] whitespace-nowrap">End</th>
                  <th className="text-left px-3 py-2 font-semibold border-b border-[var(--border)] min-w-[220px]">Progress</th>
                  <th className="text-left px-3 py-2 font-semibold border-b border-[var(--border)] min-w-[220px]">Comments</th>
                  <th className="text-right px-3 py-2 font-semibold border-b border-[var(--border)] whitespace-nowrap">Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => {
                  const sum = attemptSummaryByInstanceId[row.id] ?? null;
                  const rawAttemptResults: AttemptResult[] = [
                    sum?.final_attempt_1_result ?? null,
                    sum?.final_attempt_2_result ?? null,
                    sum?.final_attempt_3_result ?? null,
                  ];
                  const displayStatus = calculateAssessmentDisplayStatus({
                    ...row,
                    attempt_results: rawAttemptResults,
                  });
                  const finalStatus = calculateAssessmentFinalStatus({
                    ...row,
                    attempt_results: rawAttemptResults,
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
                    no_attempt_rollovers: (row as unknown as { no_attempt_rollovers?: number | null }).no_attempt_rollovers ?? null,
                    did_not_attempt: (row as unknown as { did_not_attempt?: boolean | null }).did_not_attempt ?? null,
                  });
                  const trainerAttemptFailedText = getTrainerAttemptFailedText(rawAttemptResults, row);
                  const missedAttemptText = getMissedAttemptWindowText({
                    noAttemptRollovers: (row as unknown as { no_attempt_rollovers?: number | null }).no_attempt_rollovers ?? null,
                    didNotAttempt: (row as unknown as { did_not_attempt?: boolean | null }).did_not_attempt ?? null,
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
                      did_not_attempt: (row as unknown as { did_not_attempt?: boolean | null }).did_not_attempt ?? null,
                      no_attempt_rollovers: (row as unknown as { no_attempt_rollovers?: number | null }).no_attempt_rollovers ?? null,
                      status: row.status,
                      role_context: row.role_context,
                    },
                    attemptResults,
                    submissionCount: Number(row.submission_count ?? 0) || (row.submitted_at ? 1 : 0),
                    submittedAt: row.submitted_at ?? null,
                  });
                  const win = withinInstanceAccessWindow(row, 'student');
                  const openBlocked = lifecycleBlocksOpen;
                  const disabled = ui.disabled || !win.ok || openBlocked;
                  const openTitle = openBlocked
                    ? courseAccess.message || MSG_COURSE_NOT_IN_PROGRESS
                    : !win.ok
                      ? win.reason || 'Not available'
                      : 'Open assessment';
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
                        <td className="px-3 py-2 border-b border-[var(--border)] align-top min-w-[14rem]">
                          <div className="font-medium text-[var(--text)] whitespace-normal break-normal [overflow-wrap:normal] [word-break:normal]">{row.form_name}</div>
                          <div className="text-xs text-gray-500">Version {row.form_version ?? '1.0.0'}</div>
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
                        <td className="hidden md:table-cell px-3 py-2 border-b border-[var(--border)] text-gray-700 whitespace-nowrap tabular-nums align-top">
                          {formatDDMMYYYY(row.start_date)}
                        </td>
                        <td className="hidden md:table-cell px-3 py-2 border-b border-[var(--border)] text-gray-700 whitespace-nowrap tabular-nums align-top">
                          {formatDDMMYYYY(row.end_date)}
                          {hasActiveExtension(row) ? (
                            <div className="text-xs text-amber-700">Extended to {formatDDMMYYYY(row.extension_date ?? null)}</div>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 border-b border-[var(--border)] min-w-[220px]">
                          <WorkflowProgressColumns
                            row={row}
                            attemptResults={attemptResults}
                            submissionCount={Number(row.submission_count ?? 0) || (row.submitted_at ? 1 : 0)}
                          />
                        </td>
                        <td className="px-3 py-2 border-b border-[var(--border)] align-top min-w-[220px]">
                          {(() => {
                            const outcomeDisplay =
                              ui.kind === 'past_not_competent' || ui.kind === 'past_competent'
                                ? {
                                    label: ui.outcomeLabel ?? '',
                                    className: ui.outcomeClassName ?? '',
                                    subtext: ui.kind === 'past_competent' && row.status !== 'locked' ? 'Office' : null,
                                    subtextClassName: 'text-[11px] font-medium text-amber-700',
                                  }
                                : getOutcomeLabel(displaySum, row);
                            const outcomeClass =
                              displayStatus.status === 'competent'
                                ? 'text-emerald-700'
                                : displayStatus.status === 'not_competent' || displayStatus.status === 'did_not_attempt'
                                  ? 'text-red-700'
                                  : displayStatus.status === 'saved_answers'
                                    ? 'text-orange-800'
                                    : outcomeDisplay.className;
                            const outcomeLabel = displayStatus.label;
                            const comments: Array<{ text: string; className: string }> = [];
                            if (finalStatus.status === 'completed') {
                              comments.push({ text: 'Completed', className: 'text-xs font-medium text-emerald-700' });
                            } else if (displayStatus.terminalDidNotAttempt) {
                              comments.push({ text: displayStatus.label, className: 'text-[11px] font-medium text-red-700' });
                            } else {
                              comments.push({ text: outcomeLabel, className: `text-xs font-medium ${outcomeClass}` });
                              if (outcomeDisplay.subtext) {
                                comments.push({ text: outcomeDisplay.subtext, className: outcomeDisplay.subtextClassName });
                              }
                              if (trainerAttemptFailedText) {
                                comments.push({ text: trainerAttemptFailedText, className: 'text-[11px] font-medium text-red-700' });
                              }
                              if (attemptDoneText) comments.push({ text: attemptDoneText, className: 'text-[11px] text-gray-600' });
                              if (ui.kind === 'in_progress' && missedAttemptText) {
                                comments.push({ text: missedAttemptText, className: 'text-[11px] font-medium text-amber-700' });
                              }
                            }
                            if (openBlocked) {
                              comments.push({
                                text: courseAccess.message || MSG_COURSE_NOT_IN_PROGRESS,
                                className: 'text-xs text-amber-800',
                              });
                            } else if (disabled && (ui.kind === 'future' || ui.kind === 'expired')) {
                              comments.push({ text: ui.reason, className: 'text-xs text-amber-700' });
                            } else if (!win.ok && !finalStatus.suppressExpiry) {
                              comments.push({ text: win.reason || '', className: 'text-xs text-amber-700' });
                            }
                            return (
                              <div className="flex flex-col gap-1">
                                {comments
                                  .filter((c) => c.text.trim().length > 0)
                                  .map((c, idx) => (
                                    <div key={`${row.id}-comment-${idx}`} className={c.className}>
                                      {c.text}
                                    </div>
                                  ))}
                              </div>
                            );
                          })()}
                        </td>
                        <td className="px-3 py-2 border-b border-[var(--border)] text-right align-top">
                          <div className="inline-flex w-full justify-end">
                            <ChevronDown
                              className={cn('h-4 w-4 text-gray-400 transition-transform', expandedId === row.id && 'rotate-180')}
                              aria-hidden="true"
                            />
                          </div>
                        </td>
                      </tr>
                      {expandedId === row.id ? (
                        <tr className={cn(ui.rowClassName, trainerHighlightExtra)}>
                          <td className="px-3 py-3 border-b border-[var(--border)]" colSpan={6} onClick={(e) => e.stopPropagation()}>
                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                              <FormDocumentsPanel
                                formId={Number(row.form_id)}
                                formName={String(row.form_name ?? 'Assessment')}
                                canUpload={false}
                                showTrainerSection={false}
                              />
                              {disabled ? (
                                <div
                                  className="rounded-lg border border-amber-200 bg-amber-50/80 p-4 text-left opacity-90"
                                  title={openTitle}
                                  aria-disabled="true"
                                >
                                  <div className="text-sm font-semibold text-[var(--text)]">Assessment</div>
                                  <div className="mt-1 text-xs text-gray-600 break-words">{row.form_name}</div>
                                  <p className="mt-2 text-xs text-amber-900">{openTitle}</p>
                                  <div className="mt-3 inline-flex items-center rounded-md border border-gray-200 bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-500 cursor-not-allowed">
                                    Open unavailable
                                  </div>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  className="rounded-lg border border-[var(--border)] bg-white p-4 text-left hover:bg-[var(--brand)]/10 focus-visible:bg-[var(--brand)]/10 transition-colors"
                                  onClick={() => void handleOpen(row, course)}
                                  title={openTitle}
                                >
                                  <div className="text-sm font-semibold text-[var(--text)]">Assessment</div>
                                  <div className="mt-1 text-xs text-gray-600 break-words">{row.form_name}</div>
                                  <div className="mt-3 inline-flex items-center rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700">
                                    Open
                                  </div>
                                </button>
                              )}
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
      </>
    );
  };

  const unassignedAssessments = useMemo(() => {
    if (studentCourses.length === 0) return rows;
    const grouped = groupAssessmentsByCourse(rows, studentCourses);
    return grouped.get('unassigned') ?? [];
  }, [rows, studentCourses]);

  const logout = () => {
    sessionStorage.removeItem(STORAGE_KEY);
    setStudentId(null);
    setStudentEmail('');
    setStudent(null);
    setStudentCourses([]);
    setRows([]);
    setSearchTerm('');
  };

  const headerRight = useMemo(() => {
    if (!studentId) return null;
    return (
      <div className="flex flex-wrap items-center justify-end gap-2">
        <NotificationBell
          userId={studentId}
          assessmentStudentId={studentId}
          viewAllHref=""
        />
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
          <RefreshCw className={`w-4 h-4 mr-2 inline ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
        <Button variant="outline" size="sm" onClick={logout}>
          Logout
        </Button>
      </div>
    );
  }, [studentId, refreshing, handleRefresh]);

  const dashboardBody = (
    <div className="min-h-screen min-w-0 bg-[var(--bg)]">
      <div className="w-full min-w-0 px-4 md:px-6 lg:px-8 py-6 space-y-4">
        <Card>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-2xl font-bold text-[var(--text)] flex items-center gap-2">
                <LayoutDashboard className="w-7 h-7 text-[var(--brand)]" />
                Student dashboard
              </h1>
              <p className="text-sm text-gray-600 mt-1">
                {studentId ? (
                  <>
                    Signed in as <span className="font-medium text-gray-800 break-words">{studentEmail || 'student'}</span>. Open is only allowed between start date and end date (until 23:59 AEDT).
                  </>
                ) : (
                  <>Sign in with OTP to see your assessments.</>
                )}
              </p>
            </div>
            {headerRight}
          </div>
        </Card>

        {!studentId ? (
          <Card className="max-w-xl">
            <div className="space-y-3">
              <p className="text-sm text-gray-700">
                You’re not signed in. Please sign in from the main login page to view your dashboard.
              </p>
              <div className="flex gap-2">
                <Button type="button" onClick={() => navigate('/login')} className="min-w-[10rem]">
                  Go to login
                </Button>
              </div>
            </div>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(17.5rem,21.25rem)_minmax(0,1fr)]">
            <div className="min-w-0">
              <Card>
                {studentLoading ? (
                  <div className="py-10">
                    <Loader variant="dots" size="lg" message="Loading profile..." />
                  </div>
                ) : !student ? (
                  <div className="space-y-2">
                    <div className="text-sm text-gray-700 font-medium break-words">{studentEmail}</div>
                    <div className="text-xs text-gray-500">Profile not available.</div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div>
                      <div className="text-xs text-gray-500">Student</div>
                      <div className="font-semibold text-[var(--text)] break-words">
                        {[student.first_name, student.last_name].filter(Boolean).join(' ').trim() || student.email}
                      </div>
                      {student.student_id ? <div className="text-xs text-gray-500 mt-1">Student ID: {student.student_id}</div> : null}
                    </div>

                    <div className="grid grid-cols-1 gap-2 text-sm">
                      <div className="flex items-center gap-2 text-gray-700">
                        <Mail className="w-4 h-4 text-gray-400" />
                        <span className="min-w-0 break-words">{student.email}</span>
                      </div>
                      <div className="flex items-center gap-2 text-gray-700">
                        <Phone className="w-4 h-4 text-gray-400" />
                        <span>{student.phone || '—'}</span>
                      </div>
                    </div>

                    <div className="border-t border-gray-100 pt-3 space-y-2 text-sm">
                      <div className="flex items-start justify-between gap-3">
                        <span className="text-gray-500">Batch</span>
                        <span className="text-gray-800 text-right break-words">{student.batch_name ?? '—'}</span>
                      </div>
                      <div className="flex items-start justify-between gap-3">
                        <span className="text-gray-500">Status</span>
                        <span className="text-gray-800">{student.status ?? '—'}</span>
                      </div>
                    </div>
                  </div>
                )}
              </Card>
            </div>

            <div className="min-w-0">
              <Card className="min-w-0">
                <div className="mb-4">
                  <h2 className="text-lg font-bold text-[var(--text)]">Qualifications</h2>
                  <p className="text-sm text-gray-600 mt-1 mb-3">
                    Expand a course to view and open your assessments. Open is enabled only during the allowed date window (end date is 23:59 AEDT).
                  </p>
                  <StudentQualificationsPanel
                    variant="student"
                    enrollments={studentCourses}
                    assessments={rows}
                    summaries={attemptSummaryByInstanceId}
                    loading={studentLoading || loading}
                    renderExpandedContent={renderCourseAssessments}
                  />
                </div>

                {unassignedAssessments.length > 0 ? (
                  <div className="border-t border-[var(--border)] pt-4">
                    <h3 className="text-sm font-semibold text-[var(--text)] mb-3">Other assessments</h3>
                    {renderCourseAssessments(
                      {
                        course_id: 0,
                        name: 'Other',
                        qualification_code: null,
                        enrolled_at: '',
                        start_date: null,
                        end_date: null,
                        enrollment_status: 'in_progress',
                        completed_at: null,
                        intake_label: null,
                        link_status: 'active',
                        enrollment_status_changed_at: null,
                      },
                      unassignedAssessments
                    )}
                  </div>
                ) : null}
              </Card>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  if (!studentId) return dashboardBody;

  return (
    <NotificationAcknowledgmentGate userId={studentId} studentId={studentId}>
      {dashboardBody}
    </NotificationAcknowledgmentGate>
  );
};

