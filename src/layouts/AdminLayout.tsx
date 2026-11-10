import React, { useEffect, useState } from 'react';
import { Outlet, NavLink, Link, useNavigate, useLocation } from 'react-router-dom';
import {
  FileText,
  Users,
  UserRoundCheck,
  ClipboardCheck,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Layers,
  LayoutDashboard,
  User,
  GraduationCap,
  Menu,
  BookOpen,
  DollarSign,
  BarChart3,
} from 'lucide-react';
import { cn } from '../components/utils/cn';
import { useAuth } from '../contexts/AuthContext';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { toast } from '../utils/toast';
import { NotificationBell } from '../components/NotificationBell';
import { UserMenu } from '../components/UserMenu';
import { ensureFcmToken } from '../services/pushNotificationService';
import { canAccessFinanceNav, canManagePaymentPlans, canViewFinanceReports } from '../lib/formEngine';

const SIDEBAR_WIDTH_EXPANDED = 220;
const SIDEBAR_WIDTH_COLLAPSED = 64;

export const AdminLayout: React.FC = () => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [logoError, setLogoError] = useState(false);
  const { user, logout, exitImpersonation, isImpersonating } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isMdUp = useMediaQuery('(min-width: 768px)');
  const width = sidebarCollapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED;
  const [financeNavOpen, setFinanceNavOpen] = useState(() =>
    location.pathname.startsWith('/admin/finance')
  );

  const isTrainer = user?.role === 'trainer';

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (location.pathname.startsWith('/admin/finance')) {
      setFinanceNavOpen(true);
    }
  }, [location.pathname]);

  useEffect(() => {
    if (!user?.id) return;
    // If the user already allowed notifications earlier, keep token saved/updated without prompting.
    void ensureFcmToken(user.id);
  }, [user?.id]);

  useEffect(() => {
    if (isMdUp) setMobileNavOpen(false);
  }, [isMdUp]);

  const baseNavItems = isTrainer
    ? [
        { to: '/admin/dashboard', label: 'Dashboard', icon: <LayoutDashboard className="w-5 h-5 shrink-0" />, end: true },
        { to: '/admin/course-units', label: 'Course units', icon: <BookOpen className="w-5 h-5 shrink-0" />, end: true },
        { to: '/admin/my-students', label: 'My students', icon: <Users className="w-5 h-5 shrink-0" />, end: false },
      ]
    : [
        { to: '/admin/overview', label: 'Dashboard', icon: <LayoutDashboard className="w-5 h-5 shrink-0" />, end: true },
        { to: '/admin/reports/assessments', label: 'Reports', icon: <BarChart3 className="w-5 h-5 shrink-0" />, end: true },
        { to: '/admin/forms', label: 'Forms', icon: <FileText className="w-5 h-5 shrink-0" />, end: true },
        { to: '/admin/students', label: 'Students', icon: <Users className="w-5 h-5 shrink-0" />, end: true },
        { to: '/admin/batches', label: 'Batches', icon: <Layers className="w-5 h-5 shrink-0" />, end: true },
        { to: '/admin/courses', label: 'Courses', icon: <GraduationCap className="w-5 h-5 shrink-0" />, end: true },
        { to: '/admin/users', label: 'Users', icon: <UserRoundCheck className="w-5 h-5 shrink-0" />, end: true },
        { to: '/admin/assessments', label: 'Assessments', icon: <ClipboardCheck className="w-5 h-5 shrink-0" />, end: true },
      ];
  const financeChildren = [
    ...(canManagePaymentPlans(user)
      ? [{ to: '/admin/finance/payment-plans', label: 'Payment Plan' }]
      : []),
    ...(canViewFinanceReports(user)
      ? [{ to: '/admin/finance/reports', label: 'Finance Reports' }]
      : []),
  ];
  const showFinanceNav = !isTrainer && canAccessFinanceNav(user) && financeChildren.length > 0;
  const financeSectionActive = location.pathname.startsWith('/admin/finance');

  const tailNavItems = [
    { to: '/admin/profile', label: 'My Profile', icon: <User className="w-5 h-5 shrink-0" />, end: true },
    ...(user?.role === 'admin' || user?.role === 'office' || user?.role === 'superadmin'
      ? [{ to: '/admin/enrollment', label: 'Enrollment', icon: <GraduationCap className="w-5 h-5 shrink-0" />, end: true }]
      : []),
  ];

  const showSidebarLabels = isMdUp ? !sidebarCollapsed : true;
  const hideNavForStudentDetails = /^\/admin\/students\/\d+\/?$/.test(location.pathname);

  const handleLogout = () => {
    if (isImpersonating) {
      exitImpersonation();
      toast.success('Returned to your account.');
      navigate('/admin/users', { replace: true });
      return;
    }
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="flex min-h-[100dvh] min-h-screen w-full max-w-[100vw] overflow-x-hidden bg-[var(--bg)]">
      {hideNavForStudentDetails ? (
        <main className="w-full">
          <Outlet />
        </main>
      ) : (
        <>
          {/* Mobile: tap outside to close nav */}
          {mobileNavOpen && !isMdUp ? (
            <button
              type="button"
              className="fixed inset-0 z-30 bg-black/40 md:hidden"
              aria-label="Close menu"
              onClick={() => setMobileNavOpen(false)}
            />
          ) : null}

          {/* Single navbar/sidebar: crest (sized by expand/collapse) + toggle + nav links */}
          <aside
            className={cn(
              'fixed bottom-0 left-0 top-0 z-40 flex h-[100dvh] max-h-[100dvh] min-h-0 flex-col overflow-hidden border-r border-[var(--border-strong)] bg-[var(--surface)] shadow-sm transition-[width,transform] duration-200 ease-out',
              !isMdUp && 'pt-[env(safe-area-inset-top,0px)]',
              !isMdUp && !mobileNavOpen && '-translate-x-full',
              !isMdUp && mobileNavOpen && 'translate-x-0',
              isMdUp && 'translate-x-0'
            )}
            style={{ width: isMdUp ? width : SIDEBAR_WIDTH_EXPANDED }}
          >
        <div
          className={cn(
            'flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-3',
            isMdUp && sidebarCollapsed ? 'flex-col' : 'flex-row'
          )}
        >
          <Link
            to={isTrainer ? '/admin/dashboard' : '/admin/overview'}
            className="flex shrink-0 items-center justify-center overflow-hidden no-underline text-[var(--text)]"
            aria-label={isTrainer ? 'Dashboard' : 'Forms'}
          >
            {!logoError ? (
              <img
                src="/logo-crest.png"
                alt="Skyline"
                className={cn(
                  'w-auto object-contain transition-[height] duration-200',
                  isMdUp && sidebarCollapsed ? 'h-8' : 'h-12'
                )}
                onError={() => setLogoError(true)}
              />
            ) : (
              <span
                className={cn(
                  'font-bold text-[#f97316] transition-[font-size] duration-200',
                  isMdUp && sidebarCollapsed ? 'text-sm' : 'text-lg'
                )}
              >
                SKYLINE
              </span>
            )}
          </Link>
          {showSidebarLabels && user && (
            <div className="text-xs text-gray-600 truncate max-w-[120px] min-w-0" title={user.email}>
              {user.full_name}
            </div>
          )}
          <button
            type="button"
            onClick={() => setSidebarCollapsed((c) => !c)}
            className="hidden md:flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? <ChevronRight className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}
          </button>
        </div>
        {/* Scroll only the link list; keep logout pinned to the drawer bottom (flex min-height bugs on mobile). */}
        <nav className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <ul className="min-h-0 flex-1 space-y-0.5 overflow-x-hidden overflow-y-auto px-2 py-4">
            {baseNavItems.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                      isActive ? 'bg-[#f97316]/10 text-[#ea580c]' : 'text-gray-700 hover:bg-gray-100'
                    )
                  }
                >
                  {item.icon}
                  {showSidebarLabels && <span className="min-w-0">{item.label}</span>}
                </NavLink>
              </li>
            ))}
            {showFinanceNav ? (
              <li>
                <button
                  type="button"
                  onClick={() => {
                    if (isMdUp && sidebarCollapsed) {
                      setSidebarCollapsed(false);
                      setFinanceNavOpen(true);
                      return;
                    }
                    setFinanceNavOpen((o) => !o);
                  }}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                    financeSectionActive
                      ? 'bg-[#f97316]/10 text-[#ea580c]'
                      : 'text-gray-700 hover:bg-gray-100'
                  )}
                  aria-expanded={financeNavOpen}
                >
                  <DollarSign className="w-5 h-5 shrink-0" />
                  {showSidebarLabels ? (
                    <>
                      <span className="min-w-0 flex-1 text-left">Finance</span>
                      <ChevronDown
                        className={cn(
                          'h-4 w-4 shrink-0 transition-transform',
                          financeNavOpen ? 'rotate-180' : ''
                        )}
                      />
                    </>
                  ) : null}
                </button>
                {financeNavOpen && showSidebarLabels ? (
                  <ul className="mt-0.5 space-y-0.5 border-l border-[var(--border)] ml-5 pl-2">
                    {financeChildren.map((child) => (
                      <li key={child.to}>
                        <NavLink
                          to={child.to}
                          end
                          className={({ isActive }) =>
                            cn(
                              'flex items-center rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                              isActive ? 'bg-[#f97316]/10 text-[#ea580c]' : 'text-gray-700 hover:bg-gray-100'
                            )
                          }
                        >
                          {child.label}
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ) : null}
            {tailNavItems.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                      isActive ? 'bg-[#f97316]/10 text-[#ea580c]' : 'text-gray-700 hover:bg-gray-100'
                    )
                  }
                >
                  {item.icon}
                  {showSidebarLabels && <span className="min-w-0">{item.label}</span>}
                </NavLink>
              </li>
            ))}
          </ul>
          {/* Mobile footer menu (desktop already has top-right menu) */}
          {user && !isMdUp ? (
            <div className="shrink-0 border-t border-[var(--border)] p-2 pb-[max(0.5rem,env(safe-area-inset-bottom,0px))]">
              <UserMenu
                name={user.full_name}
                onLogout={handleLogout}
                extraItems={isImpersonating ? [{ label: 'Exit preview', onClick: handleLogout }] : undefined}
                notificationUserId={user.id}
                className={cn(!showSidebarLabels ? 'w-full flex justify-center' : '')}
              />
            </div>
          ) : null}
        </nav>
          </aside>

          {/* Main: full width on small screens; offset by sidebar width on md+ */}
          <main
            className="flex min-h-[100dvh] min-h-screen min-w-0 flex-1 flex-col overflow-x-hidden transition-[margin-left] duration-200 ease-out"
            style={{ marginLeft: isMdUp ? width : 0 }}
          >
        {/* Mobile top bar — opens drawer nav (sidebar toggle is desktop-only) */}
        {!isMdUp ? (
          <header className="sticky top-0 z-20 flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top,0px))] pl-[max(0.75rem,env(safe-area-inset-left,0px))] pr-[max(0.75rem,env(safe-area-inset-right,0px))] shadow-sm">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="flex h-11 min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-md text-gray-700 hover:bg-gray-100"
              aria-label="Open menu"
            >
              <Menu className="h-6 w-6" />
            </button>
            <span className="min-w-0 flex-1 truncate text-base font-semibold text-[var(--text)]">Skyline</span>
            {user ? (
              <div className="flex items-center gap-1.5">
                <NotificationBell userId={user.id} />
                <UserMenu
                  name={user.full_name}
                  onLogout={handleLogout}
                  extraItems={isImpersonating ? [{ label: 'Exit preview', onClick: handleLogout }] : undefined}
                  notificationUserId={user.id}
                />
              </div>
            ) : null}
          </header>
        ) : null}
        {isMdUp && user ? (
          <header className="sticky top-0 z-20 flex shrink-0 items-center justify-end gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2 shadow-sm">
            <NotificationBell userId={user.id} />
            <UserMenu
              name={user.full_name}
              onLogout={handleLogout}
              extraItems={isImpersonating ? [{ label: 'Exit preview', onClick: handleLogout }] : undefined}
              notificationUserId={user.id}
            />
          </header>
        ) : null}
            <div className="min-h-0 min-w-0 flex-1 pb-[env(safe-area-inset-bottom,0px)]">
              {isImpersonating ? (
                <div
                  className="shrink-0 border-b border-amber-200 bg-amber-50 px-3 py-2 text-center text-xs font-medium text-amber-950 sm:text-sm"
                  role="status"
                >
                  Previewing as <span className="font-semibold">{user?.full_name}</span> ({user?.email}). This tab acts as that
                  user until you exit.
                </div>
              ) : null}
              <Outlet />
            </div>
          </main>
        </>
      )}
    </div>
  );
};
