import { describe, expect, it } from 'vitest';
import {
  getWrittenEvidenceChecklistQuestions as appSelect,
  isWrittenEvidenceChecklistQuestion,
  isWrittenEvidenceChecklistSection as appIsSection,
} from './writtenEvidenceChecklist';
import {
  getWrittenEvidenceChecklistQuestions as pdfSelect,
  isWrittenEvidenceChecklistSection as pdfIsSection,
  renderWrittenEvidenceChecklistHtml,
} from '../../pdf-server/writtenEvidenceChecklist';

const MODE = 'task_written_evidence_checklist';
const CODE = 'written.evidence.checklist';

const rows = (qid: number, labels: string[]) => labels.map((l, i) => ({ id: qid * 100 + i, row_label: l }));

/** PDF-shape entry (question + rows) */
const entry = (id: number, over: Record<string, unknown> = {}, labels: string[] = ['A', 'B']) => ({
  question: { id, type: 'single_choice', code: CODE, label: `Task 3.${id}`, sort_order: id, ...over },
  rows: rows(id, labels),
});
/** App-shape question (flat with rows) */
const appQ = (id: number, over: Record<string, unknown> = {}, labels: string[] = ['A', 'B']) => ({
  id, type: 'single_choice', code: CODE, label: `Task 3.${id}`, sort_order: id, rows: rows(id, labels), ...over,
});

describe('Written Evidence Checklist selection', () => {
  it('returns EVERY checklist question with rows, not just the first', () => {
    const qs = [1, 2, 3, 4].map((i) => appQ(i));
    expect(appSelect(MODE, qs).map((q) => q.id)).toEqual([1, 2, 3, 4]);
    expect(pdfSelect(MODE, [1, 2, 3, 4].map((i) => entry(i))).map((q) => q.question.id)).toEqual([1, 2, 3, 4]);
  });

  it('does not require the checklist code inside a task_written_evidence_checklist section (added questions work)', () => {
    const qs = [appQ(1), appQ(2, { code: null }), appQ(3, { code: 'something.else' })];
    expect(appSelect(MODE, qs).map((q) => q.id)).toEqual([1, 2, 3]);
    const pdf = [entry(1), entry(2, { code: null }), entry(3, { code: 'x' })];
    expect(pdfSelect(MODE, pdf).map((q) => q.question.id)).toEqual([1, 2, 3]);
  });

  it('legacy: a section NOT in checklist mode only counts questions carrying the code', () => {
    const qs = [appQ(1), appQ(2, { code: null })];
    expect(appSelect('task_questions', qs).map((q) => q.id)).toEqual([1]);
    expect(pdfSelect('task_questions', [entry(1), entry(2, { code: null })]).map((q) => q.question.id)).toEqual([1]);
  });

  it('skips questions without rows and non single-choice types', () => {
    const qs = [appQ(1, {}, []), appQ(2, { type: 'short_text' }), appQ(3)];
    expect(appSelect(MODE, qs).map((q) => q.id)).toEqual([3]);
    expect(pdfSelect(MODE, [entry(1, {}, []), entry(2, { type: 'short_text' }), entry(3)]).map((q) => q.question.id)).toEqual([3]);
  });

  it('orders by sort_order (stable), not insertion order', () => {
    const qs = [appQ(3, { sort_order: 2 }), appQ(1, { sort_order: 0 }), appQ(2, { sort_order: 1 })];
    expect(appSelect(MODE, qs).map((q) => q.id)).toEqual([1, 2, 3]);
  });

  it('section detection: by mode, or legacy by code; app and PDF agree', () => {
    expect(appIsSection(MODE, [])).toBe(true);
    expect(appIsSection('task_questions', [{ code: CODE }])).toBe(true);
    expect(appIsSection('task_questions', [{ code: 'x' }])).toBe(false);
    expect(pdfIsSection(MODE, [])).toBe(true);
    expect(pdfIsSection('task_questions', [entry(1)])).toBe(true);
    expect(pdfIsSection('task_questions', [entry(1, { code: 'x' })])).toBe(false);
  });

  it('isWrittenEvidenceChecklistQuestion: single choice in checklist mode, or carrying the code', () => {
    expect(isWrittenEvidenceChecklistQuestion(MODE, { type: 'single_choice', code: null })).toBe(true);
    expect(isWrittenEvidenceChecklistQuestion('task_questions', { type: 'single_choice', code: CODE })).toBe(true);
    expect(isWrittenEvidenceChecklistQuestion('task_questions', { type: 'single_choice', code: null })).toBe(false);
    expect(isWrittenEvidenceChecklistQuestion(MODE, { type: 'short_text', code: CODE })).toBe(false);
  });
});

describe('Written Evidence Checklist PDF HTML', () => {
  it('renders nothing when there are no checklist questions with rows', () => {
    expect(renderWrittenEvidenceChecklistHtml('Written Evidence Checklist', [], new Map())).toBe('');
  });

  it('single question: unchanged layout (section heading, no per-question label)', () => {
    const html = renderWrittenEvidenceChecklistHtml('Written Evidence Checklist', [entry(1, {}, ['Alpha', 'Beta'])], new Map());
    expect(html).toContain('<h3 class="written-evidence-checklist-heading">Written Evidence Checklist</h3>');
    expect(html).not.toContain('written-evidence-question-label');
    expect(html.match(/<table class="written-evidence-table">/g)).toHaveLength(1);
    expect(html).toContain('<td class="we-left">Alpha</td>');
    expect(html).toContain('<td class="we-left">Beta</td>');
  });

  it('multiple questions: one table per question with ALL rows, labelled, one section heading', () => {
    const qs = [
      entry(1, { label: 'Task 3.1' }, ['Established management structures and support', 'Identified the responsibilities of the managers']),
      entry(2, { label: 'Task 3.2' }, ['Row 2a']),
      entry(3, { label: 'Task 3.3' }, ['Row 3a', 'Row 3b', 'Row 3c']),
      entry(4, { label: 'Task 3.4' }, ['Summarised agreed outcomes']),
    ];
    const html = renderWrittenEvidenceChecklistHtml('Written Evidence Checklist', qs, new Map());
    expect(html.match(/<table class="written-evidence-table">/g)).toHaveLength(4);
    expect(html.match(/written-evidence-checklist-heading/g)).toHaveLength(1);
    for (const label of ['Task 3.1', 'Task 3.2', 'Task 3.3', 'Task 3.4']) {
      expect(html).toContain(`<div class="written-evidence-question-label">${label}</div>`);
    }
    for (const row of ['Established management structures and support', 'Identified the responsibilities of the managers', 'Row 2a', 'Row 3a', 'Row 3b', 'Row 3c', 'Summarised agreed outcomes']) {
      expect(html).toContain(`<td class="we-left">${row}</td>`);
    }
  });

  it('marks the saved yes/no answer per question+row key', () => {
    const q = entry(2, {}, ['R1', 'R2']);
    const answers = new Map<string, unknown>([[`q-2-${q.rows[0].id}`, 'yes'], [`q-2-${q.rows[1].id}`, 'no']]);
    const html = renderWrittenEvidenceChecklistHtml('S', [q], answers);
    const [r1, r2] = html.split('<tr>').slice(3); // skip the two header rows
    expect(r1).toContain('<span class="radio-circle filled"></span></span></td><td class="we-yn"><span class="we-radio"><span class="radio-circle"></span>');
    expect(r2).toContain('<span class="radio-circle"></span></span></td><td class="we-yn"><span class="we-radio"><span class="radio-circle filled"></span>');
  });
});
