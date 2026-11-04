import { describe, expect, it } from 'vitest';
import {
  calculateAssessmentDisplayStatus,
  calculateAssessmentFinalStatus,
  computeAttemptTones,
  computeRowUi,
  getAssessmentOutcomeDisplay,
  getInstanceWorkflowLabel,
  getMissedAttemptIndexes,
  getMissedAttemptWindowText,
  getStudentAttemptDoneText,
  hasStudentSubmissionNotSentToTrainer,
  isDidNotAttemptAnyFailure,
  isNotSubmittedByDueDate,
  isTerminalFailureProgressRow,
  shouldAutoResetTerminalAssessmentOnEndDateChange,
  type AttemptResult,
} from './assessmentRowUi';

describe('isDidNotAttemptAnyFailure', () => {
  it('requires did_not_attempt and rollovers >= 2', () => {
    expect(isDidNotAttemptAnyFailure({ didNotAttempt: true, noAttemptRollovers: 2 })).toBe(true);
    expect(isDidNotAttemptAnyFailure({ didNotAttempt: true, noAttemptRollovers: 1 })).toBe(false);
    expect(isDidNotAttemptAnyFailure({ didNotAttempt: false, noAttemptRollovers: 2 })).toBe(false);
  });
});

describe('isTerminalFailureProgressRow', () => {
  it('does not treat did_not_attempt alone as terminal', () => {
    expect(isTerminalFailureProgressRow({ did_not_attempt: true, no_attempt_rollovers: 1 })).toBe(false);
    expect(isTerminalFailureProgressRow({ did_not_attempt: true, no_attempt_rollovers: 2 })).toBe(true);
  });
});

describe('end-date terminal reset', () => {
  it('automatically resets a red exhausted assessment when its end date changes', () => {
    expect(
      shouldAutoResetTerminalAssessmentOnEndDateChange(
        {
          did_not_attempt: true,
          no_attempt_rollovers: 2,
          workflow_status: 'failed',
        },
        true,
      ),
    ).toBe(true);
  });

  it('does not reset a completed assessment when its end date changes', () => {
    expect(
      shouldAutoResetTerminalAssessmentOnEndDateChange(
        {
          did_not_attempt: true,
          no_attempt_rollovers: 2,
          workflow_status: 'completed',
        },
        true,
      ),
    ).toBe(false);
  });
});

describe('getMissedAttemptWindowText', () => {
  it('shows specific missed text for partial rollovers', () => {
    expect(getMissedAttemptWindowText({ noAttemptRollovers: 1, didNotAttempt: false })).toBe('Missed 1st attempt');
    expect(getMissedAttemptWindowText({ noAttemptRollovers: 2, didNotAttempt: false })).toBe(
      'Missed 1st attempt, 2nd attempt',
    );
    expect(getMissedAttemptWindowText({ noAttemptRollovers: 2, didNotAttempt: true })).toBe("Didn't attempt any");
  });

  it('uses the incomplete status for saved work without a final submission', () => {
    expect(
      getMissedAttemptWindowText({
        status: 'incomplete',
        submissionCount: 0,
        submittedAt: null,
        noAttemptRollovers: 2,
        didNotAttempt: false,
      }),
    ).toBe('Not submitted by due date');
  });
});

describe('computeRowUi terminal state', () => {
  it('only marks terminal when all windows missed', () => {
    const partial = computeRowUi({
      row: { did_not_attempt: true, no_attempt_rollovers: 1, status: 'draft', role_context: 'student' },
      submissionCount: 0,
    });
    expect(partial.kind).toBe('in_progress');

    const terminal = computeRowUi({
      row: { did_not_attempt: true, no_attempt_rollovers: 2, status: 'locked', role_context: 'office' },
      submissionCount: 0,
    });
    expect(terminal.kind).toBe('did_not_attempt');
    expect(terminal.outcomeLabel).toBe("Didn't attempt any");
  });

  it('returns in-progress after reset-like row state', () => {
    const reset = computeRowUi({
      row: {
        did_not_attempt: false,
        no_attempt_rollovers: 0,
        status: 'draft',
        role_context: 'student',
        start_date: '2020-01-01',
        end_date: '2030-12-31',
      },
      submissionCount: 0,
    });
    expect(reset.kind).toBe('in_progress');
    expect(reset.rowClassName).not.toContain('cursor-not-allowed');
  });

  it('distinguishes incomplete saved work from did-not-attempt', () => {
    const incomplete = computeRowUi({
      row: {
        did_not_attempt: false,
        no_attempt_rollovers: 2,
        status: 'incomplete',
        role_context: 'student',
      },
      submissionCount: 0,
    });

    expect(incomplete.kind).toBe('not_submitted');
    expect(incomplete.outcomeLabel).toBe('Not submitted by due date');
    expect(
      isNotSubmittedByDueDate({
        status: 'incomplete',
        submission_count: 0,
        submitted_at: null,
      }),
    ).toBe(true);
    expect(
      getInstanceWorkflowLabel({
        status: 'incomplete',
        submission_count: 0,
        submitted_at: null,
      }),
    ).toBe('Not submitted by due date');
  });

  it('shows a trainer-checked competent row instead of stale terminal red', () => {
    const assessed = computeRowUi({
      row: {
        did_not_attempt: true,
        no_attempt_rollovers: 2,
        status: 'locked',
        role_context: 'office',
      },
      submissionCount: 1,
      attemptResults: ['competent', null, null],
    });

    expect(assessed.kind).toBe('past_competent');
    expect(assessed.outcomeLabel).toBe('Completed');
    expect(assessed.rowClassName).toContain('emerald');
    expect(assessed.rowClassName).not.toContain('red');
  });
});

