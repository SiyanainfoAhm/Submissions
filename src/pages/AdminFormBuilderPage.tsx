import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Eye, GripVertical, Trash2, ImagePlus, Copy, MoreVertical, ClipboardPaste } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { supabase } from '../lib/supabase';
import {
  fetchForm,
  updateForm,
  ensureTaskSectionsForForm,
  formNameExists,
  fetchFormBuilderTree,
  fetchSectionQuestionsForBuilder,
  getStepIdsLinkedToTaskRow,
  insertAssessmentTaskStepWithSections,
  logDuplicateAssessmentTaskSteps,
  nextAssessmentTaskLabel,
  type FormBuilderStep,
} from '../lib/formEngine';
import { uploadFormCoverImage, uploadRowImage, uploadQuestionImage } from '../lib/storage';
import { WRITTEN_EVIDENCE_CODE, WRITTEN_EVIDENCE_MODE, isWrittenEvidenceChecklistQuestion } from '../lib/writtenEvidenceChecklist';
import type { Form, FormStep, FormSection, FormQuestion, FormQuestionOption, FormQuestionRow, Json } from '../types/database';
import { Card } from '../components/ui/Card';
import { Loader } from '../components/ui/Loader';
import { Button } from '../components/ui/Button';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { Textarea } from '../components/ui/Textarea';
import { Checkbox } from '../components/ui/Checkbox';
import { TaskInstructionsModal, type TaskInstructionsData } from '../components/form-fill/TaskInstructionsModal';
import { SectionInstructionsEditor } from '../components/form-fill/SectionInstructionsEditor';
import { AdditionalInstructionsEditor } from '../components/form-fill/AdditionalInstructionsEditor';
import { QuestionInstructionEditor } from '../components/form-fill/QuestionInstructionEditor';
import {
  buildQuestionDuplicateInsertPayload,
  applyQuestionFieldUpdate,
  deepCloneJson,
} from '../lib/questionDuplicate';
import { remapPdfMetaQuestionIds } from '../lib/contentBlockClone';
import { getQuestionInstructionListLabel } from '../utils/questionInstructionLabel';
import { getTaskQuestionDisplayNumbers } from '../lib/taskQuestionsNumbering';
import { TableLayoutSelect } from '../components/form-fill/TableLayoutSelect';
import { cn } from '../components/utils/cn';

const FLUSH_PENDING_EVENT = 'form-builder:flush-pending';

async function pasteImageFromClipboard(): Promise<File | null> {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const type of item.types) {
        if (type.startsWith('image/')) {
          const blob = await item.getType(type);
          const ext = type === 'image/png' ? 'png' : type === 'image/gif' ? 'gif' : type === 'image/webp' ? 'webp' : 'jpg';
          return new File([blob], `pasted-image.${ext}`, { type });
        }
      }
    }
  } catch (e) {
    console.warn('Paste image failed:', e);
  }
  return null;
}

const QUESTION_TYPES = [
  { value: 'instruction_block', label: 'Instruction Block' },
  { value: 'short_text', label: 'Short Text' },
  { value: 'long_text', label: 'Long Text' },
  { value: 'yes_no', label: 'Yes/No' },
  { value: 'single_choice', label: 'Single Choice' },
  { value: 'multi_choice', label: 'Multi Choice' },
  { value: 'likert_5', label: 'Likert 5' },
  { value: 'grid_table', label: 'Grid Table' },
  { value: 'image', label: 'Image Upload' },
  { value: 'date', label: 'Date' },
  { value: 'signature', label: 'Signature' },
  { value: 'page_break', label: 'Page Break' },
];

const ROLES = [
  { value: 'student', label: 'Student' },
  { value: 'trainer', label: 'Trainer' },
  { value: 'office', label: 'Office' },
];

type GridColumnType = 'question' | 'answer';

interface GridTableColumnMeta {
  label: string;
  type: GridColumnType;
}

const GRID_COLUMN_TYPE_OPTIONS = [
  { value: 'answer', label: 'Answer (user input)' },
  { value: 'question', label: 'Question (row description)' },
];

const CONTENT_BLOCK_TYPES = [
  { value: 'instruction_block', label: 'Instruction block' },
  { value: 'grid_table', label: 'Grid table' },
  { value: 'short_text', label: 'Short text' },
  { value: 'long_text', label: 'Long text' },
  { value: 'image', label: 'Image' },
];

type ContentBlockType = 'instruction_block' | 'grid_table' | 'short_text' | 'long_text' | 'image';

type ImageLayoutOption = 'side_by_side' | 'above' | 'below';

interface ContentBlock {
  type: ContentBlockType;
  content?: string;
  questionId?: number;
  wordLimit?: number;
  /** Optional bold hint text above this block (e.g. "Painting terminology:", "Decorating terminologies:") */
  headerText?: string;
  /** Image URL (stored in photomedia/skyline/{questionId}/) for instruction_block, image block, or question blocks */
  imageUrl?: string;
  /** Layout: side_by_side (text+image), above (image then question), below (question then image) */
  imageLayout?: ImageLayoutOption;
  /** Image width % in side_by_side layout (default 50) */
  imageWidthPercent?: number;
  /** When true, image is rendered full-width (stacked, not side-by-side) */
  imageFullWidth?: boolean;
}

function normalizeGridColumnType(raw: unknown): GridColumnType {
  return String(raw).trim().toLowerCase() === 'question' ? 'question' : 'answer';
}

function normalizeWordLimit(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function getGridColumnsMeta(pm: Record<string, unknown>): GridTableColumnMeta[] {
  const rawMeta = pm.columnsMeta;
  if (Array.isArray(rawMeta)) {
    const parsed = rawMeta
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const e = entry as Record<string, unknown>;
        const label = String(e.label ?? '');
        return { label, type: normalizeGridColumnType(e.type) } as GridTableColumnMeta;
      })
      .filter((e) => e != null) as GridTableColumnMeta[];
    if (parsed.length > 0) return parsed;
  }

  const columns = Array.isArray(pm.columns) ? (pm.columns as unknown[]) : ['Column 1', 'Column 2'];
  const types = Array.isArray(pm.columnTypes) ? (pm.columnTypes as unknown[]) : [];
  return columns
    .map((c, idx) => ({
      label: String(c ?? ''),
      type: normalizeGridColumnType(types[idx]),
    })) as GridTableColumnMeta[];
}

function withGridColumnsMeta(pm: Record<string, unknown>, columnsMeta: GridTableColumnMeta[]): Json {
  const existingLimitsRaw = Array.isArray(pm.columnWordLimits) ? (pm.columnWordLimits as unknown[]) : [];
  const normalized = columnsMeta.map((c) => ({
    label: String(c.label ?? ''),
    type: normalizeGridColumnType(c.type),
  }));
  return {
    ...pm,
    columnsMeta: normalized,
    // keep legacy fields synced for backward compatibility
    columns: normalized.map((c) => c.label),
    columnTypes: normalized.map((c) => c.type),
    columnWordLimits: normalized.map((_, idx) => normalizeWordLimit(existingLimitsRaw[idx])),
  } as Json;
}

// Prebuilt sections: can be reordered but not deleted (steps 5-20)
const PREBUILT_SECTION_TITLES = [
  'Student and trainer details',
  'Qualification and unit of competency',
  'Assessment Tasks',
  'Assessment Submission Method',
  'Instructions to complete the outcomes of assessment',
  'Unit Requirements',
  'Feedback to student',
  'Plagiarism',
  'Collusion',
  'Competency outcome',
  'Additional evidence',
  'Reassessment',
  'Fail to complete by due date',
  'Reasonable Adjustment',
  'Confidentiality',
  'Assessment appeals process',
  'Recognised prior learning',
  'Special needs',
  'Student declaration',
];

function isPrebuiltSection(title: string): boolean {
  return PREBUILT_SECTION_TITLES.includes(title);
}

function isPrebuiltQuestion(question: FormQuestion): boolean {
  const code = question.code || '';
  return ['student.', 'trainer.', 'qualification.', 'unit.', 'assessment.', 'reasonable_adjustment.'].some((p) => code.startsWith(p));
}

type StepWithSections = FormBuilderStep;

function SortableStepItem({
  step,
  isSelected,
  onSelect,
  onUpdate,
  onRemove,
  onDuplicate,
  menuOpen,
  onMenuToggle,
  menuRef,
  isDuplicating = false,
}: {
  step: StepWithSections;
  isSelected: boolean;
  onSelect: () => void;
  onUpdate: (title: string) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  menuOpen: boolean;
  onMenuToggle: () => void;
  menuRef: React.RefObject<HTMLDivElement | null>;
  isDuplicating?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(step.title);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `step-${step.id}` });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'flex items-center gap-1 p-2 rounded-lg cursor-pointer border transition-colors group',
        isSelected ? 'border-[var(--brand)] bg-orange-50' : 'border-transparent hover:bg-gray-100',
        isDragging && 'opacity-50'
      )}
      onClick={onSelect}
    >
      <button
        type="button"
        className="p-0.5 rounded hover:bg-gray-200 cursor-grab active:cursor-grabbing touch-none"
        onClick={(e) => e.stopPropagation()}
        {...attributes}
        {...listeners}
        aria-label="Drag to reorder"
      >
        <GripVertical className="w-4 h-4 text-gray-500" />
      </button>
      <div className="flex-1 min-w-0">
        {editing ? (
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => {
              onUpdate(title);
              setEditing(false);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <div
            className="font-medium text-sm"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
          >
            {step.title}
          </div>
        )}
      </div>
      <div ref={menuOpen ? menuRef : undefined} className="relative flex shrink-0 items-center">
        <button
          type="button"
          data-step-menu-trigger
          className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded hover:bg-gray-100 text-gray-600 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => {
            e.stopPropagation();
            onMenuToggle();
          }}
          aria-label="More options"
        >
          <MoreVertical className="w-4 h-4" />
        </button>
        {menuOpen && (
          <div
            className="absolute right-0 top-full mt-0.5 z-20 min-w-[120px] rounded-md border border-[var(--border)] bg-white py-1 shadow-lg"
            role="menu"
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text)] hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={(e) => {
                e.stopPropagation();
                if (!isDuplicating) {
                  onDuplicate();
                  onMenuToggle();
                }
              }}
              disabled={isDuplicating}
              role="menuitem"
            >
              <Copy className="w-4 h-4" />
              {isDuplicating ? 'Duplicating…' : 'Duplicate'}
            </button>
          </div>
        )}
      </div>
      <button
        type="button"
        className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded hover:bg-red-100 text-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        aria-label="Remove step"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );
}

const PDF_RENDER_MODES = [
  { value: 'normal', label: 'Details Table' },
  { value: 'likert_table', label: 'Likert Table' },
  { value: 'grid_table', label: 'Grid Table' },
  { value: 'assessment_tasks', label: 'Assessment Tasks' },
  { value: 'assessment_submission', label: 'Assessment Submission' },
  { value: 'reasonable_adjustment', label: 'Reasonable Adjustment' },
  { value: 'reasonable_adjustment_indicator', label: 'Reasonable Adjustment (Appendix A reference)' },
  { value: 'declarations', label: 'Declarations' },
  { value: 'additional_instructions', label: 'Additional Instructions' },
  { value: 'task_instructions', label: 'Task Instructions' },
  { value: 'task_questions', label: 'Task Questions' },
  { value: 'task_written_evidence_checklist', label: 'Written Evidence Checklist' },
  { value: 'task_marking_checklist', label: 'Assessment Marking Checklist' },
  { value: 'task_results', label: 'Task Results' },
  { value: 'assessment_summary', label: 'Assessment Summary Sheet' },
];

interface AssessmentTaskRow {
  id: number;
  row_label: string;
}

