import React, { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Plus, Pencil, Users, CalendarRange, Trash2, KeyRound } from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
  listBatchesPaged,
  createBatch,
  updateBatch,
  updateBatchStudentAssignments,
  listUsersForBatchAssignmentPaged,
  listStudentsPaged,
  listStudentsInBatch,
  listCoursesPaged,
  deleteBatchIfAllStudentsInactive,
  deleteBatchSuperadmin,
  fetchBatchTrainerIds,
  formatBatchTrainersLabel,
  setBatchTrainerStudentLogin,
} from '../lib/formEngine';
import type { Batch, Student } from '../lib/formEngine';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { SelectAsync } from '../components/ui/SelectAsync';
import { MultiSelectAsync } from '../components/ui/MultiSelectAsync';
import { Modal } from '../components/ui/Modal';
import { Loader } from '../components/ui/Loader';
import { AdminListPagination } from '../components/admin/AdminListPagination';
import { toast } from '../utils/toast';

const BATCH_PAGE_SIZE = 20;

export const AdminBatchesPage: React.FC = () => {
  const { user } = useAuth();
  const viewerIsSuperadmin = user?.role === 'superadmin';
  /** Only admins see/change the "trainers may log in as students" switch (also enforced on the server). */
  const viewerIsAdmin = user?.role === 'admin' || user?.role === 'superadmin';

  const [batches, setBatches] = useState<Batch[]>([]);
  const [totalBatches, setTotalBatches] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [draft, setDraft] = useState({
    name: '',
    trainer_ids: [] as number[],
    course_id: '',
    allow_trainer_student_login: false,
  });
  const [editDraft, setEditDraft] = useState<{
    name: string;
    trainer_ids: number[];
    course_id: string;
    student_ids: number[];
    allow_trainer_student_login: boolean;
  } | null>(null);
  const [, setEditStudents] = useState<Student[]>([]);
  const [activeCountByBatchId, setActiveCountByBatchId] = useState<Record<number, number>>({});
  const [deletingBatchId, setDeletingBatchId] = useState<number | null>(null);
  const [deleteBatchTarget, setDeleteBatchTarget] = useState<Batch | null>(null);
  const [batchDeleteModalStudents, setBatchDeleteModalStudents] = useState<Student[]>([]);
  const [batchDeleteModalLoading, setBatchDeleteModalLoading] = useState(false);
  /** When checked, student is fully deleted (including assessments); when unchecked, only removed from batch. */
  const [batchDeleteFullDeleteById, setBatchDeleteFullDeleteById] = useState<Record<number, boolean>>({});

  const loadBatches = useCallback(async (page: number) => {
    setLoading(true);
    const res = await listBatchesPaged(page, BATCH_PAGE_SIZE);
    setBatches(res.data);
    setTotalBatches(res.total);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadBatches(currentPage);
  }, [currentPage, loadBatches]);

  useEffect(() => {
    if (batches.length === 0) {
      setActiveCountByBatchId({});
      return;
    }
    const ids = batches.map((b) => Number(b.id)).filter((n) => Number.isFinite(n) && n > 0);
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('skyline_students')
        .select('batch_id, status')
        .in('batch_id', ids);
      if (cancelled) return;
      if (error) {
        console.error('load active students for batches error', error);
        setActiveCountByBatchId({});
        return;
      }
      const rows = (data as Array<{ batch_id: number | null; status: string | null }> | null) || [];
      const map: Record<number, number> = {};
      for (const id of ids) map[id] = 0;
      for (const r of rows) {
        const bid = Number(r.batch_id);
        if (!Number.isFinite(bid) || bid <= 0) continue;
        const st = (r.status ?? 'active') as string;
        if (st === 'inactive') continue;
        map[bid] = (map[bid] ?? 0) + 1;
      }
      setActiveCountByBatchId(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [batches]);

  useEffect(() => {
    if (!deleteBatchTarget || !viewerIsSuperadmin) {
      setBatchDeleteModalStudents([]);
      setBatchDeleteFullDeleteById({});
      setBatchDeleteModalLoading(false);
      return;
    }
    let cancelled = false;
    setBatchDeleteModalLoading(true);
    void listStudentsInBatch(deleteBatchTarget.id).then((students) => {
      if (cancelled) return;
      setBatchDeleteModalStudents(students);
      const m: Record<number, boolean> = {};
      for (const s of students) m[s.id] = true;
      setBatchDeleteFullDeleteById(m);
      setBatchDeleteModalLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [deleteBatchTarget, viewerIsSuperadmin]);

  const requestDeleteBatch = useCallback(
    (batch: Batch) => {
      const bid = Number(batch.id);
      if (!Number.isFinite(bid) || bid <= 0) return;
      const active = activeCountByBatchId[bid] ?? 0;
      if (!viewerIsSuperadmin && active > 0) {
        toast.error('Cannot delete. This batch has active students.');
        return;
      }
      setDeleteBatchTarget(batch);
    },
    [activeCountByBatchId, viewerIsSuperadmin]
  );

  const confirmDeleteBatch = useCallback(async () => {
    const batch = deleteBatchTarget;
    if (!batch) return;
    const bid = Number(batch.id);
    if (!Number.isFinite(bid) || bid <= 0) return;
    const active = activeCountByBatchId[bid] ?? 0;
    if (!viewerIsSuperadmin && active > 0) {
      toast.error('Cannot delete. This batch has active students.');
      setDeleteBatchTarget(null);
      return;
    }
    setDeletingBatchId(bid);
    try {
      if (viewerIsSuperadmin) {
        const fullDeleteIds = Object.entries(batchDeleteFullDeleteById)
          .filter(([, v]) => v)
          .map(([k]) => Number(k))
          .filter((n) => Number.isFinite(n) && n > 0);
        const res = await deleteBatchSuperadmin(bid, fullDeleteIds);
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success('Batch deleted');
        await loadBatches(currentPage);
      } else {
        const res = await deleteBatchIfAllStudentsInactive(bid);
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success('Batch deleted');
        await loadBatches(currentPage);
      }
    } finally {
      setDeletingBatchId(null);
      setDeleteBatchTarget(null);
    }
  }, [
    activeCountByBatchId,
    batchDeleteFullDeleteById,
    currentPage,
    deleteBatchTarget,
    loadBatches,
    viewerIsSuperadmin,
  ]);

  const loadTrainersMultiOptions = useCallback(async (page: number, search: string) => {
    const res = await listUsersForBatchAssignmentPaged(page, 20, search || undefined);
    return {
      options: res.data.map((t) => ({ value: t.id, label: `${t.full_name} (${t.email})` })),
      hasMore: page * 20 < res.total,
    };
  }, []);

  const loadStudentsOptions = useCallback(
    async (page: number, search: string) => {
      const courseId = editDraft?.course_id ? Number(editDraft.course_id) : null;
      if (!courseId || !Number.isFinite(courseId)) {
        return { options: [], hasMore: false };
      }
      const res = await listStudentsPaged(page, 20, search || undefined, 'active', { courseIds: [courseId] });
      return {
        options: res.data.map((s) => ({
          value: s.id,
          label: `${[s.first_name, s.last_name].filter(Boolean).join(' ') || s.email} (${s.student_id ?? s.email})`,
        })),
        hasMore: page * 20 < res.total,
      };
    },
    [editDraft?.course_id]
  );

  const loadCoursesOptions = useCallback(async (page: number, search: string) => {
    const res = await listCoursesPaged(page, 20, search || undefined);
    return {
      options: res.data.map((c) => ({ value: String(c.id), label: c.name })),
      hasMore: page * 20 < res.total,
    };
  }, []);

  const totalPages = Math.max(1, Math.ceil(totalBatches / BATCH_PAGE_SIZE));

  const handleCreate = async () => {
    if (!draft.name.trim()) {
      toast.error('Batch name is required');
      return;
    }
    if (draft.trainer_ids.length === 0) {
      toast.error('Select at least one trainer');
      return;
    }
    const courseId = Number(draft.course_id);
    if (!courseId || !Number.isFinite(courseId)) {
      toast.error('Select a course');
      return;
    }
    setCreating(true);
    const created = await createBatch({
      name: draft.name.trim(),
      trainer_id: draft.trainer_ids[0],
      trainer_ids: draft.trainer_ids,
      course_id: courseId,
    });
    let flagError: string | null = null;
    if (created && viewerIsAdmin && draft.allow_trainer_student_login) {
      const flagRes = await setBatchTrainerStudentLogin(created.id, true);
      if (!flagRes.ok) flagError = flagRes.message;
    }
    setCreating(false);
    if (created) {
      await loadBatches(currentPage);
      setDraft({ name: '', trainer_ids: [], course_id: '', allow_trainer_student_login: false });
      setIsCreateOpen(false);
      if (flagError) toast.error(`Batch added, but trainer login was not switched on: ${flagError}`);
      else toast.success('Batch added');
    } else {
      toast.error('Failed to add batch');
    }
  };

  const editingBatch = batches.find((b) => b.id === editingId);
  useEffect(() => {
    if (!editingBatch) {
      setEditDraft(null);
      setEditStudents([]);
      return;
    }
    setEditDraft({
      name: editingBatch.name,
      trainer_ids: editingBatch.trainer_ids?.length ? [...editingBatch.trainer_ids] : [editingBatch.trainer_id],
      course_id: editingBatch.course_id != null ? String(editingBatch.course_id) : '',
      student_ids: [],
      allow_trainer_student_login: Boolean(editingBatch.allow_trainer_student_login),
    });
    void fetchBatchTrainerIds(editingBatch.id).then((trainerIds) => {
      setEditDraft((p) => (p ? { ...p, trainer_ids: trainerIds.length > 0 ? trainerIds : p.trainer_ids } : null));
    });
    listStudentsInBatch(editingBatch.id).then((students) => {
      const studentIds = students.map((s) => s.id);
      setEditStudents(students);
      setEditDraft((p) => (p ? { ...p, student_ids: studentIds } : null));
    });
  }, [editingId, editingBatch?.id, editingBatch?.name, editingBatch?.trainer_id]);

  const handleSaveEdit = async () => {
    if (!editingId || !editDraft) return;
    if (!editDraft.name.trim()) {
      toast.error('Batch name is required');
      return;
    }
    if (editDraft.trainer_ids.length === 0) {
      toast.error('Select at least one trainer');
      return;
    }
    const courseId = Number(editDraft.course_id);
    if (!courseId || !Number.isFinite(courseId)) {
      toast.error('Select a course');
      return;
    }
    setSavingEdit(true);
    const batchUpdated = await updateBatch(editingId, {
      name: editDraft.name.trim(),
      trainer_id: editDraft.trainer_ids[0],
      trainer_ids: editDraft.trainer_ids,
      course_id: courseId,
    });
    const assignments = await updateBatchStudentAssignments(editingId, editDraft.student_ids);
    let flagError: string | null = null;
    if (
      viewerIsAdmin &&
      editDraft.allow_trainer_student_login !== Boolean(editingBatch?.allow_trainer_student_login)
    ) {
      const flagRes = await setBatchTrainerStudentLogin(editingId, editDraft.allow_trainer_student_login);
      if (!flagRes.ok) flagError = flagRes.message;
    }
    setSavingEdit(false);
    if (batchUpdated && assignments.ok && flagError) {
      await loadBatches(currentPage);
      toast.error(`Batch saved, but the trainer login setting was not changed: ${flagError}`);
    } else if (batchUpdated && assignments.ok) {
      await loadBatches(currentPage);
      setEditingId(null);
      toast.success('Batch updated');
    } else {
      toast.error(assignments.error ?? 'Failed to update batch');
    }
  };

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <div className="w-full px-4 md:px-6 lg:px-8 py-6">
        <Card className="mb-6">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-[var(--text)]">Batches</h2>
              <p className="text-sm text-gray-600 mt-1">
                Create batches and assign one or more trainers. Students must belong to a batch.
              </p>
            </div>
            <Button onClick={() => setIsCreateOpen(true)} className="w-full md:w-auto md:min-w-[140px]">
              <Plus className="w-4 h-4 mr-2 inline" />
              Add Batch
            </Button>
          </div>
        </Card>

        <Card>
          <h2 className="text-lg font-bold text-[var(--text)] mb-4">Batch Directory</h2>
          {!loading && (
            <AdminListPagination
              placement="top"
              totalItems={totalBatches}
              pageSize={BATCH_PAGE_SIZE}
              currentPage={currentPage}
              totalPages={totalPages}
              onPrev={() => setCurrentPage((p) => Math.max(1, p - 1))}
              onNext={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              onGoToPage={(p) => setCurrentPage(p)}
              itemLabel="batches"
            />
          )}
          {loading ? (
            <div className="py-12">
              <Loader variant="dots" size="lg" message="Loading batches..." />
            </div>
          ) : batches.length === 0 ? (
            <p className="text-gray-500">No batches yet. Create a batch to assign students.</p>
          ) : (
            <>
              <div className="space-y-3 lg:hidden">
                {batches.map((batch) => (
                  <div key={batch.id} className="rounded-lg border border-[var(--border)] bg-white p-4 shadow-sm">
                    <div className="flex items-start gap-2">
                      <Users className="mt-0.5 h-5 w-5 shrink-0 text-gray-400" />
                      <div className="min-w-0 flex-1">
                        <Link
                          to={`/admin/batches/${batch.id}/unit-dates`}
                          className="font-medium text-blue-600 hover:text-blue-800 hover:underline break-words"
                        >
                          {batch.name}
                        </Link>
                        {batch.allow_trainer_student_login ? (
                          <span
                            className="ml-2 inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 align-middle"
                            title="Trainers of this batch can log in as its students"
                          >
                            <KeyRound className="h-3 w-3" />
                            Trainer login
                          </span>
                        ) : null}
                        <div className="mt-1 text-sm text-gray-600">
                          <span className="font-medium text-gray-500">Course: </span>
                          {batch.course_name ?? '—'}
                        </div>
                        <div className="mt-1 text-sm text-gray-600 break-words">
                          <span className="font-medium text-gray-500">Trainer(s): </span>
                          {formatBatchTrainersLabel(batch)}
                        </div>
                        <div className="mt-3">
                          <Button variant="outline" size="sm" className="w-full" onClick={() => setEditingId(batch.id)}>
                            <Pencil className="mr-1 h-4 w-4" />
                            Edit
                          </Button>
                          {(viewerIsSuperadmin || (activeCountByBatchId[batch.id] ?? 0) === 0) ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="w-full mt-2"
                              onClick={() => requestDeleteBatch(batch)}
                              disabled={deletingBatchId === batch.id}
                              title={
                                viewerIsSuperadmin
                                  ? 'Delete batch (choose whether to fully delete each student)'
                                  : 'Delete batch (only when no active students)'
                              }
                            >
                              <Trash2 className="mr-1 h-4 w-4" />
                              Delete
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="hidden overflow-x-auto lg:block">
              <table className="min-w-[600px] w-full text-sm border border-[var(--border)] rounded-lg overflow-hidden">
                <thead className="bg-gray-50 text-gray-700">
                  <tr>
                    <th className="text-left px-4 py-3 font-semibold border-b border-[var(--border)]">Batch</th>
                    <th className="text-left px-4 py-3 font-semibold border-b border-[var(--border)]">Course</th>
                    <th className="text-left px-4 py-3 font-semibold border-b border-[var(--border)]">Trainer(s)</th>
                    <th className="text-right px-4 py-3 font-semibold border-b border-[var(--border)]">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((batch) => (
                    <tr key={batch.id} className="hover:bg-[var(--brand)]/10 focus-within:bg-[var(--brand)]/10 transition-colors">
                      <td className="px-4 py-3 border-b border-[var(--border)]">
                        <div className="flex items-center gap-2 min-w-0">
                          <Users className="w-4 h-4 text-gray-400 shrink-0" />
                          <Link
                            to={`/admin/batches/${batch.id}/unit-dates`}
                            className="font-medium text-blue-600 hover:text-blue-800 hover:underline truncate"
                          >
                            {batch.name}
                          </Link>
                          {batch.allow_trainer_student_login ? (
                            <span
                              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800"
                              title="Trainers of this batch can log in as its students"
                            >
                              <KeyRound className="h-3 w-3" />
                              Trainer login
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-4 py-3 border-b border-[var(--border)] text-gray-700">
                        {batch.course_name ?? '—'}
                      </td>
                      <td className="px-4 py-3 border-b border-[var(--border)] text-gray-700">
                        {formatBatchTrainersLabel(batch)}
                      </td>
                      <td className="px-4 py-3 border-b border-[var(--border)] text-right">
                        <div className="inline-flex items-center justify-end gap-2 flex-wrap">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setEditingId(batch.id)}
                            className="inline-flex items-center justify-center gap-1.5"
                          >
                            <Pencil className="w-4 h-4" />
                            Edit
                          </Button>
                          {(viewerIsSuperadmin || (activeCountByBatchId[batch.id] ?? 0) === 0) ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => requestDeleteBatch(batch)}
                              disabled={deletingBatchId === batch.id}
                              className="inline-flex items-center justify-center gap-1.5"
                              title={
                                viewerIsSuperadmin
                                  ? 'Delete batch (choose whether to fully delete each student)'
                                  : 'Delete batch (only when no active students)'
                              }
                            >
                              <Trash2 className="w-4 h-4" />
                              Delete
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </>
          )}
          {!loading && (
            <AdminListPagination
              placement="bottom"
              totalItems={totalBatches}
              pageSize={BATCH_PAGE_SIZE}
              currentPage={currentPage}
              totalPages={totalPages}
              onPrev={() => setCurrentPage((p) => Math.max(1, p - 1))}
              onNext={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              onGoToPage={(p) => setCurrentPage(p)}
              itemLabel="batches"
            />
          )}
        </Card>
      </div>

      <Modal
        isOpen={isCreateOpen}
        onClose={() => !creating && setIsCreateOpen(false)}
        title="Add Batch"
        size="md"
      >
        <div className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Batch Name *</span>
            <Input
              value={draft.name}
              onChange={(e) => setDraft((p) => ({ ...p, name: e.target.value }))}
              placeholder="e.g. Batch A, Morning Class"
              className="mt-1"
            />
          </label>
          <MultiSelectAsync
            label="Trainers *"
            value={draft.trainer_ids}
            onChange={(ids) => setDraft((p) => ({ ...p, trainer_ids: ids }))}
            loadOptions={loadTrainersMultiOptions}
            placeholder="Select trainer(s)"
            countLabel="trainers"
            searchPlaceholder="Search trainers..."
            required
          />
          <p className="text-xs text-gray-500 -mt-2">The first selected trainer is the primary contact for notifications.</p>
          {viewerIsAdmin ? (
            <label className="flex items-start gap-3 rounded-lg border border-[var(--border)] bg-gray-50 p-3 cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-gray-300"
                checked={draft.allow_trainer_student_login}
                onChange={(e) => setDraft((p) => ({ ...p, allow_trainer_student_login: e.target.checked }))}
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-gray-700">
                  Allow trainers to log in as students in this batch
                </span>
                <span className="block text-xs text-gray-500 mt-0.5">
                  Assigned trainers can open student accounts in this batch to help with submissions. Every login is
                  recorded.
                </span>
              </span>
            </label>
          ) : null}
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Course *</span>
            <SelectAsync
              value={draft.course_id}
              onChange={(v) => setDraft((p) => ({ ...p, course_id: v }))}
              loadOptions={loadCoursesOptions}
              placeholder="Select course"
              className="mt-1"
            />
          </label>
        </div>
        <div className="flex items-center justify-end gap-2 pt-4 mt-4 border-t border-[var(--border)]">
          <Button variant="outline" onClick={() => setIsCreateOpen(false)} disabled={creating}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleCreate}
            disabled={creating || !draft.name.trim() || draft.trainer_ids.length === 0 || !draft.course_id}
          >
            {creating ? 'Adding...' : 'Add Batch'}
          </Button>
        </div>
      </Modal>

      <Modal
        isOpen={!!editingId}
        onClose={() => !savingEdit && setEditingId(null)}
        title="Edit Batch"
        size="lg"
      >
        {editDraft && (
          <div className="space-y-4">
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Batch Name *</span>
              <Input
                value={editDraft.name}
                onChange={(e) => setEditDraft((p) => (p ? { ...p, name: e.target.value } : null))}
                placeholder="e.g. Batch A"
                className="mt-1"
              />
            </label>
            <MultiSelectAsync
              label="Trainers *"
              value={editDraft.trainer_ids}
              onChange={(ids) => setEditDraft((p) => (p ? { ...p, trainer_ids: ids } : null))}
              loadOptions={loadTrainersMultiOptions}
              placeholder="Select trainer(s)"
              countLabel="trainers"
              searchPlaceholder="Search trainers..."
              required
            />
            <p className="text-xs text-gray-500">The first selected trainer is the primary contact for notifications.</p>
            {viewerIsAdmin ? (
              <label className="flex items-start gap-3 rounded-lg border border-[var(--border)] bg-gray-50 p-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-gray-300"
                  checked={editDraft.allow_trainer_student_login}
                  onChange={(e) =>
                    setEditDraft((p) => (p ? { ...p, allow_trainer_student_login: e.target.checked } : null))
                  }
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-gray-700">
                    Allow trainers to log in as students in this batch
                  </span>
                  <span className="block text-xs text-gray-500 mt-0.5">
                    Assigned trainers can open student accounts in this batch to help with submissions. Every login is
                    recorded.
                  </span>
                </span>
              </label>
            ) : null}
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Course *</span>
              <SelectAsync
                value={editDraft.course_id}
                onChange={(v) => {
                  setEditDraft((p) => {
                    if (!p) return null;
                    if (p.course_id !== v && p.student_ids.length > 0) {
                      toast.info('Course changed — student selection cleared. Select students enrolled in this course.');
                      return { ...p, course_id: v, student_ids: [] };
                    }
                    return { ...p, course_id: v };
                  });
                }}
                loadOptions={loadCoursesOptions}
                placeholder="Select course"
                selectedLabel={editingBatch?.course_name ?? undefined}
                className="mt-1"
              />
            </label>
            <div className="mt-4">
              <MultiSelectAsync
                label="Students"
                value={editDraft.student_ids}
                onChange={(ids) => setEditDraft((p) => (p ? { ...p, student_ids: ids } : null))}
                loadOptions={loadStudentsOptions}
                placeholder={
                  editDraft.course_id
                    ? 'Select students for this batch'
                    : 'Select a course first'
                }
                maxHeight={220}
                countLabel="students"
                searchPlaceholder="Search eligible students…"
              />
              {editDraft.course_id ? (
                <p className="mt-1 text-xs text-gray-500">
                  Only students actively enrolled in the selected course are listed.
                </p>
              ) : (
                <p className="mt-1 text-xs text-amber-700">Select a course to choose students.</p>
              )}
            </div>

            {editingBatch ? (
              <div className="mt-6 rounded-lg border border-[var(--border)] bg-white p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-gray-800">Student unit dates</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    Filter by date range, select students and units, and mass-edit assessment dates.
                  </div>
                </div>
                <Link to={`/admin/batches/${editingBatch.id}/unit-dates`} className="shrink-0">
                  <Button type="button" variant="outline" className="w-full sm:w-auto">
                    <CalendarRange className="w-4 h-4 mr-2 inline" />
                    Open unit dates
                  </Button>
                </Link>
              </div>
            ) : null}
          </div>
        )}
        {editDraft && (
          <div className="flex items-center justify-end gap-2 pt-4 mt-4 border-t border-[var(--border)]">
            <Button variant="outline" onClick={() => setEditingId(null)} disabled={savingEdit}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleSaveEdit}
              disabled={savingEdit || !editDraft.name.trim() || editDraft.trainer_ids.length === 0 || !editDraft.course_id}
            >
              {savingEdit ? 'Saving...' : 'Save'}
            </Button>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={!!deleteBatchTarget}
        onClose={() => {
          if (deletingBatchId) return;
          setDeleteBatchTarget(null);
        }}
        title="Delete batch"
        size={viewerIsSuperadmin ? 'lg' : 'md'}
      >
        {deleteBatchTarget ? (
          <div className="space-y-4">
            <p className="text-sm text-gray-700">
              Delete batch <strong>{deleteBatchTarget.name}</strong>?
            </p>
            {viewerIsSuperadmin ? (
              <>
                <p className="text-xs text-gray-500">
                  The batch will be removed. For each student in this batch, choose whether to <strong>fully delete</strong> their
                  record (including assessments) or only <strong>remove them from this batch</strong> (uncheck to keep the
                  student).
                </p>
                {batchDeleteModalLoading ? (
                  <div className="py-6 flex justify-center">
                    <Loader variant="dots" size="md" message="Loading students…" />
                  </div>
                ) : batchDeleteModalStudents.length === 0 ? (
                  <p className="text-xs text-gray-600">No students in this batch.</p>
                ) : (
                  <ul className="max-h-56 overflow-y-auto rounded-md border border-[var(--border)] divide-y divide-[var(--border)] text-sm">
                    {batchDeleteModalStudents.map((s) => {
                      const label =
                        [s.first_name, s.last_name].filter(Boolean).join(' ').trim() || s.email || `Student #${s.id}`;
                      const checked = batchDeleteFullDeleteById[s.id] ?? false;
                      return (
                        <li key={s.id} className="flex items-start gap-3 px-3 py-2">
                          <input
                            type="checkbox"
                            id={`batch-del-full-${s.id}`}
                            className="mt-1 h-4 w-4 shrink-0 rounded border-gray-300"
                            checked={checked}
                            onChange={() =>
                              setBatchDeleteFullDeleteById((prev) => ({
                                ...prev,
                                [s.id]: !checked,
                              }))
                            }
                          />
                          <label htmlFor={`batch-del-full-${s.id}`} className="min-w-0 flex-1 cursor-pointer">
                            <span className="font-medium text-gray-800">{label}</span>
                            <span className="block text-xs text-gray-500">{s.email}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            ) : (
              <p className="text-xs text-gray-500">
                This is only allowed when the batch has <strong>no active students</strong>. This action cannot be undone.
              </p>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={() => setDeleteBatchTarget(null)} disabled={!!deletingBatchId}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void confirmDeleteBatch()}
                disabled={!!deletingBatchId || (viewerIsSuperadmin && batchDeleteModalLoading)}
              >
                {deletingBatchId === deleteBatchTarget.id ? <Loader variant="dots" size="sm" inline className="mr-2" /> : null}
                Delete
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
};
