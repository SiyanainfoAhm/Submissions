/**
 * Shared Written Evidence Checklist (PDF HTML). Used by both live `/pdf` (index.ts) and the
 * worker (htmlGenerator.ts) so every checklist question in a section prints with all its rows.
 *
 * Pure functions only (no node/supabase deps) so they can be unit-tested from src/.
 * Keep the selection rules in sync with src/lib/writtenEvidenceChecklist.ts (frontend copy).
 */

export const WRITTEN_EVIDENCE_CODE = 'written.evidence.checklist';
export const WRITTEN_EVIDENCE_MODE = 'task_written_evidence_checklist';

export interface ChecklistRowLike {
  id: number;
  row_label?: string | null;
}
export interface ChecklistQuestionEntry {
  question: { id: number; type: string; code?: string | null; label?: string | null; sort_order?: number | null };
  rows: ChecklistRowLike[];
}

export const WRITTEN_EVIDENCE_CSS = `
    .written-evidence-table { width: 100%; border-collapse: collapse; font-size: 10pt; margin: 0 0 12px 0; border: 1px solid #000; }
    .written-evidence-table th, .written-evidence-table td { border: 1px solid #000; padding: 8px 10px; vertical-align: middle; line-height: 1.25; color: #000; }
    .written-evidence-table th { background: #595959 !important; color: #fff !important; font-weight: 700; text-align: center; }
    .written-evidence-table thead { display: table-header-group; }
    .written-evidence-table thead tr { page-break-after: avoid; break-after: avoid; }
    .written-evidence-table .we-left { text-align: left; }
    .written-evidence-table .we-index { width: 28px; text-align: center; }
    .written-evidence-table .we-yn { width: 56px; text-align: center; }
    .written-evidence-table .we-radio { display: inline-flex; align-items: center; justify-content: center; }
    .written-evidence-table .we-radio .radio-circle { width: 12px; height: 12px; border: 1.5px solid #374151; border-radius: 50%; display: inline-block; }
    .written-evidence-table .we-radio .radio-circle.filled { background: #000; border-color: #000; }
    .written-evidence-wrapper { page-break-inside: avoid; break-inside: avoid; }
    .written-evidence-wrapper .written-evidence-checklist-heading { page-break-after: avoid; break-after: avoid; margin: 0 0 12px 0; font-size: 11pt; font-weight: 700; }
    .written-evidence-wrapper .written-evidence-question-label { page-break-after: avoid; break-after: avoid; margin: 0 0 6px 0; font-size: 10pt; font-weight: 700; }
`;

/** A section is a checklist section by render mode, or (legacy forms) by holding a question with the checklist code. */
export function isWrittenEvidenceChecklistSection(
  sectionMode: string | null | undefined,
  questions: ChecklistQuestionEntry[],
): boolean {
  return sectionMode === WRITTEN_EVIDENCE_MODE || questions.some((q) => q.question.code === WRITTEN_EVIDENCE_CODE);
}

/**
 * EVERY single-choice question in the section that has rows — not just the first one carrying the code.
 * In a task_written_evidence_checklist section any single_choice question counts (rows work out of the box);
 * elsewhere only questions carrying the checklist code count (legacy behaviour).
 */
export function getWrittenEvidenceChecklistQuestions(
  sectionMode: string | null | undefined,
  questions: ChecklistQuestionEntry[],
): ChecklistQuestionEntry[] {
  const inChecklistSection = sectionMode === WRITTEN_EVIDENCE_MODE;
  return questions
    .filter(
      (q) =>
        q.question.type === 'single_choice' &&
        (inChecklistSection || q.question.code === WRITTEN_EVIDENCE_CODE) &&
        (q.rows?.length ?? 0) > 0,
    )
    .map((q, i) => ({ q, i }))
    .sort((a, b) => (a.q.question.sort_order ?? 0) - (b.q.question.sort_order ?? 0) || a.i - b.i)
    .map(({ q }) => q);
}

export function renderWrittenEvidenceChecklistHtml(
  sectionTitle: string | null | undefined,
  checklistQuestions: ChecklistQuestionEntry[],
  answers: Map<string, unknown>,
): string {
  if (checklistQuestions.length === 0) return '';
  const title = sectionTitle || 'Written Evidence Checklist';
  const multiple = checklistQuestions.length > 1;
  let html = '';
  checklistQuestions.forEach((cq, qIdx) => {
    html += '<div class="written-evidence-wrapper">';
    if (qIdx === 0) html += `<h3 class="written-evidence-checklist-heading">${title}</h3>`;
    if (multiple && cq.question.label) html += `<div class="written-evidence-question-label">${cq.question.label}</div>`;
    html += '<table class="written-evidence-table">';
    html += '<thead>';
    html += '<tr><th rowspan="2" class="we-index"></th><th rowspan="2" class="we-left">Written Evidence</th><th colspan="2">Submitted</th></tr>';
    html += '<tr><th class="we-yn">Yes</th><th class="we-yn">No</th></tr>';
    html += '</thead><tbody>';
    for (let i = 0; i < cq.rows.length; i++) {
      const row = cq.rows[i];
      const val = String(answers.get(`q-${cq.question.id}-${row.id}`) ?? '');
      html += '<tr>';
      html += `<td class="we-index">${i + 1}</td>`;
      html += `<td class="we-left">${row.row_label || ''}</td>`;
      html += `<td class="we-yn"><span class="we-radio"><span class="radio-circle${val === 'yes' ? ' filled' : ''}"></span></span></td>`;
      html += `<td class="we-yn"><span class="we-radio"><span class="radio-circle${val === 'no' ? ' filled' : ''}"></span></span></td>`;
      html += '</tr>';
    }
    html += '</tbody></table></div>';
  });
  return html;
}
