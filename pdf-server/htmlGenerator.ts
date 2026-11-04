import path from 'path';
import fs from 'fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { renderAppendixAMatrixHtml } from './appendixAMatrixData.js';
import { renderTaskQuestionInstructionHtml } from './instructionBlocksHtml.js';
import { escapeImgSrc, pdfImageSrc } from './pdfConstants.js';
import {
  ASSESSMENT_QUESTION_BLOCK_CSS,
  questionContentLabelHtml,
  renderQuestionBlockClose,
  renderQuestionBlockOpen,
} from './assessmentQuestionBlock.js';
import {
  WRITTEN_EVIDENCE_CSS,
  getWrittenEvidenceChecklistQuestions,
  isWrittenEvidenceChecklistSection,
  renderWrittenEvidenceChecklistHtml,
} from './writtenEvidenceChecklist.js';
import { publicDir } from './paths.js';
import {
  buildInstancePdfFileName,
  extractStudentFieldsFromAnswers,
} from './pdfFileNaming.js';

export interface FormAnswer {
  question_id: number;
  row_id: number | null;
  value_text: string | null;
  value_number: number | null;
  value_json: unknown;
}

export interface FormQuestion {
  id: number;
  section_id: number;
  type: string;
  code: string | null;
  label: string;
  help_text: string | null;
  required: boolean;
  sort_order: number;
  role_visibility: unknown;
  role_editability: unknown;
  pdf_meta: { columns?: string[] } & Record<string, unknown>;
}

export interface FormSection {
  id: number;
  step_id: number;
  title: string;
  description: string | null;
  pdf_render_mode: string;
  sort_order: number;
  assessment_task_row_id?: number | null;
  instructions_meta?: Record<string, unknown> | null;
}

export interface FormQuestionRow {
  id: number;
  question_id: number;
  row_label: string;
  row_help: string | null;
  row_image_url: string | null;
  row_meta?: { instructions?: Record<string, unknown> } | null;
  sort_order: number;
}

export interface FormQuestionOption {
  id: number;
  question_id: number;
  value: string;
  label: string;
  sort_order: number;
}

/** Renders signature value: image (data:...) as img, plain text as red italic span */
function renderSignatureHtml(val: string | null | undefined): string {
  if (!val) return '';
  if (val.startsWith('data:')) {
    return `<img src="${escapeImgSrc(pdfImageSrc(val.replace(/\s+/g, ''), 'signature'), 'signature')}" alt="Signature" class="signature-img" style="max-height:36px;max-width:140px" loading="eager" />`;
  }
  const escaped = String(val).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return '<span style="color:#dc2626;font-style:italic;font-family:serif">' + escaped + '</span>';
}

function gridRowImgHtml(imageUrl: string | null | undefined): string {
  if (!imageUrl) return '';
  return `<img src="${escapeImgSrc(imageUrl, 'grid-row-image')}" class="signature-img" alt="" loading="eager" />`;
}

/** Escapes HTML and converts newlines to <br> so line breaks in question labels display correctly in PDF */
function labelToHtml(s: string | null | undefined): string {
  if (s == null) return '';
  const str = String(s);
  const escaped = str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return escaped.replace(/\n/g, '<br>');
}

function normalizeNbspProse(s: string): string {
  return String(s || '').replace(/&nbsp;/gi, ' ').replace(/\u00A0/g, ' ');
}

