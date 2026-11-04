import { describe, expect, it } from 'vitest';
import {
  calculateAssessmentFinalStatus,
  computeRowUi,
  withinInstanceAccessWindow,
} from './assessmentRowUi';
import { getAssessmentReportStatus } from './assessmentReportStatus';
import { getEffectiveEndDate, hasActiveExtension, mirrorExtensionDate, validateExtensionDate } from './assessmentDeadline';

describe('getEffectiveEndDate = COALESCE(extension_date, end_date)', () => {
  it('uses the extension when set, otherwise end_date', () => {
    expect(getEffectiveEndDate({ end_date: '2026-06-01', extension_date: '2026-06-15' })).toBe('2026-06-15');
    expect(getEffectiveEndDate({ end_date: '2026-06-01', extension_date: null })).toBe('2026-06-01');
    expect(getEffectiveEndDate({ end_date: '2026-06-01' })).toBe('2026-06-01');
    expect(getEffectiveEndDate({ end_date: null, extension_date: '2026-06-15' })).toBe('2026-06-15');
    expect(getEffectiveEndDate({ end_date: null, extension_date: null })).toBe('');
    expect(getEffectiveEndDate(null)).toBe('');
  });
  it('treats blank strings as unset and trims timestamps to the date', () => {
    expect(getEffectiveEndDate({ end_date: '2026-06-01', extension_date: '  ' })).toBe('2026-06-01');
    expect(getEffectiveEndDate({ end_date: '2026-06-01T00:00:00Z', extension_date: '' })).toBe('2026-06-01');
  });
  it('never mutates / depends on end_date being changed by an extension', () => {
    const row = { end_date: '2026-06-01', extension_date: '2026-06-15' };
    getEffectiveEndDate(row);
    expect(row.end_date).toBe('2026-06-01');
  });
});

describe('hasActiveExtension', () => {
  it('is true only when the extension differs from end_date', () => {
    expect(hasActiveExtension({ end_date: '2026-06-01', extension_date: '2026-06-15' })).toBe(true);
    expect(hasActiveExtension({ end_date: '2026-06-01', extension_date: '2026-06-01' })).toBe(false); // backfilled copy
    expect(hasActiveExtension({ end_date: '2026-06-01', extension_date: null })).toBe(false);
  });
});

describe('mirrorExtensionDate (same rule as the DB trigger skyline_form_instances_extension_mirror)', () => {
  it('extension equal to the OLD end date follows the new end date', () => {
    expect(mirrorExtensionDate({ oldEnd: '2026-03-10', newEnd: '2026-03-20', extension: '2026-03-10' })).toBe('2026-03-20');
    // also when the end date moves earlier
    expect(mirrorExtensionDate({ oldEnd: '2026-03-10', newEnd: '2026-03-05', extension: '2026-03-10' })).toBe('2026-03-05');
  });
  it('extension equal to the old end date becomes empty when the end date is cleared', () => {
    expect(mirrorExtensionDate({ oldEnd: '2026-09-01', newEnd: null, extension: '2026-09-01' })).toBeNull();
  });
  it('a real extension later than the new end date is left alone', () => {
    expect(mirrorExtensionDate({ oldEnd: '2026-06-01', newEnd: '2026-06-10', extension: '2026-06-15' })).toBe('2026-06-15');
  });
  it('end date moved PAST the extension: extension is raised to the new end date (deadline never goes backwards)', () => {
    expect(mirrorExtensionDate({ oldEnd: '2026-06-10', newEnd: '2026-06-20', extension: '2026-06-15' })).toBe('2026-06-20');
  });
  it('no extension stays no extension', () => {
    expect(mirrorExtensionDate({ oldEnd: null, newEnd: '2026-07-01', extension: null })).toBeNull();
    expect(mirrorExtensionDate({ oldEnd: '2026-03-10', newEnd: '2026-03-20', extension: '' })).toBeNull();
  });
});

