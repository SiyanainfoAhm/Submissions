import React, { useEffect, useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import { LayoutDashboard, RefreshCw, Users, UserRoundCheck, ClipboardCheck } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Select } from '../components/ui/Select';
import { DatePicker } from '../components/ui/DatePicker';
import { Loader } from '../components/ui/Loader';
import { toast } from '../utils/toast';
import { hasActiveExtension } from '../utils/assessmentDeadline';
import { AdminListPagination } from '../components/admin/AdminListPagination';
import { getAdminDashboardStatsV2, getOrIssueInstanceAccessLink, listAdminDashboardInstancesPaged, listBatches, type AdminDashboardStatsV2, type SubmittedInstanceRow, type Batch } from '../lib/formEngine';

const ZONE = 'Australia/Melbourne';

type TimePreset = 'today' | 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'custom';
type StatusFilter = 'all' | 'awaiting_student' | 'awaiting_trainer' | 'awaiting_office' | 'completed';

function melbourneDateRangeForPreset(preset: TimePreset, customFrom?: string, customTo?: string): { fromDate: string | null; toDate: string | null } {
  const now = DateTime.now().setZone(ZONE);
  if (preset === 'custom') {
    if (!customFrom || !customTo) return { fromDate: null, toDate: null };
    const start = DateTime.fromISO(customFrom, { zone: ZONE }).startOf('day');
    const end = DateTime.fromISO(customTo, { zone: ZONE }).startOf('day');
    if (!start.isValid || !end.isValid) return { fromDate: null, toDate: null };
    return { fromDate: start.toISODate(), toDate: end.toISODate() };
  }
  if (preset === 'today') return { fromDate: now.startOf('day').toISODate(), toDate: now.startOf('day').toISODate() };
  if (preset === 'this_week') return { fromDate: now.startOf('week').toISODate(), toDate: now.startOf('day').toISODate() };
  if (preset === 'last_week') {
    const last = now.minus({ weeks: 1 });
    return { fromDate: last.startOf('week').toISODate(), toDate: last.endOf('week').toISODate() };
  }
  if (preset === 'this_month') return { fromDate: now.startOf('month').toISODate(), toDate: now.startOf('day').toISODate() };
  if (preset === 'last_month') {
    const last = now.minus({ months: 1 });
    return { fromDate: last.startOf('month').toISODate(), toDate: last.endOf('month').toISODate() };
  }
  return { fromDate: null, toDate: null };
}

function Donut({
  value,
  total,
  label,
  color,
  active,
  onClick,
}: {
  value: number;
  total: number;
  label: string;
  color: string;
  active?: boolean;
  onClick?: () => void;
}) {
  const pct = total > 0 ? Math.min(100, Math.max(0, (value / total) * 100)) : 0;
  const r = 34;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;
  const gap = c - dash;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-lg p-1 text-left transition-colors ${
        active ? '' : 'hover:bg-[var(--surface-subtle)]'
      }`}
      title={label}
    >
      <svg width="84" height="84" viewBox="0 0 84 84" className="shrink-0">
        <circle cx="42" cy="42" r={r} fill="none" stroke="var(--border)" strokeWidth="10" />
        <circle
          cx="42"
          cy="42"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${gap}`}
          transform="rotate(-90 42 42)"
        />
        <text x="42" y="46" textAnchor="middle" className="fill-gray-900" style={{ fontSize: 14, fontWeight: 700 }}>
          {Math.round(pct)}%
        </text>
      </svg>
      <div className="min-w-0">
        <div className="text-sm font-semibold text-gray-900 truncate">{label}</div>
        <div className="text-xs text-gray-600">
          <strong className="text-gray-900">{value}</strong> of <strong className="text-gray-900">{total}</strong>
        </div>
      </div>
    </button>
  );
}