function escapeHtmlAttr(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Short/long answers may be stored as merged `{ text, answerImageUrl }` in the answer map (see getAnswerMap). */
function formatShortLongAnswerCellHtml(val: string | number | Record<string, unknown> | undefined): string {
  if (val != null && typeof val === 'object' && !Array.isArray(val)) {
    const o = val as Record<string, unknown>;
    if ('text' in o || 'answerImageUrl' in o) {
      const t = labelToHtml(String(o.text ?? ''));
      const u =
        typeof o.answerImageUrl === 'string' && o.answerImageUrl.trim()
          ? escapeImgSrc(o.answerImageUrl, 'answer-image')
          : '';
      const img = u
        ? `<div style="margin-top:8px"><img src="${u}" class="answer-image" alt="" loading="eager" style="max-width:100%;max-height:280px;object-fit:contain;border:1px solid #ddd;border-radius:4px"/></div>`
        : '';
      return (t ? `<div style="white-space:pre-line">${t}</div>` : '') + img;
    }
  }
  if (val == null) return '';
  return labelToHtml(String(val));
}

export async function getTemplateForInstance(supabase: SupabaseClient, instanceId: number) {
  const { data: instance } = await supabase
    .from('skyline_form_instances')
    .select('*')
    .eq('id', instanceId)
    .single();

  if (!instance) return null;

  const { data: form } = await supabase
    .from('skyline_forms')
    .select('*')
    .eq('id', instance.form_id)
    .single();

  if (!form) return null;

  const { data: steps } = await supabase
    .from('skyline_form_steps')
    .select('*')
    .eq('form_id', instance.form_id)
    .order('sort_order');

  const stepsWithSections: Array<{
    step: { id: number; title: string; subtitle: string | null; sort_order: number };
    sections: Array<{
      section: FormSection;
      questions: Array<{
        question: FormQuestion;
        options: FormQuestionOption[];
        rows: FormQuestionRow[];
      }>;
    }>;
  }> = [];

  for (const step of steps || []) {
    const { data: sections } = await supabase
      .from('skyline_form_sections')
      .select('*')
      .eq('step_id', step.id)
      .order('sort_order');

    const sectionsWithQs: Array<{
      section: FormSection;
      questions: Array<{
        question: FormQuestion;
        options: FormQuestionOption[];
        rows: FormQuestionRow[];
      }>;
    }> = [];

    for (const section of sections || []) {
      const { data: questions } = await supabase
        .from('skyline_form_questions')
        .select('*')
        .eq('section_id', section.id)
        .order('sort_order');

      const questionsWithExtras: Array<{
        question: FormQuestion;
        options: FormQuestionOption[];
        rows: FormQuestionRow[];
      }> = [];

      for (const q of questions || []) {
        const { data: options } = await supabase
          .from('skyline_form_question_options')
          .select('*')
          .eq('question_id', q.id)
          .order('sort_order');
        const { data: rows } = await supabase
          .from('skyline_form_question_rows')
          .select('*')
          .eq('question_id', q.id)
          .order('sort_order');
        questionsWithExtras.push({
          question: q as FormQuestion,
          options: (options as FormQuestionOption[]) || [],
          rows: (rows as FormQuestionRow[]) || [],
        });
      }
      sectionsWithQs.push({
        section: section as FormSection,
        questions: questionsWithExtras,
      });
    }
    stepsWithSections.push({ step: step as { id: number; title: string; subtitle: string | null; sort_order: number }, sections: sectionsWithQs });
  }

  return { instance: { ...instance, form }, steps: stepsWithSections };
}

export function getAnswerMap(answers: FormAnswer[]): Map<string, string | number | Record<string, unknown>> {
  const m = new Map<string, string | number | Record<string, unknown>>();
  for (const a of answers) {
    const key = a.row_id === null ? `q-${a.question_id}` : `q-${a.question_id}-${a.row_id}`;
    const j =
      a.value_json != null && typeof a.value_json === 'object' && !Array.isArray(a.value_json)
        ? (a.value_json as Record<string, unknown>)
        : null;
    if (j && typeof j.answerImageUrl === 'string' && j.answerImageUrl.trim()) {
      m.set(key, { text: String(a.value_text ?? j.text ?? ''), answerImageUrl: j.answerImageUrl });
      continue;
    }
    if (a.value_text != null) m.set(key, a.value_text);
    else if (a.value_number != null) m.set(key, a.value_number);
    else if (a.value_json != null) m.set(key, a.value_json as Record<string, unknown>);
  }
  return m;
}

export function buildHtml(data: {
  form: { name: string; version: string | null; unit_code: string | null; header_asset_url: string | null; cover_asset_url?: string | null };
  steps: Array<{
    step: { id: number; title: string; subtitle: string | null };
    sections: Array<{
      section: FormSection;
      questions: Array<{
        question: FormQuestion;
        options: FormQuestionOption[];
        rows: FormQuestionRow[];
      }>;
    }>;
  }>;
  answers: Map<string, string | number | Record<string, unknown>>;
  taskRowsMap?: Map<number, FormQuestionRow>;
  trainerAssessments?: Map<number, string>;
  resultsOffice?: Map<number, { entered_date: string | null; entered_by: string | null }>;
  resultsData?: Map<number, { first_attempt_satisfactory?: string | null; first_attempt_date?: string | null; first_attempt_feedback?: string | null; second_attempt_satisfactory?: string | null; second_attempt_date?: string | null; second_attempt_feedback?: string | null; third_attempt_satisfactory?: string | null; third_attempt_date?: string | null; third_attempt_feedback?: string | null; trainer_name?: string | null; trainer_signature?: string | null; trainer_date?: string | null }>;
  assessmentSummaryData?: Record<string, string | null>;
}): { html: string; unitCode: string; version: string; headerHtml: string } {
  function heightFromWordLimit(wordLimit: number | null | undefined): number {
    if (!wordLimit || wordLimit < 1) return 96;
    const lines = Math.max(1, Math.ceil(wordLimit / 10));
    return Math.min(3000, Math.max(36, lines * 24));
  }
  const { form, steps, answers, taskRowsMap = new Map(), trainerAssessments = new Map(), resultsOffice = new Map(), resultsData = new Map(), assessmentSummaryData = {} } = data;
  // Header images: crest (shield logo) and text logo
  const publicAssets = (data as { _publicDir?: string })._publicDir ?? publicDir;
  let crestImg = form.header_asset_url || '';
  let textImg = '';
  try {
    if (!crestImg) {
      const crestPath = path.join(publicAssets, 'logo-crest.png');
      if (fs.existsSync(crestPath)) {
        const buf = fs.readFileSync(crestPath);
        crestImg = `data:image/png;base64,${buf.toString('base64')}`;
      } else {
        let logoPath = path.join(publicAssets, 'logo.jpeg');
        let mime = 'jpeg';
        if (!fs.existsSync(logoPath)) logoPath = path.join(publicAssets, 'logo.jpg');
        if (!fs.existsSync(logoPath)) {
          logoPath = path.join(publicAssets, 'logo.png');
          mime = 'png';
        }
        if (fs.existsSync(logoPath)) {
          const logoBuf = fs.readFileSync(logoPath);
          crestImg = `data:image/${mime};base64,${logoBuf.toString('base64')}`;
        }
      }
    }
    const textPath = path.join(publicAssets, 'logo-text.png');
    if (fs.existsSync(textPath)) {
      const buf = fs.readFileSync(textPath);
      textImg = `data:image/png;base64,${buf.toString('base64')}`;
    }
  } catch (_e) {}

  let html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    @page { size: A4; margin: 190px 15mm 70px 15mm; }
    @page :first { margin: 0; }
    body { font-family: 'Calibri', 'Calibri Light', Arial, Helvetica, sans-serif; font-size: 12pt; margin: 0; padding: 0; color: #000000; box-sizing: border-box; min-height: 100%; overflow-x: hidden; }
    .header { position: fixed; top: 0; left: 15mm; right: 15mm; width: calc(100% - 30mm); z-index: 1000; background: #fff; padding: 16px 0 16px 0; display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; border-bottom: 1px solid #9ca3af; box-sizing: border-box; overflow: visible; }
    .header-inner { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; width: 100%; gap: 16px; overflow: visible; }
    .header img { max-height: 110px; max-width: 220px; flex-shrink: 0; }
    .header-address { text-align: right; font-size: 8pt; color: #374151; line-height: 1.35; flex-shrink: 0; overflow: visible; padding-left: 12px; }
    .header-address a { color: #2563eb; text-decoration: underline; }
    .divider { height: 1px; background: #9ca3af; margin: 8px 0 14px 0; }
    h2 { font-family: 'Calibri', 'Calibri Light', Arial, Helvetica, sans-serif; font-size: 16pt; font-weight: bold; margin: 0 0 12px 0; color: #000000; border-left: 4px solid #9ca3af; padding-left: 8px; }
    h3 { font-family: 'Calibri', 'Calibri Light', Arial, Helvetica, sans-serif; font-size: 16pt; font-weight: bold; margin: 12px 0 6px 0; color: #000000; }
    .step-page:not(.intro-page) h3 { color: #595959; font-size: 16pt; font-weight: bold; margin: 12px 0 6px 0; }
    .section-table { width: 100%; max-width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 12pt; font-family: 'Calibri', 'Calibri Light', Arial, sans-serif; margin: 0 0 12px 0; border: 1px solid #000; border-left: 1px solid #000 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .section-table th, .section-table td { border: 1px solid #000; padding: 10px 12px; vertical-align: middle; line-height: 1.35; overflow: visible; overflow-wrap: anywhere; word-break: break-word; box-sizing: border-box; }
    .section-table td:first-child, .section-table th:first-child { border-left: 1px solid #000 !important; }
    .section-table tbody tr { page-break-inside: avoid; break-inside: avoid; }
    .sub-section-header { background: #595959 !important; color: #fff !important; font-weight: bold; font-size: 16pt; font-family: 'Calibri', 'Calibri Light', Arial, sans-serif; padding: 10px 12px; vertical-align: middle; }
    .label-cell { width: 35%; background: #F0F4FA; font-weight: 600; color: #374151; }
    .value-cell { width: 65%; color: #000000; background: #F0F4FA; }
    .section-table .label-cell, .section-table .row-alt .label-cell, .section-table .row-normal .label-cell { background: #fff !important; font-weight: normal; color: #000;font-family:'Calibri','Calibri Light',Arial,sans-serif; }
    .section-table .value-cell, .section-table .row-alt .value-cell, .section-table .row-normal .value-cell { background: #fff !important; color: #000; font-size: 12pt; font-family: 'Calibri', 'Calibri Light', Arial, sans-serif; }
    .row-alt .label-cell { color: #000000; background: #F0F4FA; }
    .row-alt .value-cell { color: #000000; background: #F0F4FA; }
    .row-normal .label-cell, .row-normal .value-cell { background: #F0F4FA; }
    .question { margin: 12px 0; overflow: visible; page-break-inside: avoid; break-inside: avoid; }
    .question-label { font-weight: bold; margin-bottom: 4px; overflow: visible; line-height: 1.4; white-space: pre-line; }
    .decl-heading-bar { font-family: 'Calibri', 'Calibri Light', Arial, Helvetica, sans-serif; font-size: 16pt; font-weight: bold; margin: 12px 0 6px 0; color: #000000; border-left: 4px solid #9ca3af; padding-left: 8px; }
    .declarations-section { border: 1px solid #000; border-left: 1px solid #000 !important; padding: 12px; background: #fff; margin-bottom: 12px; }
    .declarations-section.declarations-section-no-border { border: none !important; padding: 0; background: transparent; }
    .declarations-section .question { margin: 10px 0; }
    .declarations-section .question:first-child { padding-top: 0; margin-top: 0; }
    .declarations-section .question-label { font-style: italic; font-weight: 500; }
    .declaration-checkbox { display: inline-flex; align-items: flex-start; gap: 10px; }
    .declaration-checkbox .cb { width: 18px; height: 18px; border: 1px solid #d1d5db; border-radius: 3px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; color: #000000; background: #fff; }
    .declaration-checkbox .cb.checked { color: #000000; }
    /* Assessment Submission Method (point 4): flow after Assessment Tasks when there's room; avoid blank page gap */
    .assessment-submission-page { page-break-before: auto; page-break-inside: avoid; }
    .assessment-submission-section { border: 1px solid #000; padding: 12px; background: #fff; margin-bottom: 12px; }
    .assessment-submission-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 24px; }
    .assessment-submission-item { display: inline-flex; align-items: center; gap: 8px; }
    .assessment-submission-item .cb { width: 18px; height: 18px; border: 1px solid #000; border-radius: 0; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; color: #000000; background: #fff; }
    .assessment-submission-item .cb.checked { background: #000000; color: #fff; }
    .assessment-submission-item .question-label { font-weight: normal; font-style: normal; }
    .assessment-submission-item .cb-inline-input { border: none; border-bottom: 1px solid #333; min-width: 120px; flex: 1; background: transparent; padding: 2px 4px; font-size: 9pt; display: inline-block; }
    .assessment-submission-item.span-full { grid-column: 1 / -1; }
    .assessment-submission-other-block { grid-column: 1 / -1; margin-top: 8px; text-align: center; }
    .assessment-submission-other-block .other-underline { display: block; margin: 0 auto; border: none; border-bottom: 1px solid #333; min-width: 200px; min-height: 18px; background: transparent; }
    .assessment-submission-hint { text-align: center; font-size: 8pt; font-style: italic; color: #6b7280; margin-top: 4px; }
    .reasonable-adjustment-section { border: 1px solid #000; margin-bottom: 12px; }
    .reasonable-adjustment-header { background: #595959 !important; color: #fff !important; font-weight: bold; font-size: 16pt; font-family: 'Calibri', 'Calibri Light', Arial, sans-serif; padding: 10px 12px; display: flex; align-items: center; gap: 8px; }
    .reasonable-adjustment-arrow { font-size: 10pt; }
    .reasonable-adjustment-body { padding: 12px; background: #fff; }
    .reasonable-adjustment-radio { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
    .reasonable-adjustment-section .radio-circle { display: inline-block; width: 12px; height: 12px; border: 1.5px solid #4b5563; border-radius: 50%; }
    .reasonable-adjustment-section .radio-circle.filled { background: #000000; border-color: #000000; }
    .reasonable-adjustment-desc { min-height: 48px; white-space: pre-line; }
    .reasonable-adjustment-sig-row { display: flex; align-items: center; gap: 12px; margin-top: 16px; flex-wrap: wrap; }
    .reasonable-adjustment-sig-label { font-weight: 600; }
    .reasonable-adjustment-sig-line { flex: 1; min-width: 120px; border-bottom: 1px solid #333; min-height: 20px; }
    .reasonable-adjustment-date-label { margin-left: 24px; font-weight: 600; }
    .reasonable-adjustment-date-line { flex: 1; min-width: 80px; border-bottom: 1px solid #333; min-height: 20px; }
    /* Appendix A - Reasonable Adjustments (full layout). Negative margin cancels step-page padding (24px) so Appendix A/B align with Assessment Summary / continued content. */
    .appendix-a-page { page-break-before: always; padding-top: 0; margin-top: -24px; }
    .appendix-b-page { page-break-before: always; padding-top: 0; margin-top: -24px; page-break-inside: auto; }
    /* Keep Appendix B header content and Table A together */
    .appendix-b-content-wrapper { page-break-inside: avoid; orphans: 3; widows: 3; }
    .appendix-b-table-a-wrapper { page-break-before: avoid !important; page-break-after: avoid; page-break-inside: avoid; orphans: 3; widows: 3; }
    .appendix-b-table-b-wrapper { page-break-before: always !important; page-break-inside: avoid; }
    .appendix-b-table-c-wrapper { page-break-before: always !important; page-break-inside: avoid; }
    .learner-eval-grey-bar { width: 100%; height: 40px; background: #595959 !important; margin-top: 20px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .appendix-a-title-bar { background: #595959 !important; color: #ffffff !important; font-weight: bold; font-size: 16pt; font-family: 'Calibri', 'Calibri Light', Arial, sans-serif; padding: 10px 12px; margin: 0 0 8px 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .appendix-section-bar { background: #595959 !important; color: #ffffff !important; font-weight: bold; font-size: 16pt; font-family: 'Calibri', 'Calibri Light', Arial, sans-serif; padding: 8px 12px; margin: 12px 0 6px 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .appendix-matrix-table { width: 100%; border-collapse: collapse; font-size: 8pt; margin: 0 0 10px 0; border: 1px solid #000; }
    .appendix-matrix-table th, .appendix-matrix-table td { border: 1px solid #000; padding: 6px 8px; vertical-align: top; line-height: 1.3; }
    .appendix-matrix-table th { background: #595959 !important; color: #ffffff !important; font-weight: bold; }
    .appendix-matrix-table .appendix-cb { width: 10px; height: 10px; border: 1px solid #000; border-radius: 0; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; font-size: 8px; color: #000000; background: #fff; margin-right: 6px; vertical-align: middle; }
    .appendix-matrix-table .appendix-cb.checked { background: #000000; color: #fff; }
    .appendix-matrix-table .appendix-cell-item { display: flex; align-items: flex-start; gap: 4px; margin: 2px 0; }
    .appendix-declaration-box { border: 1px solid #333; padding: 12px; font-style: italic; margin: 12px 0; line-height: 1.4; background: #fff; }
    .appendix-footer-bar { font-size: 8pt; color: #374151; margin-bottom: 8px; padding: 6px 12px; background: #d9d9d9 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .task-instructions-header { background: #595959 !important; color: #fff !important; font-weight: bold; font-size: 16pt; font-family: 'Calibri', 'Calibri Light', Arial, sans-serif; padding: 12px 16px; margin: 16px 0 0 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; overflow-wrap: break-word; word-wrap: break-word; word-break: break-word; white-space: normal; max-width: 100%; box-sizing: border-box; }
    .task-questions-page { page-break-before: always; }
    .task-questions-header { background: #595959 !important; color: #fff !important; font-weight: bold; font-size: 16pt; font-family: 'Calibri', 'Calibri Light', Arial, sans-serif; padding: 12px 16px; margin: 16px 0 0 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; page-break-after: avoid; break-after: avoid; }
    .task-questions-subheader { font-size: 12pt; color: #000; margin: 0 0 12px 0; padding: 0; background: transparent !important; font-family: 'Calibri', 'Calibri Light', Arial, sans-serif; overflow-wrap: break-word; word-wrap: break-word; word-break: break-word; white-space: normal; page-break-after: avoid; break-after: avoid; }
    .task-questions-instruction-label { font-size: 12pt; color: #000000; margin: 0 0 8px 0; padding: 0; background: transparent !important; font-family: 'Calibri', 'Calibri Light', Arial, sans-serif; }
    .task-instructions-student-label { font-size: 12pt; font-weight: bold; color: #000000; margin: 8px 0 4px 0; padding: 0; background: transparent !important; font-family: 'Calibri', 'Calibri Light', Arial, sans-serif; overflow-wrap: break-word; word-wrap: break-word; word-break: break-word; white-space: normal; }
    .task-instructions-subheader { font-size: 12pt; color: #000000; margin: 0 0 8px 0; padding: 0; background: transparent !important; font-family: 'Calibri', 'Calibri Light', Arial, sans-serif; overflow-wrap: break-word; word-wrap: break-word; word-break: break-word; white-space: normal; max-width: 100%; }
    .task-instructions-block { margin: 12px 0; max-width: 100%; box-sizing: border-box; }
    .task-instructions-block-title { background: #595959 !important; color: #fff !important; font-weight: bold; font-size: 16pt; font-family: 'Calibri', 'Calibri Light', Arial, sans-serif; padding: 8px 12px; overflow-wrap: break-word; word-wrap: break-word; word-break: break-word; white-space: normal; max-width: 100%; box-sizing: border-box; }
    .task-instructions-block-content { padding: 12px; background: #f9fafb; border: 1px solid #e5e7eb; border-top: none; line-height: 1.5; overflow-wrap: break-word; word-wrap: break-word; word-break: break-word; white-space: normal; max-width: 100%; box-sizing: border-box; }
    .task-instructions-block-content ul, .task-instructions-block-content li, .task-instructions-block-content p { overflow-wrap: break-word; word-wrap: break-word; word-break: break-word; white-space: normal; }
    .task-instructions-block-content ul { margin: 8px 0; padding-left: 20px; }
    .task-instructions-block-content p { margin: 6px 0; }
    .result-sheet-page { page-break-before: always; }
    .result-sheet-main { page-break-inside: avoid; break-inside: avoid; }
    .task-results-header { background: #595959 !important; color: #fff !important; font-weight: bold; font-size: 16pt; font-family: 'Calibri', 'Calibri Light', Arial, sans-serif; padding: 12px 16px; margin: 16px 0 0 0; page-break-after: avoid; break-after: avoid; }
    .task-results-outcome { margin: 12px 0; }
    .task-results-outcome-title { font-weight: bold; margin-bottom: 6px; }
    .result-sheet-table { width: 100%; border-collapse: collapse; font-size: 12pt; font-family: 'Calibri', 'Calibri Light', Arial, sans-serif; margin: 0 0 12px 0; border: 1px solid #000; }
    .result-sheet-table td { border: 1px solid #000; padding: 10px 12px; vertical-align: top; line-height: 1.35; }
    .result-sheet-table .result-label { width: 25%; background: #595959 !important; color: #ffffff; font-weight: 600; }
    .result-sheet-table .result-label.decl-office-label { background: #fae6d2 !important;color: #000000;}
    .result-sheet-table .result-value { background: #fff !important; color: #000000; }
    .result-sheet-table .answer-line { border: none; border-bottom: 1px solid #333; min-height: 18px; padding: 2px 4px; background: transparent; display: block; }
    .result-sheet-table .answer-line-inline { border: none; border-bottom: 1px solid #333; min-height: 14px; padding: 0 4px 2px; background: transparent; display: inline-block; min-width: 80px; }
    .result-sheet-table .answer-box { border: 1px solid #333; min-height: 24px; padding: 6px 8px; background: #e5e7eb; display: block; white-space: pre-line; }
    .result-sheet-table .answer-box-large { min-height: 60px; background: #fff; }
    .result-sheet-table .result-radio { display: inline-flex; align-items: center; gap: 6px; margin-right: 16px; }
    .result-sheet-table .result-radio .radio-circle { width: 12px; height: 12px; border: 1.5px solid #374151; border-radius: 50%; flex-shrink: 0; }
    .result-sheet-table .result-radio .radio-circle.filled { background: #000000; border-color: #000000; }
    .result-sheet-table .result-value-declaration { padding-bottom: 8px !important; }
    .result-sheet-table .result-value-declaration ul:last-of-type { margin-bottom: 4px !important; }
    .result-sheet-table .result-value-declaration p:last-child { margin-bottom: 0 !important; }
    .assessment-summary-page { page-break-before: always; page-break-after: always; page-break-inside: avoid; break-inside: avoid; }
    .assessment-summary-wrapper { page-break-inside: avoid; break-inside: avoid; }
    .assessment-summary-tables-wrap { page-break-inside: avoid; break-inside: avoid; }
    .assessment-summary-table.assessment-summary-info { page-break-after: avoid; break-after: avoid; margin-bottom: 4px; }
    .assessment-summary-table.assessment-summary-result { page-break-before: avoid; break-before: avoid; margin-bottom: 0; }
    .assessment-summary-header { background: #595959 !important; color: #fff !important; font-weight: bold; font-size: 16pt; font-family: 'Calibri', 'Calibri Light', Arial, sans-serif; padding: 10px 12px; text-align: center; margin: 0; border: 1px solid #000; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .assessment-summary-intro { background: #fff !important; color: #374151 !important; font-size: 8pt; padding: 6px 10px; margin: 0; line-height: 1.35; border: 1px solid #000; border-top: none; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .assessment-summary-intro .intro-main { font-size: 9pt; font-weight: 600; margin-bottom: 4px; }
    .assessment-summary-table { width: 100%; border-collapse: collapse; font-size: 8pt; margin: 0; border: 1px solid #000; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .assessment-summary-table th, .assessment-summary-table td { border: 1px solid #000; padding: 4px 6px; vertical-align: top; line-height: 1.2; }
    .assessment-summary-table .summary-label { width: 25%; background: #595959 !important; color: #fff !important; font-weight: 600; }
    .assessment-summary-table tbody tr { page-break-inside: avoid; break-inside: avoid; }
    .assessment-summary-table .summary-value { background: #fff !important; color: #000000; white-space: pre-line; }
    .assessment-summary-table .summary-attempt-value { background: #f3f4f6 !important; color: #000000; }
    .assessment-summary-table .summary-result-header { background: #595959 !important; color: #fff !important; font-weight: bold; text-align: center; }
    .assessment-summary-table .summary-attempt-col { width: 25%; text-align: center; }
    .assessment-summary-table .summary-label.summary-office { background: #fae6d2 !important; color: #000000 !important; }
    .assessment-summary-table .summary-value.summary-office { background: #fae6d2 !important; color: #000000 !important; }
    .assessment-summary-table .summary-date-line { border: none; border-bottom: 1px solid #333; min-height: 12px; padding: 0 2px 1px; background: transparent; display: inline-block; min-width: 60px; font-size: 7pt; }
    .assessment-summary-table .summary-cb { width: 12px; height: 12px; border: 1px solid #000; border-radius: 0; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; font-size: 9px; color: #000000; background: #fff; }
    .assessment-summary-table .summary-cb.checked { background: #000000; color: #fff; }
    .decl-table { width: 100%; max-width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 9pt; margin: 0 0 12px 0; border: 1px solid #000; border-left: 1px solid #000 !important; }
    .decl-table td { border: 1px solid #000; padding: 10px 12px; vertical-align: middle; line-height: 1.35; overflow: visible; overflow-wrap: anywhere; word-break: break-word; box-sizing: border-box; }
    .decl-table td:first-child { border-left: 1px solid #000 !important; }
    .decl-table .decl-label { width: 35%; background: #d9d9d9; color: #000000;font-weight: bold; }
    .decl-table .decl-value { background: #fff; color: #000000; white-space: pre-line; }
    .decl-table .decl-sig-value { color: #2563eb; font-style: italic; text-decoration: underline; }
    .decl-table .decl-other-header { background: #595959 !important; color: #fff !important; font-weight: bold; padding: 10px 12px; vertical-align: middle; }
    .decl-table .decl-office-label { font-style: italic; }
    .decl-sig-heading { font-size: 10pt; font-weight: bold; margin: 12px 0 6px 0; color: #000000; }
    .decl-sig-inline-block { margin-bottom: 12px; }
    .decl-sig-inline { margin: 10px 0; font-size: 11pt; }
    .decl-sig-inline .decl-sig-label { font-weight: normal; margin-right: 8px; }
    .decl-sig-inline .decl-sig-line { display: inline-block; border: none; border-bottom: 1px solid #000; min-width: 280px; min-height: 18px; background: transparent; vertical-align: bottom; padding: 0 2px 2px 0; }
    .assessment-summary-page .answer-box { min-height: 18px; padding: 4px 6px; font-size: 8pt; }
    .assessment-summary-page .answer-box.answer-box-large { min-height: 40px; }
    .answer-box { border: 1px solid #333; min-height: 24px; padding: 6px 8px; overflow: visible; background: #fff; white-space: pre-line; max-width: 100%; box-sizing: border-box; overflow-wrap: anywhere; word-break: break-word; }
    .answer-box.answer-box-large { min-height: 80px; }
    table { width: 100%; max-width: 100%; border-collapse: collapse; font-size: 8pt; margin-bottom: 12px; }
    th, td { border: 1px solid #000; padding: 10px 12px; vertical-align: middle; line-height: 1.35; overflow: visible; overflow-wrap: anywhere; word-break: break-word; box-sizing: border-box; }
    th { background: #595959; color: #fff; font-weight: bold; }
    tbody tr:nth-child(even) { background: #f9fafb; }
    tbody tr:nth-child(odd) { background: #fff; }
    .likert-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 8pt; font-family: 'Calibri', 'Calibri Light', Arial, sans-serif; margin: 0 0 8px 0; border: 1px solid #000; border-left: 1px solid #000 !important; }
    .likert-table th, .likert-table td { border: 1px solid #000; padding: 6px 8px; vertical-align: middle; line-height: 1.25; overflow: visible; font-size: 11pt; font-family: 'Calibri', 'Calibri Light', Arial, sans-serif; }
    .likert-table th:first-child, .likert-table td:first-child { border-left: 1px solid #000 !important; }
    .likert-header { background: #595959 !important; color: #fff !important; font-weight: bold; }
    .likert-no { width: 4%; text-align: center; font-weight: 600; vertical-align: middle; font-size: 11pt; }
    .likert-criteria { width: 50%; font-weight: 600; vertical-align: middle; font-size: 11pt; word-wrap: break-word; }
    .likert-scale { width: 9.2%; height: 100px; padding: 6px 3px; overflow: visible; font-size: 8pt; box-sizing: border-box; vertical-align: middle; }
    .likert-scale-inner { display: flex; align-items: center; justify-content: center; width: 100%; min-height: 100%; overflow: visible; }
    .likert-scale-inner span { display: inline-block; transform: rotate(-90deg); transform-origin: center center; white-space: normal; line-height: 1.15; text-align: center; }
    .likert-section-row td { background: #595959 !important; color: #fff !important; font-weight: bold; font-size: 11pt; font-family: 'Calibri', 'Calibri Light', Arial, sans-serif; }
    /* Keep likert table and its comments box on same page */
    .likert-table-with-comments { page-break-inside: avoid; }
    .likert-table tbody .likert-no { background: #e5e7eb !important; color: #000000; }
    .likert-table tbody .likert-criteria { background: #e5e7eb !important; color: #000000; }
    .likert-table tbody .row-alt .likert-no { background: #f3f4f6 !important; }
    .likert-table tbody .row-alt .likert-criteria { background: #f3f4f6 !important; }
    .likert-radio { text-align: center; background: #fff !important; }
    .likert-table tbody .row-alt .likert-radio { background: #f9fafb !important; }
    .radio-circle { display: inline-block; width: 12px; height: 12px; border: 1.5px solid #4b5563; border-radius: 50%; }
    .radio-circle.filled { background: #000000; border-color: #000000; }
    .signature-img { max-width: 150px; max-height: 60px; display: block; }
    .grid-table-no-border { width: 100%; max-width: 100%; table-layout: fixed; }
    .grid-table-no-border th, .grid-table-no-border td { border: 1px solid #000 !important; overflow-wrap: anywhere; word-break: break-word; box-sizing: border-box; }
    .grid-table-no-border th { background: #595959 !important; color: #ffffff !important; font-weight: 700; border: 1px solid #000 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .grid-table-no-border tbody tr { background: transparent !important; }
    .grid-table-no-border .label-cell, .grid-table-no-border .value-cell { background: transparent !important; white-space: pre-line; }
    .grid-table-no-border .sub-section-header { background: transparent !important; color: #000000 !important; border: 1px solid #000 !important; }
${ASSESSMENT_QUESTION_BLOCK_CSS}
${WRITTEN_EVIDENCE_CSS}
    .step-page { page-break-after: always; }
    .section-table, .likert-table, .assessment-tasks-table { page-break-inside: auto; }
    .decl-table, .result-sheet-table, .assessment-summary-table { page-break-inside: avoid; }
    .step-page:first-child { padding-top: 20px; }
    .step-page:not(:first-child) { padding-top: 24px; }
    .intro-page h2.intro-title { color: #595959; font-size: 24pt; font-weight: bold; font-family:'Calibri','Calibri Light',Arial,sans-serif; margin: 0 0 16px 0; border-left: none; padding-left: 0; }
    .intro-page h3 { color: #595959; font-weight: normal; font-size: 24pt; font-family:'Calibri','Calibri Light',Arial,sans-serif; margin: 16px 0 8px 0; }
    .intro-page h4 { font-weight: bold;font-size: 11pt;font-family:'Calibri','Calibri Light',Arial,sans-serif; margin: 12px 0 6px 0; color: #000000; }
    .intro-page p { margin: 0 0 12px 0; line-height: 1.5; }
    .intro-page ul { margin: 0 0 12px 0; padding-left: 20px; }
    .intro-page li { margin-bottom: 6px; line-height: 1.5; }
    .step-page:last-child { page-break-after: auto; }
    /* Prevent awkward breaks that could push content into footer */
    p, .intro-page p, .declarations-section { orphans: 2; widows: 2; }
    /* COVER PAGE ONLY */
    .cover-page{
      position: relative;
      z-index: 1001;
      width: 210mm;
      height: 297mm;
      page-break-after: always;
      overflow: visible;
      background: #b0b8c0;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
      margin: 0;
    }

    /* hero image area */
    .cover-image{
      position:absolute;
      top:0; left:0; right:0;
      height: 260mm;
      background-size: cover;
      background-position: center;
      background-repeat:no-repeat;
      z-index: 1;
    }

    /* logo on top-left */
    .cover-logo{
      position:absolute;
      top: 12mm;
      left: 12mm;
      z-index: 6;
    }
    .cover-logo img{
      max-height: 85px;
      max-width: 150px;
      display:block;
    }

    /* STUDENT WORKBOOK band (overlay on image) */
    .cover-band{
      position:absolute;
      left:0; right:0;
      top: 114mm;
      height: 18mm;
      background: #9ca3af;
      border-top: 2px solid #fff;
      border-bottom: 2px solid #fff;
      display:flex;
      align-items:center;
      justify-content:center;
      z-index: 5;
    }
    .cover-band h1{
      margin:0;
      font-size: 22pt;
      font-weight: 800;
      color: #1a3a5c;
      letter-spacing: 0.14em;
    }

    /* WAVE sits ON TOP of image and visually becomes the "cut" */
    .cover-wave{
      position:absolute;
      left:0; right:0;
      top: 155mm;
      height: 55mm;
      z-index: 4;
      pointer-events:none;
    }
    .cover-wave svg{
      width:100%;
      height:100%;
      display:block;
    }

    /* grey area must START EXACTLY at the same top as wave container,
      wave path itself fills grey so there is NO seam line */
    .cover-grey{
      position:absolute;
      left:0; right:0;
      top: 210mm;
      bottom:0;
      background:#b0b8c0;
      z-index: 2;
    }
    /* unit text in grey area - single line, no background on code */
    .cover-unit{
      position:absolute;
      left: 15mm; right: 15mm;
      top: 225mm;
      text-align:center;
      z-index: 7;
    }
    .cover-unit-text{
      font-size: 17pt;
      font-weight: 800;
      color:#fff;
      line-height: 1.2;
    }

    /* student table box */
    .cover-student-box{
      position:absolute;
      left: 15mm; right: 15mm;
      bottom: 18mm;
      background:#fff;
      border: 1px solid #000;
      z-index: 7;
    }
    .cover-student-table{
      width:100%;
      border-collapse: collapse;
      table-layout: fixed;
      font-size: 11pt;
    }
    .cover-student-table td{
      border: 1px solid #000;
      padding: 6px 10px;
      vertical-align: middle;
    }
    .cover-student-label{
      width: 42mm;
      background:#e5e7eb;
      font-weight: 800;
    }
    .cover-student-line{
      display:inline-block;
      width: 100%;
      border-bottom: 1px solid #000;
      min-height: 14px;
    }

  </style>
</head>
<body>
`;

  // Group steps: put Student & Trainer + Qualification & Unit on the same page
  const isStudentTrainerStep = (s: { title: string }) => /student/i.test(s.title) && /trainer/i.test(s.title);
  const isQualificationStep = (s: { title: string }) => /qualification/i.test(s.title);
  const pageGroups: Array<typeof steps> = [];
  for (let i = 0; i < steps.length; i++) {
    const curr = steps[i];
    const next = steps[i + 1];
    if (next && isStudentTrainerStep(curr.step) && isQualificationStep(next.step)) {
      pageGroups.push([curr, next]);
      i++;
    } else {
      pageGroups.push([curr]);
    }
  }

  const codeToValue = new Map<string, string | number | Record<string, unknown>>();
  for (const g of pageGroups) {
    for (const { sections } of g) {
      for (const { questions } of sections) {
        for (const { question } of questions) {
          if (question.code) {
            const v = answers.get(`q-${question.id}`);
            if (v != null) codeToValue.set(question.code, v);
          }
        }
      }
    }
  }

  const formExt = form as { qualification_code?: string | null; qualification_name?: string | null; unit_name?: string | null };
  if (!codeToValue.has('qualification.code') && formExt.qualification_code) codeToValue.set('qualification.code', formExt.qualification_code);
  if (!codeToValue.has('qualification.name') && formExt.qualification_name) codeToValue.set('qualification.name', formExt.qualification_name);
  if (!codeToValue.has('unit.code') && form.unit_code) codeToValue.set('unit.code', form.unit_code);
  if (!codeToValue.has('unit.name') && formExt.unit_name) codeToValue.set('unit.name', formExt.unit_name);

  const unitCode = String(codeToValue.get('unit.code') ?? form.unit_code ?? '');
  const unitTitle = String(codeToValue.get('unit.name') ?? codeToValue.get('qualification.name') ?? formExt.unit_name ?? formExt.qualification_name ?? '');
  const studentName = String(codeToValue.get('student.fullName') ?? '');
  const studentId = String(codeToValue.get('student.id') ?? '');
  const coverImg = (form as { cover_asset_url?: string | null }).cover_asset_url || '';

  const coverImageStyle = coverImg ? `background-image:url('${coverImg}')` : 'background:linear-gradient(180deg,#5a6a7a 0%,#3d4a5a 100%)';

  const unitText = [unitCode || 'Unit Code', unitTitle || form.name || 'Unit Title'].filter(Boolean).join(' ');

  const headerHtml = `
    <div style="position:relative;width:100%;min-height:165px;box-sizing:border-box;font-family:'Calibri','Calibri Light',Arial,sans-serif;font-weight:400;line-height:1.05;">
      <div style="height:165px;min-height:165px;width:0;overflow:hidden;pointer-events:none;"></div>
      <div style="position:absolute;left:15mm;right:15mm;top:110px;border-top:1px solid #8b95a5;z-index:0;"></div>
      <div style="position:absolute;left:15mm;top:0px;z-index:1;">${crestImg ? `<img src="${crestImg}" alt="Skyline Institute of Technology" style="width:210px;height:165px;object-fit:contain;display:block;" />` : ''}</div>
      <div style="position:absolute;left:50%;top:18px;transform:translateX(-50%);z-index:1;">${textImg ? `<img src="${textImg}" alt="SKYLINE INSTITUTE OF TECHNOLOGY" style="height:100px;width:auto;object-fit:contain;display:block;" />` : '<div style="display:flex;flex-direction:column;align-items:center;"><span style="font-size:22pt;font-weight:700;color:#f97316;letter-spacing:2px;">SKYLINE</span><span style="font-size:9pt;font-weight:600;color:#374151;letter-spacing:2px;margin-top:2px;">INSTITUTE OF TECHNOLOGY</span></div>'}</div>
      <div style="position:absolute;right:15mm;top:8px;width:240px;font-size:10pt;font-family:'Calibri','Calibri Light',Arial,sans-serif;color:#374151;text-align:right;line-height:1.25;font-weight:300;z-index:1;">
        Level 8, 310 King Street<br/>Melbourne VIC – 3000<br/>RTO: 45989 CRICOS: 04114B<br/>Email: <a href="mailto:info@slit.edu.au" style="color:#2563eb;text-decoration:underline;">info@slit.edu.au</a><br/>Phone: +61 3 9125 1661
      </div>
    </div>
  `;

  html += `<div class="cover-page">
  <div class="cover-image" style="${coverImageStyle}"></div>

  <div class="cover-logo">
    ${crestImg ? `<img src="${crestImg}" alt="Skyline" />` : ''}
  </div>

  <div class="cover-band"><h1>STUDENT WORKBOOK</h1></div>

  <div class="cover-grey"></div>

  <div class="cover-wave">
    <svg viewBox="0 0 1200 300" preserveAspectRatio="none">
      <path fill="#b0b8c0"
        d="M0,70
          C300,70 350,240 600,230
          C850,240 1150,70 1200,70
          L1200,300 L0,300 Z"/>
      </svg>
  </div>

  <div class="cover-unit">
    <div class="cover-unit-text">${unitText}</div>
  </div>

  <div class="cover-student-box">
    <table class="cover-student-table">
      <tr>
        <td class="cover-student-label">Student Name:</td>
        <td><span class="cover-student-line">${studentName || ''}</span></td>
      </tr>
      <tr>
        <td class="cover-student-label">Student ID:</td>
        <td><span class="cover-student-line">${studentId || ''}</span></td>
      </tr>
    </table>
  </div>
</div>
`;

  // Introduction page (before student details) - shown in every form
  html += `<div class="step-page intro-page">
  <h2 class="intro-title">Student Pack</h2>
  <h3>What is the purpose of this document?</h3>
  <p>The Student Pack is the document you, the student, needs to complete to demonstrate competency. This document includes the context and conditions of your assessment, the tasks to be completed by you and an outline of the evidence to be gathered.</p>
  <h4>The information includes the following:</h4>
  <ul>
    <li>Information related to the unit of competency.</li>
    <li>Guidelines and instructions to complete each task and activity.</li>
    <li>A student evaluation form</li>
  </ul>
  <h4>Student Evaluation Form</h4>
  <p>These documents are designed after conducting thorough industry consultation. Students are encouraged to evaluate this document and provide constructive feedback to their training organisation if they feel that this document can be improved.</p>
  <h4>Link to other unit documents</h4>
  <ul>
    <li>The Student Pack is a document for students to complete to demonstrate their competency. This document includes context and conditions of assessment, tasks to be administered to the student, and an outline of the evidence to be gathered from the student.</li>
    <li>The Unit Mapping is a document that contains information and comprehensive mapping with the training package requirements.</li>
  </ul>
</div>
`;

  const formHasAppendixA = steps.some((g) => /Appendix\s*A/i.test((g.step?.title ?? '').trim()));
  let headerNum = 1;
  for (const group of pageGroups) {
    html += `<div class="step-page">`;
    for (const { step, sections } of group) {
      const isLearnerEvaluation = (step?.title || '').trim() === 'Learner Evaluation';
      let learnerEvalIntroShown = false;
      const learnerEvalLikertSections = isLearnerEvaluation ? sections.filter(s => s.section.pdf_render_mode === 'likert_table').sort((a, b) => b.section.sort_order - a.section.sort_order) : [];
      const lastLikertSectionId = learnerEvalLikertSections.length > 0 ? learnerEvalLikertSections[0].section.id : null;
      for (const { section, questions } of sections) {
      /* Skip Written Evidence Checklist section when no question has rows - avoids blank header (matches live /pdf) */
      if (
        isWrittenEvidenceChecklistSection(section.pdf_render_mode, questions) &&
        getWrittenEvidenceChecklistQuestions(section.pdf_render_mode, questions).length === 0
      ) {
        continue;
      }
      if (isLearnerEvaluation && !learnerEvalIntroShown) {
        html += '<div class="appendix-b-page">';
        html += '<div class="appendix-b-content-wrapper">';
        html += '<div class="appendix-a-title-bar" style="text-align:center">Appendix B - Learner Evaluation Form</div>';
        html += '<p style="margin:8px 0;line-height:1.4;font-size:11pt">Please complete this evaluation form as thoroughly as you can, in order for us to continuously improve our training quality. The purpose of the evaluation form is to evaluate the areas below:</p>';
        html += '<ul style="margin:0 0 8px 0;padding-left:20px;line-height:1.4;font-size:11pt">';
        html += '<li>logistics and support</li>';
        html += '<li>facilitation</li>';
        html += '<li>training material</li>';
        html += '<li>assessment</li>';
        html += '</ul>';
        html += '<p style="margin:0 0 10px 0;line-height:1.4;font-size:11pt">Your honest and detailed input is therefore of great value to us, and we appreciate your assistance in completing this evaluation form!</p>';
        learnerEvalIntroShown = true;
      }
      /* Only increment headerNum when we output a visible numbered section. Reasonable Adjustment (Appendix A) has no number; inline Reasonable Adjustment handles its own increment below. */
      /* assessment_submission: wrap label + content so both move to new page together */
      if (section.pdf_render_mode === 'assessment_submission') {
        html += `<div class="assessment-submission-page">`;
        html += `<h3>${headerNum}. ${section.title}</h3>`;
        headerNum++;
        if (section.description) html += `<p>${section.description}</p>`;
      } else if (section.pdf_render_mode !== 'declarations' && section.pdf_render_mode !== 'reasonable_adjustment' && section.pdf_render_mode !== 'task_instructions' && section.pdf_render_mode !== 'additional_instructions' && section.pdf_render_mode !== 'task_results' && section.pdf_render_mode !== 'task_questions' && section.pdf_render_mode !== 'task_written_evidence_checklist' && section.pdf_render_mode !== 'assessment_summary' && section.title !== 'Assessment Summary Sheet' && !isLearnerEvaluation) {
        html += `<h3>${headerNum}. ${section.title}</h3>`;
        headerNum++;
        if (section.description) html += `<p>${section.description}</p>`;
      }

      if (isLearnerEvaluation && section.title === 'Participant Information') {
        html += '<table class="section-table" style="margin-bottom:10px;width:100%"><tbody>';
        const participantQs = questions.filter(q => q.question.type === 'short_text').sort((a, b) => a.question.sort_order - b.question.sort_order);
        const leftQs = participantQs.slice(0, 3);
        const rightQs = participantQs.slice(3, 6);
        const studentFullName = String(codeToValue.get('student.fullName') ?? '');
        const trainerFullName = String(codeToValue.get('trainer.fullName') ?? '');
        for (let i = 0; i < 3; i++) {
          const leftQ = leftQs[i];
          const rightQ = rightQs[i];
          let leftVal = leftQ ? String(answers.get(`q-${leftQ.question.id}`) ?? '') : '';
          let rightVal = rightQ ? String(answers.get(`q-${rightQ.question.id}`) ?? '') : '';
          if (leftQ?.question.code === 'evaluation.studentName' && leftVal.length <= 1 && studentFullName) leftVal = studentFullName;
          if (leftQ?.question.code === 'evaluation.trainerName' && leftVal.length <= 1 && trainerFullName) leftVal = trainerFullName;
          html += '<tr>';
          html += `<td class="label-cell" style="width:25%;background:#595959 !important;color:#fff !important;font-weight:600;border:1px solid #000">${leftQ?.question.label || ''}</td>`;
          html += `<td class="value-cell" style="width:25%;background:#fff;border:1px solid #000">${leftVal}</td>`;
          html += `<td class="label-cell" style="width:25%;background:#595959 !important;color:#fff !important;font-weight:600;border:1px solid #000">${rightQ?.question.label || ''}</td>`;
          html += `<td class="value-cell" style="width:25%;background:#fff;border:1px solid #000">${rightVal}</td>`;
          html += '</tr>';
        }
        html += '</tbody></table>';
      } else if (section.pdf_render_mode === 'likert_table') {
        // For Learner Evaluation: A (sort_order=1) stays with Appendix B header (no break), B (sort_order=2) and C (sort_order=3) each get their own page
        const isSectionA = isLearnerEvaluation && section.sort_order === 1;
        const isSectionB = isLearnerEvaluation && section.sort_order === 2;
        const isSectionC = isLearnerEvaluation && section.sort_order === 3;
        const isLastSection = isLearnerEvaluation && section.id === lastLikertSectionId;
        
        // Structure: content-wrapper contains header + Table A, then Table B and C get separate pages
        if (isSectionA) {
          // Table A stays in content-wrapper - no page break, keep together with header
          html += `<div class="appendix-b-table-a-wrapper" style="margin-bottom:12px;page-break-before:avoid !important;page-break-inside:avoid;">`;
        } else {
          // Table B/C: content-wrapper should already be closed after Table A
          // Determine wrapper class for B and C with explicit page breaks
          let wrapperClass = '';
          let inlineStyle = 'margin-bottom:12px;';
          if (isSectionB) {
            wrapperClass = 'appendix-b-table-b-wrapper';
            inlineStyle += 'page-break-before:always !important;page-break-inside:avoid;';
          } else if (isSectionC) {
            wrapperClass = 'appendix-b-table-c-wrapper';
            inlineStyle += 'page-break-before:always !important;page-break-inside:avoid;';
          }
          html += `<div class="${wrapperClass}" style="${inlineStyle}">`;
        }
        const scaleLabels = ['Strongly<br/>Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly<br/>Agree'];
        html += '<div class="likert-table-with-comments">';
        html += '<table class="likert-table"><thead><tr>';
        html += '<th class="likert-header likert-no">No.</th><th class="likert-header likert-criteria">Criteria/Question</th>';
        for (const lbl of scaleLabels) html += `<th class="likert-header likert-scale"><div class="likert-scale-inner"><span>${lbl}</span></div></th>`;
        html += '</tr><tr class="likert-section-row">';
        const sectionLetter = section.sort_order >= 1 ? String.fromCharCode(64 + section.sort_order) : '';
        const sectionTitleText = sectionLetter ? `${sectionLetter}. ${section.title}` : section.title;
        html += `<td class="likert-no">${sectionLetter}</td><td colspan="6" class="likert-section-title">${sectionTitleText}</td>`;
        html += '</tr></thead><tbody>';
        let rowNum = 1;
        for (const { question, rows } of questions) {
          if (question.type === 'likert_5') {
            for (const row of rows) {
              const key = `q-${question.id}-${row.id}`;
              const val = answers.get(key);
              const sel = val != null ? String(val) : '';
              const rowClass = rowNum % 2 === 0 ? 'row-alt' : 'row-normal';
              html += `<tr class="${rowClass}"><td class="likert-no">${rowNum}</td><td class="likert-criteria">${row.row_label}</td>`;
              for (let i = 1; i <= 5; i++) {
                const filled = sel === String(i);
                html += `<td class="likert-radio"><span class="radio-circle${filled ? ' filled' : ''}"></span></td>`;
              }
              html += '</tr>';
              rowNum++;
            }
          }
        }
        html += '</tbody></table>';
        const commentsQ = questions.find(q => q.question.type === 'long_text' && q.question.code?.includes('Comments'));
        if (commentsQ) {
          const commentsRaw = answers.get(`q-${commentsQ.question.id}`);
          const commentsVal = formatShortLongAnswerCellHtml(commentsRaw as string | number | Record<string, unknown> | undefined);
          html += `<div class="question" style="margin-top:8px;font-family:'Calibri','Calibri Light',Arial,sans-serif;font-size:11pt"><div class="question-label" style="font-weight:600;margin-bottom:4px">${commentsQ.question.label}</div>`;
          html += `<div class="answer-box answer-box-large" style="min-height:50px;font-size:11pt">${commentsVal}</div></div>`;
        }
        html += '</div>'; // close likert-table-with-comments
        // Add grey bar inside the wrapper for C so it stays on same page
        if (isLastSection) {
          html += '<div class="learner-eval-grey-bar"></div>';
        }
        html += '</div>'; // Close table wrapper
        
        // Close content-wrapper after Table A
        if (isSectionA) {
          html += '</div>'; // Close appendix-b-content-wrapper
        }
      } else if (section.pdf_render_mode === 'grid_table') {
        const pm = (questions[0]?.question?.pdf_meta as Record<string, unknown>) || {};
        const cols = (Array.isArray(pm.columns) ? pm.columns : ['Column 1', 'Column 2']) as string[];
        const columnTypes = (pm.columnTypes as string[]) || cols.map(() => 'answer');
        const layout = (pm.layout as string) || 'no_image';
        const isSplit = layout === 'split' || layout === 'polygon';
        const isNoImage = layout === 'no_image';
        const firstCol = (pm.firstColumnLabel as string) || (isNoImage ? 'Item' : layout === 'polygon' ? 'Polygon Name' : layout === 'default' ? 'Shape' : 'Name');
        const secondCol = (pm.secondColumnLabel as string) || (isNoImage ? 'Description' : layout === 'polygon' ? 'Polygon Shape' : 'Image');
        html += '<table class="grid-table-no-border"><thead><tr>';
        if (isSplit) {
          html += `<th>${secondCol}</th>`;
        } else if (isNoImage) {
          html += `<th>${firstCol}</th><th>${secondCol}</th>`;
        } else {
          html += `<th>${firstCol}</th>`;
        }
        for (const c of cols) html += `<th>${c}</th>`;
        html += '</tr></thead><tbody>';
        for (const { question, rows } of questions) {
          for (const row of rows) {
            const key = `q-${question.id}-${row.id}`;
            const val = answers.get(key) as Record<string, string> | undefined;
            html += '<tr>';
            if (isSplit) {
              html += `<td>${row.row_image_url ? `${gridRowImgHtml(row.row_image_url)}<br/>${row.row_label}` : row.row_label}</td>`;
            } else if (isNoImage) {
              html += `<td>${row.row_label}</td>`;
              html += `<td>${row.row_help || '—'}</td>`;
            } else {
              html += `<td>${row.row_image_url ? `${gridRowImgHtml(row.row_image_url)}<br/>${row.row_label}` : row.row_label}</td>`;
            }
            for (let i = 0; i < cols.length; i++) {
              const colType = columnTypes[i] === 'question' ? 'question' : 'answer';
              const cellVal = colType === 'question' ? (row.row_help || '—') : (val && typeof val === 'object' ? (val[`r${row.id}_c${i}`] || '') : '');
              html += `<td>${cellVal}</td>`;
            }
            html += '</tr>';
          }
        }
        html += '</tbody></table>';
      } else if (section.pdf_render_mode === 'assessment_tasks') {
        const taskQuestion = questions.find((q) => q.question.type === 'grid_table' && q.rows.length > 0);
        if (taskQuestion) {
          html += '<table class="section-table assessment-tasks-table">';
          html += '<thead><tr><th class="sub-section-header">Evidence number</th><th class="sub-section-header">Assessment method/ Type of evidence</th></tr></thead><tbody>';
          let rowIdx = 0;
          for (const row of taskQuestion.rows) {
            const rowClass = rowIdx++ % 2 === 0 ? 'row-normal' : 'row-alt';
            const methodText = (row.row_help || '').replace(/\n/g, '<br/>');
            html += `<tr class="${rowClass}"><td class="label-cell">${row.row_label}</td><td class="value-cell">${methodText}</td></tr>`;
          }
          html += '</tbody></table>';
        }
      } else if (section.pdf_render_mode === 'assessment_submission') {
        const multiChoice = questions.find((q) => q.question.type === 'multi_choice');
        const otherDescQ = questions.find((q) => q.question.type === 'short_text');
        const otherDescVal = otherDescQ
          ? formatShortLongAnswerCellHtml(answers.get(`q-${otherDescQ.question.id}`) as string | number | Record<string, unknown> | undefined)
          : '';
        const mcVal = multiChoice ? answers.get(`q-${multiChoice.question.id}`) : undefined;
        const selected = new Set(Array.isArray(mcVal) ? (mcVal as string[]) : []);
        const opts = multiChoice?.options ?? [];
        html += '<div class="assessment-submission-section">';
        html += '<div class="assessment-submission-grid">';
        for (let i = 0; i < opts.length; i++) {
          const opt = opts[i];
          const checked = selected.has(opt.value);
          const isOther = opt.value === 'other';
          const isLms = /lms|learning management/i.test(opt.label);
          const itemClass = 'assessment-submission-item' + (isLms || isOther ? ' span-full' : '');
          html += `<div class="${itemClass}">`;
          html += `<span class="cb ${checked ? 'checked' : ''}">${checked ? '✓' : ''}</span>`;
          html += `<span class="question-label">${opt.label}</span>`;
          if (isOther) {
            html += `<span class="cb-inline-input">${otherDescVal}</span>`;
          }
          html += '</div>';
        }
        html += '<div class="assessment-submission-other-block">';
        html += '<div class="other-underline"></div>';
        html += '<div class="assessment-submission-hint">(Please describe here)</div>';
        html += '</div>';
        html += '</div>';
        html += '</div>';
        html += '</div>'; /* close assessment-submission-page */
      } else if (section.pdf_render_mode === 'additional_instructions') {
        const instr = (section as { instructions_meta?: Record<string, unknown> | null }).instructions_meta as Record<string, unknown> | null | undefined;
        html += `<div class="task-instructions-header">${String(section.title || 'Additional Instructions').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`;
        html += `<div class="task-instructions-student-label">Student Instructions</div>`;
        const renderInstructionImage = (block: Record<string, unknown>) => {
          const imageUrl = String(block.imageUrl || '').trim();
          if (!imageUrl) return '';
          const img = `<img src="${escapeImgSrc(imageUrl, 'instruction-image')}" alt="" loading="eager" style="max-width:100%;height:auto;object-fit:contain;border:1px solid #e5e7eb;border-radius:6px;" />`;
          return `<div style="margin:10px 0 8px 0">${img}</div>`;
        };
        if (instr) {
          const customBlocks = Array.isArray((instr as { blocks?: unknown[] }).blocks)
            ? ((instr as { blocks?: Array<{ id?: string; type?: string; heading?: string; content?: string; columnHeaders?: string[]; rows?: Array<{ heading?: string; content?: string; cells?: string[] }> }> }).blocks || [])
            : [];
          for (const b of customBlocks) {
            const heading = String(b.heading || '').trim();
            const bRec = b as unknown as Record<string, unknown>;
            if (b.type === 'table') {
              if (heading) html += `<div class="task-instructions-block-title">${heading.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`;
              const rows = Array.isArray(b.rows) ? b.rows : [];
              const columnHeaders = Array.isArray(b.columnHeaders) ? b.columnHeaders : [];
              if (rows.length > 0) {
                const imgHtml = renderInstructionImage(bRec);
                html += '<table class="section-table task-instructions-table">';
                if (columnHeaders.length > 0) {
                  html += '<thead><tr>';
                  for (const h of columnHeaders) {
                    html += `<th class="label-cell" style="font-weight:700;border:1px solid #000;padding:6px 8px;text-align:left">${String(h).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</th>`;
                  }
                  html += '</tr></thead>';
                }
                html += '<tbody>';
                for (const r of rows) {
                  const cells = (r as { cells?: string[] }).cells;
                  if (Array.isArray(cells) && cells.length > 0) {
                    html += '<tr>';
                    for (const c of cells) {
                      html += `<td class="value-cell" style="border:1px solid #000;padding:6px 8px">${String(c ?? '')}</td>`;
                    }
                    html += '</tr>';
                  } else {
                    html += '<tr>';
                    html += `<td class="label-cell" style="width:35%;font-weight:700;border:1px solid #000;padding:6px 8px">${String((r as { heading?: string }).heading || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</td>`;
                    html += `<td class="value-cell" style="border:1px solid #000;padding:6px 8px">${String((r as { content?: string }).content || '')}</td>`;
                    html += '</tr>';
                  }
                }
                html += '</tbody></table>';
                if (imgHtml) html += imgHtml;
              }
            } else if (String((b as { content?: string }).content || '').replace(/<[^>]*>/g, '').trim()) {
              if (heading) html += `<div class="task-instructions-block-title">${heading.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`;
              const imgHtml = renderInstructionImage(bRec);
              html += `<div class="task-instructions-block-content">${String((b as { content?: string }).content || '')}</div>`;
              if (imgHtml) html += imgHtml;
            }
          }
        }
      } else if (section.pdf_render_mode === 'task_instructions') {
        const rowId = section.assessment_task_row_id;
        const row = rowId ? taskRowsMap.get(rowId) : null;
        const instr = row?.row_meta?.instructions as Record<string, string | string[] | undefined> | undefined;
        const assessmentType = instr?.assessment_type ? String(instr.assessment_type).replace(/<[^>]*>/g, '').trim() || 'Assessment' : 'Assessment';
        html += `<div class="task-instructions-header">${row?.row_label || section.title} – ${assessmentType}</div>`;
        html += `<div class="task-instructions-student-label">Student Instructions</div>`;
        html += `<div class="task-instructions-subheader">Assessment method-based instructions and guidelines: ${row?.row_help || ''}</div>`;
        if (instr) {
          const customBlocks = Array.isArray((instr as { blocks?: unknown[] }).blocks)
            ? ((instr as { blocks?: Array<{ id?: string; type?: string; heading?: string; content?: string; columnHeaders?: string[]; rows?: Array<{ heading?: string; content?: string; cells?: string[] }> }> }).blocks || [])
            : [];
          const renderInstructionImage = (block: Record<string, unknown>) => {
            const imageUrl = String(block.imageUrl || '').trim();
            if (!imageUrl) return '';
            const img = `<img src="${escapeImgSrc(imageUrl, 'instruction-image')}" alt="" loading="eager" style="max-width:100%;height:auto;object-fit:contain;border:1px solid #e5e7eb;border-radius:6px;" />`;
            return `<div style="margin:10px 0 8px 0">${img}</div>`;
          };

          if (customBlocks.length > 0) {
            for (const b of customBlocks) {
              const heading = String((b as { heading?: string }).heading || '').trim();
              const bRec = b as unknown as Record<string, unknown>;
              if ((b as { type?: string }).type === 'table') {
                if (heading) html += `<div class="task-instructions-block-title">${heading.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`;
                const rows = Array.isArray((b as { rows?: unknown[] }).rows) ? ((b as { rows?: Array<{ heading?: string; content?: string; cells?: string[] }> }).rows || []) : [];
                const columnHeaders = Array.isArray((b as { columnHeaders?: unknown[] }).columnHeaders) ? ((b as { columnHeaders?: string[] }).columnHeaders || []) : [];
                if (rows.length > 0) {
                  const imgHtml = renderInstructionImage(bRec);
                  html += '<table class="section-table task-instructions-table">';
                  if (columnHeaders.length > 0) {
                    html += '<thead><tr>';
                    for (const h of columnHeaders) {
                      html += `<th class="label-cell" style="font-weight:700;border:1px solid #000;padding:6px 8px;text-align:left">${String(h).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</th>`;
                    }
                    html += '</tr></thead>';
                  }
                  html += '<tbody>';
                  for (const r of rows) {
                    const cells = (r as { cells?: string[] }).cells;
                    if (Array.isArray(cells) && cells.length > 0) {
                      html += '<tr>';
                      for (const c of cells) {
                        html += `<td class="value-cell" style="border:1px solid #000;padding:6px 8px">${String(c ?? '')}</td>`;
                      }
                      html += '</tr>';
                    } else {
                      html += '<tr>';
                      html += `<td class="label-cell" style="width:35%;font-weight:700;border:1px solid #000;padding:6px 8px">${String((r as { heading?: string }).heading || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</td>`;
                      html += `<td class="value-cell" style="border:1px solid #000;padding:6px 8px">${String((r as { content?: string }).content || '')}</td>`;
                      html += '</tr>';
                    }
                  }
                  html += '</tbody></table>';
                  if (imgHtml) html += imgHtml;
                }
              } else if (String((b as { content?: string }).content || '').replace(/<[^>]*>/g, '').trim()) {
                if (heading) html += `<div class="task-instructions-block-title">${heading.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`;
                const imgHtml = renderInstructionImage(bRec);
                html += `<div class="task-instructions-block-content">${String((b as { content?: string }).content || '')}</div>`;
                if (imgHtml) html += imgHtml;
              }
            }
          }

          if (customBlocks.length === 0) {
            const blocks: { title: string; content: string }[] = [
              { title: 'Assessment type', content: String(instr.assessment_type || '') },
              { title: 'Instructions provided to the student:', content: String(instr.task_description || '') },
              { title: 'Applicable conditions:', content: String(instr.applicable_conditions || '') },
              { title: 'Resubmissions and reattempts:', content: String(instr.resubmissions || '') },
              { title: 'Location:', content: (instr.location_intro || '') + (Array.isArray(instr.location_options) ? '<ul><li>' + instr.location_options.map((o: string) => o).join('</li><li>') + '</li></ul>' : '') + (instr.location_note || '') },
              { title: 'Instructions for answering the written questions:', content: String(instr.answering_instructions || '') },
              { title: 'Purpose of the assessment', content: String(instr.purpose_intro || '') + String(instr.purpose_bullets || '') },
            ];
            for (const b of blocks) {
              if (b.content && b.content.replace(/<[^>]*>/g, '').trim()) {
                html += `<div class="task-instructions-block"><div class="task-instructions-block-title">${b.title}</div><div class="task-instructions-block-content">${b.content}</div></div>`;
              }
            }
            if (instr.task_instructions && String(instr.task_instructions).replace(/<[^>]*>/g, '').trim()) {
              html += `<div class="task-instructions-block"><div class="task-instructions-block-title">Task instructions</div><div class="task-instructions-block-content">${instr.task_instructions}</div></div>`;
            }
          }
        }
      } else if (section.pdf_render_mode === 'task_questions') {
        const rowId = (section as { assessment_task_row_id?: number | null }).assessment_task_row_id;
        const row = rowId ? taskRowsMap.get(rowId) : null;
        const instr = row?.row_meta?.instructions as Record<string, string> | undefined;
        const assessmentType = instr?.assessment_type ? String(instr.assessment_type).replace(/<[^>]*>/g, '').trim() || (row?.row_help || 'Assessment') : (row?.row_help || 'Assessment');
        const taskHeaderTitle = `${row?.row_label || section.title} – ${assessmentType}`;
        html += '<div class="task-questions-page">';
        html += `<div class="task-questions-header">${taskHeaderTitle}</div>`;
        html += `<div class="task-questions-subheader">Provide your response to each question in the box below.</div>`;
        headerNum++;
        const orderedQs = questions.filter(
          (q) => !((q.question.pdf_meta as Record<string, unknown>)?.isAdditionalBlockOf)
        );
        const renderableQs = orderedQs.filter((q) => q.question.type !== 'instruction_block');
        const taskQNumById = new Map<number, number>();
        let qnAcc = 0;
        for (const rq of renderableQs) {
          if (rq.question.type === 'page_break') continue;
          qnAcc++;
          taskQNumById.set(rq.question.id, qnAcc);
        }
        for (let i = 0; i < orderedQs.length; i++) {
          const { question, rows } = orderedQs[i];
          if (question.type === 'instruction_block') {
            html += renderTaskQuestionInstructionHtml(question, normalizeNbspProse, labelToHtml);
            continue;
          }
          if (question.type === 'page_break') continue;
          const nextIsPageBreak = orderedQs[i + 1]?.question.type === 'page_break';
          const qNum = taskQNumById.get(question.id) ?? 0;
          const sat = trainerAssessments.get(question.id);
          const satYes = sat === 'yes';
          const satNo = sat === 'no';
          const isGridTable = question.type === 'grid_table' && rows.length > 0;
          const isFirstQuestion = qNum === 1;
          const boxClass = 'task-q-question-box' + (isFirstQuestion ? ' task-q-first-question' : '') + (nextIsPageBreak ? ' page-break-after' : '');
          const pmTop = (question.pdf_meta as Record<string, unknown>) || {};
          const textAboveHeader = String(pmTop.textAboveHeader ?? '').trim();
          let contentCellHtml = questionContentLabelHtml(question.label);
          if (textAboveHeader) contentCellHtml += `<div class="task-q-text-above-header">${labelToHtml(textAboveHeader)}</div>`;
          html += renderQuestionBlockOpen({
            qNum,
            contentCellHtml,
            satYes,
            satNo,
            boxClass,
          });
          if (isGridTable) {
            const pm = (question.pdf_meta as Record<string, unknown>) || {};
            const cols = (Array.isArray(pm.columns) ? pm.columns : ['Column 1', 'Column 2']) as string[];
            const layout = (pm.layout as string) || 'no_image';
            const isSplit = layout === 'split' || layout === 'polygon';
            const isNoImage = layout === 'no_image';
            const firstCol = (pm.firstColumnLabel as string) || (isNoImage ? 'Item' : layout === 'default' ? 'Shape' : 'Name');
            const secondCol = (pm.secondColumnLabel as string) || (isNoImage ? 'Description' : 'Image');
            const columnWordLimits = (Array.isArray(pm.columnWordLimits) ? pm.columnWordLimits : []).map((v: unknown) => (typeof v === 'number' && v > 0 ? v : null)) as (number | null)[];
            html += '<table class="section-table grid-table-no-border task-q-inner-table"><thead><tr>';
            if (isSplit) {
              html += `<th>${secondCol}</th>`;
            } else if (isNoImage) {
              html += `<th>${firstCol}</th><th>${secondCol}</th>`;
            } else {
              html += `<th>${firstCol}</th>`;
            }
            for (const c of cols) html += `<th>${c}</th>`;
            html += '</tr></thead><tbody>';
            for (const row of rows) {
              const key = `q-${question.id}-${row.id}`;
              const val = answers.get(key) as Record<string, string> | undefined;
              html += '<tr>';
              if (isSplit) {
                html += `<td class="value-cell">${row.row_image_url ? `${gridRowImgHtml(row.row_image_url)}<br/>${row.row_label}` : row.row_label}</td>`;
              } else if (isNoImage) {
                html += `<td class="label-cell">${row.row_label}</td>`;
                html += `<td class="value-cell">${row.row_help || '—'}</td>`;
              } else {
                html += `<td class="label-cell">${row.row_image_url ? `${gridRowImgHtml(row.row_image_url)}<br/>${row.row_label}` : row.row_label}</td>`;
              }
              const columnTypes = (pm.columnTypes as string[]) || cols.map(() => 'answer');
              for (let i = 0; i < cols.length; i++) {
                const colType = columnTypes[i] === 'question' ? 'question' : 'answer';
                const cellVal = colType === 'question' ? (row.row_help || '—') : (val && typeof val === 'object' ? (val[`r${row.id}_c${i}`] || '') : '');
                const wl = columnWordLimits[i];
                const cellStyle = colType === 'answer' && wl ? `min-height:${heightFromWordLimit(wl)}px;max-height:${heightFromWordLimit(wl)}px;height:${heightFromWordLimit(wl)}px;` : '';
                html += `<td class="value-cell"${cellStyle ? ` style="${cellStyle}"` : ''}>${cellVal}</td>`;
              }
              html += '</tr>';
            }
            html += '</tbody></table>';
          }
          if (!isGridTable) {
            const key = rows[0] ? `q-${question.id}-${rows[0].id}` : `q-${question.id}`;
            const val = answers.get(key);
            const qPm = question.pdf_meta as Record<string, unknown> | undefined;
            const qWordLimit = typeof qPm?.wordLimit === 'number' && qPm.wordLimit > 0 ? qPm.wordLimit : null;
            const blockClass = question.type === 'long_text' ? 'task-q-answer-block task-q-answer-large' : 'task-q-answer-block';
            const blockStyle = qWordLimit ? `min-height:${heightFromWordLimit(qWordLimit)}px;max-height:${heightFromWordLimit(qWordLimit)}px;height:${heightFromWordLimit(qWordLimit)}px;` : '';
            html += `<div class="${blockClass}"${blockStyle ? ` style="${blockStyle}"` : ''}>${formatShortLongAnswerCellHtml(val as string | number | Record<string, unknown> | undefined)}</div>`;
          }
          const legacyAb = pmTop?.additionalBlock as Record<string, unknown> | undefined;
          const contentBlocks: Array<{ type: string; content?: string; questionId?: number; headerText?: string }> = Array.isArray(pmTop?.contentBlocks)
            ? (pmTop.contentBlocks as Array<{ type: string; content?: string; questionId?: number; headerText?: string }>)
            : legacyAb ? [{ type: String(legacyAb.type ?? 'instruction_block'), content: legacyAb.content as string, questionId: legacyAb.questionId as number }] : [];
          const blockHeaderHtml = (ht: string | undefined) => (ht ? `<div class="task-q-text-above-header">${labelToHtml(ht)}</div>` : '');
          for (const block of contentBlocks) {
            const blockImgUrl = (block as { imageUrl?: string }).imageUrl;
            const blockContent = String(block.content ?? '');
            const isImageBlock = block.type === 'image';
            if (
              (block.type === 'instruction_block' && (blockContent || blockImgUrl)) ||
              (isImageBlock && blockImgUrl)
            ) {
              const textOnly = isImageBlock ? '' : blockContent;
              const blockFull = (block as { imageFullWidth?: boolean }).imageFullWidth === true;
              const blockLayout = blockFull ? 'above' : ((block as { imageLayout?: string }).imageLayout || (isImageBlock ? 'above' : 'side_by_side'));
              const blockPct = Math.max(20, Math.min(80, (block as { imageWidthPercent?: number }).imageWidthPercent || 50));
              const imgTag = blockImgUrl
                ? `<img src="${escapeImgSrc(blockImgUrl, 'content-block-image')}" alt="" loading="eager" style="max-width:100%;${blockFull ? 'width:100%;display:block;margin:0 auto;' : ''}max-height:${blockFull ? 520 : 280}px;object-fit:contain;border:1px solid #ddd;border-radius:4px" />`
                : '';
              let innerHtml = '';
              if (!imgTag) innerHtml = `<div class="task-q-additional-instruction">${textOnly}</div>`;
              else if (blockLayout === 'above') innerHtml = `<div style="margin-bottom:8px">${imgTag}</div><div class="task-q-additional-instruction">${textOnly}</div>`;
              else if (blockLayout === 'below') innerHtml = `<div class="task-q-additional-instruction">${textOnly}</div><div style="margin-top:8px">${imgTag}</div>`;
              else innerHtml = `<div style="display:flex;gap:16px;align-items:flex-start"><div style="flex:1;min-width:0"><div class="task-q-additional-instruction">${textOnly}</div></div><div style="width:${blockPct}%;flex-shrink:0">${imgTag}</div></div>`;
              html += `<div class="task-q-content-block mt-3">${blockHeaderHtml(block.headerText)}${innerHtml}</div>`;
              continue;
            }
            if ((block.type === 'short_text' || block.type === 'long_text') && block.questionId) {
              const childQ = questions.find((x) => x.question.id === block.questionId);
              if (childQ) {
                const cq = childQ.question;
                const key = `q-${cq.id}`;
                const val = answers.get(key);
                const cqPm = (cq.pdf_meta as Record<string, unknown>) || {};
                const qWordLimit = typeof cqPm?.wordLimit === 'number' && cqPm.wordLimit > 0 ? cqPm.wordLimit : null;
                const blockClass = block.type === 'long_text' ? 'task-q-answer-block task-q-answer-large' : 'task-q-answer-block';
                const blockStyle = qWordLimit ? `min-height:${heightFromWordLimit(qWordLimit)}px;max-height:${heightFromWordLimit(qWordLimit)}px;height:${heightFromWordLimit(qWordLimit)}px;` : '';
                html += `<div class="task-q-content-block mt-3">${blockHeaderHtml(block.headerText)}${questionContentLabelHtml(cq.label)}<div class="${blockClass}"${blockStyle ? ` style="${blockStyle}"` : ''}>${formatShortLongAnswerCellHtml(val as string | number | Record<string, unknown> | undefined)}</div></div>`;
              }
              continue;
            }
            if (block.type === 'grid_table' && block.questionId) {
            const childQ = questions.find((x) => x.question.id === block.questionId);
            if (childQ) {
              html += `<div class="task-q-content-block mt-3">${blockHeaderHtml(block.headerText)}`;
              const { question: cq, rows: cRows } = childQ;
              const cqPm = (cq.pdf_meta as Record<string, unknown>) || {};
              const cCols = (Array.isArray(cqPm.columns) ? cqPm.columns : ['Column 1', 'Column 2']) as string[];
              const cLayout = (cqPm.layout as string) || 'no_image';
              const cIsSplit = cLayout === 'split' || cLayout === 'polygon';
              const cIsNoImage = cLayout === 'no_image';
              const cFirstCol = (cqPm.firstColumnLabel as string) || (cIsNoImage ? 'Item' : cLayout === 'default' ? 'Shape' : 'Name');
              const cSecondCol = (cqPm.secondColumnLabel as string) || (cIsNoImage ? 'Description' : 'Image');
              const cColumnWordLimits = (Array.isArray(cqPm.columnWordLimits) ? cqPm.columnWordLimits : []).map((v: unknown) => (typeof v === 'number' && v > 0 ? v : null)) as (number | null)[];
              html += '<div class="task-q-additional-grid"><table class="section-table grid-table-no-border task-q-inner-table"><thead><tr>';
              if (cIsSplit) html += `<th>${cSecondCol}</th>`;
              else if (cIsNoImage) html += `<th>${cFirstCol}</th><th>${cSecondCol}</th>`;
              else html += `<th>${cFirstCol}</th>`;
              for (const c of cCols) html += `<th>${c}</th>`;
              html += '</tr></thead><tbody>';
              for (const row of cRows) {
                const key = `q-${cq.id}-${row.id}`;
                const val = answers.get(key) as Record<string, string> | undefined;
                html += '<tr>';
                if (cIsSplit) {
                  html += `<td class="value-cell">${row.row_image_url ? `${gridRowImgHtml(row.row_image_url)}<br/>${row.row_label}` : row.row_label}</td>`;
                } else if (cIsNoImage) {
                  html += `<td class="label-cell">${row.row_label}</td>`;
                  html += `<td class="value-cell">${row.row_help || '—'}</td>`;
                } else {
                  html += `<td class="label-cell">${row.row_image_url ? `${gridRowImgHtml(row.row_image_url)}<br/>${row.row_label}` : row.row_label}</td>`;
                }
                const cColumnTypes = (cqPm.columnTypes as string[]) || cCols.map(() => 'answer');
                for (let i = 0; i < cCols.length; i++) {
                  const colType = cColumnTypes[i] === 'question' ? 'question' : 'answer';
                  const cellVal = colType === 'question' ? (row.row_help || '—') : (val && typeof val === 'object' ? (val[`r${row.id}_c${i}`] || '') : '');
                  const wl = cColumnWordLimits[i];
                  const cellStyle = colType === 'answer' && wl ? `min-height:${heightFromWordLimit(wl)}px;max-height:${heightFromWordLimit(wl)}px;height:${heightFromWordLimit(wl)}px;` : '';
                  html += `<td class="value-cell"${cellStyle ? ` style="${cellStyle}"` : ''}>${cellVal}</td>`;
                }
                html += '</tr>';
              }
              html += '</tbody></table></div></div>';
            }
            }
          }
          html += renderQuestionBlockClose();
        }
        html += '</div>'; // Close task-questions-page wrapper
      } else if (section.pdf_render_mode === 'task_results') {
        const rowId = section.assessment_task_row_id;
        const row = rowId ? taskRowsMap.get(rowId) : null;
        const taskTitle = row?.row_label || section.title;
        const rd = resultsData.get(section.id);
        const f1s = rd?.first_attempt_satisfactory === 's';
        const f1n = rd?.first_attempt_satisfactory === 'ns';
        const f2s = rd?.second_attempt_satisfactory === 's';
        const f2n = rd?.second_attempt_satisfactory === 'ns';
        const f3s = rd?.third_attempt_satisfactory === 's';
        const f3n = rd?.third_attempt_satisfactory === 'ns';
        html += `<div class="result-sheet-page"><div class="result-sheet-main"><div class="task-results-header">${taskTitle} – Results Sheet</div>`;
        html += '<table class="result-sheet-table"><tbody>';
        html += '<tr><td class="result-label" rowspan="3">Outcome</td><td class="result-value">';
        html += '<div class="task-results-outcome-title">First attempt:</div>';
        html += '<div>Outcome (make sure to tick the correct checkbox):</div>';
        html += '<div style="margin: 6px 0;"><span class="result-radio"><span class="radio-circle' + (f1s ? ' filled' : '') + '"></span><span class="question-label">Satisfactory (S)</span></span><span class="result-radio"><span class="radio-circle' + (f1n ? ' filled' : '') + '"></span><span class="question-label">Not Satisfactory (NS)</span></span></div>';
        html += '<div style="margin: 8px 0;"><span class="question-label">Date:</span> <span class="answer-line-inline" style="min-width:120px;">' + (rd?.first_attempt_date ?? '') + '</span></div>';
        html += '<div class="question" style="margin: 8px 0;"><span class="question-label">Feedback:</span><div class="answer-box answer-box-large">' + (rd?.first_attempt_feedback ?? '') + '</div></div>';
        html += '</td></tr>';
        html += '<tr><td class="result-value">';
        html += '<div class="task-results-outcome-title">Second attempt:</div>';
        html += '<div>Outcome (make sure to tick the correct checkbox):</div>';
        html += '<div style="margin: 6px 0;"><span class="result-radio"><span class="radio-circle' + (f2s ? ' filled' : '') + '"></span><span class="question-label">Satisfactory (S)</span></span><span class="result-radio"><span class="radio-circle' + (f2n ? ' filled' : '') + '"></span><span class="question-label">Not Satisfactory (NS)</span></span></div>';
        html += '<div style="margin: 8px 0;"><span class="question-label">Date:</span> <span class="answer-line-inline" style="min-width:120px;">' + (rd?.second_attempt_date ?? '') + '</span></div>';
        html += '<div class="question" style="margin: 8px 0;"><span class="question-label">Feedback:</span><div class="answer-box answer-box-large">' + (rd?.second_attempt_feedback ?? '') + '</div></div>';
        html += '</td></tr>';
        html += '<tr><td class="result-value">';
        html += '<div class="task-results-outcome-title">Third attempt:</div>';
        html += '<div>Outcome (make sure to tick the correct checkbox):</div>';
        html += '<div style="margin: 6px 0;"><span class="result-radio"><span class="radio-circle' + (f3s ? ' filled' : '') + '"></span><span class="question-label">Satisfactory (S)</span></span><span class="result-radio"><span class="radio-circle' + (f3n ? ' filled' : '') + '"></span><span class="question-label">Not Satisfactory (NS)</span></span></div>';
        html += '<div style="margin: 8px 0;"><span class="question-label">Date:</span> <span class="answer-line-inline" style="min-width:120px;">' + (rd?.third_attempt_date ?? '') + '</span></div>';
        html += '<div class="question" style="margin: 8px 0;"><span class="question-label">Feedback:</span><div class="answer-box answer-box-large">' + (rd?.third_attempt_feedback ?? '') + '</div></div>';
        html += '</td></tr>';
        html += '<tr><td class="result-label">Student Declaration</td><td class="result-value result-value-declaration">';
        html += '<ul style="margin: 8px 0; padding-left: 20px;"><li>I declare that the answers I have provided are my own work.</li><li>I have kept a copy of all relevant notes and reference material.</li><li>I have provided references for all sources where the information is not my own.</li>';
        html += '<li>For the purposes of assessment, I give the trainer/assessor permission to:<ul style="margin: 4px 0; padding-left: 20px;"><li>i. Reproduce this assessment and provide a copy to another member of the RTO for the purposes of assessment.</li><li>ii. Take steps to authenticate the assessment, including conducting a plagiarism check.</li></ul></li></ul>';
        html += '<p style="margin: 12px 0 4px 0;"><strong>I understand that if I disagree with the assessment outcome, I can appeal the assessment process, and either re-submit additional evidence undertake gap training and or have my submission re-assessed.</strong></p>';
        html += '<p style="margin: 4px 0 0 0;"><strong>All appeal options have been explained to me.</strong></p>';
        html += '</td></tr>';
        const studentNameDisplay = (() => {
          const rn = (rd?.student_name ?? '').trim();
          if (rn.length > 1) return rn;
          const sig = rd?.student_signature;
          if (sig && typeof sig === 'string' && !sig.startsWith('data:')) return sig;
          return String(codeToValue.get('student.fullName') ?? '');
        })();
        const trainerNameDisplay = (() => {
          const rn = (rd?.trainer_name ?? '').trim();
          if (rn.length > 1) return rn;
          const sig = rd?.trainer_signature;
          if (sig && typeof sig === 'string' && !sig.startsWith('data:')) return sig;
          return String(codeToValue.get('trainer.fullName') ?? '');
        })();
        html += '<tr><td class="result-label">Student Name</td><td class="result-value">' + studentNameDisplay + '</td></tr>';
        html += '<tr><td class="result-label">Student Signature</td><td class="result-value">' + renderSignatureHtml(rd?.student_signature ?? '') + '</td></tr>';
        html += '<tr><td class="result-label">Trainer/Assessor Name</td><td class="result-value">' + trainerNameDisplay + '</td></tr>';
        html += '<tr><td class="result-label">Trainer/Assessor Signature</td><td class="result-value">' + renderSignatureHtml(rd?.trainer_signature ?? '') + '</td></tr>';
        html += '<tr><td class="result-label">Date</td><td class="result-value">' + (rd?.trainer_date ?? '') + '</td></tr>';
        const officeEntry = resultsOffice.get(section.id);
        const officeInitial = Boolean(officeEntry?.initial_checked);
        const officeUpdated = Boolean(officeEntry?.updated_checked);
        html += '<tr><td class="result-label decl-office-label">Office Use Only</td><td class="result-value">';
        html += 'The outcome of this assessment has been entered into the Student Management System. ';
        html += 'Initial: <span class="summary-cb' + (officeInitial ? ' checked' : '') + '">' + (officeInitial ? '✓' : '') + '</span> ';
        html += 'Updated: <span class="summary-cb' + (officeUpdated ? ' checked' : '') + '">' + (officeUpdated ? '✓' : '') + '</span>';
        html += '</td></tr>';
        html += '</tbody></table></div></div>';
      } else if (section.pdf_render_mode === 'assessment_summary' || section.title === 'Assessment Summary Sheet') {
        const taskRowsOrdered: { id: number; row_label: string }[] = [];
        const taskRowToSectionId = new Map<number, number>();
        const seenTaskRowIds = new Set<number>();
        const summaryStepIdx = steps.findIndex(
          (g) =>
            /Assessment Summary/i.test(String(g.step?.title ?? '').trim()) ||
            g.sections.some((s) => s.section.pdf_render_mode === 'assessment_summary')
        );
        for (let gi = 0; gi < steps.length; gi++) {
          if (summaryStepIdx >= 0 && gi >= summaryStepIdx) continue;
          const g = steps[gi];
          for (const { section: sec, questions } of g.sections) {
            if (sec.pdf_render_mode === 'assessment_tasks') {
              const taskQ = questions.find((q) => q.question.type === 'grid_table' && q.rows.length > 0);
              if (taskQ) {
                for (const r of taskQ.rows) {
                  if (seenTaskRowIds.has(r.id)) continue;
                  seenTaskRowIds.add(r.id);
                  taskRowsOrdered.push({ id: r.id, row_label: r.row_label });
                }
              }
            }
            if (sec.pdf_render_mode === 'task_results' && (sec as { assessment_task_row_id?: number }).assessment_task_row_id) {
              taskRowToSectionId.set((sec as { assessment_task_row_id: number }).assessment_task_row_id, sec.id);
            }
          }
        }
        const sum = assessmentSummaryData || {};
        const studentName = String(codeToValue.get('student.fullName') ?? '');
        const studentId = String(codeToValue.get('student.id') ?? '');
        const unitCodeName = [String(codeToValue.get('unit.code') ?? ''), String(codeToValue.get('unit.name') ?? '')].filter(Boolean).join(' ');
        html += '<div class="assessment-summary-page"><div class="assessment-summary-wrapper">';
        html += '<div class="assessment-summary-header">ASSESSMENT SUMMARY SHEET</div>';
        html += '<div class="assessment-summary-intro"><div class="intro-main">This form is to be completed by the assessor and used as a final record of student competency.</div>';
        html += 'All student submissions including any associated checklists (outlined below) are to be attached to this cover sheet before placing on the student\'s file.<br/>';
        html += 'Student results are not to be entered onto the Student Database unless all relevant paperwork is completed and attached to this form.</div>';
        html += '<div class="assessment-summary-tables-wrap">';
        html += '<table class="assessment-summary-table assessment-summary-info"><tbody>';
        html += '<tr><td class="summary-label" style="width:25%">Student Name:</td><td class="summary-value" colspan="3">' + studentName + '</td></tr>';
        html += '<tr><td class="summary-label">Student ID:</td><td class="summary-value" colspan="3">' + studentId + '</td></tr>';
        html += '<tr><td class="summary-label">Start date:</td><td class="summary-value"><span class="summary-date-line">' + (sum.start_date ?? '') + '</span></td><td class="summary-label" style="text-align:right;width:15%">End Date:</td><td class="summary-value"><span class="summary-date-line">' + (sum.end_date ?? '') + '</span></td></tr>';
        html += '<tr><td class="summary-label">Unit Code & Name:</td><td class="summary-value" colspan="3">' + unitCodeName + '</td></tr>';
        html += '</tbody></table>';
        html += '<table class="assessment-summary-table assessment-summary-result"><thead><tr><th class="summary-label">Please attach the following evidence to this form</th><th colspan="3" class="summary-result-header">Result</th></tr>';
        html += '<tr><th class="summary-label"></th><th class="summary-result-header summary-attempt-col">1st Attempt</th><th class="summary-result-header summary-attempt-col">2nd Attempt</th><th class="summary-result-header summary-attempt-col">3rd Attempt</th></tr></thead><tbody>';
        if (taskRowsOrdered.length === 0) {
          // Default placeholder rows so new forms always show full table structure (match reference image)
          html += '<tr><td class="summary-label">Assessment Task 1</td>';
          html += '<td class="summary-attempt-value summary-attempt-col"><div style="margin:2px 0;display:flex;align-items:center;gap:6px"><span class="summary-cb"></span> Satisfactory</div><div style="margin:2px 0;display:flex;align-items:center;gap:6px"><span class="summary-cb"></span> Not Satisfactory</div><div style="margin-top:6px;font-size:8pt">Date: <span class="summary-date-line"></span></div></td>';
          html += '<td class="summary-attempt-value summary-attempt-col"><div style="margin:2px 0;display:flex;align-items:center;gap:6px"><span class="summary-cb"></span> Satisfactory</div><div style="margin:2px 0;display:flex;align-items:center;gap:6px"><span class="summary-cb"></span> Not Satisfactory</div><div style="margin-top:6px;font-size:8pt">Date: <span class="summary-date-line"></span></div></td>';
          html += '<td class="summary-attempt-value summary-attempt-col"><div style="margin:2px 0;display:flex;align-items:center;gap:6px"><span class="summary-cb"></span> Satisfactory</div><div style="margin:2px 0;display:flex;align-items:center;gap:6px"><span class="summary-cb"></span> Not Satisfactory</div><div style="margin-top:6px;font-size:8pt">Date: <span class="summary-date-line"></span></div></td></tr>';
          html += '<tr><td class="summary-label">Assessment Task 2</td>';
          html += '<td class="summary-attempt-value summary-attempt-col"><div style="margin:2px 0;display:flex;align-items:center;gap:6px"><span class="summary-cb"></span> Satisfactory</div><div style="margin:2px 0;display:flex;align-items:center;gap:6px"><span class="summary-cb"></span> Not Satisfactory</div><div style="margin-top:6px;font-size:8pt">Date: <span class="summary-date-line"></span></div></td>';
          html += '<td class="summary-attempt-value summary-attempt-col"><div style="margin:2px 0;display:flex;align-items:center;gap:6px"><span class="summary-cb"></span> Satisfactory</div><div style="margin:2px 0;display:flex;align-items:center;gap:6px"><span class="summary-cb"></span> Not Satisfactory</div><div style="margin-top:6px;font-size:8pt">Date: <span class="summary-date-line"></span></div></td>';
          html += '<td class="summary-attempt-value summary-attempt-col"><div style="margin:2px 0;display:flex;align-items:center;gap:6px"><span class="summary-cb"></span> Satisfactory</div><div style="margin:2px 0;display:flex;align-items:center;gap:6px"><span class="summary-cb"></span> Not Satisfactory</div><div style="margin-top:6px;font-size:8pt">Date: <span class="summary-date-line"></span></div></td></tr>';
        }
        for (const tr of taskRowsOrdered) {
          const secId = taskRowToSectionId.get(tr.id);
          const rd = secId ? resultsData.get(secId) : null;
          const f1s = rd?.first_attempt_satisfactory === 's';
          const f1n = rd?.first_attempt_satisfactory === 'ns';
          const f2s = rd?.second_attempt_satisfactory === 's';
          const f2n = rd?.second_attempt_satisfactory === 'ns';
          const f3s = rd?.third_attempt_satisfactory === 's';
          const f3n = rd?.third_attempt_satisfactory === 'ns';
          html += '<tr><td class="summary-label">' + tr.row_label + '</td>';
          html += '<td class="summary-attempt-value summary-attempt-col"><div style="margin:2px 0;display:flex;align-items:center;gap:6px"><span class="summary-cb' + (f1s ? ' checked' : '') + '">' + (f1s ? '✓' : '') + '</span> Satisfactory</div><div style="margin:2px 0;display:flex;align-items:center;gap:6px"><span class="summary-cb' + (f1n ? ' checked' : '') + '">' + (f1n ? '✓' : '') + '</span> Not Satisfactory</div><div style="margin-top:6px;font-size:8pt">Date: <span class="summary-date-line">' + (rd?.first_attempt_date ?? '') + '</span></div></td>';
          html += '<td class="summary-attempt-value summary-attempt-col"><div style="margin:2px 0;display:flex;align-items:center;gap:6px"><span class="summary-cb' + (f2s ? ' checked' : '') + '">' + (f2s ? '✓' : '') + '</span> Satisfactory</div><div style="margin:2px 0;display:flex;align-items:center;gap:6px"><span class="summary-cb' + (f2n ? ' checked' : '') + '">' + (f2n ? '✓' : '') + '</span> Not Satisfactory</div><div style="margin-top:6px;font-size:8pt">Date: <span class="summary-date-line">' + (rd?.second_attempt_date ?? '') + '</span></div></td>';
          html += '<td class="summary-attempt-value summary-attempt-col"><div style="margin:2px 0;display:flex;align-items:center;gap:6px"><span class="summary-cb' + (f3s ? ' checked' : '') + '">' + (f3s ? '✓' : '') + '</span> Satisfactory</div><div style="margin:2px 0;display:flex;align-items:center;gap:6px"><span class="summary-cb' + (f3n ? ' checked' : '') + '">' + (f3n ? '✓' : '') + '</span> Not Satisfactory</div><div style="margin-top:6px;font-size:8pt">Date: <span class="summary-date-line">' + (rd?.third_attempt_date ?? '') + '</span></div></td></tr>';
        }
        const fc1 = sum.final_attempt_1_result === 'competent';
        const fnc1 = sum.final_attempt_1_result === 'not_yet_competent';
        const fc2 = sum.final_attempt_2_result === 'competent';
        const fnc2 = sum.final_attempt_2_result === 'not_yet_competent';
        const fc3 = sum.final_attempt_3_result === 'competent';
        const fnc3 = sum.final_attempt_3_result === 'not_yet_competent';
        html += '<tr style="border-top:2px solid #000"><td class="summary-label">Final Assessment result for this unit</td>';
        html += '<td class="summary-attempt-value summary-attempt-col"><div style="margin:2px 0;display:flex;align-items:center;gap:6px"><span class="summary-cb' + (fc1 ? ' checked' : '') + '">' + (fc1 ? '✓' : '') + '</span> Competent</div><div style="margin:2px 0;display:flex;align-items:center;gap:6px"><span class="summary-cb' + (fnc1 ? ' checked' : '') + '">' + (fnc1 ? '✓' : '') + '</span> Not Yet Competent</div></td>';
        html += '<td class="summary-attempt-value summary-attempt-col"><div style="margin:2px 0;display:flex;align-items:center;gap:6px"><span class="summary-cb' + (fc2 ? ' checked' : '') + '">' + (fc2 ? '✓' : '') + '</span> Competent</div><div style="margin:2px 0;display:flex;align-items:center;gap:6px"><span class="summary-cb' + (fnc2 ? ' checked' : '') + '">' + (fnc2 ? '✓' : '') + '</span> Not Yet Competent</div></td>';
        html += '<td class="summary-attempt-value summary-attempt-col"><div style="margin:2px 0;display:flex;align-items:center;gap:6px"><span class="summary-cb' + (fc3 ? ' checked' : '') + '">' + (fc3 ? '✓' : '') + '</span> Competent</div><div style="margin:2px 0;display:flex;align-items:center;gap:6px"><span class="summary-cb' + (fnc3 ? ' checked' : '') + '">' + (fnc3 ? '✓' : '') + '</span> Not Yet Competent</div></td></tr>';
        html += '<tr><td class="summary-label" style="vertical-align:top"><span style="font-weight:600">Trainer/Assessor Signature</span><div style="font-size:8pt;font-style:italic;margin-top:6px;line-height:1.3">I declare that I have conducted a fair, valid, reliable, and flexible assessment with this student, and I have provided appropriate feedback</div></td><td colspan="3" class="summary-value">';
        html += '<table style="width:100%;border:none;font-size:9pt"><tr><td style="width:33%;border:none;padding:4px 8px 4px 0;vertical-align:top"><div><span style="font-weight:600">Signature:</span></div><div class="summary-date-line" style="min-width:100%;display:block">' + renderSignatureHtml(sum.trainer_sig_1 ?? '') + '</div><div style="margin-top:4px"><span style="font-weight:600">Date:</span> <span class="summary-date-line">' + (sum.trainer_date_1 ?? '') + '</span></div></td>';
        html += '<td style="width:33%;border:none;padding:4px 8px;vertical-align:top"><div><span style="font-weight:600">Signature:</span></div><div class="summary-date-line" style="min-width:100%;display:block">' + renderSignatureHtml(sum.trainer_sig_2 ?? '') + '</div><div style="margin-top:4px"><span style="font-weight:600">Date:</span> <span class="summary-date-line">' + (sum.trainer_date_2 ?? '') + '</span></div></td>';
        html += '<td style="width:33%;border:none;padding:4px 0 4px 8px;vertical-align:top"><div><span style="font-weight:600">Signature:</span></div><div class="summary-date-line" style="min-width:100%;display:block">' + renderSignatureHtml(sum.trainer_sig_3 ?? '') + '</div><div style="margin-top:4px"><span style="font-weight:600">Date:</span> <span class="summary-date-line">' + (sum.trainer_date_3 ?? '') + '</span></div></td></tr></table></td></tr>';
        html += '<tr><td class="summary-label" style="vertical-align:top"><span style="font-weight:600">Student:</span><div style="font-size:8pt;font-style:italic;margin-top:6px;line-height:1.3">I declare that I have been assessed in this unit, and I have been advised of my result. I also am aware of my appeal rights.</div></td><td colspan="3" class="summary-value">';
        html += '<table style="width:100%;border:none;font-size:9pt"><tr><td style="width:33%;border:none;padding:4px 8px 4px 0;vertical-align:top"><div><span style="font-weight:600">Signature:</span></div><div class="summary-date-line" style="min-width:100%;display:block">' + renderSignatureHtml(sum.student_sig_1 ?? '') + '</div><div style="margin-top:4px"><span style="font-weight:600">Date:</span> <span class="summary-date-line">' + (sum.student_date_1 ?? '') + '</span></div></td>';
        html += '<td style="width:33%;border:none;padding:4px 8px;vertical-align:top"><div><span style="font-weight:600">Signature:</span></div><div class="summary-date-line" style="min-width:100%;display:block">' + renderSignatureHtml(sum.student_sig_2 ?? '') + '</div><div style="margin-top:4px"><span style="font-weight:600">Date:</span> <span class="summary-date-line">' + (sum.student_date_2 ?? '') + '</span></div></td>';
        html += '<td style="width:33%;border:none;padding:4px 0 4px 8px;vertical-align:top"><div><span style="font-weight:600">Signature:</span></div><div class="summary-date-line" style="min-width:100%;display:block">' + renderSignatureHtml(sum.student_sig_3 ?? '') + '</div><div style="margin-top:4px"><span style="font-weight:600">Date:</span> <span class="summary-date-line">' + (sum.student_date_3 ?? '') + '</span></div></td></tr></table></td></tr>';
        html += '<tr><td class="summary-label">Student overall Feedback:</td><td colspan="3" class="summary-value"><div class="answer-box answer-box-large" style="min-height:50px;background:#fff">' + (sum.student_overall_feedback ?? '') + '</div></td></tr>';
        const adminInitialChecked = Boolean(sum.admin_initial_checked);
        const adminUpdatedChecked = Boolean(sum.admin_updated_checked);
        html += '<tr><td class="summary-label summary-office" colspan="2">Administrative use only - Entered onto Student Management Database</td><td class="summary-value summary-office" colspan="2">Initial: <span class="summary-cb' + (adminInitialChecked ? ' checked' : '') + '">' + (adminInitialChecked ? '✓' : '') + '</span> &nbsp; Updated: <span class="summary-cb' + (adminUpdatedChecked ? ' checked' : '') + '">' + (adminUpdatedChecked ? '✓' : '') + '</span></td></tr>';
        html += '</tbody></table></div></div></div>';
      } else if (section.pdf_render_mode === 'reasonable_adjustment') {
        const stepTitle = (step?.title || '').trim();
        const isAppendixA = /Appendix\s*A/i.test(stepTitle);
        if (!isAppendixA && formHasAppendixA) {
          html += `<h3>${headerNum}. Reasonable Adjustment</h3>`;
          headerNum++;
          html += '<p style="margin:0 0 10px 0;line-height:1.5">Reasonable Adjustment: See Appendix A – Reasonable Adjustments for details and to record any adjustments applied.</p>';
        } else {
        const taskQ = isAppendixA
          ? questions.find((q) => q.question.code === 'reasonable_adjustment_appendix.task')
          : questions.find((q) => q.question.code === 'reasonable_adjustment.task');
        const descQ = isAppendixA
          ? questions.find((q) => q.question.code === 'reasonable_adjustment_appendix.explanation')
          : questions.find((q) => q.question.code === 'reasonable_adjustment.description');
        const matrixQ = isAppendixA
          ? questions.find(
              (q) =>
                q.question.code === 'reasonable_adjustment_appendix.matrix' ||
                (q.question.pdf_meta as Record<string, unknown>)?.appendixMatrix === true
            )
          : null;
        let sigQ = isAppendixA ? questions.find((q) => q.question.code === 'trainer.reasonableAdjustmentAppendixSignature') : questions.find((q) => q.question.type === 'signature');
        if (isAppendixA && !sigQ) sigQ = questions.find((q) => q.question.type === 'signature');
        const yesNoQ = questions.find((q) => q.question.type === 'yes_no');
        const taskVal = taskQ ? String(answers.get(`q-${taskQ.question.id}`) ?? '') : '';
        const descVal = descQ ? String(answers.get(`q-${descQ.question.id}`) ?? '') : '';
        const appliedVal = yesNoQ ? String(answers.get(`q-${yesNoQ.question.id}`) ?? '') : '';
        const yesChecked = appliedVal.toLowerCase() === 'yes' || appliedVal === 'true';
        const noChecked = appliedVal.toLowerCase() === 'no' || appliedVal === 'false' || (!yesChecked && appliedVal !== '');
        let sigVal: string | null = null;
        let dateVal = '';
        let trainerNameVal = String(codeToValue.get('trainer.fullName') ?? '');
        if (sigQ) {
          const v = answers.get(`q-${sigQ.question.id}`);
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            const o = v as Record<string, unknown>;
            sigVal = (typeof o.signature === 'string' ? o.signature : null) ?? (typeof o.imageDataUrl === 'string' ? o.imageDataUrl : null) ?? (typeof o.typedText === 'string' ? o.typedText : null);
            dateVal = String(o.date ?? o.signedAtDate ?? '');
            if (o.name != null || o.fullName != null) trainerNameVal = String(o.name ?? o.fullName ?? '');
          } else if (typeof v === 'string' && v) {
            sigVal = v;
          }
        }
        const sigDisplay = renderSignatureHtml(sigVal ?? '');
        if (!isAppendixA) {
          html += `<h3>${headerNum}. Reasonable Adjustment</h3>`;
          headerNum++;
          if (section.description) {
            const desc = section.description;
            const inCaseIdx = desc.search(/In the case that/i);
            const beforeInCase = inCaseIdx >= 0 ? desc.slice(0, inCaseIdx).trim() : desc;
            const inCasePart = inCaseIdx >= 0 ? desc.slice(inCaseIdx).trim() : '';
            if (beforeInCase) html += `<p style="margin:0 0 10px 0;line-height:1.5">${beforeInCase.replace(/\n/g, '<br/>')}</p>`;
            if (inCasePart) html += `<p style="margin:0 0 12px 0;line-height:1.5;font-style:italic">${inCasePart.replace(/\n/g, '<br/>')}</p>`;
          }
          html += '<div class="reasonable-adjustment-section">';
          html += '<div class="reasonable-adjustment-header"><span class="reasonable-adjustment-arrow">&#9654;</span> Reasonable Adjustment</div>';
          html += '<div class="reasonable-adjustment-body">';
          html += `<div class="question"><div class="question-label">${yesNoQ?.question.label || 'Was reasonable adjustment applied to any of these assessment tasks?'}</div>`;
          html += '<div class="reasonable-adjustment-radio"><span class="radio-circle' + (yesChecked ? ' filled' : '') + '"></span> Yes</div>';
          html += '<div class="reasonable-adjustment-radio"><span class="radio-circle' + (noChecked ? ' filled' : '') + '"></span> No</div></div>';
          html += `<div class="question"><div class="question-label">${taskQ?.question.label || 'If yes, which assessment task was this applied to?'}</div><div class="answer-box">${taskVal}</div></div>`;
          html += `<div class="question"><div class="question-label">${descQ?.question.label || 'Provide a description of the adjustment applied and explain reasons.'}</div><div class="answer-box reasonable-adjustment-desc">${descVal}</div></div>`;
          html += '<div class="reasonable-adjustment-sig-row"><span class="reasonable-adjustment-sig-label">Trainer Signature:</span><span class="reasonable-adjustment-sig-line">' + sigDisplay + '</span><span class="reasonable-adjustment-date-label">Date:</span><span class="reasonable-adjustment-date-line">' + dateVal + '</span></div>';
          html += '</div></div>';
        } else {
        html += '<div class="appendix-a-page">';
        html += '<div class="appendix-a-title-bar">Appendix A – Reasonable Adjustments</div>';
        html += '<div class="appendix-section-bar">Write (task name and number) where reasonable adjustments have been applied:</div>';
        html += '<div class="answer-box answer-box-large" style="min-height:60px;margin-bottom:14px">' + (taskVal || '') + '</div>';
        html += '<div class="appendix-section-bar">Reasonable Adjustments</div>';
        html += '<ul style="margin:0 0 12px 0;padding-left:20px;line-height:1.45">';
        html += '<li>Students with carer responsibilities, cultural or religious obligations, English as an additional language, disability etc., can request for reasonable adjustments.</li>';
        html += '<li>Please note, academic standards of the unit/course will not be lowered to accommodate the needs of any student, but there is a requirement to be flexible about the way in which it is delivered or assessed.</li>';
        html += '<li>The Disability Standards for Education requires institutions to take reasonable steps to enable the student with a disability to participate in education on the same basis as a student without a disability.</li>';
        html += '<li>The trainer/assessor must complete the section below "Reasonable Adjustment Strategies Matrix" to ensure the explanation and correct strategy have been recorded and implemented.</li>';
        html += '<li>The trainer/assessor must notify the administration/compliance and quality assurance department for any reasonable adjustments made.</li>';
        html += '<li>All evidence and supplementary documentation must be submitted with the assessment pack to the administration/compliance and quality assurance department.</li>';
        html += '</ul>';
        const matrixVal = matrixQ ? (answers.get(`q-${matrixQ.question.id}`) as Record<string, boolean> | undefined) : undefined;
        const matrixChecked: Record<string, boolean> =
          matrixVal && typeof matrixVal === 'object' && !Array.isArray(matrixVal) ? matrixVal : {};
        html += renderAppendixAMatrixHtml(matrixChecked);
        html += '<div class="appendix-section-bar">Explanation of reasonable adjustments strategy used</div>';
        html += '<div class="answer-box answer-box-large" style="min-height:100px;margin-bottom:14px">' + (descVal || '') + '</div>';
        const declarationText = 'I declare that I have attached all relevant evidence to provide reasonable adjustment. The training package guidelines and criteria have not been compromised in the process of providing reasonable adjustment to the student. I declare that I have conducted a fair, valid, reliable, and flexible assessment. I have provided explanation of reasonable adjustments strategy used, as required.';
        html += '<table class="decl-table" style="margin-bottom:14px"><tbody>';
        html += '<tr><td class="decl-label" style="width:35%">Trainer/Assessor Name</td><td class="decl-value">' + (trainerNameVal || '') + '</td></tr>';
        html += '<tr><td class="decl-label">Trainer/Assessor Declaration</td><td class="decl-value"><span style="font-style:italic;line-height:1.4">' + declarationText + '</span></td></tr>';
        html += '<tr><td class="decl-label" style="width:35%">Trainer/Assessor Signature</td><td class="decl-value">' + sigDisplay + '</td></tr>';
        html += '<tr><td class="decl-label">Date</td><td class="decl-value">' + (dateVal || '') + '</td></tr>';
        html += '</tbody></table>';
        html += '</div>';
        }
        }
      } else if (section.pdf_render_mode === 'declarations') {
        const sectionTitle = section.title.toLowerCase();
        if (sectionTitle.includes('final declaration')) {
          html += `<div class="decl-heading-bar">${headerNum}. ${section.title}</div>`;
          headerNum++;
          html += '<div class="declarations-section">';
          for (const { question, options } of questions) {
            if (question.type === 'yes_no' || question.type === 'single_choice') {
              const key = `q-${question.id}`;
              const val = answers.get(key);
              const checked = String(val || '').toLowerCase() === 'yes' || String(val || '').toLowerCase() === 'true';
              html += `<div class="question declaration-checkbox"><span class="cb ${checked ? 'checked' : ''}">${checked ? '✓' : ''}</span><span class="question-label">${question.label}</span></div>`;
            }
          }
          html += '</div>';
        } else if (sectionTitle.includes('signature')) {
          html += `<div class="decl-heading-bar">${headerNum}. ${section.title}</div>`;
          headerNum++;
          for (const { question } of questions) {
            if (question.type === 'signature') {
              const code = question.code || '';
              const val = answers.get(`q-${question.id}`);
              const pm = (question.pdf_meta as Record<string, unknown>) || {};
              const showName = pm.showNameField !== false;
              const showDate = pm.showDateField !== false;
              let nameVal = '';
              let sigVal: string | null = null;
              let dateVal = '';
              if (val && typeof val === 'object' && !Array.isArray(val)) {
                const o = val as Record<string, unknown>;
                nameVal = String(o.name ?? o.fullName ?? codeToValue.get(code.startsWith('student') ? 'student.fullName' : 'trainer.fullName') ?? '');
                sigVal = (typeof o.signature === 'string' ? o.signature : null) ?? (typeof o.imageDataUrl === 'string' ? o.imageDataUrl : null) ?? (typeof o.typedText === 'string' ? o.typedText : null);
                dateVal = String(o.date ?? o.signedAtDate ?? '');
              } else if (typeof val === 'string' && val) {
                sigVal = val;
                nameVal = String(codeToValue.get(code.startsWith('student') ? 'student.fullName' : 'trainer.fullName') ?? '');
              }
              const isStudent = code.startsWith('student');
              if (isStudent) {
                html += '<div class="decl-sig-inline-block">';
                html += `<div class="decl-sig-inline"><span class="decl-sig-label">${question.label}:</span>${renderSignatureHtml(sigVal ?? '') || '<span class="decl-sig-line"></span>'}</div>`;
                if (showDate) html += `<div class="decl-sig-inline"><span class="decl-sig-label">Date:</span><span class="decl-sig-line">${dateVal || ''}</span></div>`;
                html += '</div>';
              } else {
                const sigDisplay = renderSignatureHtml(sigVal ?? '') || `<span class="decl-sig-value">${nameVal || '-'}</span>`;
                html += `<div class="decl-sig-heading">${question.label}</div>`;
                html += '<table class="decl-table"><tbody>';
                if (showName) html += `<tr><td class="decl-label">Trainer/Assessor Name</td><td class="decl-value">${nameVal || ''}</td></tr>`;
                html += `<tr><td class="decl-label">${question.label}</td><td class="decl-value">${sigDisplay}</td></tr>`;
                if (showDate) html += `<tr><td class="decl-label">Date</td><td class="decl-value">${dateVal || ''}</td></tr>`;
                html += '</tbody></table>';
              }
            }
          }
        } else if (sectionTitle.includes('office')) {
          html += `<div class="decl-heading-bar">${headerNum}. ${section.title}</div>`;
          headerNum++;
          html += '<table class="decl-table"><tbody>';
          html += '<tr><td colspan="2" class="decl-other-header">Other</td></tr>';
          for (const { question } of questions) {
            const key = `q-${question.id}`;
            const val = answers.get(key);
            const label = question.label;
            html += `<tr><td class="decl-label decl-office-label">${label}</td><td class="decl-value">${val ?? ''}</td></tr>`;
          }
          html += '</tbody></table>';
        } else {
          const hasStudentSig = questions.some((q) => q.question.type === 'signature' && (q.question.code || '').startsWith('student'));
          const declSectionClass = hasStudentSig ? 'declarations-section declarations-section-no-border' : 'declarations-section';
          html += `<h3>${headerNum}. ${section.title}</h3>`;
          headerNum++;
          if (section.description) html += `<p class="intro-page" style="margin: 0 0 12px 0; line-height: 1.5;">${(section.description || '').replace(/\n/g, '<br/>')}</p>`;
          html += `<div class="${declSectionClass}">`;
          for (const { question } of questions) {
            if (question.type === 'signature') {
              const code = question.code || '';
              const val = answers.get(`q-${question.id}`);
              const pm = (question.pdf_meta as Record<string, unknown>) || {};
              const showName = pm.showNameField !== false;
              const showDate = pm.showDateField !== false;
              let nameVal = '';
              let sigVal: string | null = null;
              let dateVal = '';
              if (val && typeof val === 'object' && !Array.isArray(val)) {
                const o = val as Record<string, unknown>;
                nameVal = String(o.name ?? o.fullName ?? codeToValue.get(code.startsWith('student') ? 'student.fullName' : 'trainer.fullName') ?? '');
                sigVal = (typeof o.signature === 'string' ? o.signature : null) ?? (typeof o.imageDataUrl === 'string' ? o.imageDataUrl : null) ?? (typeof o.typedText === 'string' ? o.typedText : null);
                dateVal = String(o.date ?? o.signedAtDate ?? '');
              } else if (typeof val === 'string' && val) {
                sigVal = val;
                nameVal = String(codeToValue.get(code.startsWith('student') ? 'student.fullName' : 'trainer.fullName') ?? '');
              }
              const isStudent = code.startsWith('student');
              if (isStudent) {
                html += '<div class="decl-sig-inline-block">';
                html += `<div class="decl-sig-inline"><span class="decl-sig-label">${question.label}:</span>${renderSignatureHtml(sigVal ?? '') || '<span class="decl-sig-line"></span>'}</div>`;
                if (showDate) html += `<div class="decl-sig-inline"><span class="decl-sig-label">Date:</span><span class="decl-sig-line">${dateVal || ''}</span></div>`;
                html += '</div>';
              } else {
                const sigDisplay = renderSignatureHtml(sigVal ?? '') || `<span class="decl-sig-value">${nameVal || '-'}</span>`;
                html += `<div class="decl-sig-heading">${question.label}</div>`;
                html += '<table class="decl-table"><tbody>';
                if (showName) html += `<tr><td class="decl-label">Trainer/Assessor Name</td><td class="decl-value">${nameVal || ''}</td></tr>`;
                html += `<tr><td class="decl-label">${question.label}</td><td class="decl-value">${sigDisplay}</td></tr>`;
                if (showDate) html += `<tr><td class="decl-label">Date</td><td class="decl-value">${dateVal || ''}</td></tr>`;
                html += '</tbody></table>';
              }
            } else if (question.type === 'date') {
              const val = answers.get(`q-${question.id}`);
              html += `<div class="question"><div class="question-label">${question.label}</div><div class="answer-box">${val ?? ''}</div></div>`;
            } else if (question.type === 'yes_no' || question.type === 'single_choice') {
              const val = answers.get(`q-${question.id}`);
              const checked = String(val || '').toLowerCase() === 'yes' || String(val || '').toLowerCase() === 'true';
              html += `<div class="question declaration-checkbox"><span class="cb ${checked ? 'checked' : ''}">${checked ? '✓' : ''}</span><span class="question-label">${question.label}</span></div>`;
            } else if (question.type === 'short_text' || question.type === 'long_text') {
              const val = answers.get(`q-${question.id}`);
              html += `<div class="question"><div class="question-label">${question.label}</div><div class="answer-box">${formatShortLongAnswerCellHtml(val as string | number | Record<string, unknown> | undefined)}</div></div>`;
            } else {
              const val = answers.get(`q-${question.id}`);
              html += `<div class="question"><div class="question-label">${question.label}</div><div class="answer-box">${val ?? ''}</div></div>`;
            }
          }
          html += '</div>';
        }
      } else if (isWrittenEvidenceChecklistSection(section.pdf_render_mode, questions)) {
        html += renderWrittenEvidenceChecklistHtml(
          section.title,
          getWrittenEvidenceChecklistQuestions(section.pdf_render_mode, questions),
          answers,
        );
      } else {
        const instructionBlocks = questions.filter((q) => q.question.type === 'instruction_block');
        for (const { question } of instructionBlocks) {
          if (question.help_text) {
            html += `<div class="intro-page" style="margin: 0 0 12px 0; line-height: 1.5;">${(question.help_text || '').replace(/\n/g, '<br/>')}</div>`;
          }
        }
        const normalQuestions = questions.filter(
          (q) => q.question.type !== 'instruction_block' && q.question.type !== 'page_break'
        );
        if (normalQuestions.length > 0) {
          const groupNames: Record<string, string> = {
            student: 'Student details',
            trainer: 'Trainer details',
            qualification: 'Qualification/Course/Program Details',
            unit: 'Unit of competency',
            office: 'Office Use Only',
          };
          const groups: Record<string, typeof normalQuestions> = {};
          for (const q of normalQuestions) {
            const prefix = (q.question.code || '').split('.')[0] || 'other';
            const groupKey = groupNames[prefix] || 'Other';
            if (!groups[groupKey]) groups[groupKey] = [];
            groups[groupKey].push(q);
          }
          html += '<table class="section-table">';
          let rowIdx = 0;
          for (const [groupName, groupQs] of Object.entries(groups)) {
            html += `<tr><td colspan="2" class="sub-section-header">${groupName}</td></tr>`;
            for (const { question, rows } of groupQs) {
              const key = rows[0] ? `q-${question.id}-${rows[0].id}` : `q-${question.id}`;
              const rawVal = answers.get(key);
              const val = (rawVal != null && rawVal !== '') ? rawVal : (question.code ? codeToValue.get(question.code) : undefined);
              const rowClass = rowIdx++ % 2 === 0 ? 'row-normal' : 'row-alt';
              const cellHtml =
                question.type === 'short_text' || question.type === 'long_text'
                  ? formatShortLongAnswerCellHtml(val as string | number | Record<string, unknown> | undefined)
                  : (val ?? '');
              html += `<tr class="${rowClass}"><td class="label-cell">${question.label}</td><td class="value-cell">${cellHtml}</td></tr>`;
            }
          }
          html += '</table>';
        }
      }
      if (isLearnerEvaluation && learnerEvalIntroShown) {
        html += '</div>';
      }
    }
  }
  html += `</div>`;
  }

  html += `
  </div>
</body>
</html>`;

  const version = form.version || '1';
  return { html, unitCode, version, headerHtml };
}



export async function getPdfData(
  supabase: SupabaseClient,
  instanceId: number,
): Promise<{ html: string; unitCode: string; version: string; headerHtml: string; fileName: string } | null> {
  const template = await getTemplateForInstance(supabase, instanceId);
  if (!template) return null;

  const { data: answers } = await supabase
    .from('skyline_form_answers')
    .select('*')
    .eq('instance_id', instanceId);

  let trainerAssessmentsMap = new Map<number, string>();
  try {
    const { data: assessments } = await supabase
      .from('skyline_form_trainer_assessments')
      .select('question_id, satisfactory')
      .eq('instance_id', instanceId);
    for (const a of (assessments as { question_id: number; satisfactory: string | null }[]) || []) {
      if (a.satisfactory) trainerAssessmentsMap.set(a.question_id, a.satisfactory);
    }
  } catch (_e) {}

  let resultsOfficeMap = new Map<number, { entered_date: string | null; entered_by: string | null; initial_checked?: boolean; updated_checked?: boolean }>();
  let resultsDataMap = new Map<number, Record<string, string | null>>();
  try {
    const { data: officeRows } = await supabase
      .from('skyline_form_results_office')
      .select('section_id, entered_date, entered_by, initial_checked, updated_checked')
      .eq('instance_id', instanceId);
    for (const r of (officeRows as { section_id: number; entered_date: string | null; entered_by: string | null; initial_checked?: boolean | null; updated_checked?: boolean | null }[]) || []) {
      resultsOfficeMap.set(r.section_id, {
        entered_date: r.entered_date,
        entered_by: r.entered_by,
        initial_checked: Boolean(r.initial_checked ?? false),
        updated_checked: Boolean(r.updated_checked ?? false),
      });
    }
  } catch (_e) {}
  try {
    const { data: resultsRows } = await supabase
      .from('skyline_form_results_data')
      .select('section_id, first_attempt_satisfactory, first_attempt_date, first_attempt_feedback, second_attempt_satisfactory, second_attempt_date, second_attempt_feedback, third_attempt_satisfactory, third_attempt_date, third_attempt_feedback, student_name, student_signature, trainer_name, trainer_signature, trainer_date')
      .eq('instance_id', instanceId);
    for (const r of (resultsRows as Record<string, unknown>[]) || []) {
      const sid = r.section_id as number;
      resultsDataMap.set(sid, {
        first_attempt_satisfactory: (r.first_attempt_satisfactory as string) ?? null,
        first_attempt_date: (r.first_attempt_date as string) ?? null,
        first_attempt_feedback: (r.first_attempt_feedback as string) ?? null,
        second_attempt_satisfactory: (r.second_attempt_satisfactory as string) ?? null,
        second_attempt_date: (r.second_attempt_date as string) ?? null,
        second_attempt_feedback: (r.second_attempt_feedback as string) ?? null,
        third_attempt_satisfactory: (r.third_attempt_satisfactory as string) ?? null,
        third_attempt_date: (r.third_attempt_date as string) ?? null,
        third_attempt_feedback: (r.third_attempt_feedback as string) ?? null,
        student_name: (r.student_name as string) ?? null,
        student_signature: (r.student_signature as string) ?? null,
        trainer_name: (r.trainer_name as string) ?? null,
        trainer_signature: (r.trainer_signature as string) ?? null,
        trainer_date: (r.trainer_date as string) ?? null,
      });
    }
  } catch (_e) {}

  let assessmentSummaryMap = {};
  try {
    const { data: sumRow } = await supabase
      .from('skyline_form_assessment_summary_data')
      .select('*')
      .eq('instance_id', instanceId)
      .maybeSingle();
    if (sumRow) {
      const r = sumRow as Record<string, unknown>;
      assessmentSummaryMap = {
        start_date: (r.start_date as string) ?? null,
        end_date: (r.end_date as string) ?? null,
        final_attempt_1_result: (r.final_attempt_1_result as string) ?? null,
        final_attempt_2_result: (r.final_attempt_2_result as string) ?? null,
        final_attempt_3_result: (r.final_attempt_3_result as string) ?? null,
        trainer_sig_1: (r.trainer_sig_1 as string) ?? null,
        trainer_date_1: (r.trainer_date_1 as string) ?? null,
        trainer_sig_2: (r.trainer_sig_2 as string) ?? null,
        trainer_date_2: (r.trainer_date_2 as string) ?? null,
        trainer_sig_3: (r.trainer_sig_3 as string) ?? null,
        trainer_date_3: (r.trainer_date_3 as string) ?? null,
        student_sig_1: (r.student_sig_1 as string) ?? null,
        student_date_1: (r.student_date_1 as string) ?? null,
        student_sig_2: (r.student_sig_2 as string) ?? null,
        student_date_2: (r.student_date_2 as string) ?? null,
        student_sig_3: (r.student_sig_3 as string) ?? null,
        student_date_3: (r.student_date_3 as string) ?? null,
        student_overall_feedback: (r.student_overall_feedback as string) ?? null,
        admin_initials: (r.admin_initials as string) ?? null,
        admin_initial_checked: r.admin_initial_checked ? '1' : null,
        admin_updated_checked: r.admin_updated_checked ? '1' : null,
        reasonable_adjustment_task: (r.reasonable_adjustment_task as string) ?? null,
        reasonable_adjustment_explanation: (r.reasonable_adjustment_explanation as string) ?? null,
        trainer_assessor_name: (r.trainer_assessor_name as string) ?? null,
        trainer_assessor_signature: (r.trainer_assessor_signature as string) ?? null,
        trainer_assessor_date: (r.trainer_assessor_date as string) ?? null,
      };
    }
  } catch (_e) {}

  const answerMap = getAnswerMap((answers ?? []) as FormAnswer[]);

  const taskRowIds = new Set<number>();
  for (const g of template.steps) {
    for (const { section } of g.sections) {
      const sid = section.assessment_task_row_id;
      if (sid) taskRowIds.add(sid);
    }
  }
  const taskRowsMap = new Map<number, FormQuestionRow>();
  if (taskRowIds.size > 0) {
    const { data: taskRows } = await supabase
      .from('skyline_form_question_rows')
      .select('*')
      .in('id', Array.from(taskRowIds));
    for (const r of (taskRows ?? []) as FormQuestionRow[]) taskRowsMap.set(r.id, r);
  }

  const form = template.instance.form;
  const built = buildHtml({
    form: form,
    steps: template.steps,
    answers: answerMap,
    taskRowsMap,
    trainerAssessments: trainerAssessmentsMap,
    resultsOffice: resultsOfficeMap,
    resultsData: resultsDataMap,
    assessmentSummaryData: assessmentSummaryMap,
  });

  const { studentId, studentName } = extractStudentFieldsFromAnswers(template.steps, answerMap);
  const fileName = buildInstancePdfFileName({
    unitCode: built.unitCode,
    studentId,
    studentName,
    instanceId,
  });

  return { ...built, fileName };
}