describe('validateExtensionDate', () => {
  it('rejects an extension earlier than end_date', () => {
    expect(validateExtensionDate('2026-06-10', '2026-06-01')).toMatch(/earlier than the end date/);
  });
  it('accepts equal, later, empty, and missing end_date', () => {
    expect(validateExtensionDate('2026-06-10', '2026-06-10')).toBeNull();
    expect(validateExtensionDate('2026-06-10', '2026-06-20')).toBeNull();
    expect(validateExtensionDate('2026-06-10', null)).toBeNull();
    expect(validateExtensionDate(null, '2026-06-20')).toBeNull();
  });
  it('rejects a malformed date', () => {
    expect(validateExtensionDate('2026-06-10', '20/06/2026')).toMatch(/valid date/);
  });
});

describe('deadline logic uses COALESCE(extension_date, end_date)', () => {
  const base = { start_date: '2026-02-01', status: 'draft', role_context: 'student' };

  it('withinInstanceAccessWindow: an extension keeps the student window open past end_date', () => {
    expect(withinInstanceAccessWindow({ ...base, end_date: '2026-06-01' }, 'student', '2026-06-05').ok).toBe(false);
    expect(withinInstanceAccessWindow({ ...base, end_date: '2026-06-01', extension_date: '2026-06-15' }, 'student', '2026-06-05').ok).toBe(true);
    // ...until the extension passes; the message names the effective deadline
    const late = withinInstanceAccessWindow({ ...base, end_date: '2026-06-01', extension_date: '2026-06-15' }, 'student', '2026-06-16');
    expect(late.ok).toBe(false);
    expect(late.reason).toContain('15/06/2026');
  });

  it('withinInstanceAccessWindow: trainers/office are never blocked by the end date (unchanged)', () => {
    expect(withinInstanceAccessWindow({ ...base, end_date: '2026-06-01' }, 'trainer', '2026-09-01').ok).toBe(true);
  });

  it('computeRowUi: past due without an extension, open with one, past due again once it has passed', () => {
    // computeRowUi derives "past due" from the real clock (calculateAssessmentFinalStatus), so use clearly past/future dates.
    const row = { ...base, start_date: '2000-01-01', end_date: '2000-06-01', answer_count: 0 };
    expect(computeRowUi({ row }).kind).toBe('not_submitted');
    expect(computeRowUi({ row: { ...row, extension_date: '2999-01-01' } }).kind).toBe('in_progress');
    expect(computeRowUi({ row: { ...row, extension_date: '2000-07-01' } }).kind).toBe('not_submitted');
  });

  it('"Not submitted by due date": saved answers + past deadline, but not while an extension is open', () => {
    const row = { ...base, end_date: '2026-06-01', answer_count: 5 };
    const noExt = calculateAssessmentFinalStatus({ ...row, end_date: '2000-01-01' });
    expect(noExt.status).toBe('not_submitted');
    expect(calculateAssessmentFinalStatus({ ...row, end_date: '2000-01-01', extension_date: '2999-01-01' }).status).toBe('in_progress');
    // extension in the past again -> due-date failure again
    expect(calculateAssessmentFinalStatus({ ...row, end_date: '2000-01-01', extension_date: '2000-02-01' }).status).toBe('not_submitted');
  });

  it('report status: Failed after the effective deadline, In Progress during an extension', () => {
    expect(getAssessmentReportStatus({ status: 'draft', end_date: '2000-01-01' })).toBe('Failed');
    expect(getAssessmentReportStatus({ status: 'draft', end_date: '2000-01-01', extension_date: '2999-01-01' })).toBe('In Progress');
  });

  it('an extension never changes what end_date means in the row (end_date is only the original deadline)', () => {
    const row = { ...base, end_date: '2026-06-01', extension_date: '2026-06-15', answer_count: 0 };
    computeRowUi({ row, today: '2026-06-05' });
    expect(row.end_date).toBe('2026-06-01');
  });
});
