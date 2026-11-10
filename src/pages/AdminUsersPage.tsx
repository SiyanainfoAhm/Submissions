import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Mail, Phone, Pencil, Shield, UserRound, Building2, LogIn } from 'lucide-react';
import { listUsersPaged, createUser, updateUser, listBatchesPaged, queueStaffImpersonationTabOpen, batchIncludesTrainer, type Batch } from '../lib/formEngine';
import {
  buildUserEmail,
  buildEmailFromLocalAndDomain,
  getEmailLocalPartForEdit,
  getUserEmailLocalPart,
  getInstitutionalDomainFromEmail,
  type InstitutionalDomain,
  STAFF_DOMAIN,
} from '../lib/emailUtils';
import type { UserRow, AppUser, AppUserRole } from '../lib/formEngine';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { EmailWithDomainPicker } from '../components/ui/EmailWithDomainPicker';
import { Modal } from '../components/ui/Modal';
import { Loader } from '../components/ui/Loader';
import { toast } from '../utils/toast';
import { AdminListPagination } from '../components/admin/AdminListPagination';
import { useAuth } from '../contexts/AuthContext';
import type { CreateUserInput } from '../lib/formEngine';

const BASE_ROLE_OPTIONS = [
  { value: 'admin', label: 'Admin' },
  { value: 'trainer', label: 'Trainer' },
];

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

const ROLE_FILTER_OPTIONS = [
  { value: '', label: 'All roles' },
  { value: 'superadmin', label: 'Super Admin' },
  ...BASE_ROLE_OPTIONS,
];

const STATUS_FILTER_OPTIONS = [
  { value: '', label: 'All statuses' },
  ...STATUS_OPTIONS,
];

const roleLabel = (role: string) =>
  role === 'superadmin' ? 'Super Admin' : BASE_ROLE_OPTIONS.find((r) => r.value === role)?.label ?? role;

function userRowToAppUser(row: UserRow): AppUser {
  return {
    id: row.id,
    full_name: row.full_name,
    email: row.email,
    phone: row.phone,
    status: row.status,
    role: row.role as AppUserRole,
    can_login_as_student: Boolean(row.can_login_as_student),
    can_login_as_trainer: Boolean(row.can_login_as_trainer),
    can_view_finance_reports: Boolean(row.can_view_finance_reports),
  };
}

