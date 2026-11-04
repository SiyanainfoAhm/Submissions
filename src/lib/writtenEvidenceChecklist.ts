/**
 * Written Evidence Checklist selection rules for the app (trainer/office view + builder).
 * Keep in sync with pdf-server/writtenEvidenceChecklist.ts (PDF copy).
 *
 * A section holds ONE OR MORE checklist questions (Task 3.1, 3.2, ...). Every single-choice question in a
 * task_written_evidence_checklist section is a checklist question and supports rows out of the box — it does
 * not need the `written.evidence.checklist` code. Legacy sections identified only by that code keep working.
 */

export const WRITTEN_EVIDENCE_CODE = 'written.evidence.checklist';
export const WRITTEN_EVIDENCE_MODE = 'task_written_evidence_checklist';

interface QuestionLike {
  type: string;
  code?: string | null;
  sort_order?: number | null;
  rows?: unknown[] | null;
}

export function isWrittenEvidenceChecklistSection(
  sectionMode: string | null | undefined,
  questions: { code?: string | null }[],
): boolean {
  return sectionMode === WRITTEN_EVIDENCE_MODE || questions.some((q) => q.code === WRITTEN_EVIDENCE_CODE);
}

/** True when a question of this type/code, in a section of this mode, is a rows-based checklist question. */
export function isWrittenEvidenceChecklistQuestion(
  sectionMode: string | null | undefined,
  q: { type: string; code?: string | null },
): boolean {
  return q.type === 'single_choice' && (sectionMode === WRITTEN_EVIDENCE_MODE || q.code === WRITTEN_EVIDENCE_CODE);
}

/** Every checklist question in the section that has rows, in sort_order (stable). */
export function getWrittenEvidenceChecklistQuestions<Q extends QuestionLike>(
  sectionMode: string | null | undefined,
  questions: Q[],
): Q[] {
  return questions
    .filter((q) => isWrittenEvidenceChecklistQuestion(sectionMode, q) && (q.rows?.length ?? 0) > 0)
    .map((q, i) => ({ q, i }))
    .sort((a, b) => (a.q.sort_order ?? 0) - (b.q.sort_order ?? 0) || a.i - b.i)
    .map(({ q }) => q);
}