describe('assessment status precedence', () => {
  const staleRolloverRow = {
    did_not_attempt: true,
    no_attempt_rollovers: 2,
    status: 'submitted',
    role_context: 'office',
    end_date: '2020-01-01',
  };

  it('displays Completed, never did-not-attempt, when trainer and office completed', () => {
    const display = calculateAssessmentDisplayStatus({
      ...staleRolloverRow,
      submission_count: 0,
      attempt_results: ['competent', null, null],
      trainer_assessment_exists: true,
      workflow_status: 'completed',
    });
    const ui = computeRowUi({
      row: staleRolloverRow,
      submissionCount: 1,
      attemptResults: ['competent', null, null],
      today: '2026-09-17',
    });

    expect(display.label).toBe('Completed');
    expect(display.label).not.toBe("Didn't attempt any");
    expect(display.terminalDidNotAttempt).toBe(false);
    expect(ui.kind).toBe('past_competent');
  });

  it('makes the full row and all progress indicators green after final office approval', () => {
    const input = {
      status: 'locked',
      role_context: 'office',
      workflow_status: 'completed',
      office_assessment_completed: true,
      did_not_attempt: true,
      no_attempt_rollovers: 2,
      submission_count: 0,
      submitted_at: null,
      answer_count: 0,
      attempt_results: ['competent', null, null] as AttemptResult[],
      trainer_assessment_exists: true,
      end_date: '2020-01-01',
    };

    const final = calculateAssessmentFinalStatus(input);
    const row = computeRowUi({
      row: input,
      attemptResults: input.attempt_results,
      submissionCount: 0,
      submittedAt: null,
      today: '2026-09-17',
    });

    expect(final).toMatchObject({
      status: 'completed',
      comment: 'Completed',
      rowTone: 'green',
      studentProgress: 'done',
      trainerProgress: 'done',
      officeProgress: 'done',
      terminalDidNotAttempt: false,
      suppressExpiry: true,
    });
    expect(row.kind).toBe('past_competent');
    expect(row.rowClassName).toContain('emerald');
    expect(row.outcomeLabel).toBe('Completed');
    expect(final.comment).not.toMatch(/Not submitted by due date|Expired on|Didn't attempt any/);
  });

  it('lets office_status completed override stale expiry and submission fields', () => {
    const result = calculateAssessmentFinalStatus({
      did_not_attempt: true,
      submitted_at: null,
      expired: true,
      office_status: 'completed',
    });

    expect({
      finalStatus: result.status,
      rowColor: result.rowTone,
      student: result.studentProgress === 'done' ? 'completed' : result.studentProgress,
      trainer: result.trainerProgress === 'done' ? 'completed' : result.trainerProgress,
      office: result.officeProgress === 'done' ? 'completed' : result.officeProgress,
      comment: result.comment,
    }).toEqual({
      finalStatus: 'completed',
      rowColor: 'green',
      student: 'completed',
      trainer: 'completed',
      office: 'completed',
      comment: 'Completed',
    });
  });

  it('lets a trainer assessment override stale rollover flags', () => {
    const ui = computeRowUi({
      row: staleRolloverRow,
      submissionCount: 1,
      attemptResults: ['not_yet_competent', null, null],
      ignoreEndDateForAccess: true,
    });

    expect(ui.kind).toBe('past_not_competent');
    expect(ui.outcomeLabel).toBe('Competency Not Achieved');
    expect(ui.outcomeLabel).not.toBe("Didn't attempt any");
  });

  it('lets a submitted assessment override stale did_not_attempt', () => {
    const ui = computeRowUi({
      row: {
        ...staleRolloverRow,
        role_context: 'trainer',
      },
      submissionCount: 1,
      submittedAt: '2026-09-17T01:00:00.000Z',
      attemptResults: [null, null, null],
      ignoreEndDateForAccess: true,
    });

    expect(ui.kind).toBe('in_progress');
    expect(getMissedAttemptWindowText({
      didNotAttempt: true,
      noAttemptRollovers: 2,
      submissionCount: 1,
    })).not.toBe("Didn't attempt any");
  });

  it('shows did-not-attempt only for a completely untouched expired assessment', () => {
    const untouched = computeRowUi({
      row: {
        did_not_attempt: true,
        no_attempt_rollovers: 2,
        status: 'locked',
        role_context: 'office',
        end_date: '2020-01-01',
      },
      submissionCount: 0,
      submittedAt: null,
      attemptResults: [null, null, null],
      today: '2026-09-17',
    });

    expect(untouched.kind).toBe('did_not_attempt');
    expect(untouched.outcomeLabel).toBe("Didn't attempt any");
  });

  it('uses saved answers before stale did-not-attempt flags for production-shaped rows', () => {
    const display = calculateAssessmentDisplayStatus({
      status: 'locked',
      role_context: 'office',
      did_not_attempt: true,
      no_attempt_rollovers: 2,
      submission_count: 0,
      submitted_at: null,
      answer_count: 39,
      attempt_results: [null, null, null],
      trainer_assessment_exists: false,
      end_date: '2026-09-16',
    });

    expect(display.status).toBe('saved_answers');
    expect(display.label).toBe('Not submitted by due date');
    expect(display.terminalDidNotAttempt).toBe(false);
  });
});

describe('getMissedAttemptIndexes', () => {
  it('maps rollovers and terminal flag to slots', () => {
    expect([...getMissedAttemptIndexes({ no_attempt_rollovers: 0, did_not_attempt: false })]).toEqual([]);
    expect([...getMissedAttemptIndexes({ no_attempt_rollovers: 1, did_not_attempt: false })]).toEqual([0]);
    expect([...getMissedAttemptIndexes({ no_attempt_rollovers: 2, did_not_attempt: true })]).toEqual([0, 1, 2]);
  });
});

describe('computeAttemptTones', () => {
  const studentTones = (input: Parameters<typeof computeAttemptTones>[0]) => computeAttemptTones(input).student;
  const trainerTones = (input: Parameters<typeof computeAttemptTones>[0]) => computeAttemptTones(input).trainer;
  const tones = studentTones;

  it('submitted but not yet handed to the trainer: student dot yellow (submitted), trainer dot yellow (awaiting)', () => {
    const input = {
      submissionCount: 1,
      results: [null, null, null] as AttemptResult[],
      no_attempt_rollovers: 0,
      did_not_attempt: false,
      role_context: 'student',
      status: 'draft',
    };
    expect(trainerTones(input)).toEqual(['yellow', 'gray', 'gray']);
    expect(studentTones(input)).toEqual(['yellow', 'gray', 'gray']);
  });

  it('not-sent submission of a later attempt lights that attempt slot, earlier results unchanged', () => {
    const base = { role_context: 'student', status: 'draft', did_not_attempt: false, no_attempt_rollovers: 0 };
    // 2nd attempt submitted, not sent
    expect(studentTones({ ...base, submissionCount: 2, results: ['not_yet_competent', null, null] })).toEqual(['red', 'yellow', 'gray']);
    expect(trainerTones({ ...base, submissionCount: 2, results: ['not_yet_competent', null, null] })).toEqual(['red', 'yellow', 'gray']);
    // 3rd attempt submitted, not sent
    expect(studentTones({ ...base, submissionCount: 3, results: ['not_yet_competent', 'not_yet_competent', null] })).toEqual(['red', 'red', 'yellow']);
    expect(trainerTones({ ...base, submissionCount: 3, results: ['not_yet_competent', 'not_yet_competent', null] })).toEqual(['red', 'red', 'yellow']);
    // first window missed: the submission counts as attempt 2
    expect(studentTones({ ...base, submissionCount: 1, results: [null, null, null], no_attempt_rollovers: 1 })).toEqual(['red', 'yellow', 'gray']);
  });

  it('nothing submitted: not-sent logic does not light any dot (trainer stays gray)', () => {
    const t = trainerTones({
      submissionCount: 0,
      results: [null, null, null],
      role_context: 'student',
      status: 'draft',
      no_attempt_rollovers: 0,
      did_not_attempt: false,
    });
    expect(t).toEqual(['gray', 'gray', 'gray']);
  });

  it('Progress column always agrees with the Comments status for submitted-not-sent (icons + dots + comment)', () => {
    const row = { status: 'draft', role_context: 'student', submission_count: 1, submitted_at: '2026-03-01T00:00:00Z', end_date: '2026-11-29' };
    const none: AttemptResult[] = [null, null, null];
    const comment = getAssessmentOutcomeDisplay({
      status: row.status,
      role_context: row.role_context,
      attemptResults: none,
      submissionCount: 1,
      submittedAt: row.submitted_at,
    });
    expect(comment.label).toBe('Submitted');
    expect(comment.subtext).toBe('Not sent to trainer');
    const final = calculateAssessmentFinalStatus({ ...row, attempt_results: none });
    expect(final.studentProgress).toBe('done');
    expect(final.trainerProgress).toBe('pending');
    expect(final.officeProgress).toBe('idle');
    const tones = computeAttemptTones({ submissionCount: 1, results: none, role_context: row.role_context, status: row.status });
    expect(tones.student[0]).toBe('yellow');
    expect(tones.trainer[0]).toBe('yellow');
  });

  it('submitted and sent to trainer keeps its existing tones', () => {
    const input = { submissionCount: 1, results: [null, null, null] as AttemptResult[], role_context: 'trainer', status: 'draft' };
    expect(studentTones(input)).toEqual(['yellow', 'gray', 'gray']);
    expect(trainerTones(input)).toEqual(['yellow', 'gray', 'gray']);
  });

  it('labels stuck handoff as submitted not sent', () => {
    expect(
      hasStudentSubmissionNotSentToTrainer({
        status: 'draft',
        role_context: 'student',
        submission_count: 1,
      }),
    ).toBe(true);
    expect(
      getInstanceWorkflowLabel({
        status: 'draft',
        role_context: 'student',
        submission_count: 1,
      }),
    ).toBe('Submitted (Not Sent)');
  });

  it('Case A: clean start', () => {
    expect(
      tones({
        submissionCount: 0,
        results: [null, null, null],
        no_attempt_rollovers: 0,
        did_not_attempt: false,
        role_context: 'student',
        status: 'draft',
      }),
    ).toEqual(['yellow', 'gray', 'gray']);
  });

  it('Case B: attempt 1 missed, on attempt 2', () => {
    expect(
      tones({
        submissionCount: 0,
        results: [null, null, null],
        no_attempt_rollovers: 1,
        did_not_attempt: false,
        role_context: 'student',
        status: 'draft',
      }),
    ).toEqual(['red', 'yellow', 'gray']);
  });

  it('Case C: attempt 1 missed, attempt 2 submitted awaiting trainer', () => {
    expect(
      tones({
        submissionCount: 1,
        results: [null, null, null],
        no_attempt_rollovers: 1,
        did_not_attempt: false,
        role_context: 'trainer',
        status: 'submitted',
      }),
    ).toEqual(['red', 'yellow', 'gray']);
  });

  it('Case D: attempt 1 missed, attempt 2 NYC, attempt 3 available', () => {
    expect(
      tones({
        submissionCount: 1,
        results: [null, 'not_yet_competent', null],
        no_attempt_rollovers: 1,
        did_not_attempt: false,
        role_context: 'student',
        status: 'draft',
      }),
    ).toEqual(['red', 'red', 'yellow']);
  });

  it('Case E: attempt 1 submitted awaiting trainer', () => {
    expect(
      tones({
        submissionCount: 1,
        results: [null, null, null],
        no_attempt_rollovers: 0,
        did_not_attempt: false,
        role_context: 'trainer',
        status: 'submitted',
      }),
    ).toEqual(['yellow', 'gray', 'gray']);
  });

  it('Case F: all three windows missed', () => {
    expect(
      tones({
        submissionCount: 0,
        results: [null, null, null],
        terminalDidNotAttempt: true,
      }),
    ).toEqual(['red', 'red', 'red']);
  });

  it('after reset: attempt 1 available', () => {
    expect(
      tones({
        submissionCount: 0,
        results: [null, null, null],
        no_attempt_rollovers: 0,
        did_not_attempt: false,
        role_context: 'student',
        status: 'draft',
      }),
    ).toEqual(['yellow', 'gray', 'gray']);
  });
});

describe('getStudentAttemptDoneText with rollovers', () => {
  it('maps awaiting trainer to actual attempt slot after missed window', () => {
    const text = getStudentAttemptDoneText({
      submissionCount: 1,
      attemptResults: [null, null, null],
      role_context: 'trainer',
      status: 'submitted',
      no_attempt_rollovers: 1,
      did_not_attempt: false,
    });
    expect(text).toBe('Submitted 2nd attempt — awaiting trainer');
  });
});