export const AdminUsersPage: React.FC = () => {
  const PAGE_SIZE = 20;
  const { user: authUser } = useAuth();
  const viewerIsSuperadmin = authUser?.role === 'superadmin';
  const viewerCanStaffPreview =
    viewerIsSuperadmin || Boolean(authUser?.can_login_as_student) || Boolean(authUser?.can_login_as_trainer);
  // Server rules (skyline_admin_create_user / skyline_admin_update_user): only a super admin
  // can create admin or super admin accounts, or change anyone's role or rights.
  const assignableRoleOptions = React.useMemo(
    () =>
      viewerIsSuperadmin
        ? [{ value: 'superadmin', label: 'Super Admin' }, ...BASE_ROLE_OPTIONS]
        : BASE_ROLE_OPTIONS.filter((o) => o.value === 'trainer'),
    [viewerIsSuperadmin]
  );
  const assignableRoleValues = React.useMemo(
    () => assignableRoleOptions.map((o) => o.value),
    [assignableRoleOptions]
  );
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [roleFilter, setRoleFilter] = useState<'' | 'superadmin' | 'admin' | 'trainer'>('');
  const [statusFilter, setStatusFilter] = useState<'' | 'active' | 'inactive'>('');
  const [currentPage, setCurrentPage] = useState(1);
  const [totalUsers, setTotalUsers] = useState(0);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  const [draft, setDraft] = useState({
    first_name: '',
    last_name: '',
    email_local: '',
    email_domain: STAFF_DOMAIN as InstitutionalDomain,
    phone: '',
    status: 'active',
    role: 'trainer' as CreateUserInput['role'],
  });

  const [editDraft, setEditDraft] = useState<{
    first_name: string;
    last_name: string;
    email_local: string;
    email_domain: InstitutionalDomain;
    phone: string;
    status: string;
    role: string;
    can_login_as_student: boolean;
    can_view_finance_reports: boolean;
  } | null>(null);

  const userFullName = `${draft.first_name} ${draft.last_name}`.trim();
  const userEmailSuggested = buildUserEmail(userFullName);
  const [batches, setBatches] = useState<Batch[]>([]);

  useEffect(() => {
    listBatchesPaged(1, 500).then((res) => setBatches(res.data));
  }, []);

  const digitsOnly = (val: string) => val.replace(/\D/g, '');

  const validateUserForm = (
    form: { first_name: string; last_name: string; email_local: string; phone: string; status: string; role: string },
    allowedRoles: readonly string[]
  ): string | null => {
    const fullName = `${(form.first_name || '').trim()} ${(form.last_name || '').trim()}`.trim();
    if (!fullName) return 'First name and last name are required.';
    const email =
      buildEmailFromLocalAndDomain(form.email_local?.trim() || '', (form as { email_domain?: typeof STAFF_DOMAIN }).email_domain ?? STAFF_DOMAIN) ||
      buildUserEmail(fullName);
    if (!email) return 'Email local part is required.';
    if (!form.phone.trim()) return 'Phone is required.';
    if (!/^\d{10}$/.test(form.phone.trim())) return 'Phone must be exactly 10 digits.';
    if (!form.status.trim()) return 'Status is required.';
    if (!form.role || !allowedRoles.includes(form.role)) return 'Role is required.';
    return null;
  };

  useEffect(() => {
    const t = setTimeout(async () => {
      setLoading(true);
      const res = await listUsersPaged(currentPage, PAGE_SIZE, searchTerm, roleFilter || undefined, statusFilter || undefined);
      setUsers(res.data);
      setTotalUsers(res.total);
      setLoading(false);
    }, 250);
    return () => clearTimeout(t);
  }, [currentPage, searchTerm, roleFilter, statusFilter]);

  const createError = useMemo(() => validateUserForm(draft, assignableRoleValues), [draft, assignableRoleValues]);
  // When editing, a non-super-admin keeps the user's current role (they cannot change it).
  const editRoleValues = useMemo(
    () => (viewerIsSuperadmin || !editDraft ? assignableRoleValues : [editDraft.role]),
    [viewerIsSuperadmin, editDraft, assignableRoleValues]
  );
  const editError = useMemo(
    () => (editDraft ? validateUserForm(editDraft, editRoleValues) : null),
    [editDraft, editRoleValues]
  );

  const handleCreate = async () => {
    const err = validateUserForm(draft, assignableRoleValues);
    if (err) {
      toast.error(err);
      return;
    }
    setCreating(true);
    const fullName = `${draft.first_name.trim()} ${draft.last_name.trim()}`.trim();
    const email =
      buildEmailFromLocalAndDomain(draft.email_local?.trim() || '', draft.email_domain) ||
      buildUserEmail(fullName);
    const created = await createUser({
      full_name: fullName,
      email,
      phone: draft.phone,
      status: draft.status,
      role: draft.role,
    });
    setCreating(false);
    if (!created.ok) {
      toast.error(created.message);
      return;
    }
    setCurrentPage(1);
    const res = await listUsersPaged(1, PAGE_SIZE, searchTerm, roleFilter || undefined, statusFilter || undefined);
    setUsers(res.data);
    setTotalUsers(res.total);
    setDraft({
      first_name: '',
      last_name: '',
      email_local: '',
      email_domain: STAFF_DOMAIN,
      phone: '',
      status: 'active',
      role: 'trainer',
    });
    setIsCreateOpen(false);
    toast.success('User added');
  };

  const editingUser = useMemo(() => (editingId ? users.find((u) => u.id === editingId) : null), [editingId, users]);

  useEffect(() => {
    if (!editingUser) {
      setEditDraft(null);
      return;
    }
    const parts = (editingUser.full_name ?? '').trim().split(/\s+/);
    const first_name = parts[0] ?? '';
    const last_name = parts.slice(1).join(' ') ?? '';
    const email = editingUser.email ?? '';
    const domain = getInstitutionalDomainFromEmail(email) ?? STAFF_DOMAIN;
    setEditDraft({
      first_name,
      last_name,
      email_local: getEmailLocalPartForEdit(email),
      email_domain: domain,
      phone: editingUser.phone ?? '',
      status: editingUser.status ?? 'active',
      role: editingUser.role ?? 'trainer',
      // Single toggle controls both student+trainer login rights.
      can_login_as_student: Boolean(editingUser.can_login_as_student || editingUser.can_login_as_trainer),
      can_view_finance_reports: Boolean(editingUser.can_view_finance_reports),
    });
  }, [editingUser]);

  const handleSaveEdit = async () => {
    if (!editingId || !editDraft) return;
    const err = validateUserForm(editDraft, editRoleValues);
    if (err) {
      toast.error(err);
      return;
    }
    setSavingEdit(true);
    const fullName = `${editDraft.first_name.trim()} ${editDraft.last_name.trim()}`.trim();
    const email = buildEmailFromLocalAndDomain(editDraft.email_local?.trim() || '', editDraft.email_domain);
    const updatePayload: Parameters<typeof updateUser>[1] = {
      full_name: fullName,
      email,
      phone: editDraft.phone,
      status: editDraft.status,
    };
    // Role and rights are super-admin-only on the server, so only a super admin sends them.
    if (viewerIsSuperadmin) {
      updatePayload.role = editDraft.role as CreateUserInput['role'];
      updatePayload.can_login_as_student = editDraft.can_login_as_student;
      updatePayload.can_login_as_trainer = editDraft.can_login_as_student;
      updatePayload.can_view_finance_reports =
        editDraft.role === 'admin' ? editDraft.can_view_finance_reports : false;
    }
    const updated = await updateUser(editingId, updatePayload);
    setSavingEdit(false);
    if (!updated.ok) {
      toast.error(updated.message);
      return;
    }
    const res = await listUsersPaged(currentPage, PAGE_SIZE, searchTerm, roleFilter || undefined, statusFilter || undefined);
    setUsers(res.data);
    setTotalUsers(res.total);
    setEditingId(null);
    toast.success('User updated');
  };

  const totalPages = Math.max(1, Math.ceil(totalUsers / PAGE_SIZE));

  const RoleIcon = ({ role }: { role: string }) => {
    if (role === 'superadmin') return <Shield className="w-4 h-4 text-violet-700" />;
    if (role === 'admin') return <Shield className="w-4 h-4 text-amber-600" />;
    if (role === 'trainer') return <UserRound className="w-4 h-4 text-blue-600" />;
    return <Building2 className="w-4 h-4 text-emerald-600" />;
  };

  // Mirrors the server: an admin can edit trainers / office users and their own details;
  // editing another admin or a super admin needs a super admin.
  const canEditDirectoryUser = (row: UserRow) =>
    viewerIsSuperadmin ||
    row.id === authUser?.id ||
    !(row.role === 'superadmin' || row.role === 'admin');

  const handleOpenAsUser = (row: UserRow) => {
    if (!viewerCanStaffPreview || !authUser?.id) return;
    if (row.id === authUser.id) {
      toast.error('Pick a different user than yourself.');
      return;
    }
    if (row.role === 'superadmin') {
      toast.error('Super admin accounts cannot be opened in preview from here.');
      return;
    }
    const appUser = userRowToAppUser(row);
    queueStaffImpersonationTabOpen(appUser, authUser.id);
    toast.success(`Opening new tab as ${row.full_name}…`);
    window.open('/admin', '_blank');
  };

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <div className="w-full px-4 md:px-6 lg:px-8 py-6">
        <Card className="mb-6">
          <div>
            <h2 className="text-lg font-bold text-[var(--text)]">Users</h2>
            <p className="text-sm text-gray-600 mt-1">
              Manage user directory. Add Admin or Trainer. Batches are assigned to trainers on the Batches page.
            </p>
          </div>
          <div className="mt-4 flex w-full min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
              <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
                <span className="text-sm text-gray-600 shrink-0">Role:</span>
                <Select
                  value={roleFilter}
                  onChange={(v) => {
                    setRoleFilter(v as '' | 'superadmin' | 'admin' | 'trainer');
                    setCurrentPage(1);
                  }}
                  options={ROLE_FILTER_OPTIONS}
                  className="min-w-0 w-full sm:w-[140px]"
                />
                <span className="text-sm text-gray-600 shrink-0">Status:</span>
                <Select
                  value={statusFilter}
                  onChange={(v) => {
                    setStatusFilter(v as '' | 'active' | 'inactive');
                    setCurrentPage(1);
                  }}
                  options={STATUS_FILTER_OPTIONS}
                  className="min-w-0 w-full sm:w-[140px]"
                />
                <Input
                  value={searchTerm}
                  onChange={(e) => {
                    setSearchTerm(e.target.value);
                    setCurrentPage(1);
                  }}
                  placeholder="Search..."
                  className="w-full min-w-0 sm:w-48"
                />
              </div>
              <Button onClick={() => setIsCreateOpen(true)} className="w-full shrink-0 sm:w-auto">
                <Plus className="w-4 h-4 mr-2 inline" />
                Add User
              </Button>
          </div>
        </Card>

        <Card>
          <h2 className="text-lg font-bold text-[var(--text)] mb-4">User Directory</h2>
          {!loading && (
            <AdminListPagination
              placement="top"
              totalItems={totalUsers}
              pageSize={PAGE_SIZE}
              currentPage={currentPage}
              totalPages={totalPages}
              onPrev={() => setCurrentPage((p) => Math.max(1, p - 1))}
              onNext={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              onGoToPage={(p) => setCurrentPage(p)}
              itemLabel="users"
            />
          )}
          {loading ? (
            <div className="py-12">
              <Loader variant="dots" size="lg" message="Loading users..." />
            </div>
          ) : users.length === 0 ? (
            <p className="text-gray-500">No users found.</p>
          ) : (
            <>
              <div className="space-y-3 lg:hidden">
                {users.map((user) => (
                  <div key={user.id} className="rounded-lg border border-[var(--border)] bg-white p-4 shadow-sm">
                    <div className="flex items-start gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-orange-100 text-sm font-semibold text-orange-700">
                        {user.full_name.slice(0, 2).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-[var(--text)] break-words">{user.full_name}</div>
                        <div className="text-xs text-gray-500">ID: {user.id}</div>
                        <div className="mt-2 flex items-center gap-2 text-sm text-gray-700">
                          <RoleIcon role={user.role} />
                          <span className="font-medium">{roleLabel(user.role)}</span>
                        </div>
                        <div className="mt-2 space-y-1 text-sm break-all text-gray-700">
                          <div className="flex items-start gap-2">
                            <Mail className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                            <span>{user.email}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Phone className="h-4 w-4 shrink-0 text-gray-400" />
                            <span>{user.phone || '-'}</span>
                          </div>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {(user.role === 'trainer' || user.role === 'admin' || user.role === 'superadmin') &&
                            batches
                              .filter((b) => batchIncludesTrainer(b, user.id))
                              .map((b) => (
                                <span key={b.id} className="inline-flex rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                                  {b.name}
                                </span>
                              ))}
                          {((user.role !== 'trainer' && user.role !== 'admin' && user.role !== 'superadmin') ||
                            batches.filter((b) => batchIncludesTrainer(b, user.id)).length === 0) && (
                            <span className="text-xs text-gray-400">—</span>
                          )}
                        </div>
                        <div className="mt-2">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                              (user.status || 'active') === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600'
                            }`}
                          >
                            {user.status || 'active'}
                          </span>
                        </div>
                        <div className="mt-3 flex flex-col gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-full"
                            disabled={!canEditDirectoryUser(user)}
                            onClick={() => {
                              if (!canEditDirectoryUser(user)) {
                                toast.error('Only a super admin can edit this user.');
                                return;
                              }
                              setEditingId(user.id);
                            }}
                          >
                            <Pencil className="mr-1 h-4 w-4" />
                            Edit
                          </Button>
                          {viewerCanStaffPreview ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="w-full"
                              disabled={user.role === 'superadmin' || user.id === authUser?.id}
                              title="Open admin app in a new tab as this user"
                              onClick={() => handleOpenAsUser(user)}
                            >
                              <LogIn className="mr-1 h-4 w-4" />
                              Open as user
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="hidden overflow-x-auto lg:block">
              <table className="min-w-[900px] w-full text-sm border border-[var(--border)] rounded-lg overflow-hidden">
                <thead className="bg-gray-50 text-gray-700">
                  <tr>
                    <th className="text-left px-4 py-3 font-semibold border-b border-[var(--border)]">User</th>
                    <th className="text-left px-4 py-3 font-semibold border-b border-[var(--border)]">Contact</th>
                    <th className="text-left px-4 py-3 font-semibold border-b border-[var(--border)]">Role</th>
                    <th className="text-left px-4 py-3 font-semibold border-b border-[var(--border)]">Batches</th>
                    <th className="text-left px-4 py-3 font-semibold border-b border-[var(--border)]">Status</th>
                    <th className="text-right px-4 py-3 font-semibold border-b border-[var(--border)]">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.id} className="hover:bg-[var(--brand)]/10 focus-within:bg-[var(--brand)]/10 transition-colors align-top">
                      <td className="px-4 py-3 border-b border-[var(--border)]">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-full bg-orange-100 text-orange-700 font-semibold flex items-center justify-center">
                            {user.full_name.slice(0, 2).toUpperCase()}
                          </div>
                          <div>
                            <div className="font-semibold text-[var(--text)]">{user.full_name}</div>
                            <div className="text-xs text-gray-500">ID: {user.id}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 border-b border-[var(--border)]">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2 text-gray-700">
                            <Mail className="w-4 h-4 text-gray-400" />
                            <span>{user.email}</span>
                          </div>
                          <div className="flex items-center gap-2 text-gray-700">
                            <Phone className="w-4 h-4 text-gray-400" />
                            <span>{user.phone || '-'}</span>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 border-b border-[var(--border)]">
                        <div className="flex items-center gap-2">
                          <RoleIcon role={user.role} />
                          <span className="font-medium">{roleLabel(user.role)}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 border-b border-[var(--border)]">
                        <div className="flex flex-wrap gap-1">
                          {(user.role === 'trainer' || user.role === 'admin' || user.role === 'superadmin') &&
                            batches
                              .filter((b) => batchIncludesTrainer(b, user.id))
                              .map((b) => (
                                <span
                                  key={b.id}
                                  className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700"
                                >
                                  {b.name}
                                </span>
                              ))}
                          {((user.role !== 'trainer' && user.role !== 'admin' && user.role !== 'superadmin') ||
                            batches.filter((b) => batchIncludesTrainer(b, user.id)).length === 0) && (
                            <span className="text-gray-400 text-xs">—</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 border-b border-[var(--border)]">
                        <span
                          className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                            (user.status || 'active') === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          {user.status || 'active'}
                        </span>
                      </td>
                      <td className="px-4 py-3 border-b border-[var(--border)] text-right">
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={!canEditDirectoryUser(user)}
                            onClick={() => {
                              if (!canEditDirectoryUser(user)) {
                                toast.error('Only a super admin can edit this user.');
                                return;
                              }
                              setEditingId(user.id);
                            }}
                            className="inline-flex items-center justify-center gap-1.5 min-w-[96px] whitespace-nowrap"
                          >
                            <Pencil className="w-4 h-4" />
                            Edit
                          </Button>
                          {viewerCanStaffPreview ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={user.role === 'superadmin' || user.id === authUser?.id}
                              title="Open admin app in a new tab as this user"
                              onClick={() => handleOpenAsUser(user)}
                              className="inline-flex items-center justify-center gap-1.5 whitespace-nowrap"
                            >
                              <LogIn className="w-4 h-4" />
                              Open as user
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
              totalItems={totalUsers}
              pageSize={PAGE_SIZE}
              currentPage={currentPage}
              totalPages={totalPages}
              onPrev={() => setCurrentPage((p) => Math.max(1, p - 1))}
              onNext={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              onGoToPage={(p) => setCurrentPage(p)}
              itemLabel="users"
            />
          )}
        </Card>
      </div>

      <Modal isOpen={isCreateOpen} onClose={() => setIsCreateOpen(false)} title="Add User" size="md">
        <div className="min-w-0 space-y-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Input
              value={draft.first_name}
              onChange={(e) => {
                const fn = e.target.value;
                setDraft((p) => {
                  const fullName = `${fn} ${p.last_name}`.trim();
                  const prevSuggested = buildUserEmail(`${p.first_name} ${p.last_name}`.trim());
                  const suggested = buildUserEmail(fullName);
                  const prevLocal = getUserEmailLocalPart(prevSuggested);
                  const syncEmail = !p.email_local || p.email_local === prevLocal;
                  return { ...p, first_name: fn, email_local: syncEmail && suggested ? getUserEmailLocalPart(suggested) : p.email_local };
                });
              }}
              placeholder="First name *"
              required
            />
            <Input
              value={draft.last_name}
              onChange={(e) => {
                const ln = e.target.value;
                setDraft((p) => {
                  const fullName = `${p.first_name} ${ln}`.trim();
                  const prevSuggested = buildUserEmail(`${p.first_name} ${p.last_name}`.trim());
                  const suggested = buildUserEmail(fullName);
                  const prevLocal = getUserEmailLocalPart(prevSuggested);
                  const syncEmail = !p.email_local || p.email_local === prevLocal;
                  return { ...p, last_name: ln, email_local: syncEmail && suggested ? getUserEmailLocalPart(suggested) : p.email_local };
                });
              }}
              placeholder="Last name *"
              required
            />
          </div>
          <EmailWithDomainPicker
            label="Email"
            localPart={draft.email_local || getUserEmailLocalPart(userEmailSuggested)}
            onLocalPartChange={(v) => setDraft((p) => ({ ...p, email_local: v }))}
            domain={draft.email_domain}
            onDomainChange={(d) => setDraft((p) => ({ ...p, email_domain: d }))}
            placeholder="e.g. firstname.lastname"
          />
          <Input
            value={draft.phone}
            onChange={(e) => setDraft((p) => ({ ...p, phone: digitsOnly(e.target.value).slice(0, 10) }))}
            placeholder="Phone (10 digits) *"
            required
          />
          <Select
            value={draft.role}
            onChange={(v) => setDraft((p) => ({ ...p, role: v as CreateUserInput['role'] }))}
            options={assignableRoleOptions}
            label="Role"
          />
          <Select
            value={draft.status}
            onChange={(v) => setDraft((p) => ({ ...p, status: v }))}
            options={STATUS_OPTIONS}
            label="Status"
          />
          <div className="flex flex-col gap-2 pt-2 sm:flex-row sm:items-center sm:justify-end sm:pt-1">
            <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => setIsCreateOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" className="w-full sm:w-auto" onClick={handleCreate} disabled={creating || !!createError}>
              {creating ? (
                <>
                  <Loader variant="dots" size="sm" inline className="mr-2" />
                  Saving...
                </>
              ) : (
                <>
                  <Plus className="w-4 h-4 mr-2 inline" />
                  Add User
                </>
              )}
            </Button>
          </div>
        </div>
      </Modal>

      {editingId && editDraft && (
        <Modal isOpen={!!editingId} onClose={() => setEditingId(null)} title="Edit User" size="md">
          <div className="min-w-0 space-y-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Input
                value={editDraft.first_name}
                onChange={(e) => setEditDraft((p) => (p ? { ...p, first_name: e.target.value } : p))}
                placeholder="First name *"
                required
              />
              <Input
                value={editDraft.last_name}
                onChange={(e) => setEditDraft((p) => (p ? { ...p, last_name: e.target.value } : p))}
                placeholder="Last name *"
                required
              />
            </div>
            <EmailWithDomainPicker
              label="Email"
              localPart={editDraft.email_local}
              onLocalPartChange={(v) => setEditDraft((p) => (p ? { ...p, email_local: v } : p))}
              domain={editDraft.email_domain}
              onDomainChange={(d) => setEditDraft((p) => (p ? { ...p, email_domain: d } : p))}
              placeholder="e.g. firstname.lastname"
            />
            <Input
              value={editDraft.phone}
              onChange={(e) => setEditDraft((p) => (p ? { ...p, phone: digitsOnly(e.target.value).slice(0, 10) } : p))}
              placeholder="Phone (10 digits) *"
              required
            />
            <Select
              value={editDraft.role}
              onChange={(v) => setEditDraft((p) => (p ? { ...p, role: v } : p))}
              options={
                viewerIsSuperadmin
                  ? assignableRoleOptions
                  : [{ value: editDraft.role, label: roleLabel(editDraft.role) }]
              }
              label={viewerIsSuperadmin ? 'Role' : 'Role (only a super admin can change this)'}
            />
            <Select
              value={editDraft.status}
              onChange={(v) => setEditDraft((p) => (p ? { ...p, status: v } : p))}
              options={STATUS_OPTIONS}
              label="Status"
            />
            {viewerIsSuperadmin ? (
              <div className="rounded-lg border border-[var(--border)] bg-gray-50 px-3 py-3">
                <div className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">Rights</div>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-gray-300 text-[var(--brand)] focus:ring-[var(--brand)]"
                      checked={editDraft.can_login_as_student}
                      onChange={(e) =>
                        setEditDraft((p) => (p ? { ...p, can_login_as_student: e.target.checked } : p))
                      }
                      disabled={editDraft.role !== 'admin'}
                    />
                    Allow login as student or trainer
                  </label>
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-gray-300 text-[var(--brand)] focus:ring-[var(--brand)]"
                      checked={editDraft.can_view_finance_reports}
                      onChange={(e) =>
                        setEditDraft((p) => (p ? { ...p, can_view_finance_reports: e.target.checked } : p))
                      }
                      disabled={editDraft.role !== 'admin'}
                    />
                    Allow Finance Reports access
                  </label>
                </div>
                {editDraft.role !== 'admin' ? (
                  <p className="mt-2 text-[11px] text-gray-500">These rights are configurable for admin users only.</p>
                ) : null}
              </div>
            ) : null}
            <div className="flex flex-col gap-2 pt-2 sm:flex-row sm:items-center sm:justify-end sm:pt-1">
              <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => setEditingId(null)}>
                Cancel
              </Button>
              <Button size="sm" className="w-full sm:w-auto" onClick={handleSaveEdit} disabled={savingEdit || !!editError}>
                {savingEdit ? (
                  <>
                    <Loader variant="dots" size="sm" inline className="mr-2" />
                    Saving...
                  </>
                ) : (
                  'Save Changes'
                )}
              </Button>
            </div>
          </div>
        </Modal>
      )}

    </div>
  );
};
