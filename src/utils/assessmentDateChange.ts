import {
  extendInstanceAccessTokensToDate,
  fetchAssessmentSummaries,
  syncStudentTokenExpiryToDeadline,
  updateFormInstanceDates,
  type SubmittedInstanceRow,
} from '../lib/formEngine';
import {
  isTerminalFailureProgressRow,
  shouldPromptResetAttemptsOnEndDateChange,
  type AttemptResult,
} from './assessmentRowUi';

export const END_DATE_RESET_DIALOG_TITLE = 'Reset assessment attempts?';
export const END_DATE_RESET_DIALOG_MESSAGE =
  'This assessment has used all three attempts. Changing the end date will reset it to attempt 1, clear attempt history, and return the assessment to the student. Do you want to continue?';

export function needsResetPromptOnEndDateChangeSync(
  row: SubmittedInstanceRow,
  nextEnd: string | null,
  attemptResults?: AttemptResult[] | null
): boolean | 'check-async' {
  if (!endDateChanged(row, nextEnd)) return false;
  if (isTerminalFailureProgressRow(row)) return true;

  const submitted = Math.min(
    3,
    Math.max(0, Number(row.submission_count ?? 0) || (row.submitted_at ? 1 : 0))
  );
  if (submitted >= 3) {
    if (attemptResults) {
      return shouldPromptResetAttemptsOnEndDateChange({
        row,
        currentEnd: row.end_date,
        nextEnd,
        attemptResults,
      });
    }
    return 'check-async';
  }

  if (attemptResults && attemptResults.length > 0) {
    return shouldPromptResetAttemptsOnEndDateChange({
      row,
      currentEnd: row.end_date,
      nextEnd,
      attemptResults,
    });
  }

  return false;
}

export function endDateChanged(
  row: Pick<SubmittedInstanceRow, 'end_date'>,
  nextEnd: string | null
): boolean {
  const next = String(nextEnd ?? '').trim();
  const current = String(row.end_date ?? '').trim();
  return Boolean(next) && next !== current;
}

export async function getAttemptResultsForInstance(instanceId: number): Promise<AttemptResult[]> {
  const summaries = await fetchAssessmentSummaries([instanceId]);
  const sum = summaries[instanceId];
  if (!sum) return [];
  return [
    (sum.final_attempt_1_result as AttemptResult) ?? null,
    (sum.final_attempt_2_result as AttemptResult) ?? null,
    (sum.final_attempt_3_result as AttemptResult) ?? null,
  ];
}

async function needsResetPromptOnEndDateChange(
  row: SubmittedInstanceRow,
  nextEnd: string | null
): Promise<boolean> {
  const attemptResults = await getAttemptResultsForInstance(row.id);
  return shouldPromptResetAttemptsOnEndDateChange({
    row,
    currentEnd: row.end_date,
    nextEnd,
    attemptResults,
  });
}

export async function resolveNeedsResetPrompt(
  row: SubmittedInstanceRow,
  nextEnd: string | null,
  attemptResults?: AttemptResult[] | null
): Promise<boolean> {
  const sync = needsResetPromptOnEndDateChangeSync(row, nextEnd, attemptResults);
  if (sync === true) return true;
  if (sync === false) return false;
  return needsResetPromptOnEndDateChange(row, nextEnd);
}

export async function commitAssessmentDateChange(
  instanceId: number,
  dates: { start_date: string | null; end_date: string | null; extension_date?: string | null },
  opts: { resetAttempts?: boolean }
): Promise<void> {
  await updateFormInstanceDates(instanceId, dates, { resetAttempts: opts.resetAttempts });
  if (dates.end_date) {
    // Also follows the effective deadline (a later extension keeps the link open past end_date).
    await extendInstanceAccessTokensToDate(instanceId, 'student', dates.end_date);
  } else if ('extension_date' in dates) {
    // Extension-only change: never rewrites end_date, just realigns the student link expiry to the new deadline.
    await syncStudentTokenExpiryToDeadline(instanceId);
  }
}
