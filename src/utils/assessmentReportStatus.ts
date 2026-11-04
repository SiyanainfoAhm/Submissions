import { calculateAssessmentDisplayStatus, melDateString } from './assessmentRowUi';
import { getEffectiveEndDate } from './assessmentDeadline';

export type AssessmentReportStatus = 'Completed' | 'In Progress' | 'Failed';

/** Report status: completed (locked), failed (past end date or did not attempt), otherwise in progress. */
export function getAssessmentReportStatus(row: {
  status?: string | null;
  end_date?: string | null;
  extension_date?: string | null;
  did_not_attempt?: boolean | null;
  no_attempt_rollovers?: number | null;
}): AssessmentReportStatus {
  const st = String(row.status ?? '').trim();
  const display = calculateAssessmentDisplayStatus(row);
  if (st === 'locked' && !display.terminalDidNotAttempt) {
    return 'Completed';
  }
  if (display.terminalDidNotAttempt) {
    return 'Failed';
  }
  const end = getEffectiveEndDate(row);
  if (end) {
    const today = melDateString();
    if (today > end) return 'Failed';
  }
  return 'In Progress';
}

export function assessmentReportStatusClassName(status: AssessmentReportStatus): string {
  if (status === 'Completed') return 'text-emerald-700 font-medium';
  if (status === 'Failed') return 'text-red-700 font-medium';
  return 'text-amber-700 font-medium';
}
