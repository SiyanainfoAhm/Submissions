import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { KeyRound, Users } from 'lucide-react';
import { Card } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { Loader } from '../components/ui/Loader';
import { AdminListPagination } from '../components/admin/AdminListPagination';
import {
  listMyBatchesForTrainer,
  listMyStudentsForTrainer,
  type TrainerBatchOption,
  type TrainerStudentRow,
} from '../lib/formEngine';

const PAGE_SIZE = 25;
const ALL_BATCHES = '';

/**
 * Trainer-only list: students in the batches the signed-in trainer trains.
 * Search, batch filter and paging are all done on the server (which also enforces whose
 * batches these are), so large batches stay fast.
 */
export const TrainerMyStudentsPage: React.FC = () => {
  const [students, setStudents] = useState<TrainerStudentRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [batchId, setBatchId] = useState<string>(ALL_BATCHES);
  const [batches, setBatches] = useState<TrainerBatchOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listMyBatchesForTrainer().then((res) => {
      if (cancelled) return;
      setBatches(res.ok ? res.data : []);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      const res = await listMyStudentsForTrainer(page, PAGE_SIZE, search, batchId ? Number(batchId) : null);
      if (cancelled) return;
      if (res.ok) {
        // Landed past the last page (e.g. students were moved out of the batch): go back to page 1.
        if (res.data.length === 0 && page > 1) {
          setPage(1);
          return;
        }
        setStudents(res.data);
        setTotal(res.total);
        setErrorMessage(null);
      } else {
        setStudents([]);
        setTotal(0);
        setErrorMessage(res.message);
      }
      setLoading(false);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [page, search, batchId]);

  const batchOptions = useMemo(() => {
    const allCount = batches.reduce((sum, b) => sum + b.student_count, 0);
    return [
      { value: ALL_BATCHES, label: `All my batches (${allCount})` },
      ...batches.map((b) => ({ value: String(b.id), label: `${b.name} (${b.student_count})` })),
    ];
  }, [batches]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const firstShown = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastShown = Math.min(total, page * PAGE_SIZE);
  const rangeLabel = `Showing ${firstShown}–${lastShown} of ${total}`;
  const filtered = Boolean(search.trim()) || batchId !== ALL_BATCHES;

  const pagination = (placement: 'top' | 'bottom') => (
    <AdminListPagination
      placement={placement}
      totalItems={total}
      pageSize={PAGE_SIZE}
      currentPage={page}
      totalPages={totalPages}
      onPrev={() => setPage((p) => Math.max(1, p - 1))}
      onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
      onGoToPage={(p) => setPage(Math.min(totalPages, Math.max(1, p)))}
      itemLabel="students"
      rangeLabel={rangeLabel}
    />
  );

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <div className="w-full px-4 md:px-6 lg:px-8 py-6">
        <Card className="mb-6">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-[var(--text)]">My students</h2>
              <p className="text-sm text-gray-600 mt-1">Students in the batches you train.</p>
            </div>
            <div className="flex w-full flex-col gap-2 sm:flex-row lg:w-auto">
              <div className="w-full sm:w-72">
                <Input
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                  placeholder="Search name, student ID or email"
                  aria-label="Search students"
                />
              </div>
              <div className="w-full sm:w-72">
                <Select
                  value={batchId}
                  onChange={(v) => {
                    setBatchId(v);
                    setPage(1);
                  }}
                  options={batchOptions}
                />
              </div>
            </div>
          </div>
        </Card>

        <Card>
          {loading ? (
            <div className="py-12">
              <Loader variant="dots" size="lg" message="Loading students..." />
            </div>
          ) : errorMessage ? (
            <p className="text-sm text-amber-700">{errorMessage}</p>
          ) : students.length === 0 ? (
            <p className="text-gray-500">
              {filtered
                ? 'No students match your search or batch.'
                : 'There are no students in the batches you train yet.'}
            </p>
          ) : (
            <>
              {pagination('top')}
              <div className="overflow-x-auto">
                <table className="min-w-[640px] w-full text-sm border border-[var(--border)] rounded-lg overflow-hidden">
                  <thead className="bg-gray-50 text-gray-700">
                    <tr>
                      <th className="text-left px-4 py-3 font-semibold border-b border-[var(--border)]">Student</th>
                      <th className="text-left px-4 py-3 font-semibold border-b border-[var(--border)]">Student ID</th>
                      <th className="text-left px-4 py-3 font-semibold border-b border-[var(--border)]">Batch</th>
                      <th className="text-left px-4 py-3 font-semibold border-b border-[var(--border)]">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {students.map((s) => (
                      <tr key={s.id} className="hover:bg-[var(--brand)]/10 transition-colors">
                        <td className="px-4 py-3 border-b border-[var(--border)]">
                          <div className="flex items-center gap-2 min-w-0">
                            <Users className="w-4 h-4 text-gray-400 shrink-0" />
                            <div className="min-w-0">
                              <Link
                                to={`/admin/my-students/${s.id}`}
                                className="font-medium text-blue-600 hover:text-blue-800 hover:underline break-words"
                              >
                                {s.full_name || s.email}
                              </Link>
                              <div className="text-xs text-gray-500 break-all">{s.email}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 border-b border-[var(--border)] text-gray-700">{s.student_code ?? '—'}</td>
                        <td className="px-4 py-3 border-b border-[var(--border)] text-gray-700">
                          <span>{s.batch_name ?? '—'}</span>
                          {s.can_login_as_student ? (
                            <span
                              className="ml-2 inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 align-middle"
                              title="You can log in as this student"
                            >
                              <KeyRound className="h-3 w-3" />
                              Login allowed
                            </span>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 border-b border-[var(--border)] text-gray-700 capitalize">
                          {s.status ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {pagination('bottom')}
            </>
          )}
        </Card>
      </div>
    </div>
  );
};