export const AdminDashboardPage: React.FC = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [stats, setStats] = useState<AdminDashboardStatsV2 | null>(null);
  const [rows, setRows] = useState<SubmittedInstanceRow[]>([]);
  const [rowsTotal, setRowsTotal] = useState(0);
  const [rowsLoading, setRowsLoading] = useState(false);
  const PAGE_SIZE = 20;
  const [page, setPage] = useState(1);

  const [timePreset, setTimePreset] = useState<TimePreset>('this_week');
  const [status, setStatus] = useState<StatusFilter>('awaiting_student');
  const [customFrom, setCustomFrom] = useState<string>('');
  const [customTo, setCustomTo] = useState<string>('');
  const [batchId, setBatchId] = useState<string>('');
  const [batches, setBatches] = useState<Batch[]>([]);

  const range = useMemo(() => melbourneDateRangeForPreset(timePreset, customFrom, customTo), [timePreset, customFrom, customTo]);

  const load = async (opts?: { silent?: boolean; forceRefresh?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    const bid = batchId ? Number(batchId) : null;
    const res = await getAdminDashboardStatsV2(
      {
        fromDate: range.fromDate,
        toDate: range.toDate,
        status,
        batchId: bid && Number.isFinite(bid) && bid > 0 ? bid : null,
      },
      { forceRefresh: opts?.forceRefresh }
    );
    if (!res.ok) {
      toast.error(res.error);
      setStats(null);
      setLoading(false);
      return;
    }
    setStats(res.stats);
    setLoading(false);
  };

  const loadRows = async (opts?: { silent?: boolean; forceRefresh?: boolean }) => {
    if (!opts?.silent) setRowsLoading(true);
    const bid = batchId ? Number(batchId) : null;
    const res = await listAdminDashboardInstancesPaged(
      page,
      PAGE_SIZE,
      status,
      range.fromDate,
      range.toDate,
      bid && Number.isFinite(bid) && bid > 0 ? bid : null,
      { forceRefresh: opts?.forceRefresh }
    );
    setRows(res.data);
    setRowsTotal(res.total);
    setRowsLoading(false);
  };

  useEffect(() => {
    const t = window.setTimeout(() => void load(), 150);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.fromDate, range.toDate, status, batchId]);

  useEffect(() => {
    const t = window.setTimeout(() => void loadRows(), 150);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.fromDate, range.toDate, status, page, batchId]);

  useEffect(() => {
    setPage(1);
  }, [range.fromDate, range.toDate, status, batchId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const b = await listBatches();
      if (!cancelled) setBatches(b);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const totalInRange = useMemo(() => {
    if (!stats) return 0;
    const w = stats.workflow;
    return (w.awaiting_student ?? 0) + (w.awaiting_trainer ?? 0) + (w.awaiting_office ?? 0) + (w.completed ?? 0);
  }, [stats]);

  const formatDate = (d: string | null | undefined) => {
    const v = String(d ?? '').trim();
    if (!v) return '—';
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
    return v;
  };

  const workflowLabel = (r: Pick<SubmittedInstanceRow, 'status' | 'role_context'>): string => {
    if (r.status === 'locked') return 'Completed';
    if (r.role_context === 'trainer') return 'Awaiting trainer';
    if (r.role_context === 'office') return 'Awaiting office';
    return 'Awaiting student';
  };

  const handleOpenAssessment = async (row: SubmittedInstanceRow) => {
    const url = await getOrIssueInstanceAccessLink(row.id, 'office');
    if (!url) {
      toast.error('Failed to open secure link');
      return;
    }
    const nextUrl = (() => {
      try {
        const u = new URL(url, window.location.origin);
        u.searchParams.set('admin', '1');
        return u.toString();
      } catch {
        return url;
      }
    })();
    window.open(nextUrl, '_blank');
  };

  if (loading) return <Loader fullPage variant="dots" size="lg" message="Loading dashboard…" />;

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <div className="w-full px-4 md:px-6 lg:px-8 py-6">
        <div className="mb-6 flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-[var(--text)] flex items-center gap-2">
              <LayoutDashboard className="w-7 h-7 text-[var(--brand)]" />
              Admin dashboard
            </h1>
            <p className="text-sm text-gray-600 mt-1">Overview of assessments workflow, students, and trainers.</p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-full sm:w-56">
              <Select
                label="Time"
                value={timePreset}
                onChange={(v) => setTimePreset(v as TimePreset)}
                options={[
                  { value: 'today', label: 'Today' },
                  { value: 'this_week', label: 'This week' },
                  { value: 'last_week', label: 'Last week' },
                  { value: 'this_month', label: 'This month' },
                  { value: 'last_month', label: 'Last month' },
                  { value: 'custom', label: 'Custom range' },
                ]}
              />
            </div>
            <div className="w-full sm:w-56">
              <Select
                label="Status"
                value={status}
                onChange={(v) => setStatus(v as StatusFilter)}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'awaiting_student', label: 'Awaiting student' },
                  { value: 'awaiting_trainer', label: 'Awaiting trainer' },
                  { value: 'awaiting_office', label: 'Awaiting office' },
                  { value: 'completed', label: 'Completed' },
                ]}
              />
            </div>
            <div className="w-full sm:w-64">
              <Select
                label="Batch"
                value={batchId}
                onChange={(v) => setBatchId(v)}
                options={[
                  { value: '', label: 'All batches' },
                  ...(batches || []).map((b) => ({
                    value: String(b.id),
                    label: `${b.name}${b.trainer_name ? ` — ${b.trainer_name}` : ''}`,
                  })),
                ]}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={async () => {
                setRefreshing(true);
                await load({ silent: true, forceRefresh: true });
                await loadRows({ silent: true, forceRefresh: true });
                setRefreshing(false);
                toast.success('Dashboard refreshed');
              }}
              disabled={refreshing}
              className="h-12"
              title="Refresh"
            >
              <span className="inline-flex items-center gap-2">
                <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
                Refresh
              </span>
            </Button>
          </div>
        </div>

        {timePreset === 'custom' ? (
          <Card className="mb-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <DatePicker label="From (Melbourne)" value={customFrom} onChange={setCustomFrom} placement="below" />
              <DatePicker label="To (Melbourne)" value={customTo} onChange={setCustomTo} placement="below" />
            </div>
            <p className="text-xs text-gray-500 mt-3">
                  Uses Melbourne dates (AEST/AEDT) and filters assessments where the <strong>start or end date</strong> falls within the range.
            </p>
          </Card>
        ) : null}

        {/* Totals */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
          <button
            type="button"
            className="text-left"
            onClick={() => navigate('/admin/assessments')}
            title="Go to assessments"
          >
            <Card className="bg-gradient-to-br from-[var(--brand)] to-[#ea580c] text-white overflow-hidden relative hover:opacity-[0.97]">
              <div className="absolute top-0 right-0 w-24 h-24 -mt-4 -mr-4 rounded-full bg-white/10" />
              <div className="relative">
                <p className="text-white/90 text-sm font-medium">Total assessments</p>
                <p className="text-4xl font-bold mt-1">{stats?.totals.assessments ?? 0}</p>
                <p className="text-white/80 text-xs mt-1">All time</p>
              </div>
            </Card>
          </button>

          <button type="button" className="text-left" onClick={() => navigate('/admin/students')} title="Go to students">
            <Card className="hover:bg-[var(--surface-subtle)]">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[var(--text-secondary)] text-sm font-medium">Students</p>
                  <p className="text-3xl font-bold text-[var(--text)] mt-1">{stats?.totals.students ?? 0}</p>
                  <p className="text-[var(--text-muted)] text-xs mt-1">Active records</p>
                </div>
                <Users className="w-10 h-10 text-[var(--icon-muted)]" />
              </div>
            </Card>
          </button>

          <button type="button" className="text-left" onClick={() => navigate('/admin/users')} title="Go to users (trainers)">
            <Card className="hover:bg-[var(--surface-subtle)]">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[var(--text-secondary)] text-sm font-medium">Trainers</p>
                  <p className="text-3xl font-bold text-[var(--text)] mt-1">{stats?.totals.trainers ?? 0}</p>
                  <p className="text-[var(--text-muted)] text-xs mt-1">Users with trainer role</p>
                </div>
                <UserRoundCheck className="w-10 h-10 text-[var(--icon-muted)]" />
              </div>
            </Card>
          </button>

          <button type="button" className="text-left" onClick={() => navigate('/admin/users')} title="Go to users (admins)">
            <Card className="hover:bg-[var(--surface-subtle)]">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[var(--text-secondary)] text-sm font-medium">Admins</p>
                  <p className="text-3xl font-bold text-[var(--text)] mt-1">{stats?.totals.admins ?? 0}</p>
                  <p className="text-[var(--text-muted)] text-xs mt-1">Users with admin or super admin role</p>
                </div>
                <ClipboardCheck className="w-10 h-10 text-[var(--icon-muted)]" />
              </div>
            </Card>
          </button>
        </div>

        {/* Workflow donuts */}
        <Card className="mb-6">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-4">
            <div>
              <h2 className="text-lg font-bold text-[var(--text)]">Workflow (filtered)</h2>
              <p className="text-xs text-[var(--text-muted)] mt-1">Awaiting student = draft, awaiting trainer/office = role stage, completed = locked.</p>
            </div>
            <div className="text-xs text-[var(--text-secondary)]">
              Total in range: <strong className="text-[var(--text-primary)]">{totalInRange}</strong>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            <Card
              className={
                status === 'awaiting_student'
                  ? 'border border-[var(--orange-border)] bg-[var(--orange-soft)]'
                  : 'border border-[var(--workflow-border)]'
              }
              padding="sm"
            >
              <Donut
                value={stats?.workflow.awaiting_student ?? 0}
                total={totalInRange}
                label="Awaiting student"
                color="#64748b"
                active={status === 'awaiting_student'}
                onClick={() => setStatus('awaiting_student')}
              />
            </Card>
            <Card
              className={
                status === 'awaiting_trainer'
                  ? 'border border-[var(--orange-border)] bg-[var(--orange-soft)]'
                  : 'border border-[var(--workflow-border)]'
              }
              padding="sm"
            >
              <Donut
                value={stats?.workflow.awaiting_trainer ?? 0}
                total={totalInRange}
                label="Awaiting trainer"
                color="#f59e0b"
                active={status === 'awaiting_trainer'}
                onClick={() => setStatus('awaiting_trainer')}
              />
            </Card>
            <Card
              className={
                status === 'awaiting_office'
                  ? 'border border-[var(--orange-border)] bg-[var(--orange-soft)]'
                  : 'border border-[var(--workflow-border)]'
              }
              padding="sm"
            >
              <Donut
                value={stats?.workflow.awaiting_office ?? 0}
                total={totalInRange}
                label="Awaiting office"
                color="#3b82f6"
                active={status === 'awaiting_office'}
                onClick={() => setStatus('awaiting_office')}
              />
            </Card>
            <Card
              className={
                status === 'completed'
                  ? 'border border-[var(--orange-border)] bg-[var(--orange-soft)]'
                  : 'border border-[var(--workflow-border)]'
              }
              padding="sm"
            >
              <Donut
                value={stats?.workflow.completed ?? 0}
                total={totalInRange}
                label="Completed"
                color="#10b981"
                active={status === 'completed'}
                onClick={() => setStatus('completed')}
              />
            </Card>
          </div>
        </Card>

        {/* Assessments list */}
        <Card>
          <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4 mb-4">
            <div>
              <h2 className="text-lg font-bold text-[var(--text)]">Assessments</h2>
              <p className="text-xs text-gray-500 mt-1">
                Showing <strong className="text-gray-900">{workflowLabel({ status: status === 'completed' ? 'locked' : 'draft', role_context: status === 'awaiting_trainer' ? 'trainer' : status === 'awaiting_office' ? 'office' : 'student' })}</strong>{' '}
                within the selected date range
                {batchId ? (
                  <>
                    {' '}
                    for batch <strong className="text-gray-900">{batches.find((b) => String(b.id) === batchId)?.name ?? `#${batchId}`}</strong>
                  </>
                ) : null}
                .
              </p>
            </div>
            <Button type="button" variant="outline" onClick={() => navigate('/admin/assessments')} className="h-12" title="Open assessments directory">
              Open directory
            </Button>
          </div>

          <div className="border border-[var(--border)] rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm border-collapse">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200 text-left">
                    <th className="py-2.5 px-3 font-semibold text-gray-800 min-w-[14rem]">Student</th>
                    <th className="py-2.5 px-3 font-semibold text-gray-800 min-w-[12rem]">Trainer</th>
                    <th className="py-2.5 px-3 font-semibold text-gray-800 min-w-[14rem]">Unit</th>
                    <th className="py-2.5 px-3 font-semibold text-gray-800 whitespace-nowrap w-[9rem]">Start date</th>
                    <th className="py-2.5 px-3 font-semibold text-gray-800 whitespace-nowrap w-[9rem]">End date</th>
                    <th className="py-2.5 px-3 font-semibold text-gray-800 whitespace-nowrap w-[11rem]">Workflow</th>
                  </tr>
                </thead>
                <tbody>
                  {rowsLoading ? (
                    <tr>
                      <td className="py-10 px-3 text-center text-gray-500 text-sm" colSpan={6}>
                        Loading…
                      </td>
                    </tr>
                  ) : rows.length === 0 ? (
                    <tr>
                      <td className="py-10 px-3 text-center text-gray-500 text-sm" colSpan={6}>
                        No assessments for this filter.
                      </td>
                    </tr>
                  ) : (
                    rows.map((r) => (
                      <tr
                        key={r.id}
                        className="border-b border-gray-100 hover:bg-[var(--brand)]/10 focus-within:bg-[var(--brand)]/10 cursor-pointer transition-colors"
                        onClick={() => void handleOpenAssessment(r)}
                        title="Open assessment (admin edit mode)"
                      >
                        <td className="py-2.5 px-3">
                          <div className="font-semibold text-gray-900 break-words">{r.student_name || '—'}</div>
                          <div className="text-xs text-gray-600 break-all">{r.student_email || '—'}</div>
                        </td>
                        <td className="py-2.5 px-3 text-gray-900 break-words">
                          <div className="font-medium">{r.trainer_name || '—'}</div>
                          <div className="text-xs text-gray-600">{r.batch_name || '—'}</div>
                        </td>
                        <td className="py-2.5 px-3 text-gray-900 break-words">{r.form_name || '—'}</td>
                        <td className="py-2.5 px-3 text-gray-700 whitespace-nowrap">{formatDate(r.start_date)}</td>
                        <td className="py-2.5 px-3 text-gray-700 whitespace-nowrap">
                          {formatDate(r.end_date)}
                          {hasActiveExtension(r) ? (
                            <div className="text-xs text-amber-700">Extended to {formatDate(r.extension_date ?? null)}</div>
                          ) : null}
                        </td>
                        <td className="py-2.5 px-3 text-gray-700 whitespace-nowrap">{workflowLabel(r)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-4">
            {(() => {
              const totalPages = Math.max(1, Math.ceil(rowsTotal / PAGE_SIZE));
              if (rowsTotal <= 0) return null;
              return (
                <AdminListPagination
                  totalItems={rowsTotal}
                  pageSize={PAGE_SIZE}
                  currentPage={page}
                  totalPages={totalPages}
                  onPrev={() => setPage((p) => Math.max(1, p - 1))}
                  onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
                  onGoToPage={(p) => setPage(p)}
                  itemLabel="assessments"
                  placement="bottom"
                />
              );
            })()}
          </div>
        </Card>
      </div>
    </div>
  );
};

export default AdminDashboardPage;