function SortableSectionItem({
  section,
  isSelected,
  onSelect,
  onUpdate,
  onPdfModeChange,
  onAssessmentTaskRowChange,
  onRemove,
  onDuplicate,
  menuOpen,
  onMenuToggle,
  menuRef,
  canDelete = true,
  assessmentTaskRows = [],
  isDuplicating = false,
}: {
  section: FormSection & { questions: FormQuestion[] };
  isSelected: boolean;
  onSelect: () => void;
  onUpdate: (title: string) => void;
  onPdfModeChange: (mode: string) => void;
  onAssessmentTaskRowChange?: (rowId: number | null) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  menuOpen: boolean;
  onMenuToggle: () => void;
  menuRef: React.RefObject<HTMLDivElement | null>;
  canDelete?: boolean;
  assessmentTaskRows?: AssessmentTaskRow[];
  isDuplicating?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(section.title);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `section-${section.id}` });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'flex items-center gap-1 p-2 rounded-lg cursor-pointer border transition-colors group',
        isSelected ? 'border-[var(--brand)] bg-orange-50' : 'border-transparent hover:bg-gray-100',
        isDragging && 'opacity-50'
      )}
      onClick={onSelect}
    >
      <button
        type="button"
        className="p-0.5 rounded hover:bg-gray-200 cursor-grab active:cursor-grabbing touch-none shrink-0"
        onClick={(e) => e.stopPropagation()}
        {...attributes}
        {...listeners}
        aria-label="Drag to reorder"
      >
        <GripVertical className="w-4 h-4 text-gray-500" />
      </button>
      <div className="flex-1 min-w-0">
        {editing ? (
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => {
              onUpdate(title);
              setEditing(false);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <div
            className="text-sm"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
          >
            {section.title}
          </div>
        )}
        {isSelected && (
          <div onClick={(e) => e.stopPropagation()} className="mt-2 space-y-2 w-full min-w-0">
            <Select
              value={section.pdf_render_mode}
              onChange={onPdfModeChange}
              options={PDF_RENDER_MODES}
            />
            {(section.pdf_render_mode === 'task_instructions' || section.pdf_render_mode === 'task_questions' || section.pdf_render_mode === 'task_written_evidence_checklist' || section.pdf_render_mode === 'task_marking_checklist' || section.pdf_render_mode === 'task_results') && assessmentTaskRows.length > 0 && (
              <Select
                label="Link to task"
                value={String((section as { assessment_task_row_id?: number | null }).assessment_task_row_id ?? '')}
                onChange={(v) => onAssessmentTaskRowChange?.(v ? Number(v) : null)}
                options={[{ value: '', label: '— Select task —' }, ...assessmentTaskRows.map((r) => ({ value: String(r.id), label: r.row_label }))]}
              />
            )}
          </div>
        )}
      </div>
      <div ref={menuOpen ? menuRef : undefined} className="relative flex shrink-0 items-center">
        <button
          type="button"
          data-section-menu-trigger
          className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded hover:bg-gray-100 text-gray-600 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => {
            e.stopPropagation();
            onMenuToggle();
          }}
          aria-label="More options"
        >
          <MoreVertical className="w-4 h-4" />
        </button>
        {menuOpen && (
          <div
            className="absolute right-0 top-full mt-0.5 z-20 min-w-[120px] rounded-md border border-[var(--border)] bg-white py-1 shadow-lg"
            role="menu"
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text)] hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={(e) => {
                e.stopPropagation();
                if (!isDuplicating) {
                  onDuplicate();
                  onMenuToggle();
                }
              }}
              disabled={isDuplicating}
              role="menuitem"
            >
              <Copy className="w-4 h-4" />
              {isDuplicating ? 'Duplicating…' : 'Duplicate'}
            </button>
          </div>
        )}
      </div>
      {canDelete && (
        <button
          type="button"
          className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded hover:bg-red-100 text-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label="Remove section"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

function SortableQuestionItem({
  question,
  index,
  totalCount,
  isSelected,
  onSelect,
  onRemove,
  onDuplicate,
  canDelete = true,
  menuOpen,
  onMenuToggle,
  menuRef,
  isInstruction = false,
  questionDisplayNumber,
  numberedQuestionTotal,
}: {
  question: FormQuestion;
  index: number;
  totalCount: number;
  isSelected: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onDuplicate: () => void;
  canDelete?: boolean;
  menuOpen: boolean;
  onMenuToggle: () => void;
  menuRef: React.RefObject<HTMLDivElement | null>;
  isInstruction?: boolean;
  /** When set (task_questions), instructions/page_breaks do not consume a Q number. */
  questionDisplayNumber?: number;
  numberedQuestionTotal?: number;
}) {
  const listNumber = questionDisplayNumber ?? index + 1;
  const listTotal = numberedQuestionTotal ?? totalCount;
  const isPageBreak = question.type === 'page_break';
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `question-${question.id}` });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'flex items-center gap-1 p-2 rounded-lg cursor-pointer border text-sm transition-colors group',
        isSelected ? 'border-[var(--brand)] bg-orange-50' : 'border-transparent hover:bg-gray-100',
        isDragging && 'opacity-50'
      )}
      onClick={onSelect}
    >
      <button
        type="button"
        className="p-0.5 rounded hover:bg-gray-200 cursor-grab active:cursor-grabbing touch-none shrink-0"
        onClick={(e) => e.stopPropagation()}
        {...attributes}
        {...listeners}
        aria-label="Drag to reorder"
      >
        <GripVertical className="w-4 h-4 text-gray-500" />
      </button>
      <div
        className="flex-1 min-w-0 truncate"
        title={isInstruction ? 'Instruction' : isPageBreak ? 'Page break' : `Question ${listNumber} of ${listTotal}`}
      >
        {isInstruction ? (
          <span className="text-amber-800">Instruction: {getQuestionInstructionListLabel(question)}</span>
        ) : isPageBreak ? (
          <span className="text-gray-500 italic">Page break</span>
        ) : questionDisplayNumber != null ? (
          <>{questionDisplayNumber}. {question.label || question.type}</>
        ) : (
          <>{listNumber}. {question.label || question.type}</>
        )}
      </div>
      <div ref={menuRef} className="relative shrink-0">
        <button
          type="button"
          data-question-menu-trigger
          className="p-0.5 rounded hover:bg-gray-200 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => {
            e.stopPropagation();
            onMenuToggle();
          }}
          aria-label="More options"
        >
          <MoreVertical className="w-4 h-4 text-gray-500" />
        </button>
        {menuOpen && (
          <div
            className="absolute right-0 top-full mt-0.5 z-20 min-w-[120px] rounded-md border border-[var(--border)] bg-white py-1 shadow-lg"
            role="menu"
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text)] hover:bg-gray-100"
              onClick={(e) => {
                e.stopPropagation();
                onDuplicate();
                onMenuToggle();
              }}
              role="menuitem"
            >
              <Copy className="w-4 h-4" />
              Duplicate
            </button>
          </div>
        )}
      </div>
      {canDelete && (
        <button
          type="button"
          className="p-0.5 rounded hover:bg-red-100 text-red-600 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label="Remove question"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

export const AdminFormBuilderPage: React.FC = () => {
  const { formId } = useParams<{ formId: string }>();
  const [form, setForm] = useState<Form | null>(null);
  const [steps, setSteps] = useState<StepWithSections[]>([]);
  const [selectedStepId, setSelectedStepId] = useState<number | null>(null);
  const [selectedSectionId, setSelectedSectionId] = useState<number | null>(null);
  const [editingQuestionId, setEditingQuestionId] = useState<number | null>(null);
  const [autoOpenInstructionQuestionId, setAutoOpenInstructionQuestionId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [coverUploading, setCoverUploading] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<{ type: 'step' | 'section' | 'question'; id: number } | null>(null);
  const [assessmentTaskRows, setAssessmentTaskRows] = useState<AssessmentTaskRow[]>([]);
  const [openStepMenuId, setOpenStepMenuId] = useState<number | null>(null);
  const [openSectionMenuId, setOpenSectionMenuId] = useState<number | null>(null);
  const [openQuestionMenuId, setOpenQuestionMenuId] = useState<number | null>(null);
  const [duplicatingStepId, setDuplicatingStepId] = useState<number | null>(null);
  const [duplicatingSectionId, setDuplicatingSectionId] = useState<number | null>(null);
  const [loadingSectionTypeChange, setLoadingSectionTypeChange] = useState<number | null>(null);
  const stepMenuRef = useRef<HTMLDivElement | null>(null);
  const sectionMenuRef = useRef<HTMLDivElement | null>(null);
  const questionMenuRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();
  const coverInputRef = React.useRef<HTMLInputElement>(null);
  const lastSavedFormNameRef = useRef<string>('');
  const questionPendingUpdates = useRef<Record<number, Partial<FormQuestion>>>({});
  const questionSaveTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const questionBlurSavePromise = useRef<Promise<void> | null>(null);
  const QUESTION_SAVE_DEBOUNCE_MS = 450;

  const assessmentTasksGridQuestionId = useMemo(() => {
    for (const step of steps) {
      const sec = step.sections.find((s) => s.pdf_render_mode === 'assessment_tasks');
      if (!sec) continue;
      const gridQ = sec.questions.find((q) => q.type === 'grid_table');
      if (gridQ) return gridQ.id;
    }
    return null;
  }, [steps]);

  useEffect(() => {
    if (assessmentTasksGridQuestionId == null) {
      setAssessmentTaskRows([]);
      return;
    }
    let cancelled = false;
    supabase
      .from('skyline_form_question_rows')
      .select('id, row_label')
      .eq('question_id', assessmentTasksGridQuestionId)
      .order('sort_order')
      .then(({ data }) => {
        if (!cancelled) setAssessmentTaskRows((data as AssessmentTaskRow[]) || []);
      });
    return () => { cancelled = true; };
  }, [assessmentTasksGridQuestionId]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-step-menu-trigger]')) return;
      if (openStepMenuId !== null && stepMenuRef.current && !stepMenuRef.current.contains(target)) {
        setOpenStepMenuId(null);
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [openStepMenuId]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-section-menu-trigger]')) return;
      if (openSectionMenuId !== null && sectionMenuRef.current && !sectionMenuRef.current.contains(target)) {
        setOpenSectionMenuId(null);
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [openSectionMenuId]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-question-menu-trigger]')) return;
      if (openQuestionMenuId !== null && questionMenuRef.current && !questionMenuRef.current.contains(target)) {
        setOpenQuestionMenuId(null);
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [openQuestionMenuId]);

  const handleCoverUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !formId || !form) return;
    if (!file.type.startsWith('image/')) {
      alert('Please select an image file (JPEG, PNG, WebP, or GIF)');
      return;
    }
    setCoverUploading(true);
    try {
      const { url, error: uploadError } = await uploadFormCoverImage(Number(formId), file);
      if (uploadError) {
        alert(`Upload failed: ${uploadError}\n\nAdd INSERT policy on photomedia bucket. See scripts/fix-storage-policies.sql`);
        return;
      }
      if (url) {
        const { error } = await updateForm(Number(formId), { cover_asset_url: url });
        if (error) {
          console.error('Failed to save cover URL:', error);
          alert(`Upload succeeded but save failed: ${error.message}. Run scripts/fix-cover-column.sql`);
          return;
        }
        setForm((prev) => (prev ? { ...prev, cover_asset_url: url } : null));
      }
    } catch (err) {
      console.error(err);
      alert(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCoverUploading(false);
      e.target.value = '';
    }
  };

  const loadData = useCallback(async () => {
    if (!formId) return;
    const fid = Number(formId);
    await ensureTaskSectionsForForm(fid);
    await logDuplicateAssessmentTaskSteps(fid);
    const [f, stepsWithSections] = await Promise.all([
      fetchForm(fid, { allowInactiveForAdmin: true }),
      fetchFormBuilderTree(fid),
    ]);
    setForm(f || null);
    if (f) lastSavedFormNameRef.current = f.name || '';
    setSteps(stepsWithSections);
    if (stepsWithSections.length > 0 && !selectedStepId) setSelectedStepId(stepsWithSections[0].id);
    setLoading(false);
  }, [formId]);

  const refreshStepsTree = useCallback(async () => {
    if (!formId) return;
    const fid = Number(formId);
    const stepsWithSections = await fetchFormBuilderTree(fid);
    setSteps(stepsWithSections);
  }, [formId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    return () => {
      Object.keys(questionSaveTimers.current).forEach((id) => {
        clearTimeout(questionSaveTimers.current[Number(id)]);
        const pending = questionPendingUpdates.current[Number(id)];
        if (pending && Object.keys(pending).length > 0) {
          supabase.from('skyline_form_questions').update(pending).eq('id', Number(id));
        }
      });
      questionSaveTimers.current = {};
      questionPendingUpdates.current = {};
    };
  }, []);

  useEffect(() => {
    const handler = () => {
      Object.keys(questionSaveTimers.current).forEach((id) => {
        clearTimeout(questionSaveTimers.current[Number(id)]);
        const pending = questionPendingUpdates.current[Number(id)];
        if (pending && Object.keys(pending).length > 0) {
          supabase.from('skyline_form_questions').update(pending).eq('id', Number(id));
        }
      });
      window.dispatchEvent(new CustomEvent(FLUSH_PENDING_EVENT, { detail: { addPromises: () => {} } }));
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const selectedStep = steps.find((s) => s.id === selectedStepId);
  const selectedSection = selectedStep?.sections.find((s) => s.id === selectedSectionId);

  const addStep = async () => {
    if (!formId) return;
    const { data } = await supabase
      .from('skyline_form_steps')
      .insert({ form_id: Number(formId), title: `Step ${steps.length + 1}`, sort_order: steps.length })
      .select('*')
      .single();
    if (data) {
      setSteps((prev) => [...prev, { ...data, sections: [] }]);
      setSelectedStepId(data.id);
    }
  };

  const updateStep = async (stepId: number, updates: Partial<FormStep>) => {
    await supabase.from('skyline_form_steps').update(updates).eq('id', stepId);
    setSteps((prev) =>
      prev.map((s) => (s.id === stepId ? { ...s, ...updates } : s))
    );
    if (updates.title != null) {
      const nextTitle = updates.title;
      const step = steps.find((s) => s.id === stepId);
      const taskLinkedModes = ['task_instructions', 'task_questions', 'task_written_evidence_checklist', 'task_marking_checklist', 'task_results'];
      const firstTaskSec = step?.sections.find((sec) => taskLinkedModes.includes(sec.pdf_render_mode));
      const rowId = firstTaskSec ? (firstTaskSec as FormSection & { assessment_task_row_id?: number | null }).assessment_task_row_id : null;
      if (rowId != null) {
        await supabase.from('skyline_form_question_rows').update({ row_label: nextTitle }).eq('id', rowId);
        setAssessmentTaskRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, row_label: nextTitle } : r)));
      }
    }
  };

  const addSection = async () => {
    if (!selectedStepId) return;
    const taskLinkedModes = ['task_instructions', 'task_questions', 'task_written_evidence_checklist', 'task_marking_checklist', 'task_results'];
    const firstTaskSec = selectedStep?.sections.find((sec) => taskLinkedModes.includes(sec.pdf_render_mode));
    const defaultRowId = firstTaskSec ? (firstTaskSec as FormSection & { assessment_task_row_id?: number | null }).assessment_task_row_id ?? null : null;
    const insertPayload: Record<string, unknown> = {
      step_id: selectedStepId,
      title: `Section ${(selectedStep?.sections.length || 0) + 1}`,
      sort_order: selectedStep?.sections.length || 0,
    };
    if (defaultRowId != null) insertPayload.assessment_task_row_id = defaultRowId;
    const { data } = await supabase
      .from('skyline_form_sections')
      .insert(insertPayload)
      .select('*')
      .single();
    if (data) {
      setSteps((prev) =>
        prev.map((s) =>
          s.id === selectedStepId
            ? { ...s, sections: [...s.sections, { ...data, questions: [] }] }
            : s
        )
      );
      setSelectedSectionId(data.id);
    }
  };

  const updateSection = async (sectionId: number, updates: Partial<FormSection>) => {
    await supabase.from('skyline_form_sections').update(updates).eq('id', sectionId);
    setSteps((prev) =>
      prev.map((s) => ({
        ...s,
        sections: s.sections.map((sec) =>
          sec.id === sectionId ? { ...sec, ...updates } : sec
        ),
      }))
    );
  };

  const ensureWrittenEvidenceChecklistQuestion = async (sectionId: number) => {
    const section = steps.flatMap((s) => s.sections).find((sec) => sec.id === sectionId);
    if (!section) return;
    const hasChecklistQ = section.questions?.some((q) => q.code === 'written.evidence.checklist');
    if (hasChecklistQ) return;
    const { data: writtenQ } = await supabase
      .from('skyline_form_questions')
      .insert({
        section_id: sectionId,
        type: 'single_choice',
        code: 'written.evidence.checklist',
        label: 'Written Evidence Checklist',
        sort_order: 0,
        role_visibility: { student: false, trainer: true, office: true },
        role_editability: { student: false, trainer: true, office: true },
      })
      .select('*')
      .single();
    if (!writtenQ) return;
    await supabase.from('skyline_form_question_options').insert([
      { question_id: (writtenQ as FormQuestion).id, value: 'yes', label: 'Yes', sort_order: 0 },
      { question_id: (writtenQ as FormQuestion).id, value: 'no', label: 'No', sort_order: 1 },
    ]);
    const { data: opts } = await supabase.from('skyline_form_question_options').select('*').eq('question_id', (writtenQ as FormQuestion).id).order('sort_order');
    const questionWithOptions = {
      ...writtenQ,
      options: (opts as FormQuestionOption[]) ?? [],
      rows: [] as FormQuestionRow[],
    };
    setSteps((prev) =>
      prev.map((s) => ({
        ...s,
        sections: s.sections.map((sec) =>
          sec.id === sectionId
            ? { ...sec, questions: [...(sec.questions || []), questionWithOptions] }
            : sec
        ),
      }))
    );
    setEditingQuestionId((writtenQ as FormQuestion).id);
  };

  const refreshSectionInState = useCallback(async (sectionId: number) => {
    const questionsWithExtras = await fetchSectionQuestionsForBuilder(sectionId);
    if (questionsWithExtras.length === 0) return;
    setSteps((prev) =>
      prev.map((s) => ({
        ...s,
        sections: s.sections.map((sec) =>
          sec.id === sectionId ? { ...sec, questions: questionsWithExtras } : sec
        ),
      }))
    );
  }, []);

  const ensureMarkingChecklistQuestions = async (sectionId: number) => {
    const section = steps.flatMap((s) => s.sections).find((sec) => sec.id === sectionId);
    if (!section) return;
    const hasEvidenceOutcome = section.questions?.some((q) => q.code === 'assessment.marking.evidence_outcome');
    if (hasEvidenceOutcome) return;
    const { data: evidenceQ } = await supabase.from('skyline_form_questions').insert({
      section_id: sectionId, type: 'single_choice', code: 'assessment.marking.evidence_outcome', label: 'Evidence Outcome', sort_order: 0,
      role_visibility: { student: false, trainer: true, office: true }, role_editability: { student: false, trainer: true, office: true },
    }).select('id').single();
    if (evidenceQ) {
      const evId = (evidenceQ as { id: number }).id;
      await supabase.from('skyline_form_question_options').insert([
        { question_id: evId, value: 'yes', label: 'Yes', sort_order: 0 },
        { question_id: evId, value: 'no', label: 'No', sort_order: 1 },
      ]);
    }
    const { data: perfQ } = await supabase.from('skyline_form_questions').insert({
      section_id: sectionId, type: 'single_choice', code: 'assessment.marking.performance_outcome', label: 'Performance Outcome', sort_order: 1,
      role_visibility: { student: false, trainer: true, office: true }, role_editability: { student: false, trainer: true, office: true },
    }).select('id').single();
    if (perfQ) {
      await supabase.from('skyline_form_question_options').insert([
        { question_id: (perfQ as { id: number }).id, value: 'yes', label: 'Yes', sort_order: 0 },
        { question_id: (perfQ as { id: number }).id, value: 'no', label: 'No', sort_order: 1 },
      ]);
    }
    await refreshSectionInState(sectionId);
  };

  const handlePdfModeChange = async (sectionId: number, mode: string) => {
    const needsLoading = mode === 'task_written_evidence_checklist' || mode === 'task_marking_checklist';
    if (needsLoading) setLoadingSectionTypeChange(sectionId);
    try {
      await updateSection(sectionId, { pdf_render_mode: mode });
      if (mode === 'task_written_evidence_checklist') {
        await ensureWrittenEvidenceChecklistQuestion(sectionId);
      } else if (mode === 'task_marking_checklist') {
        await ensureMarkingChecklistQuestions(sectionId);
      }
    } finally {
      if (needsLoading) setLoadingSectionTypeChange(null);
    }
  };

  const removeStep = (stepId: number) => {
    setConfirmRemove({ type: 'step', id: stepId });
  };

  const executeRemoveStep = async (stepId: number) => {
    const step = steps.find((s) => s.id === stepId);
    const firstTaskSec = step?.sections?.find(
      (s) => (s as { assessment_task_row_id?: number | null }).assessment_task_row_id != null
    );
    const rowId = firstTaskSec
      ? (firstTaskSec as { assessment_task_row_id?: number | null }).assessment_task_row_id
      : null;

    let shouldDeleteGridRow = false;
    if (rowId != null && formId) {
      const linkedStepIds = await getStepIdsLinkedToTaskRow(Number(formId), rowId);
      shouldDeleteGridRow = linkedStepIds.length === 1 && linkedStepIds[0] === stepId;
    }

    await supabase.from('skyline_form_steps').delete().eq('id', stepId);
    setSteps((prev) => prev.filter((s) => s.id !== stepId));
    if (selectedStepId === stepId) {
      const remaining = steps.filter((s) => s.id !== stepId);
      setSelectedStepId(remaining[0]?.id ?? null);
      setSelectedSectionId(remaining[0]?.sections[0]?.id ?? null);
    }

    if (shouldDeleteGridRow && rowId != null) {
      await supabase.from('skyline_form_question_rows').delete().eq('id', rowId);
      setAssessmentTaskRows((prev) => prev.filter((r) => r.id !== rowId));
    }
  };

  const removeSection = (sectionId: number) => {
    setConfirmRemove({ type: 'section', id: sectionId });
  };

  const executeRemoveSection = async (sectionId: number) => {
    await supabase.from('skyline_form_sections').delete().eq('id', sectionId);
    setSteps((prev) =>
      prev.map((s) => ({
        ...s,
        sections: s.sections.filter((sec) => sec.id !== sectionId),
      }))
    );
    if (selectedSectionId === sectionId) {
      const step = steps.find((s) => s.id === selectedStepId);
      const remaining = (step?.sections ?? []).filter((s) => s.id !== sectionId);
      setSelectedSectionId(remaining[0]?.id ?? null);
    }
  };

  const duplicateStep = async (stepId: number) => {
    if (!formId) return;
    setDuplicatingStepId(stepId);
    try {
    const step = steps.find((s) => s.id === stepId);
    if (!step) return;
    const stepIndex = steps.findIndex((s) => s.id === stepId);
    const newSortOrder = step.sort_order + 1;
    const taskLinkedModes = ['task_instructions', 'task_questions', 'task_written_evidence_checklist', 'task_marking_checklist', 'task_results'];
    const isTaskStep = step.sections.some((sec) => taskLinkedModes.includes(sec.pdf_render_mode));
    let newStepTitle = `${step.title} (Copy)`;
    if (isTaskStep && assessmentTasksGridQuestionId != null) {
      const { data: existingRows } = await supabase
        .from('skyline_form_question_rows')
        .select('row_label')
        .eq('question_id', assessmentTasksGridQuestionId);
      const labels = (existingRows as { row_label: string }[]) ?? [];
      newStepTitle = nextAssessmentTaskLabel(labels.map((r) => r.row_label));
    }
    const { data: newStep } = await supabase
      .from('skyline_form_steps')
      .insert({ form_id: Number(formId), title: newStepTitle, subtitle: step.subtitle, sort_order: newSortOrder })
      .select('*')
      .single();
    if (!newStep) return;
    for (const s of steps) {
      if (s.sort_order >= newSortOrder && s.id !== stepId) {
        await supabase.from('skyline_form_steps').update({ sort_order: s.sort_order + 1 }).eq('id', s.id);
      }
    }
    // If this step has task-linked sections, create a new row in the assessment tasks grid and link sections to it
    let newRowId: number | null = null;
    const firstTaskSec = step.sections.find((sec) => taskLinkedModes.includes(sec.pdf_render_mode));
    const origRowId = firstTaskSec ? (firstTaskSec as FormSection & { assessment_task_row_id?: number | null }).assessment_task_row_id : null;
    if (assessmentTasksGridQuestionId != null && origRowId != null) {
      const { data: origRow } = await supabase.from('skyline_form_question_rows').select('row_help, row_meta').eq('id', origRowId).single();
      const { data: existingRows } = await supabase.from('skyline_form_question_rows').select('sort_order').eq('question_id', assessmentTasksGridQuestionId);
      const maxSort = existingRows?.length ? Math.max(...(existingRows as { sort_order: number }[]).map((r) => r.sort_order)) : -1;
      const nextSort = maxSort + 1;
      const { data: newRow } = await supabase
        .from('skyline_form_question_rows')
        .insert({
          question_id: assessmentTasksGridQuestionId,
          row_label: newStepTitle,
          row_help: origRow ? (origRow as { row_help: string | null }).row_help : null,
          row_meta: origRow ? (origRow as { row_meta: unknown }).row_meta : {},
          sort_order: nextSort,
        })
        .select('id')
        .single();
      if (newRow) newRowId = (newRow as { id: number }).id;
    }
    const newStepWithSections = { ...newStep, sections: [] as (FormSection & { questions: FormQuestion[] })[] };
    for (const sec of step.sections) {
      const secWithRow = sec as FormSection & { assessment_task_row_id?: number | null };
      const isTaskLinked = taskLinkedModes.includes(sec.pdf_render_mode);
      const rowIdForSec = isTaskLinked && newRowId != null ? newRowId : (secWithRow.assessment_task_row_id ?? null);
      const { data: newSec } = await supabase
        .from('skyline_form_sections')
        .insert({
          step_id: (newStep as FormStep).id,
          title: sec.title,
          description: sec.description,
          pdf_render_mode: sec.pdf_render_mode,
          sort_order: sec.sort_order,
          assessment_task_row_id: rowIdForSec,
        })
        .select('*')
        .single();
      if (!newSec) continue;
      const newSecWithQs = { ...newSec, questions: [] as FormQuestion[] };
      const { data: questions } = await supabase.from('skyline_form_questions').select('*').eq('section_id', sec.id).order('sort_order');
      const questionIdMap = new Map<number, number>();
      for (const q of (questions as FormQuestion[]) || []) {
        const insertPayload = buildQuestionDuplicateInsertPayload(q, {
          sectionId: (newSec as FormSection).id,
          sortOrder: q.sort_order ?? 0,
          clearContentBlockQuestionIds: false,
          clearCode: false,
        });
        // Keep original labels when duplicating a whole assessment task step.
        insertPayload.label = q.label;
        insertPayload.code = q.code ?? null;
        const { data: newQ } = await supabase
          .from('skyline_form_questions')
          .insert(insertPayload)
          .select('*')
          .single();
        if (!newQ) continue;
        const newQuestionId = (newQ as FormQuestion).id;
        questionIdMap.set(q.id, newQuestionId);
        const { data: opts } = await supabase.from('skyline_form_question_options').select('*').eq('question_id', q.id).order('sort_order');
        if ((opts as { value: string; label: string; sort_order: number }[])?.length) {
          await supabase.from('skyline_form_question_options').insert(
            (opts as { value: string; label: string; sort_order: number }[]).map((o) => ({
              question_id: newQuestionId,
              value: o.value,
              label: o.label,
              sort_order: o.sort_order,
            }))
          );
        }
        const { data: rows } = await supabase.from('skyline_form_question_rows').select('*').eq('question_id', q.id).order('sort_order');
        for (const r of (rows as { row_label: string; row_help: string | null; row_image_url: string | null; row_meta: unknown; sort_order: number }[]) || []) {
          await supabase.from('skyline_form_question_rows').insert({
            question_id: newQuestionId,
            row_label: r.row_label,
            row_help: r.row_help,
            row_image_url: r.row_image_url,
            row_meta: deepCloneJson(r.row_meta ?? {}),
            sort_order: r.sort_order,
          });
        }
        newSecWithQs.questions.push(newQ as FormQuestion);
      }
      // Rewire contentBlocks / isAdditionalBlockOf onto the newly inserted question IDs.
      for (const cq of newSecWithQs.questions) {
        const remapped = remapPdfMetaQuestionIds(cq.pdf_meta, questionIdMap);
        if (!remapped) continue;
        await supabase.from('skyline_form_questions').update({ pdf_meta: remapped as unknown as Json }).eq('id', cq.id);
        cq.pdf_meta = remapped as unknown as FormQuestion['pdf_meta'];
      }
      newStepWithSections.sections.push(newSecWithQs);
    }
    const reordered = [...steps];
    reordered.splice(stepIndex + 1, 0, newStepWithSections);
    setSteps(reordered);
    setSelectedStepId((newStep as FormStep).id);
    setSelectedSectionId(newStepWithSections.sections[0]?.id ?? null);
    if (newRowId != null && assessmentTasksGridQuestionId != null) {
      const { data } = await supabase.from('skyline_form_question_rows').select('id, row_label').eq('question_id', assessmentTasksGridQuestionId).order('sort_order');
      setAssessmentTaskRows((data as AssessmentTaskRow[]) || []);
    }
    } finally {
      setDuplicatingStepId(null);
    }
  };

  const duplicateSection = async (sectionId: number) => {
    if (!selectedStepId) return;
    setDuplicatingSectionId(sectionId);
    try {
    const step = steps.find((s) => s.id === selectedStepId);
    if (!step) return;
    const section = step.sections.find((s) => s.id === sectionId);
    if (!section) return;
    const secIndex = step.sections.findIndex((s) => s.id === sectionId);
    const secWithRow = section as FormSection & { assessment_task_row_id?: number | null };
    // Task-linked sections: do not inherit the original task link when duplicating, so the user explicitly selects the correct task
    const isTaskLinked = ['task_results', 'task_instructions', 'task_questions', 'task_written_evidence_checklist', 'task_marking_checklist'].includes(section.pdf_render_mode);
    const newRowId = isTaskLinked ? null : (secWithRow.assessment_task_row_id ?? null);
    const { data: newSec } = await supabase
      .from('skyline_form_sections')
      .insert({
        step_id: selectedStepId,
        title: section.title,
        description: section.description,
        pdf_render_mode: section.pdf_render_mode,
        sort_order: section.sort_order + 1,
        assessment_task_row_id: newRowId,
      })
      .select('*')
      .single();
    if (!newSec) return;
    for (const s of step.sections) {
      if (s.sort_order > section.sort_order) {
        await supabase.from('skyline_form_sections').update({ sort_order: s.sort_order + 1 }).eq('id', s.id);
      }
    }
    // Don't duplicate questions - new section is empty (user adds questions as needed)
    const newQuestions: FormQuestion[] = [];
    setSteps((prev) =>
      prev.map((s) => {
        if (s.id !== selectedStepId) return s;
        const reordered = [...s.sections];
        const newSecWithQs = { ...newSec, questions: newQuestions };
        reordered.splice(secIndex + 1, 0, newSecWithQs);
        return { ...s, sections: reordered };
      })
    );
    setSelectedSectionId((newSec as FormSection).id);
    } finally {
      setDuplicatingSectionId(null);
    }
  };

  const handleStepsDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (!activeId.startsWith('step-') || !overId.startsWith('step-')) return;
    const oldIndex = steps.findIndex((s) => `step-${s.id}` === activeId);
    const newIndex = steps.findIndex((s) => `step-${s.id}` === overId);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(steps, oldIndex, newIndex);
    setSteps(reordered);
    for (let i = 0; i < reordered.length; i++) {
      await supabase.from('skyline_form_steps').update({ sort_order: i }).eq('id', reordered[i].id);
    }
  };

  const handleSectionsDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !selectedStepId) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (!activeId.startsWith('section-') || !overId.startsWith('section-')) return;
    const step = steps.find((s) => s.id === selectedStepId);
    if (!step) return;
    const oldIndex = step.sections.findIndex((s) => `section-${s.id}` === activeId);
    const newIndex = step.sections.findIndex((s) => `section-${s.id}` === overId);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(step.sections, oldIndex, newIndex);
    setSteps((prev) =>
      prev.map((s) =>
        s.id === selectedStepId ? { ...s, sections: reordered } : s
      )
    );
    for (let i = 0; i < reordered.length; i++) {
      await supabase.from('skyline_form_sections').update({ sort_order: i }).eq('id', reordered[i].id);
    }
  };

  const stepSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const sectionSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const questionSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const removeQuestion = (questionId: number) => {
    setConfirmRemove({ type: 'question', id: questionId });
  };

  const handleConfirmRemove = async () => {
    if (!confirmRemove) return;
    const item = confirmRemove;
    setConfirmRemove(null);
    if (item.type === 'step') await executeRemoveStep(item.id);
    else if (item.type === 'section') await executeRemoveSection(item.id);
    else await executeRemoveQuestion(item.id);
  };

  const getConfirmDialogConfig = () => {
    if (!confirmRemove) return null;
    if (confirmRemove.type === 'step') {
      return { title: 'Remove Step', message: 'Remove this step? All sections and questions in it will be deleted.', confirmLabel: 'Remove' };
    }
    if (confirmRemove.type === 'section') {
      return { title: 'Remove Section', message: 'Remove this section? All questions in it will be deleted.', confirmLabel: 'Remove' };
    }
    return { title: 'Remove Question', message: 'Remove this question? Options and rows will be deleted.', confirmLabel: 'Remove' };
  };

  const executeRemoveQuestion = async (questionId: number) => {
    await supabase.from('skyline_form_questions').delete().eq('id', questionId);
    setSteps((prev) =>
      prev.map((s) => ({
        ...s,
        sections: s.sections.map((sec) => ({
          ...sec,
          questions: sec.questions.filter((q) => q.id !== questionId),
        })),
      }))
    );
    if (editingQuestionId === questionId) {
      const remaining = (selectedSection?.questions ?? []).filter((q) => q.id !== questionId);
      setEditingQuestionId(remaining[0]?.id ?? null);
    }
  };

  const handleQuestionsDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !selectedSectionId) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (!activeId.startsWith('question-') || !overId.startsWith('question-')) return;
    const questions = selectedSection?.questions ?? [];
    const mainQuestions = questions.filter((q) => !(q.pdf_meta as Record<string, unknown>)?.isAdditionalBlockOf);
    const children = questions.filter((q) => (q.pdf_meta as Record<string, unknown>)?.isAdditionalBlockOf);
    const oldIndex = mainQuestions.findIndex((q) => `question-${q.id}` === activeId);
    const newIndex = mainQuestions.findIndex((q) => `question-${q.id}` === overId);
    if (oldIndex === -1 || newIndex === -1 || !selectedSection) return;
    const reorderedMain = arrayMove(mainQuestions, oldIndex, newIndex);
    const reordered: FormQuestion[] = [];
    for (const main of reorderedMain) {
      reordered.push(main);
      reordered.push(...children.filter((c) => (c.pdf_meta as Record<string, unknown>)?.isAdditionalBlockOf === main.id));
    }
    setSteps((prev) =>
      prev.map((s) => ({
        ...s,
        sections: s.sections.map((sec) =>
          sec.id === selectedSectionId ? { ...sec, questions: reordered } : sec
        ),
      }))
    );
    for (let i = 0; i < reordered.length; i++) {
      await supabase.from('skyline_form_questions').update({ sort_order: i }).eq('id', reordered[i].id);
    }
  };

  const addQuestion = async () => {
    if (!selectedSectionId) return;
    // Written Evidence Checklist sections: new questions are checklist questions out of the box
    // (single choice yes/no, rows supported, trainer + office), not a plain short-text question.
    const isChecklistSection = selectedSection?.pdf_render_mode === WRITTEN_EVIDENCE_MODE;
    const { data: rawData } = await supabase
      .from('skyline_form_questions')
      .insert(
        isChecklistSection
          ? {
              section_id: selectedSectionId,
              type: 'single_choice',
              code: WRITTEN_EVIDENCE_CODE,
              label: 'Written Evidence Checklist',
              sort_order: selectedSection?.questions.length || 0,
              role_visibility: { student: false, trainer: true, office: true },
              role_editability: { student: false, trainer: true, office: true },
            }
          : {
              section_id: selectedSectionId,
              type: 'short_text',
              label: 'New Question',
              sort_order: selectedSection?.questions.length || 0,
            },
      )
      .select('*')
      .single();
    let data = rawData;
    if (data && isChecklistSection) {
      await supabase.from('skyline_form_question_options').insert([
        { question_id: (data as FormQuestion).id, value: 'yes', label: 'Yes', sort_order: 0 },
        { question_id: (data as FormQuestion).id, value: 'no', label: 'No', sort_order: 1 },
      ]);
      const { data: opts } = await supabase.from('skyline_form_question_options').select('*').eq('question_id', (data as FormQuestion).id).order('sort_order');
      data = { ...data, options: (opts as FormQuestionOption[]) ?? [], rows: [] as FormQuestionRow[] } as typeof data;
    }
    if (data) {
      setSteps((prev) =>
        prev.map((s) => ({
          ...s,
          sections: s.sections.map((sec) =>
            sec.id === selectedSectionId
              ? { ...sec, questions: [...sec.questions, data] }
              : sec
          ),
        }))
      );
      setEditingQuestionId(data.id);
    }
  };

  const addQuestionInstruction = async () => {
    if (!selectedSectionId) return;
    const { data } = await supabase
      .from('skyline_form_questions')
      .insert({
        section_id: selectedSectionId,
        type: 'instruction_block',
        label: 'Instruction',
        sort_order: selectedSection?.questions.length || 0,
        pdf_meta: { instructions: {} },
      })
      .select('*')
      .single();
    if (data) {
      setSteps((prev) =>
        prev.map((s) => ({
          ...s,
          sections: s.sections.map((sec) =>
            sec.id === selectedSectionId
              ? { ...sec, questions: [...sec.questions, data] }
              : sec
          ),
        }))
      );
      setEditingQuestionId(data.id);
      setAutoOpenInstructionQuestionId(data.id);
    }
  };

  const duplicateQuestion = async (questionId: number) => {
    if (!selectedSectionId || !selectedSection) return;
    const q = selectedSection.questions.find((x) => x.id === questionId);
    if (!q) return;
    const sourceId = q.id;
    const newSortOrder = (q.sort_order ?? 0) + 1;
    for (const other of selectedSection.questions) {
      if ((other.sort_order ?? 0) >= newSortOrder) {
        await supabase.from('skyline_form_questions').update({ sort_order: (other.sort_order ?? 0) + 1 }).eq('id', other.id);
      }
    }

    const sourcePm = deepCloneJson((q.pdf_meta ?? {}) as Record<string, unknown>);
    const sourceBlocks = Array.isArray(sourcePm.contentBlocks)
      ? (sourcePm.contentBlocks as ContentBlock[])
      : [];

    const insertPayload = buildQuestionDuplicateInsertPayload(q, {
      sectionId: selectedSectionId,
      sortOrder: newSortOrder,
      clearContentBlockQuestionIds: true,
      // Keep system codes only for prebuilt checklist questions; free-text questions must not share codes.
      clearCode: !isPrebuiltQuestion(q),
    });

    // Insert parent without shared contentBlock questionIds first — rewire after cloning children.
    const { data: newQ, error: insertErr } = await supabase
      .from('skyline_form_questions')
      .insert(insertPayload)
      .select('*')
      .single();
    if (insertErr || !newQ) {
      console.error('duplicateQuestion: insert failed', insertErr);
      return;
    }
    const newParentId = (newQ as FormQuestion).id;
    if (!Number.isFinite(newParentId) || newParentId <= 0 || newParentId === sourceId) {
      console.error('duplicateQuestion: invalid new id', { sourceId, newParentId });
      return;
    }

    const { data: opts } = await supabase.from('skyline_form_question_options').select('*').eq('question_id', sourceId).order('sort_order');
    if ((opts as { value: string; label: string; sort_order: number }[])?.length) {
      await supabase.from('skyline_form_question_options').insert(
        (opts as { value: string; label: string; sort_order: number }[]).map((o) => ({
          question_id: newParentId,
          value: o.value,
          label: o.label,
          sort_order: o.sort_order,
        }))
      );
    }
    const { data: rows } = await supabase.from('skyline_form_question_rows').select('*').eq('question_id', sourceId).order('sort_order');
    for (const r of (rows as { row_label: string; row_help: string | null; row_image_url: string | null; row_meta: unknown; sort_order: number }[]) || []) {
      await supabase.from('skyline_form_question_rows').insert({
        question_id: newParentId,
        row_label: r.row_label,
        row_help: r.row_help,
        row_image_url: r.row_image_url,
        row_meta: deepCloneJson(r.row_meta ?? {}),
        sort_order: r.sort_order,
      });
    }

    // Deep-clone content-block children (grid_table / short_text / long_text) so the copy
    // does NOT share answer identity with the original table blocks.
    const remappedBlocks: ContentBlock[] = [];
    let nextChildSort =
      selectedSection.questions.reduce((m, qq) => Math.max(m, qq.sort_order ?? 0), newSortOrder) + 1;
    for (const block of sourceBlocks) {
      const srcChildId = Number(block.questionId);
      if (!Number.isFinite(srcChildId) || srcChildId <= 0) {
        remappedBlocks.push(deepCloneJson(block));
        continue;
      }
      const srcChild = selectedSection.questions.find((x) => x.id === srcChildId);
      if (!srcChild) {
        remappedBlocks.push({ ...deepCloneJson(block), questionId: undefined });
        continue;
      }
      const srcChildPm = deepCloneJson((srcChild.pdf_meta ?? {}) as Record<string, unknown>);
      srcChildPm.isAdditionalBlockOf = newParentId;
      const { data: newChild } = await supabase
        .from('skyline_form_questions')
        .insert({
          section_id: selectedSectionId,
          type: srcChild.type,
          code: null,
          label: srcChild.label,
          help_text: srcChild.help_text,
          required: srcChild.required ?? false,
          sort_order: nextChildSort++,
          role_visibility: deepCloneJson(srcChild.role_visibility ?? {}),
          role_editability: deepCloneJson(srcChild.role_editability ?? {}),
          pdf_meta: srcChildPm,
        })
        .select('*')
        .single();
      if (!newChild) {
        remappedBlocks.push({ ...deepCloneJson(block), questionId: undefined });
        continue;
      }
      const newChildId = (newChild as FormQuestion).id;
      const { data: childOpts } = await supabase
        .from('skyline_form_question_options')
        .select('*')
        .eq('question_id', srcChildId)
        .order('sort_order');
      if ((childOpts as { value: string; label: string; sort_order: number }[])?.length) {
        await supabase.from('skyline_form_question_options').insert(
          (childOpts as { value: string; label: string; sort_order: number }[]).map((o) => ({
            question_id: newChildId,
            value: o.value,
            label: o.label,
            sort_order: o.sort_order,
          }))
        );
      }
      const { data: childRows } = await supabase
        .from('skyline_form_question_rows')
        .select('*')
        .eq('question_id', srcChildId)
        .order('sort_order');
      for (const r of (childRows as {
        row_label: string;
        row_help: string | null;
        row_image_url: string | null;
        row_meta: unknown;
        sort_order: number;
      }[]) || []) {
        await supabase.from('skyline_form_question_rows').insert({
          question_id: newChildId,
          row_label: r.row_label,
          row_help: r.row_help,
          row_image_url: r.row_image_url,
          row_meta: deepCloneJson(r.row_meta ?? {}),
          sort_order: r.sort_order,
        });
      }
      remappedBlocks.push({ ...deepCloneJson(block), questionId: newChildId });
    }

    const finalPm = { ...sourcePm, contentBlocks: remappedBlocks };
    await supabase.from('skyline_form_questions').update({ pdf_meta: finalPm as unknown as Json }).eq('id', newParentId);

    // Reload section questions from DB so every row (including nested JSON) is a fresh object.
    // Do NOT re-attach source pdf_meta references into React state.
    const { data: refreshedQs } = await supabase
      .from('skyline_form_questions')
      .select('*')
      .eq('section_id', selectedSectionId)
      .order('sort_order');
    const refreshedList = deepCloneJson(((refreshedQs as FormQuestion[]) || []).map((qq) => ({ ...qq })));

    setSteps((prev) =>
      prev.map((s) => ({
        ...s,
        sections: s.sections.map((sec) =>
          sec.id === selectedSectionId ? { ...sec, questions: refreshedList } : sec
        ),
      }))
    );
    setEditingQuestionId(newParentId);
    setOpenQuestionMenuId(null);
  };

  const createContentBlockQuestion = async (
    parentQuestion: FormQuestion,
    blockType: ContentBlockType,
    blockIndex: number,
    blocks: ContentBlock[]
  ) => {
    if (!selectedSectionId) return;
    await flushQuestionSave(parentQuestion.id);
    const maxSort = selectedSection?.questions?.length
      ? Math.max(...selectedSection.questions.map((q) => (q.sort_order ?? 0) as number), -1)
      : -1;
    const parentPm = deepCloneJson((parentQuestion.pdf_meta as Record<string, unknown> | undefined) || {});

    let insertPayload: Record<string, unknown>;
    if (blockType === 'grid_table') {
      insertPayload = {
        section_id: selectedSectionId,
        type: 'grid_table',
        label: 'Table',
        sort_order: maxSort + 1,
        pdf_meta: { isAdditionalBlockOf: parentQuestion.id, layout: 'no_image', columnsMeta: [{ label: 'Terms', type: 'question' }, { label: 'Explanation', type: 'answer' }] },
      };
    } else if (blockType === 'short_text' || blockType === 'long_text') {
      insertPayload = {
        section_id: selectedSectionId,
        type: blockType,
        label: blockType === 'short_text' ? 'Short answer' : 'Long answer',
        sort_order: maxSort + 1,
        pdf_meta: { isAdditionalBlockOf: parentQuestion.id, wordLimit: blockType === 'long_text' ? 200 : 50 },
      };
    } else {
      return;
    }

    const { data: newQ, error: insertErr } = await supabase
      .from('skyline_form_questions')
      .insert(insertPayload)
      .select('*')
      .single();
    if (insertErr || !newQ) {
      console.error('Failed to create content block:', insertErr);
      const nextBlocks = blocks.filter((_, i) => i !== blockIndex);
      updateQuestion(parentQuestion.id, { pdf_meta: { ...parentPm, contentBlocks: nextBlocks } as unknown as Json });
      return;
    }
    const childId = (newQ as FormQuestion).id;
    const nextBlocks = [...blocks];
    nextBlocks[blockIndex] = { ...nextBlocks[blockIndex], questionId: childId };
    const { error: updateErr } = await supabase
      .from('skyline_form_questions')
      .update({ pdf_meta: { ...parentPm, contentBlocks: nextBlocks } as unknown as Json })
      .eq('id', parentQuestion.id);
    if (updateErr) {
      console.error('Failed to link content block:', updateErr);
      const reverted = blocks.filter((_, i) => i !== blockIndex);
      updateQuestion(parentQuestion.id, { pdf_meta: { ...parentPm, contentBlocks: reverted } as unknown as Json });
      return;
    }
    // Optimistic update: merge new question into local state so section/question stay selected (no loadData refetch)
    const newQuestion = newQ as FormQuestion;
    setSteps((prev) =>
      prev.map((step) => {
        if (step.id !== selectedStepId) return step;
        return {
          ...step,
          sections: step.sections.map((sec) => {
            if (sec.id !== selectedSectionId) return sec;
            const questions = [...sec.questions, newQuestion].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
            return {
              ...sec,
              questions: questions.map((q) =>
                q.id === parentQuestion.id ? { ...q, pdf_meta: { ...parentPm, contentBlocks: nextBlocks } as unknown as Json } : q
              ),
            };
          }),
        };
      })
    );
  };

  const flushQuestionSave = useCallback((questionId: number): Promise<void> => {
    const pending = questionPendingUpdates.current[questionId];
    delete questionPendingUpdates.current[questionId];
    const t = questionSaveTimers.current[questionId];
    if (t) clearTimeout(t);
    delete questionSaveTimers.current[questionId];
    if (pending && Object.keys(pending).length > 0) {
      return Promise.resolve(supabase.from('skyline_form_questions').update(pending).eq('id', questionId)).then(() => {});
    }
    return Promise.resolve();
  }, []);

  /** Flush all debounced saves (questions, options, rows) before preview or navigation. */
  const flushAllPendingSaves = useCallback(async () => {
    if (questionBlurSavePromise.current) {
      await questionBlurSavePromise.current;
      questionBlurSavePromise.current = null;
    }
    const timerIds = Object.keys(questionSaveTimers.current).map(Number);
    const pendingIds = Object.keys(questionPendingUpdates.current).map(Number);
    const allIds = [...new Set([...timerIds, ...pendingIds])];
    allIds.forEach((id) => {
      clearTimeout(questionSaveTimers.current[id]);
      delete questionSaveTimers.current[id];
    });
    const promises: Promise<unknown>[] = [];
    for (const id of allIds) {
      const pending = questionPendingUpdates.current[id];
      delete questionPendingUpdates.current[id];
      if (pending && Object.keys(pending).length > 0) {
        promises.push(Promise.resolve(supabase.from('skyline_form_questions').update(pending).eq('id', id)));
      }
    }
    const childPromises: Promise<unknown>[] = [];
    window.dispatchEvent(
      new CustomEvent(FLUSH_PENDING_EVENT, { detail: { addPromises: (ps: Promise<unknown>[]) => childPromises.push(...ps) } })
    );
    await Promise.all([...promises, ...childPromises]);
  }, []);

  const updateQuestion = useCallback((questionId: number, updates: Partial<FormQuestion>) => {
    if (!Number.isFinite(questionId) || questionId <= 0) return;

    // Deep-clone nested JSON in the patch so callers cannot accidentally share
    // pdf_meta / role maps across questions after a shallow duplicate.
    const safeUpdates = { ...updates } as Partial<FormQuestion>;
    if (safeUpdates.pdf_meta != null) {
      safeUpdates.pdf_meta = deepCloneJson(safeUpdates.pdf_meta) as FormQuestion['pdf_meta'];
    }
    if (safeUpdates.role_visibility != null) {
      safeUpdates.role_visibility = deepCloneJson(safeUpdates.role_visibility) as FormQuestion['role_visibility'];
    }
    if (safeUpdates.role_editability != null) {
      safeUpdates.role_editability = deepCloneJson(safeUpdates.role_editability) as FormQuestion['role_editability'];
    }

    setSteps((prev) =>
      prev.map((s) => ({
        ...s,
        sections: s.sections.map((sec) => ({
          ...sec,
          questions: applyQuestionFieldUpdate(sec.questions, questionId, safeUpdates),
        })),
      }))
    );
    questionPendingUpdates.current[questionId] = {
      ...questionPendingUpdates.current[questionId],
      ...safeUpdates,
    };
    const existing = questionSaveTimers.current[questionId];
    if (existing) clearTimeout(existing);
    questionSaveTimers.current[questionId] = setTimeout(() => {
      flushQuestionSave(questionId);
    }, QUESTION_SAVE_DEBOUNCE_MS);
  }, [flushQuestionSave]);

  if (loading || !form) {
    return <Loader fullPage variant="dots" size="lg" message="Loading form..." />;
  }

  return (
    <div className="flex min-h-screen flex-col bg-[var(--bg)]">
      <header className="shrink-0 bg-white border-b border-[var(--border)] shadow-sm sticky top-0 z-20 min-w-0">
        <div className="w-full px-4 md:px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 min-w-0">
          <div className="flex flex-col gap-2 min-w-0 flex-1 sm:min-w-0">
            <div className="flex items-start gap-3 min-w-0">
              <button
                type="button"
                onClick={async (e) => {
                  e.preventDefault();
                  await new Promise((r) => setTimeout(r, 0));
                  await flushAllPendingSaves();
                  navigate('/admin/forms');
                }}
                className="text-gray-600 hover:text-gray-900 bg-transparent border-none cursor-pointer font-inherit p-0 shrink-0 mt-1"
              >
                ← Back
              </button>
              <textarea
                value={form.name}
                title={form.name || undefined}
                rows={3}
                spellCheck={false}
                onChange={(e) => setForm((prev) => (prev ? { ...prev, name: e.target.value } : null))}
                onBlur={async (e) => {
                  const newName = (e.target.value || '')
                    .replace(/\r?\n/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();
                  if (!newName) {
                    setForm((prev) => (prev ? { ...prev, name: lastSavedFormNameRef.current } : null));
                    return;
                  }
                  if (newName === lastSavedFormNameRef.current) return;
                  const exists = await formNameExists(newName, Number(formId));
                  if (exists) {
                    alert('A form with this name already exists. Please choose a different name.');
                    setForm((prev) => (prev ? { ...prev, name: lastSavedFormNameRef.current } : null));
                    return;
                  }
                  const { error } = await updateForm(Number(formId), { name: newName });
                  if (error) {
                    alert(`Failed to save name: ${error.message}`);
                    setForm((prev) => (prev ? { ...prev, name: lastSavedFormNameRef.current } : null));
                    return;
                  }
                  lastSavedFormNameRef.current = newName;
                  setForm((prev) => (prev ? { ...prev, name: newName } : null));
                }}
                className="text-xl font-bold text-[var(--text)] bg-transparent border-b-2 border-transparent hover:border-[var(--border)] focus:outline-none focus:border-[var(--brand)] py-1 px-0 min-w-0 flex-1 w-full min-h-[4.5rem] max-h-40 resize-y leading-snug [field-sizing:content]"
                placeholder="Form name"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-gray-500 shrink-0">Version:</span>
                <input
                  type="text"
                  value={form.version ?? '1.0.0'}
                  onChange={(e) => setForm((prev) => (prev ? { ...prev, version: e.target.value } : null))}
                  onBlur={async (e) => {
                    const v = (e.target.value || '1.0.0').trim() || '1.0.0';
                    await updateForm(Number(formId), { version: v });
                    setForm((prev) => (prev ? { ...prev, version: v } : null));
                  }}
                  className="text-sm border border-[var(--border)] rounded px-2 py-0.5 w-14 focus:outline-none focus:ring-1 focus:ring-[var(--brand)] focus:border-[var(--brand)] shrink-0"
                  placeholder="1.0.0"
                />
                <span className="text-xs text-gray-500 shrink-0" title="Access/expiry is now controlled per assessment (instance) by admin.">
                  Link expiry is per assessment (instance)
                </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0 self-start sm:self-center">
              <input
                ref={coverInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif"
                className="hidden"
                onChange={handleCoverUpload}
              />
              {form.cover_asset_url && (
                <div className="w-10 h-10 rounded border border-[var(--border)] overflow-hidden shrink-0">
                  <img src={form.cover_asset_url} alt="Cover" className="w-full h-full object-cover" />
                </div>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => coverInputRef.current?.click()}
                disabled={coverUploading}
              >
                {coverUploading ? (
                  <Loader variant="dots" size="sm" inline className="mr-1" />
                ) : (
                  <>
                    <ImagePlus className="w-4 h-4 mr-1" />
                    {form.cover_asset_url ? 'Change Cover' : 'Add Cover'}
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  if (!formId || !form) return;
                  const file = await pasteImageFromClipboard();
                  if (!file) {
                    alert('No image in clipboard. Take a screenshot (Print Screen) or copy an image first, then paste.');
                    return;
                  }
                  setCoverUploading(true);
                  try {
                    const { url, error } = await uploadFormCoverImage(Number(formId), file);
                    if (error) {
                      alert(`Upload failed: ${error}`);
                    } else if (url) {
                      const { error: updateErr } = await updateForm(Number(formId), { cover_asset_url: url });
                      if (updateErr) alert(`Save failed: ${updateErr.message}`);
                      else setForm((prev) => (prev ? { ...prev, cover_asset_url: url } : null));
                    }
                  } finally {
                    setCoverUploading(false);
                  }
                }}
                disabled={coverUploading}
                title="Paste from clipboard"
              >
                <ClipboardPaste className="w-4 h-4 mr-1" />
                Paste
              </Button>
            <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              setPreviewing(true);
              try {
                await new Promise((r) => setTimeout(r, 0));
                await flushAllPendingSaves();
                navigate(`/admin/forms/${formId}/preview`);
              } finally {
                setPreviewing(false);
              }
            }}
            disabled={previewing}
          >
            {previewing ? (
              <Loader variant="dots" size="sm" inline className="mr-1" />
            ) : (
              <Eye className="w-4 h-4 mr-1" />
            )}
            {previewing ? 'Loading...' : 'Preview'}
            </Button>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:h-[calc(100dvh-5.5rem)] lg:flex-row">
        {/* Left: Steps */}
        <div className="w-full max-h-[min(40vh,320px)] shrink-0 overflow-y-auto border-b border-[var(--border)] bg-white p-3 sm:p-4 lg:h-auto lg:max-h-none lg:w-56 lg:shrink-0 lg:border-b-0 lg:border-r">
          <div className="flex justify-between items-center mb-3">
            <h2 className="font-semibold text-sm">Steps</h2>
            <Button variant="outline" size="sm" onClick={addStep}>
              + Add
            </Button>
          </div>
          <DndContext sensors={stepSensors} collisionDetection={closestCenter} onDragEnd={handleStepsDragEnd}>
            <SortableContext items={steps.map((s) => `step-${s.id}`)} strategy={verticalListSortingStrategy}>
              <div className="space-y-1">
                {steps.map((step) => (
                  <SortableStepItem
                    key={step.id}
                    step={step}
                    isSelected={step.id === selectedStepId}
                    onSelect={() => {
                      setSelectedStepId(step.id);
                      setSelectedSectionId(step.sections[0]?.id ?? null);
                    }}
                    onUpdate={(title) => updateStep(step.id, { title })}
                    onRemove={() => removeStep(step.id)}
                    onDuplicate={() => {
                      setOpenStepMenuId(null);
                      duplicateStep(step.id);
                    }}
                    menuOpen={openStepMenuId === step.id}
                    onMenuToggle={() => setOpenStepMenuId(openStepMenuId === step.id ? null : step.id)}
                    menuRef={stepMenuRef}
                    isDuplicating={duplicatingStepId === step.id}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </div>

        {/* Middle: Sections */}
        <div className="w-full max-h-[min(38vh,300px)] shrink-0 overflow-y-auto border-b border-[var(--border)] bg-white p-3 sm:p-4 lg:h-auto lg:max-h-none lg:w-72 lg:min-w-[16rem] lg:shrink-0 lg:border-b-0 lg:border-r">
          <div className="flex justify-between items-center mb-3">
            <h2 className="font-semibold text-sm">Sections</h2>
            <Button
              variant="outline"
              size="sm"
              onClick={addSection}
              disabled={!selectedStepId}
            >
              + Add
            </Button>
          </div>
          {selectedStep ? (
            <DndContext sensors={sectionSensors} collisionDetection={closestCenter} onDragEnd={handleSectionsDragEnd}>
              <SortableContext items={selectedStep.sections.map((s) => `section-${s.id}`)} strategy={verticalListSortingStrategy}>
                <div className="space-y-1">
                  {selectedStep.sections.map((sec) => (
                    <SortableSectionItem
                      key={sec.id}
                      section={sec}
                      isSelected={sec.id === selectedSectionId}
                      onSelect={() => setSelectedSectionId(sec.id)}
                      onUpdate={(title) => updateSection(sec.id, { title })}
                      onPdfModeChange={(mode) => handlePdfModeChange(sec.id, mode)}
                      onAssessmentTaskRowChange={(rowId) => updateSection(sec.id, { assessment_task_row_id: rowId })}
                      assessmentTaskRows={assessmentTaskRows}
                      onRemove={() => removeSection(sec.id)}
                      onDuplicate={() => {
                        setOpenSectionMenuId(null);
                        duplicateSection(sec.id);
                      }}
                      menuOpen={openSectionMenuId === sec.id}
                      onMenuToggle={() => setOpenSectionMenuId(openSectionMenuId === sec.id ? null : sec.id)}
                      menuRef={sectionMenuRef}
                      canDelete={!isPrebuiltSection(sec.title)}
                      isDuplicating={duplicatingSectionId === sec.id}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          ) : (
            <p className="text-sm text-gray-500">Select a step</p>
          )}
        </div>

        {/* Right: Content (Questions or Instructions) + Editor */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
          <div className="w-full max-h-[min(36vh,280px)] shrink-0 overflow-y-auto border-b border-[var(--border)] bg-white p-3 sm:p-4 lg:h-auto lg:max-h-none lg:w-72 lg:shrink-0 lg:border-b-0 lg:border-r">
            <div className="flex justify-between items-center mb-3">
              <h2 className="font-semibold text-sm">
                {selectedSection?.pdf_render_mode === 'task_instructions'
                  ? 'Instructions'
                  : selectedSection?.pdf_render_mode === 'task_questions'
                    ? 'Questions to answer'
                    : selectedSection?.pdf_render_mode === 'task_written_evidence_checklist'
                      ? 'Written Evidence Checklist'
                      : selectedSection?.pdf_render_mode === 'task_marking_checklist'
                        ? 'Assessment Marking Checklist'
                        : selectedSection?.pdf_render_mode === 'task_results'
                          ? 'Results'
                          : selectedSection?.pdf_render_mode === 'assessment_summary' || selectedSection?.title === 'Assessment Summary Sheet'
                            ? 'Assessment Summary Sheet'
                            : 'Questions'}
              </h2>
              {(selectedSection?.pdf_render_mode === 'task_questions' || (!['task_instructions', 'additional_instructions', 'task_questions', 'task_written_evidence_checklist', 'task_marking_checklist', 'task_results', 'assessment_summary'].includes(selectedSection?.pdf_render_mode || '') && selectedSection?.title !== 'Assessment Summary Sheet')) && (
                <div className="flex items-center gap-1">
                  {selectedSection?.pdf_render_mode === 'task_questions' && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={addQuestionInstruction}
                      disabled={!selectedSectionId}
                    >
                      + Add Instruction
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={addQuestion}
                    disabled={!selectedSectionId}
                  >
                    + Add
                  </Button>
                </div>
              )}
            </div>
            {selectedSection ? (
              selectedSection.pdf_render_mode === 'task_instructions' ? (
                <p className="text-sm text-gray-600">
                  Instructions students will read before answering. Use the editor on the right to add content.
                </p>
              ) : selectedSection.pdf_render_mode === 'additional_instructions' ? (
                <p className="text-sm text-gray-600">
                  General instructions that appear in the PDF but are not linked to a specific task. Use the editor on the right to add content.
                </p>
              ) : loadingSectionTypeChange === selectedSection.id ? (
                <div className="flex items-center gap-2 py-4 text-sm text-gray-600">
                  <Loader className="w-5 h-5 shrink-0" />
                  <span>Creating checklist questions…</span>
                </div>
              ) : selectedSection.pdf_render_mode === 'task_marking_checklist' ? (
                <DndContext sensors={questionSensors} collisionDetection={closestCenter} onDragEnd={handleQuestionsDragEnd}>
                  {(() => {
                    const visibleQuestions = selectedSection.questions.filter((q) => !(q.pdf_meta as Record<string, unknown>)?.isAdditionalBlockOf);
                    return (
                  <SortableContext items={visibleQuestions.map((q) => `question-${q.id}`)} strategy={verticalListSortingStrategy}>
                    <div className="space-y-1">
                      {visibleQuestions.map((q, idx) => (
                        <SortableQuestionItem
                          key={q.id}
                          question={q}
                          index={idx}
                          totalCount={visibleQuestions.length}
                          isSelected={editingQuestionId === q.id}
                          onSelect={() => setEditingQuestionId(q.id)}
                          onRemove={() => removeQuestion(q.id)}
                          onDuplicate={() => duplicateQuestion(q.id)}
                          canDelete={!isPrebuiltQuestion(q)}
                          menuOpen={openQuestionMenuId === q.id}
                          onMenuToggle={() => setOpenQuestionMenuId(openQuestionMenuId === q.id ? null : q.id)}
                          menuRef={questionMenuRef}
                          isInstruction={selectedSection.pdf_render_mode === 'task_questions' && q.type === 'instruction_block'}
                        />
                      ))}
                    </div>
                  </SortableContext>
                    );
                  })()}
                </DndContext>
              ) : selectedSection.pdf_render_mode === 'task_results' ? (
                <p className="text-sm text-gray-600">
                  Results sheet for trainer/assessor to record outcomes.
                </p>
              ) : selectedSection.pdf_render_mode === 'assessment_summary' || selectedSection.title === 'Assessment Summary Sheet' ? (
                <p className="text-sm text-gray-600">
                  Assessment Summary Sheet. Appears as one page in the PDF. Student details, task results, signatures and feedback are completed when the form is filled.
                </p>
              ) : (
                <DndContext sensors={questionSensors} collisionDetection={closestCenter} onDragEnd={handleQuestionsDragEnd}>
                  {(() => {
                    const visibleQuestions = selectedSection.questions.filter((q) => !(q.pdf_meta as Record<string, unknown>)?.isAdditionalBlockOf);
                    const isTaskQuestions = selectedSection.pdf_render_mode === 'task_questions';
                    const taskQNumbers = isTaskQuestions ? getTaskQuestionDisplayNumbers(visibleQuestions) : null;
                    const numberedTotal = taskQNumbers ? taskQNumbers.size : visibleQuestions.length;
                    return (
                  <SortableContext items={visibleQuestions.map((q) => `question-${q.id}`)} strategy={verticalListSortingStrategy}>
                    <div className="space-y-1">
                      {visibleQuestions.map((q, idx) => (
                        <SortableQuestionItem
                          key={q.id}
                          question={q}
                          index={idx}
                          totalCount={visibleQuestions.length}
                          questionDisplayNumber={taskQNumbers?.get(q.id)}
                          numberedQuestionTotal={isTaskQuestions ? numberedTotal : undefined}
                          isSelected={editingQuestionId === q.id}
                          onSelect={() => setEditingQuestionId(q.id)}
                          onRemove={() => removeQuestion(q.id)}
                          onDuplicate={() => duplicateQuestion(q.id)}
                          canDelete={!isPrebuiltQuestion(q)}
                          menuOpen={openQuestionMenuId === q.id}
                          onMenuToggle={() => setOpenQuestionMenuId(openQuestionMenuId === q.id ? null : q.id)}
                          menuRef={questionMenuRef}
                          isInstruction={isTaskQuestions && q.type === 'instruction_block'}
                        />
                      ))}
                    </div>
                  </SortableContext>
                    );
                  })()}
                </DndContext>
              )
            ) : (
              <p className="text-sm text-gray-500">Select a section</p>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto bg-gray-50 p-4 sm:p-6">
            {selectedSection?.pdf_render_mode === 'task_instructions' ? (
              <SectionInstructionsEditor
                section={selectedSection}
                onSaved={loadData}
              />
            ) : selectedSection?.pdf_render_mode === 'additional_instructions' ? (
              <AdditionalInstructionsEditor section={selectedSection as unknown as { id: number; title: string; instructions_meta?: TaskInstructionsData | null }} onSaved={loadData} />
            ) : editingQuestionId && selectedSection ? (() => {
              const q = selectedSection.questions.find((x) => x.id === editingQuestionId);
              if (!q) return null;
              if (selectedSection.pdf_render_mode === 'task_questions' && q.type === 'instruction_block') {
                return (
                  <QuestionInstructionEditor
                    question={q}
                    sectionId={selectedSection.id}
                    autoOpen={autoOpenInstructionQuestionId === q.id}
                    onAutoOpenHandled={() => setAutoOpenInstructionQuestionId(null)}
                    onSaved={(updates) => {
                      setAutoOpenInstructionQuestionId(null);
                      setSteps((prev) =>
                        prev.map((s) => ({
                          ...s,
                          sections: s.sections.map((sec) =>
                            sec.id === selectedSection.id
                              ? {
                                  ...sec,
                                  questions: sec.questions.map((x) => (x.id === q.id ? { ...x, ...updates } : x)),
                                }
                              : sec
                          ),
                        }))
                      );
                    }}
                  />
                );
              }
              const rv = (q.role_visibility as Record<string, boolean>) || {};
              const re = (q.role_editability as Record<string, boolean>) || {};
              // Always work from a deep clone so editor spreads cannot mutate another question's nested pdf_meta.
              const pm = deepCloneJson(((q.pdf_meta as Record<string, unknown>) || {}));
              const gridColumnsMeta = getGridColumnsMeta(pm);
              const questionWordLimit = normalizeWordLimit(pm.wordLimit);
              const gridColumnWordLimits = gridColumnsMeta.map((_, idx) =>
                normalizeWordLimit(Array.isArray(pm.columnWordLimits) ? (pm.columnWordLimits as unknown[])[idx] : null)
              );
              const layout = (pm.layout as string) || 'no_image';
              const isNoImageNoHeader = layout === 'no_image_no_header';
              return (
                <Card key={q.id}>
                  <h3 className="font-bold mb-4">Edit Question</h3>
                  <div className="space-y-4">
                    {q.type === 'page_break' ? (
                      <p className="text-sm text-gray-500 italic">
                        Page Break inserts a new page in the PDF. Label and help text are not displayed. Use the question list order to place it between questions.
                      </p>
                    ) : (
                      <>
                        <Textarea
                          key={`label-${q.id}`}
                          label="Label"
                          value={q.label}
                          onChange={(e) => updateQuestion(q.id, { label: e.target.value })}
                          onBlur={() => { questionBlurSavePromise.current = flushQuestionSave(q.id); }}
                          rows={4}
                          placeholder="Use multiple lines for sub-questions (e.g. 11.1, 11.2)"
                        />
                        <Textarea
                          key={`help-${q.id}`}
                          label="Help Text"
                          value={q.help_text || ''}
                          onChange={(e) => updateQuestion(q.id, { help_text: e.target.value })}
                          onBlur={() => { questionBlurSavePromise.current = flushQuestionSave(q.id); }}
                        />
                        <div className="flex items-center gap-2">
                          <Checkbox
                            label="Required"
                            checked={q.required}
                            onChange={(v) => updateQuestion(q.id, { required: v })}
                          />
                        </div>
                      </>
                    )}
                    <Select
                      label="Type"
                      value={q.type}
                      onChange={(v) => updateQuestion(q.id, { type: v })}
                      options={QUESTION_TYPES}
                    />
                    {(q.type === 'short_text' || q.type === 'long_text') && (
                      <>
                        <Input
                          label="Word limit (optional)"
                          type="number"
                          min={1}
                          value={questionWordLimit ?? ''}
                          onChange={(e) =>
                            updateQuestion(q.id, {
                              pdf_meta: { ...pm, wordLimit: normalizeWordLimit(e.target.value) },
                            })
                          }
                          placeholder="e.g. 50"
                        />
                        <Checkbox
                          label="Allow image upload with answer (optional for respondent; HEIC/iPhone photos are converted for PDF)"
                          checked={!!pm.allowAnswerImage}
                          onChange={(v) =>
                            updateQuestion(q.id, {
                              pdf_meta: { ...pm, allowAnswerImage: !!v },
                            })
                          }
                        />
                      </>
                    )}
                    {(q.type !== 'page_break') && (
                      <div className="space-y-2">
                        <span className="text-sm font-semibold text-gray-700">Question image (optional)</span>
                        <p className="text-xs text-gray-500">Add a diagram or illustration with the question. Side-by-side for lengthy content, or image above for compact layouts. Works for all question types including grid tables.</p>
                        <div className="flex flex-wrap gap-2 items-center">
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            id={`q-img-${q.id}`}
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              if (!file || !file.type.startsWith('image/')) return;
                              const { url, error } = await uploadQuestionImage(q.id, file);
                              e.target.value = '';
                              if (error) alert(`Upload failed: ${error}`);
                              else if (url) updateQuestion(q.id, { pdf_meta: { ...pm, imageUrl: url } });
                            }}
                          />
                          <Button type="button" variant="outline" size="sm" onClick={() => document.getElementById(`q-img-${q.id}`)?.click()}>
                            <ImagePlus className="w-4 h-4 mr-1" /> Upload
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={async () => {
                              const file = await pasteImageFromClipboard();
                              if (!file) {
                                alert('No image in clipboard. Take a screenshot (Print Screen) or copy an image first, then paste.');
                                return;
                              }
                              const { url, error } = await uploadQuestionImage(q.id, file);
                              if (error) alert(`Upload failed: ${error}`);
                              else if (url) updateQuestion(q.id, { pdf_meta: { ...pm, imageUrl: url } });
                            }}
                          >
                            <ClipboardPaste className="w-4 h-4 mr-1" /> Paste
                          </Button>
                          {(pm.imageUrl as string) && (
                            <>
                              <img src={pm.imageUrl as string} alt="" className="h-12 object-contain border rounded" />
                              <button type="button" className="text-xs text-red-600" onClick={() => updateQuestion(q.id, { pdf_meta: { ...pm, imageUrl: undefined, imageLayout: undefined, imageWidthPercent: undefined, imageFullWidth: undefined } })}>Remove</button>
                            </>
                          )}
                        </div>
                        {(pm.imageUrl as string) && (
                          <div className="flex flex-wrap gap-4 pt-1">
                            <Checkbox
                              label="Full width image"
                              checked={!!(pm.imageFullWidth as boolean | undefined)}
                              onChange={(v) => updateQuestion(q.id, { pdf_meta: { ...pm, imageFullWidth: !!v, imageLayout: v ? 'above' : (pm.imageLayout as string) } })}
                            />
                            <div>
                              <label className="text-xs text-gray-500">Layout</label>
                              <Select
                                value={(pm.imageLayout as string) || 'side_by_side'}
                                onChange={(v) => updateQuestion(q.id, { pdf_meta: { ...pm, imageLayout: (v as ImageLayoutOption) || 'side_by_side', imageFullWidth: ((v as string) === 'side_by_side') ? (pm.imageFullWidth as boolean | undefined) : (pm.imageFullWidth as boolean | undefined) } })}
                                options={[
                                  { value: 'side_by_side', label: 'Text & image side-by-side' },
                                  { value: 'above', label: 'Image above, question below' },
                                  { value: 'below', label: 'Question above, image below' },
                                ]}
                              />
                            </div>
                            {!((pm.imageFullWidth as boolean | undefined) ?? false) && (((pm.imageLayout as string) || 'side_by_side') === 'side_by_side') && (
                              <div>
                                <label className="text-xs text-gray-500">Image width %</label>
                                <Input type="number" min={20} max={80} value={(pm.imageWidthPercent as number) ?? 50} onChange={(e) => updateQuestion(q.id, { pdf_meta: { ...pm, imageWidthPercent: Math.max(20, Math.min(80, Number(e.target.value) || 50)) } })} />
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    {q.type !== 'page_break' && (
                    <>
                      <div>
                        <div className="text-sm font-semibold mb-2">Role Visibility</div>
                        <div className="flex gap-4">
                          {ROLES.map((r) => (
                            <Checkbox
                              key={r.value}
                              label={r.label}
                              checked={rv[r.value] !== false}
                              onChange={(v) =>
                                updateQuestion(q.id, {
                                  role_visibility: { ...rv, [r.value]: v },
                                })
                              }
                            />
                          ))}
                        </div>
                      </div>
                      <div>
                        <div className="text-sm font-semibold mb-2">Role Editability</div>
                        <div className="flex gap-4">
                          {ROLES.map((r) => (
                            <Checkbox
                              key={r.value}
                              label={r.label}
                              checked={re[r.value] !== false}
                              onChange={(v) =>
                                updateQuestion(q.id, {
                                  role_editability: { ...re, [r.value]: v },
                                })
                              }
                            />
                          ))}
                        </div>
                      </div>
                    </>
                    )}
                    {(q.type === 'single_choice' || q.type === 'multi_choice' || q.type === 'yes_no') && (
                      <QuestionOptionsEditor questionId={q.id} />
                    )}
                    {selectedSection?.pdf_render_mode === 'task_questions' && (
                      <Input
                        label="Text above table/header (optional, bold)"
                        value={String(pm.textAboveHeader ?? '').trim()}
                        onChange={(e) =>
                          updateQuestion(q.id, {
                            pdf_meta: { ...pm, textAboveHeader: e.target.value || undefined },
                          })
                        }
                        placeholder="e.g. Painting terminology:"
                      />
                    )}
                    {q.type === 'grid_table' && (
                      <div className="space-y-3 mb-4">
                        <div className="text-sm font-semibold text-gray-700">1. Table layout</div>
                        <div>
                          <TableLayoutSelect
                            value={layout}
                            onChange={(v) =>
                              updateQuestion(q.id, {
                                pdf_meta: { ...pm, layout: v },
                              })
                            }
                          />
                        </div>
                        {layout === 'default' && (
                          <Input
                            label="First column header (image + label)"
                            value={(pm.firstColumnLabel as string | undefined) ?? 'Shape'}
                            onChange={(e) =>
                              updateQuestion(q.id, {
                                pdf_meta: { ...pm, firstColumnLabel: e.target.value },
                              })
                            }
                            placeholder="e.g. Shape, Name, Item (spaces and commas allowed)"
                          />
                        )}
                        {layout === 'split' && (
                          <div className="grid grid-cols-2 gap-2">
                            <Input
                              label="1st column header"
                              value={(pm.firstColumnLabel as string | undefined) ?? 'Name'}
                              onChange={(e) =>
                                updateQuestion(q.id, {
                                  pdf_meta: { ...pm, firstColumnLabel: e.target.value },
                                })
                              }
                              placeholder="e.g. Polygon Name, Measurement (spaces and commas allowed)"
                            />
                            <Input
                              label="2nd column header"
                              value={(pm.secondColumnLabel as string | undefined) ?? 'Image'}
                              onChange={(e) =>
                                updateQuestion(q.id, {
                                  pdf_meta: { ...pm, secondColumnLabel: e.target.value },
                                })
                              }
                              placeholder="e.g. Polygon Shape, Diagram (spaces and commas allowed)"
                            />
                          </div>
                        )}
                        <div>
                          <div className="text-sm font-semibold mb-2">{isNoImageNoHeader ? 'Columns (structure only, headers hidden)' : 'Columns'}</div>
                          <div className="space-y-2">
                            {gridColumnsMeta.map((col, colIdx) => (
                              <div key={`col-${colIdx}`} className="grid grid-cols-12 gap-2 items-end">
                                <div className={isNoImageNoHeader ? 'col-span-11' : 'col-span-7'}>
                                  {isNoImageNoHeader ? (
                                    <div className="text-sm text-gray-600 pb-2">Column {colIdx + 1}</div>
                                  ) : (
                                    <Input
                                      label={`Column ${colIdx + 1} header`}
                                      value={col.label}
                                      onChange={(e) => {
                                        const next = [...gridColumnsMeta];
                                        next[colIdx] = { ...next[colIdx], label: e.target.value };
                                        updateQuestion(q.id, { pdf_meta: withGridColumnsMeta(pm, next) });
                                      }}
                                      placeholder="e.g. Activity, Required items (spaces allowed)"
                                    />
                                  )}
                                </div>
                                <div className={isNoImageNoHeader ? 'col-span-11 -mt-2' : 'col-span-2'}>
                                  <Select
                                    label="Type"
                                    value={col.type}
                                    onChange={(v) => {
                                      const next = [...gridColumnsMeta];
                                      next[colIdx] = { ...next[colIdx], type: normalizeGridColumnType(v) };
                                      updateQuestion(q.id, { pdf_meta: withGridColumnsMeta(pm, next) });
                                    }}
                                    options={GRID_COLUMN_TYPE_OPTIONS}
                                  />
                                </div>
                                <div className={isNoImageNoHeader ? 'col-span-11 -mt-2' : 'col-span-2'}>
                                  <Input
                                    label="Word limit (optional)"
                                    type="number"
                                    min={1}
                                    value={gridColumnWordLimits[colIdx] ?? ''}
                                    disabled={col.type !== 'answer'}
                                    onChange={(e) => {
                                      const nextLimits = [...gridColumnWordLimits];
                                      nextLimits[colIdx] = normalizeWordLimit(e.target.value);
                                      updateQuestion(q.id, {
                                        pdf_meta: { ...(withGridColumnsMeta(pm, gridColumnsMeta) as Record<string, unknown>), columnWordLimits: nextLimits } as Json,
                                      });
                                    }}
                                    placeholder={col.type === 'answer' ? 'e.g. 20' : 'N/A'}
                                  />
                                </div>
                                <div className={isNoImageNoHeader ? 'col-span-12 flex justify-end -mt-2' : 'col-span-1 flex justify-end'}>
                                  <button
                                    type="button"
                                    className="text-xs text-red-600 hover:text-red-700 pb-2"
                                    onClick={() => {
                                      const next = gridColumnsMeta.filter((_, i) => i !== colIdx);
                                      updateQuestion(q.id, { pdf_meta: withGridColumnsMeta(pm, next) });
                                    }}
                                  >
                                    Remove
                                  </button>
                                </div>
                              </div>
                            ))}
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                const next = [...gridColumnsMeta, { label: `Column ${gridColumnsMeta.length + 1}`, type: 'answer' as GridColumnType }];
                                updateQuestion(q.id, { pdf_meta: withGridColumnsMeta(pm, next) });
                              }}
                            >
                              + Add column
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}
                    {(q.type === 'likert_5' || q.type === 'grid_table' || isWrittenEvidenceChecklistQuestion(selectedSection?.pdf_render_mode, q) || (q.type === 'single_choice' && (q.code === 'assessment.marking.evidence_outcome' || q.code === 'assessment.marking.performance_outcome'))) && (
                      <>
                        {q.type === 'grid_table' && <div className="text-sm font-semibold text-gray-700 mb-2">2. Table rows</div>}
                        {isWrittenEvidenceChecklistQuestion(selectedSection?.pdf_render_mode, q) && <div className="text-sm font-semibold text-gray-700 mb-2">Checklist rows</div>}
                        {q.type === 'single_choice' && q.code === 'assessment.marking.evidence_outcome' && <div className="text-sm font-semibold text-gray-700 mb-2">Evidence Outcome rows</div>}
                        {q.type === 'single_choice' && q.code === 'assessment.marking.performance_outcome' && <div className="text-sm font-semibold text-gray-700 mb-2">Performance Outcome rows</div>}
                        <QuestionRowsEditor
                          questionId={q.id}
                          sectionPdfMode={selectedSection?.pdf_render_mode}
                          formId={formId ? Number(formId) : null}
                          steps={steps}
                          onStepsCreated={refreshStepsTree}
                          gridTableLayout={q.type === 'grid_table' ? ((q.pdf_meta as Record<string, unknown>)?.layout as string) : undefined}
                          simpleLabelsOnly={isWrittenEvidenceChecklistQuestion(selectedSection?.pdf_render_mode, q) || (q.type === 'single_choice' && (q.code === 'assessment.marking.evidence_outcome' || q.code === 'assessment.marking.performance_outcome'))}
                        />
                      </>
                    )}
                    {selectedSection?.pdf_render_mode === 'task_questions' && (
                      <div className="space-y-3 pt-4 border-t border-gray-200">
                        <div className="text-sm font-semibold text-gray-700">Content blocks</div>
                        <p className="text-xs text-gray-500">Add extra blocks below the main content (tables, instructions, short/long text). Order and mix as needed.</p>
                        {(() => {
                          const legacyAb = pm.additionalBlock as Record<string, unknown> | undefined;
                          const blocks: ContentBlock[] = Array.isArray(pm.contentBlocks)
                            ? (pm.contentBlocks as ContentBlock[])
                            : legacyAb
                              ? [{ type: (legacyAb.type as ContentBlockType) || 'instruction_block', content: legacyAb.content as string | undefined, questionId: legacyAb.questionId as number | undefined }]
                              : [];
                          const setBlocks = (next: ContentBlock[]) => {
                            const { additionalBlock: _, contentBlocks: __, ...rest } = pm;
                            updateQuestion(q.id, { pdf_meta: { ...rest, contentBlocks: next } as unknown as Json });
                          };
                          const addBlock = (type: ContentBlockType) => {
                            const next = [...blocks, type === 'image' ? { type, imageLayout: 'above' as ImageLayoutOption } : { type }];
                            setBlocks(next);
                            if (type === 'instruction_block' || type === 'image') return;
                            createContentBlockQuestion(q, type, next.length - 1, next);
                          };
                          const removeBlock = (idx: number) => {
                            const next = blocks.filter((_, i) => i !== idx);
                            setBlocks(next);
                          };
                          const updateBlock = (idx: number, upd: Partial<ContentBlock>) => {
                            const next = [...blocks];
                            next[idx] = { ...next[idx], ...upd };
                            setBlocks(next);
                          };
                          return (
                            <div className="space-y-4">
                              {blocks.map((block, idx) => (
                                <div key={idx} className="pl-4 border-l-2 border-gray-200 space-y-2">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-sm font-medium text-gray-600">Block {idx + 1}: {CONTENT_BLOCK_TYPES.find((o) => o.value === block.type)?.label ?? block.type}</span>
                                    <button type="button" className="text-xs text-red-600 hover:text-red-700" onClick={() => removeBlock(idx)}>
                                      Remove
                                    </button>
                                  </div>
                                  <Input
                                    label="Hint text above block (optional, bold)"
                                    value={String(block.headerText ?? '')}
                                    onChange={(e) => updateBlock(idx, { headerText: e.target.value || undefined })}
                                    placeholder="e.g. Painting terminology:"
                                  />
                                  {block.type === 'instruction_block' && (
                                    <>
                                      <Textarea
                                        label="Content"
                                        value={String(block.content ?? '').trim()}
                                        onChange={(e) => updateBlock(idx, { content: e.target.value || undefined })}
                                        placeholder="Enter instruction text (supports HTML)"
                                        rows={3}
                                      />
                                      <div className="space-y-2">
                                        <span className="text-xs font-medium text-gray-600">Image (optional)</span>
                                        <div className="flex flex-wrap gap-2 items-center">
                                          <input
                                            type="file"
                                            accept="image/*"
                                            className="hidden"
                                            id={`block-img-${q.id}-${idx}`}
                                            onChange={async (e) => {
                                              const file = e.target.files?.[0];
                                              if (!file || !file.type.startsWith('image/')) return;
                                              const { url, error } = await uploadQuestionImage(q.id, file);
                                              e.target.value = '';
                                              if (error) alert(`Upload failed: ${error}`);
                                              else if (url) updateBlock(idx, { imageUrl: url });
                                            }}
                                          />
                                          <Button type="button" variant="outline" size="sm" onClick={() => document.getElementById(`block-img-${q.id}-${idx}`)?.click()}>
                                            <ImagePlus className="w-4 h-4 mr-1" /> Upload
                                          </Button>
                                          <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            onClick={async () => {
                                              const file = await pasteImageFromClipboard();
                                              if (!file) {
                                                alert('No image in clipboard. Take a screenshot (Print Screen) or copy an image first, then paste.');
                                                return;
                                              }
                                              const { url, error } = await uploadQuestionImage(q.id, file);
                                              if (error) alert(`Upload failed: ${error}`);
                                              else if (url) updateBlock(idx, { imageUrl: url });
                                            }}
                                          >
                                            <ClipboardPaste className="w-4 h-4 mr-1" /> Paste
                                          </Button>
                                          {block.imageUrl && (
                                            <>
                                              <img src={block.imageUrl} alt="" className="h-12 object-contain border rounded" />
                                              <button type="button" className="text-xs text-red-600" onClick={() => updateBlock(idx, { imageUrl: undefined, imageFullWidth: undefined })}>Remove</button>
                                            </>
                                          )}
                                        </div>
                                        {block.imageUrl && (
                                          <div className="flex flex-wrap gap-4">
                                            <Checkbox
                                              label="Full width image"
                                              checked={!!block.imageFullWidth}
                                              onChange={(v) => updateBlock(idx, { imageFullWidth: !!v, imageLayout: v ? 'above' : block.imageLayout })}
                                            />
                                            <div>
                                              <label className="text-xs text-gray-500">Layout</label>
                                              <Select
                                                value={block.imageLayout || 'side_by_side'}
                                                onChange={(v) => updateBlock(idx, { imageLayout: (v as ImageLayoutOption) || 'side_by_side' })}
                                                attachDropdown="trigger"
                                                options={[
                                                  { value: 'side_by_side', label: 'Text & image side-by-side' },
                                                  { value: 'above', label: 'Image above, text below' },
                                                  { value: 'below', label: 'Text above, image below' },
                                                ]}
                                              />
                                            </div>
                                            {!block.imageFullWidth && ((block.imageLayout || 'side_by_side') === 'side_by_side') && (
                                              <div>
                                                <label className="text-xs text-gray-500">Image width %</label>
                                                <Input type="number" min={20} max={80} value={block.imageWidthPercent ?? 50} onChange={(e) => updateBlock(idx, { imageWidthPercent: Math.max(20, Math.min(80, Number(e.target.value) || 50)) })} />
                                              </div>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                    </>
                                  )}
                                  {block.type === 'image' && (
                                    <div className="space-y-2">
                                      <p className="text-xs text-gray-500">Optional image shown below the main question (same style as question image in the PDF).</p>
                                      <div className="flex flex-wrap gap-2 items-center">
                                        <input
                                          type="file"
                                          accept="image/*"
                                          className="hidden"
                                          id={`block-img-only-${q.id}-${idx}`}
                                          onChange={async (e) => {
                                            const file = e.target.files?.[0];
                                            if (!file || !file.type.startsWith('image/')) return;
                                            const { url, error } = await uploadQuestionImage(q.id, file);
                                            e.target.value = '';
                                            if (error) alert(`Upload failed: ${error}`);
                                            else if (url) updateBlock(idx, { imageUrl: url });
                                          }}
                                        />
                                        <Button type="button" variant="outline" size="sm" onClick={() => document.getElementById(`block-img-only-${q.id}-${idx}`)?.click()}>
                                          <ImagePlus className="w-4 h-4 mr-1" /> Upload
                                        </Button>
                                        <Button
                                          type="button"
                                          variant="outline"
                                          size="sm"
                                          onClick={async () => {
                                            const file = await pasteImageFromClipboard();
                                            if (!file) {
                                              alert('No image in clipboard. Take a screenshot (Print Screen) or copy an image first, then paste.');
                                              return;
                                            }
                                            const { url, error } = await uploadQuestionImage(q.id, file);
                                            if (error) alert(`Upload failed: ${error}`);
                                            else if (url) updateBlock(idx, { imageUrl: url });
                                          }}
                                        >
                                          <ClipboardPaste className="w-4 h-4 mr-1" /> Paste
                                        </Button>
                                        {block.imageUrl && (
                                          <>
                                            <img src={block.imageUrl} alt="" className="h-12 object-contain border rounded" />
                                            <button type="button" className="text-xs text-red-600" onClick={() => updateBlock(idx, { imageUrl: undefined, imageFullWidth: undefined })}>Remove</button>
                                          </>
                                        )}
                                      </div>
                                      {block.imageUrl && (
                                        <div className="flex flex-wrap gap-4">
                                          <Checkbox
                                            label="Full width image"
                                            checked={!!block.imageFullWidth}
                                            onChange={(v) => updateBlock(idx, { imageFullWidth: !!v, imageLayout: v ? 'above' : block.imageLayout })}
                                          />
                                          <div>
                                            <label className="text-xs text-gray-500">Layout</label>
                                            <Select
                                              value={block.imageLayout || 'above'}
                                              onChange={(v) => updateBlock(idx, { imageLayout: (v as ImageLayoutOption) || 'above' })}
                                              attachDropdown="trigger"
                                              options={[
                                                { value: 'side_by_side', label: 'Text & image side-by-side' },
                                                { value: 'above', label: 'Image above, text below' },
                                                { value: 'below', label: 'Text above, image below' },
                                              ]}
                                            />
                                          </div>
                                          {!block.imageFullWidth && ((block.imageLayout || 'above') === 'side_by_side') && (
                                            <div>
                                              <label className="text-xs text-gray-500">Image width %</label>
                                              <Input type="number" min={20} max={80} value={block.imageWidthPercent ?? 50} onChange={(e) => updateBlock(idx, { imageWidthPercent: Math.max(20, Math.min(80, Number(e.target.value) || 50)) })} />
                                            </div>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  )}
                                  {(block.type === 'short_text' || block.type === 'long_text') && (() => {
                                    const childQ = block.questionId ? selectedSection.questions.find((x) => x.id === block.questionId) : null;
                                    if (!childQ) return <p className="text-sm text-amber-600">Creating... Please wait.</p>;
                                    const childPm = (childQ.pdf_meta as Record<string, unknown>) || {};
                                    const wl = normalizeWordLimit(childPm.wordLimit);
                                    return (
                                      <div className="space-y-2">
                                        <Input label="Label" value={childQ.label} onChange={(e) => updateQuestion(childQ.id, { label: e.target.value })} />
                                        <Input label="Word limit" type="number" min={1} value={wl ?? ''} onChange={(e) => updateQuestion(childQ.id, { pdf_meta: { ...childPm, wordLimit: normalizeWordLimit(e.target.value) } })} placeholder="e.g. 100" />
                                        <Checkbox
                                          label="Allow image upload with answer (optional; HEIC/iPhone converted for PDF)"
                                          checked={!!childPm.allowAnswerImage}
                                          onChange={(v) => updateQuestion(childQ.id, { pdf_meta: { ...childPm, allowAnswerImage: !!v } })}
                                        />
                                        <div className="space-y-1">
                                          <span className="text-xs font-medium text-gray-600">Image (optional)</span>
                                          <div className="flex flex-wrap gap-2 items-center">
                                            <input
                                              type="file"
                                              accept="image/*"
                                              className="hidden"
                                              id={`block-q-img-${childQ.id}`}
                                              onChange={async (e) => {
                                                const file = e.target.files?.[0];
                                                if (!file || !file.type.startsWith('image/')) return;
                                                const { url, error } = await uploadQuestionImage(childQ.id, file);
                                                e.target.value = '';
                                                if (error) alert(`Upload failed: ${error}`);
                                                else if (url) updateQuestion(childQ.id, { pdf_meta: { ...childPm, imageUrl: url } });
                                              }}
                                            />
                                            <Button type="button" variant="outline" size="sm" onClick={() => document.getElementById(`block-q-img-${childQ.id}`)?.click()}>
                                              <ImagePlus className="w-4 h-4 mr-1" /> Upload
                                            </Button>
                                            <Button
                                              type="button"
                                              variant="outline"
                                              size="sm"
                                              onClick={async () => {
                                                const file = await pasteImageFromClipboard();
                                                if (!file) {
                                                  alert('No image in clipboard. Take a screenshot (Print Screen) or copy an image first, then paste.');
                                                  return;
                                                }
                                                const { url, error } = await uploadQuestionImage(childQ.id, file);
                                                if (error) alert(`Upload failed: ${error}`);
                                                else if (url) updateQuestion(childQ.id, { pdf_meta: { ...childPm, imageUrl: url } });
                                              }}
                                            >
                                              <ClipboardPaste className="w-4 h-4 mr-1" /> Paste
                                            </Button>
                                            {(childPm.imageUrl as string) && (
                                              <>
                                                <img src={childPm.imageUrl as string} alt="" className="h-12 object-contain border rounded" />
                                                <button type="button" className="text-xs text-red-600" onClick={() => updateQuestion(childQ.id, { pdf_meta: { ...childPm, imageUrl: undefined, imageLayout: undefined, imageWidthPercent: undefined, imageFullWidth: undefined } })}>Remove</button>
                                              </>
                                            )}
                                          </div>
                                          {(childPm.imageUrl as string) && (
                                            <div className="flex flex-wrap gap-4 items-end">
                                              <Checkbox
                                                label="Full width image"
                                                checked={!!(childPm.imageFullWidth as boolean | undefined)}
                                                onChange={(v) => updateQuestion(childQ.id, { pdf_meta: { ...childPm, imageFullWidth: !!v, imageLayout: v ? 'above' : (childPm.imageLayout as string) } })}
                                              />
                                              <div style={{ minWidth: 220 }}>
                                                <Select
                                                  label="Image layout"
                                                  value={(childPm.imageLayout as string) || 'side_by_side'}
                                                  onChange={(v) => updateQuestion(childQ.id, { pdf_meta: { ...childPm, imageLayout: (v as ImageLayoutOption) || 'side_by_side' } })}
                                                  attachDropdown="trigger"
                                                  options={[
                                                    { value: 'side_by_side', label: 'Text & image side-by-side' },
                                                    { value: 'above', label: 'Image above' },
                                                    { value: 'below', label: 'Image below' },
                                                  ]}
                                                />
                                              </div>
                                              {!((childPm.imageFullWidth as boolean | undefined) ?? false) && (((childPm.imageLayout as string) || 'side_by_side') === 'side_by_side') && (
                                                <div>
                                                  <label className="text-xs text-gray-500">Image width %</label>
                                                  <Input
                                                    type="number"
                                                    min={20}
                                                    max={80}
                                                    value={(childPm.imageWidthPercent as number) ?? 50}
                                                    onChange={(e) =>
                                                      updateQuestion(childQ.id, {
                                                        pdf_meta: { ...childPm, imageWidthPercent: Math.max(20, Math.min(80, Number(e.target.value) || 50)) },
                                                      })
                                                    }
                                                  />
                                                </div>
                                              )}
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                    );
                                  })()}
                                  {block.type === 'grid_table' && (() => {
                                    const childQ = block.questionId ? selectedSection.questions.find((x) => x.id === block.questionId) : null;
                                    if (!childQ) return <p className="text-sm text-amber-600">Creating... Please wait.</p>;
                                    const childPm = (childQ.pdf_meta as Record<string, unknown>) || {};
                                    const childColumns = getGridColumnsMeta(childPm);
                                    const childColumnWordLimits = childColumns.map((_, idx) =>
                                      normalizeWordLimit(Array.isArray(childPm.columnWordLimits) ? (childPm.columnWordLimits as unknown[])[idx] : null)
                                    );
                                    return (
                                      <div className="space-y-2">
                                        <TableLayoutSelect value={(childPm.layout as string) || 'no_image'} onChange={(v) => updateQuestion(childQ.id, { pdf_meta: { ...childPm, layout: v } })} />
                                        <div className="space-y-2">
                                          {childColumns.map((col, colIdx) => (
                                            <div key={colIdx} className="grid grid-cols-12 gap-2 items-end">
                                              <div className="col-span-5">
                                                <Input label={`Column ${colIdx + 1}`} value={col.label} onChange={(e) => { const next = [...childColumns]; next[colIdx] = { ...next[colIdx], label: e.target.value }; updateQuestion(childQ.id, { pdf_meta: withGridColumnsMeta(childPm, next) }); }} placeholder="e.g. Terms, Explanation" />
                                              </div>
                                              <div className="col-span-3">
                                                <Select
                                                  label="Type"
                                                  value={col.type}
                                                  onChange={(v) => {
                                                    const next = [...childColumns];
                                                    next[colIdx] = { ...next[colIdx], type: normalizeGridColumnType(v) };
                                                    updateQuestion(childQ.id, { pdf_meta: withGridColumnsMeta(childPm, next) });
                                                  }}
                                                  options={GRID_COLUMN_TYPE_OPTIONS}
                                                />
                                              </div>
                                              <div className="col-span-3">
                                                <Input
                                                  label="Word limit (optional)"
                                                  type="number"
                                                  min={1}
                                                  value={childColumnWordLimits[colIdx] ?? ''}
                                                  disabled={col.type !== 'answer'}
                                                  onChange={(e) => {
                                                    const nextLimits = [...childColumnWordLimits];
                                                    nextLimits[colIdx] = normalizeWordLimit(e.target.value);
                                                    updateQuestion(childQ.id, {
                                                      pdf_meta: { ...(withGridColumnsMeta(childPm, childColumns) as Record<string, unknown>), columnWordLimits: nextLimits } as Json,
                                                    });
                                                  }}
                                                  placeholder={col.type === 'answer' ? 'e.g. 20' : 'N/A'}
                                                />
                                              </div>
                                              <div className="col-span-1 flex justify-end">
                                                <button
                                                  type="button"
                                                  className="text-xs text-red-600 hover:text-red-700 pb-2"
                                                  onClick={() => { const next = childColumns.filter((_, i) => i !== colIdx); updateQuestion(childQ.id, { pdf_meta: withGridColumnsMeta(childPm, next) }); }}
                                                >
                                                  Remove
                                                </button>
                                              </div>
                                            </div>
                                          ))}
                                          <Button type="button" variant="outline" size="sm" onClick={() => { const next = [...childColumns, { label: `Column ${childColumns.length + 1}`, type: 'answer' as GridColumnType }]; updateQuestion(childQ.id, { pdf_meta: withGridColumnsMeta(childPm, next) }); }}>+ Add column</Button>
                                        </div>
                                        <QuestionRowsEditor questionId={childQ.id} sectionPdfMode="task_questions" formId={formId ? Number(formId) : null} steps={steps} onStepsCreated={refreshStepsTree} gridTableLayout={(childPm.layout as string) || undefined} />
                                      </div>
                                    );
                                  })()}
                                </div>
                              ))}
                              <div className="flex flex-wrap gap-2">
                                {CONTENT_BLOCK_TYPES.map((opt) => (
                                  <Button key={opt.value} type="button" variant="outline" size="sm" onClick={() => addBlock(opt.value as ContentBlockType)}>
                                    + Add {opt.label}
                                  </Button>
                                ))}
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                </Card>
              );
            })() : selectedSection?.pdf_render_mode === 'task_results' ? (
              <Card>
                <h3 className="font-bold mb-2">Results sheet</h3>
                <p className="text-sm text-gray-600">
                  This section shows the results template (Satisfactory/Not Satisfactory, feedback, signatures) for the trainer/assessor to complete. No editing needed here.
                </p>
              </Card>
            ) : selectedSection?.pdf_render_mode === 'assessment_summary' || selectedSection?.title === 'Assessment Summary Sheet' ? (
              <Card>
                <h3 className="font-bold mb-2">Assessment Summary Sheet</h3>
                <p className="text-sm text-gray-600 mb-3">
                  This section appears as a single page in the PDF. It includes:
                </p>
                <ul className="text-sm text-gray-600 list-disc list-inside space-y-1 mb-3">
                  <li>Student name, ID, start/end date, unit code & name</li>
                  <li>Evidence table with 1st / 2nd / 3rd attempt (Satisfactory / Not Satisfactory, dates)</li>
                  <li>Final assessment result (Competent / Not Yet Competent)</li>
                  <li>Trainer/assessor and student signatures and dates</li>
                  <li>Student overall feedback</li>
                  <li>Administrative use – initials</li>
                </ul>
                <p className="text-sm text-gray-600">
                  All content is completed when the form is filled (e.g. on the form fill page). No editing needed here in the builder.
                </p>
              </Card>
            ) : selectedSection && !editingQuestionId ? (
              <p className="text-sm text-gray-500">
                {selectedSection.pdf_render_mode === 'task_questions'
                  ? 'Select a question or instruction to edit, or click + Add / + Add Instruction'
                  : 'Select a question to edit, or click + Add to create one'}
              </p>
            ) : !selectedSection ? (
              <p className="text-sm text-gray-500">Select a section</p>
            ) : null}
          </div>
        </div>
      </div>

      {confirmRemove && (() => {
        const config = getConfirmDialogConfig()!;
        return (
          <ConfirmDialog
            isOpen
            onClose={() => setConfirmRemove(null)}
            onConfirm={handleConfirmRemove}
            title={config.title}
            message={config.message}
            confirmLabel={config.confirmLabel}
            variant="danger"
          />
        );
      })()}
    </div>
  );
};

const OPTION_SAVE_DEBOUNCE_MS = 450;

function QuestionOptionsEditor({ questionId }: { questionId: number }) {
  const [options, setOptions] = useState<{ id: number; value: string; label: string; sort_order: number }[]>([]);
  const optionPendingUpdates = useRef<Record<number, { value?: string; label?: string }>>({});
  const optionSaveTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    supabase
      .from('skyline_form_question_options')
      .select('*')
      .eq('question_id', questionId)
      .order('sort_order')
      .then(({ data }) => setOptions(data || []));
  }, [questionId]);

  useEffect(() => {
    return () => {
      Object.keys(optionSaveTimers.current).forEach((id) => {
        clearTimeout(optionSaveTimers.current[Number(id)]);
        const pending = optionPendingUpdates.current[Number(id)];
        if (pending && Object.keys(pending).length > 0) {
          supabase.from('skyline_form_question_options').update(pending).eq('id', Number(id));
        }
      });
      optionSaveTimers.current = {};
      optionPendingUpdates.current = {};
    };
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ addPromises: (ps: Promise<unknown>[]) => void }>).detail;
      const promises: Promise<unknown>[] = [];
      Object.keys(optionSaveTimers.current).forEach((id) => {
        clearTimeout(optionSaveTimers.current[Number(id)]);
        delete optionSaveTimers.current[Number(id)];
      });
      Object.keys(optionPendingUpdates.current).forEach((id) => {
        const pending = optionPendingUpdates.current[Number(id)];
        delete optionPendingUpdates.current[Number(id)];
        if (pending && Object.keys(pending).length > 0) {
          promises.push(Promise.resolve(supabase.from('skyline_form_question_options').update(pending).eq('id', Number(id))));
        }
      });
      if (promises.length > 0) detail.addPromises(promises);
    };
    window.addEventListener(FLUSH_PENDING_EVENT, handler);
    return () => window.removeEventListener(FLUSH_PENDING_EVENT, handler);
  }, []);

  const addOption = async () => {
    const { data } = await supabase
      .from('skyline_form_question_options')
      .insert({ question_id: questionId, value: `opt_${Date.now()}`, label: 'New option', sort_order: options.length })
      .select('*')
      .single();
    if (data) setOptions((prev) => [...prev, data]);
  };

  const flushOptionSave = useCallback((id: number) => {
    const pending = optionPendingUpdates.current[id];
    delete optionPendingUpdates.current[id];
    const t = optionSaveTimers.current[id];
    if (t) clearTimeout(t);
    delete optionSaveTimers.current[id];
    if (pending && Object.keys(pending).length > 0) {
      supabase.from('skyline_form_question_options').update(pending).eq('id', id);
    }
  }, []);

  const updateOption = useCallback((id: number, updates: { value?: string; label?: string }) => {
    setOptions((prev) => prev.map((o) => (o.id === id ? { ...o, ...updates } : o)));
    optionPendingUpdates.current[id] = { ...optionPendingUpdates.current[id], ...updates };
    const existing = optionSaveTimers.current[id];
    if (existing) clearTimeout(existing);
    optionSaveTimers.current[id] = setTimeout(() => flushOptionSave(id), OPTION_SAVE_DEBOUNCE_MS);
  }, [flushOptionSave]);

  return (
    <div>
      <div className="text-sm font-semibold mb-2">Options</div>
      <div className="space-y-2">
        {options.map((opt) => (
          <div key={opt.id} className="flex gap-2">
            <Input
              value={opt.value}
              onChange={(e) => updateOption(opt.id, { value: e.target.value })}
              placeholder="Value"
              className="w-24"
            />
            <Input
              value={opt.label}
              onChange={(e) => updateOption(opt.id, { label: e.target.value })}
              placeholder="Label"
              className="flex-1"
            />
          </div>
        ))}
      </div>
      <Button variant="outline" size="sm" onClick={addOption} className="mt-2">
        + Add option
      </Button>
    </div>
  );
}

interface QuestionRow {
  id: number;
  row_label: string;
  row_help: string | null;
  row_image_url: string | null;
  row_meta?: Record<string, unknown> | null;
  sort_order: number;
}

const ROW_SAVE_DEBOUNCE_MS = 450;

function QuestionRowsEditor({ questionId, sectionPdfMode, formId, steps, onStepsCreated, gridTableLayout, simpleLabelsOnly = false }: { questionId: number; sectionPdfMode?: string; formId?: number | null; steps?: { sort_order: number }[]; onStepsCreated?: () => void; gridTableLayout?: string; simpleLabelsOnly?: boolean }) {
  const [rows, setRows] = useState<QuestionRow[]>([]);
  const [bulkRowCount, setBulkRowCount] = useState<string>('5');
  const [bulkAdding, setBulkAdding] = useState(false);
  const [instructionsModalRow, setInstructionsModalRow] = useState<QuestionRow | null>(null);
  const [uploadingRowId, setUploadingRowId] = useState<number | null>(null);
  const rowsRef = useRef<QuestionRow[]>([]);
  const rowPendingUpdates = useRef<Record<number, Partial<QuestionRow>>>({});
  const rowSaveTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    supabase
      .from('skyline_form_question_rows')
      .select('*')
      .eq('question_id', questionId)
      .order('sort_order')
      .then(({ data }) => setRows(data || []));
  }, [questionId]);

  useEffect(() => {
    return () => {
      Object.keys(rowSaveTimers.current).forEach((id) => {
        clearTimeout(rowSaveTimers.current[Number(id)]);
        const pending = rowPendingUpdates.current[Number(id)];
        if (pending && Object.keys(pending).length > 0) {
          supabase.from('skyline_form_question_rows').update(pending).eq('id', Number(id));
        }
      });
      rowSaveTimers.current = {};
      rowPendingUpdates.current = {};
    };
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ addPromises: (ps: Promise<unknown>[]) => void }>).detail;
      const promises: Promise<unknown>[] = [];
      Object.keys(rowSaveTimers.current).forEach((id) => {
        clearTimeout(rowSaveTimers.current[Number(id)]);
        delete rowSaveTimers.current[Number(id)];
      });
      Object.keys(rowPendingUpdates.current).forEach((id) => {
        const pending = rowPendingUpdates.current[Number(id)];
        delete rowPendingUpdates.current[Number(id)];
        if (pending && Object.keys(pending).length > 0) {
          promises.push(Promise.resolve(supabase.from('skyline_form_question_rows').update(pending).eq('id', Number(id))));
        }
      });
      if (promises.length > 0) detail.addPromises(promises);
    };
    window.addEventListener(FLUSH_PENDING_EVENT, handler);
    return () => window.removeEventListener(FLUSH_PENDING_EVENT, handler);
  }, []);

  const isAssessmentTasks = sectionPdfMode === 'assessment_tasks';

  const addRow = async () => {
    const currentRows = rowsRef.current;
    const defaultLabel =
      sectionPdfMode === 'assessment_tasks'
        ? nextAssessmentTaskLabel(currentRows.map((r) => r.row_label))
        : '';
    const { data } = await supabase
      .from('skyline_form_question_rows')
      .insert({ question_id: questionId, row_label: defaultLabel, sort_order: currentRows.length })
      .select('*')
      .single();
    if (data) {
      setRows((prev) => {
        const next = [...prev, data];
        rowsRef.current = next;
        return next;
      });
      if (sectionPdfMode === 'assessment_tasks' && formId && onStepsCreated) {
        const row = data as QuestionRow;
        const { data: maxStepRow } = await supabase
          .from('skyline_form_steps')
          .select('sort_order')
          .eq('form_id', formId)
          .order('sort_order', { ascending: false })
          .limit(1)
          .maybeSingle();
        const maxStepOrder =
          maxStepRow && typeof (maxStepRow as { sort_order: number }).sort_order === 'number'
            ? (maxStepRow as { sort_order: number }).sort_order
            : steps?.length
              ? Math.max(...steps.map((s) => s.sort_order), 0)
              : 0;
        await insertAssessmentTaskStepWithSections(formId, row.id, row.row_label, maxStepOrder + 1);
        onStepsCreated();
      }
    }
  };

  const addMultipleRows = async () => {
    const parsed = Math.floor(Number.parseInt(String(bulkRowCount).trim(), 10));
    const n = Math.min(100, Math.max(1, Number.isFinite(parsed) ? parsed : 1));
    if (isAssessmentTasks) {
      setBulkAdding(true);
      try {
        for (let i = 0; i < n; i++) {
          await addRow();
        }
      } finally {
        setBulkAdding(false);
      }
      return;
    }
    setBulkAdding(true);
    try {
      const start = rowsRef.current.length;
      const inserts = Array.from({ length: n }, (_, i) => ({
        question_id: questionId,
        row_label: '',
        sort_order: start + i,
      }));
      const { data, error } = await supabase.from('skyline_form_question_rows').insert(inserts).select('*');
      if (error) {
        console.error('Bulk insert rows failed:', error);
        alert(`Could not add rows: ${error.message}`);
        return;
      }
      if (data?.length) {
        setRows((prev) => {
          const next = [...prev, ...(data as QuestionRow[])];
          rowsRef.current = next;
          return next;
        });
      }
    } finally {
      setBulkAdding(false);
    }
  };

  const flushRowSave = useCallback(async (id: number) => {
    const pending = rowPendingUpdates.current[id];
    delete rowPendingUpdates.current[id];
    const t = rowSaveTimers.current[id];
    if (t) clearTimeout(t);
    delete rowSaveTimers.current[id];
    if (pending && Object.keys(pending).length > 0) {
      const { error } = await supabase.from('skyline_form_question_rows').update(pending).eq('id', id);
      if (error) {
        console.error('Failed to save row changes:', error);
      }
    }
  }, []);

  const updateRow = useCallback((id: number, updates: Partial<QuestionRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...updates } : r)));
    rowPendingUpdates.current[id] = { ...rowPendingUpdates.current[id], ...updates };
    const existing = rowSaveTimers.current[id];
    if (existing) clearTimeout(existing);
    rowSaveTimers.current[id] = setTimeout(() => { void flushRowSave(id); }, ROW_SAVE_DEBOUNCE_MS);
  }, [flushRowSave]);

  const saveInstructions = async (rowId: number, data: TaskInstructionsData) => {
    const row_meta = { instructions: data };
    if (rowSaveTimers.current[rowId]) clearTimeout(rowSaveTimers.current[rowId]);
    delete rowSaveTimers.current[rowId];
    delete rowPendingUpdates.current[rowId];
    const updates: { row_meta: typeof row_meta; row_help?: string | null } = { row_meta };
    if (data.assessment_type !== undefined) {
      updates.row_help = data.assessment_type || null;
    }
    await supabase.from('skyline_form_question_rows').update(updates).eq('id', rowId);
    setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, row_meta, row_help: updates.row_help ?? r.row_help } : r)));
  };

  const removeRow = async (r: QuestionRow) => {
    if (!window.confirm('Remove this row? This cannot be undone.')) return;
    delete rowSaveTimers.current[r.id];
    delete rowPendingUpdates.current[r.id];
    if (isAssessmentTasks && formId && onStepsCreated) {
      const { data: sections } = await supabase.from('skyline_form_sections').select('step_id').eq('assessment_task_row_id', r.id);
      const stepIds = [...new Set((sections || []).map((s: { step_id: number }) => s.step_id))];
      for (const stepId of stepIds) {
        await supabase.from('skyline_form_sections').delete().eq('step_id', stepId);
        await supabase.from('skyline_form_steps').delete().eq('id', stepId);
      }
      onStepsCreated();
    }
    await supabase.from('skyline_form_question_rows').delete().eq('id', r.id);
    setRows((prev) => prev.filter((x) => x.id !== r.id));
  };

  return (
    <div>
      <div className="text-sm font-semibold mb-2">{isAssessmentTasks ? 'Assessment tasks' : 'Table rows'}</div>
      {isAssessmentTasks ? (
        <p className="text-xs text-gray-600 mb-3">
          Each task automatically gets <strong>Instructions</strong>, <strong>Questions</strong>, and <strong>Results</strong> sections. Click <strong>Edit instructions</strong> to add content. Add questions in the task&apos;s Questions section.
        </p>
      ) : gridTableLayout === 'no_image' ? (
        <p className="text-xs text-gray-600 mb-3">
          Each row = one table row. <strong>Row label</strong> → 1st column. <strong>Description</strong> → 2nd column. Add input columns in Table layout below.
        </p>
      ) : gridTableLayout === 'no_image_no_header' ? (
        <p className="text-xs text-gray-600 mb-3">
          Each row = one table row. Header row is hidden in this layout.
        </p>
      ) : (
        <p className="text-xs text-gray-600 mb-3">
          Each row = one table row. <strong>Row label</strong> = first column (e.g. Polygon Name). <strong>Image</strong> = optional (upload or URL). <strong>Description</strong> = for question-type columns.
        </p>
      )}
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.id} className="flex flex-col gap-2 p-2 rounded border border-gray-200">
            <div className="flex gap-2 items-center">
              <Input
                value={r.row_label}
                onChange={(e) => updateRow(r.id, { row_label: e.target.value })}
                onBlur={() => { void flushRowSave(r.id); }}
                placeholder={isAssessmentTasks ? 'Evidence number (e.g. Assessment task 1)' : 'Row label'}
                className="flex-1"
              />
              <Button variant="outline" size="sm" onClick={() => removeRow(r)} title="Remove row" className="text-red-600 hover:text-red-700 hover:border-red-300">
                <Trash2 className="w-4 h-4" />
              </Button>
              {!isAssessmentTasks && !simpleLabelsOnly && gridTableLayout !== 'no_image' && (
                <div className="flex items-center gap-2 min-w-0">
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    id={`row-image-${r.id}`}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file || !formId) return;
                      setUploadingRowId(r.id);
                      const { url, error } = await uploadRowImage(formId, questionId, r.id, file);
                      setUploadingRowId(null);
                      e.target.value = '';
                      if (error) alert(`Upload failed: ${error}`);
                      else if (url) updateRow(r.id, { row_image_url: url });
                    }}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!formId || uploadingRowId === r.id}
                    onClick={() => document.getElementById(`row-image-${r.id}`)?.click()}
                  >
                    {uploadingRowId === r.id ? 'Uploading…' : <ImagePlus className="w-4 h-4" />}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!formId || uploadingRowId === r.id}
                    title="Paste from clipboard (e.g. screenshot)"
                    onClick={async () => {
                      const file = await pasteImageFromClipboard();
                      if (!file) {
                        alert('No image in clipboard. Take a screenshot (Print Screen) or copy an image first, then paste.');
                        return;
                      }
                      setUploadingRowId(r.id);
                      const { url, error } = await uploadRowImage(formId!, questionId, r.id, file);
                      setUploadingRowId(null);
                      if (error) alert(`Upload failed: ${error}`);
                      else if (url) updateRow(r.id, { row_image_url: url });
                    }}
                  >
                    <ClipboardPaste className="w-4 h-4" />
                  </Button>
                  <Input
                    value={r.row_image_url || ''}
                    onChange={(e) => updateRow(r.id, { row_image_url: e.target.value || null })}
                    onBlur={() => { void flushRowSave(r.id); }}
                    placeholder="Or paste image URL"
                    className="w-40"
                  />
                </div>
              )}
              {isAssessmentTasks && (
                <Button variant="outline" size="sm" onClick={() => setInstructionsModalRow(r)}>
                  Edit instructions
                </Button>
              )}
            </div>
            {!isAssessmentTasks && !simpleLabelsOnly && (
              <Textarea
                value={r.row_help || ''}
                onChange={(e) => updateRow(r.id, { row_help: e.target.value || null })}
                onBlur={() => { void flushRowSave(r.id); }}
                placeholder={gridTableLayout === 'no_image' ? '2nd column content (e.g. question or description)' : 'Description / question text (for 2nd column or question-type columns)'}
                rows={2}
                className="text-sm"
              />
            )}
            {isAssessmentTasks && (
              <Textarea
                value={r.row_help || ''}
                onChange={(e) => updateRow(r.id, { row_help: e.target.value || null })}
                onBlur={() => { void flushRowSave(r.id); }}
                placeholder="Assessment method/ Type of evidence (use new lines for multiple items)"
                rows={2}
                className="text-sm"
              />
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <Button variant="outline" size="sm" onClick={() => void addRow()} disabled={bulkAdding}>
          + Add row
        </Button>
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-gray-300 bg-gray-50/80 px-2 py-1.5">
          <span className="text-xs text-gray-600 shrink-0">Or add many:</span>
          <Input
            type="number"
            min={1}
            max={100}
            value={bulkRowCount}
            onChange={(e) => setBulkRowCount(e.target.value)}
            className="h-8 w-16 text-sm"
            aria-label="Number of rows to add"
          />
          <Button variant="outline" size="sm" onClick={() => void addMultipleRows()} disabled={bulkAdding} className="shrink-0">
            {bulkAdding ? 'Adding…' : 'Add rows'}
          </Button>
        </div>
      </div>
      {instructionsModalRow && (
        <TaskInstructionsModal
          isOpen={!!instructionsModalRow}
          onClose={() => setInstructionsModalRow(null)}
          rowLabel={instructionsModalRow.row_label}
          initialData={(instructionsModalRow.row_meta as { instructions?: TaskInstructionsData })?.instructions}
          rowHelpFallback={instructionsModalRow.row_help}
          onSave={(data) => saveInstructions(instructionsModalRow.id, data)}
        />
      )}
    </div>
  );
}
