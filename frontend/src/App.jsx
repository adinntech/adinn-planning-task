import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  Bell,
  BriefcaseBusiness,
  Building2,
  CalendarClock,
  CheckCircle2,
  CheckCheck,
  ChevronRight,
  ClipboardList,
  Clock3,
  Download,
  Eye,
  FileText,
  IndianRupee,
  LayoutDashboard,
  LogOut,
  Menu,
  MapPinned,
  MessageCircle,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  Upload,
  UserCog,
  Users,
  XCircle
} from 'lucide-react';
import logo from './assets/adinn-logo.png';
import { api, clearSession, fileUrl, getSavedUser, login, uploadWithProgress } from './api';

const statuses = [
  'Pending Lead Assignment',
  'Pending Acceptance',
  'Accepted',
  'In Progress',
  'Waiting for Details',
  'Submitted for Review',
  'Rework Required',
  'Completed',
  'Declined',
  'Cancelled'
];

const priorities = ['Low', 'Medium', 'High', 'Urgent'];
const campaignTypes = ['Outdoor', 'Roadshow'];
const planningVerticals = ['Outdoor', 'Roadshow'];
const categories = ['Campaign Plan', 'Route Planning', 'Media Planning', 'Budget Planning', 'Permit/Permission', 'Presentation Support', 'Vendor Coordination', 'Other'];
const clientTypes = ['', 'Direct Client', 'Ad Agency'];
const planFormats = ['', 'Customized PPT', 'Normal PPT'];
const ownershipOptions = ['Own', 'Trade', 'Own/Trade', 'Any'];
const locationOptions = ['Prime', 'Urban', 'Prime/Urban', 'Semi-Urban', 'Any'];
const sizeOptions = ['Small', 'Medium', 'Large', 'Small/Medium', 'Medium/Large', 'Any'];

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const hasTime = String(value).includes('T') || /\d{2}:\d{2}/.test(String(value));
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...(hasTime ? { hour: '2-digit', minute: '2-digit' } : {})
  });
}

const UPLOAD_CONCURRENCY = 3;
const COMPRESSIBLE_IMAGE_TYPES = new Set(['image/jpeg', 'image/webp']);
const IMAGE_COMPRESSION_MIN_SIZE = 800 * 1024;
const IMAGE_MAX_DIMENSION = 2000;
const IMAGE_JPEG_QUALITY = 0.8;

// Shrinks large photos client-side before upload so the slow leg (client's own
// upload bandwidth) has fewer bytes to push. PNG is only resized (lossless,
// keeps transparency); JPEG/WEBP are also re-encoded at a lower quality.
// Falls back to the original file on any error, or if compression didn't
// actually make it smaller.
async function compressImageFile(file) {
  const isLossyCompressible = COMPRESSIBLE_IMAGE_TYPES.has(file.type) && file.size > IMAGE_COMPRESSION_MIN_SIZE;
  const isResizablePng = file.type === 'image/png' && file.size > IMAGE_COMPRESSION_MIN_SIZE;
  if (!isLossyCompressible && !isResizablePng) return file;

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    if (isResizablePng && scale >= 1) return file;

    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    const blob = await new Promise(resolve => {
      canvas.toBlob(resolve, file.type, file.type === 'image/png' ? undefined : IMAGE_JPEG_QUALITY);
    });

    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name, { type: file.type, lastModified: Date.now() });
  } catch {
    return file;
  }
}

async function saveAttachmentToDevice(file) {
  if (!file?.download_url) throw new Error('Download link is unavailable.');
  const response = await fetch(fileUrl(file.download_url));
  if (!response.ok) throw new Error(`Unable to download file (${response.status})`);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = file.file_name || 'attachment';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function isOverdue(task) {
  if (!task?.due_date || ['Completed', 'Cancelled', 'Declined'].includes(task.status)) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(task.due_date);
  due.setHours(0, 0, 0, 0);
  return due < today;
}

function className(...values) {
  return values.filter(Boolean).join(' ');
}

function valueOrDash(value) {
  if (value === null || value === undefined || String(value).trim() === '') return '-';
  return String(value);
}

function roleLabel(role) {
  if (role === 'manager') return 'BD';
  if (role === 'admin') return 'Admin';
  if (role === 'planning_lead') return 'Planning Lead';
  if (role === 'planner') return 'Planner';
  return valueOrDash(role);
}

function conversionLabel(status) {
  if (status === 'Won') return 'Won – Plan Converted';
  if (status === 'Loss') return 'Loss – Plan Not Converted';
  return '-';
}

function DetailField({ label, value }) {
  return <div><span>{label}</span><strong>{valueOrDash(value)}</strong></div>;
}

function StatCard({ icon: Icon, label, value, accent, sub }) {
  return (
    <div className="stat-card">
      <div className={className('stat-icon', accent)}><Icon size={22} /></div>
      <div>
        <p>{label}</p>
        <strong>{value ?? 0}</strong>
        {sub && <span>{sub}</span>}
      </div>
    </div>
  );
}

function Pill({ children, type = 'status' }) {
  return <span className={className('pill', type, String(children).toLowerCase().replaceAll(' ', '-').replaceAll('&', 'and'))}>{children}</span>;
}

function EmptyState({ title, text }) {
  return (
    <div className="empty-state">
      <ClipboardList size={36} />
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

function Toast({ message, kind, onClose }) {
  if (!message) return null;
  return (
    <div className={className('toast', kind === 'error' && 'error')}>
      <span>{message}</span>
      <button onClick={onClose}>×</button>
    </div>
  );
}

function NotificationBell({ onOpenTask, onViewAll, refreshKey, notify }) {
  const notificationRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const lastSeenIdRef = useRef(null);

  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  async function load() {
    setLoading(true);
    try {
      const data = await api('/notifications?limit=30');
      const notifications = data.notifications || [];
      setItems(notifications);
      setUnreadCount(data.unread_count || 0);

      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        const highestId = notifications.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0);
        if (lastSeenIdRef.current !== null) {
          notifications
            .filter(item => Number(item.id) > lastSeenIdRef.current)
            .forEach(item => {
              const popup = new Notification(item.title, { body: item.message, tag: `task-notification-${item.id}` });
              popup.onclick = () => {
                window.focus();
                if (item.task_id) onOpenTask(item.task_id);
                popup.close();
              };
            });
        }
        if (highestId > 0) lastSeenIdRef.current = highestId;
      }
    } catch (err) {
      if (notify) notify(err.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 60000);
    return () => window.clearInterval(timer);
  }, [refreshKey]);

  useEffect(() => {
    if (!open) return undefined;

    function handlePointerDown(event) {
      if (notificationRef.current && !notificationRef.current.contains(event.target)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  async function markRead(item) {
    try {
      await api(`/notifications/${item.id}/read`, { method: 'PATCH' });
      setItems(previous => previous.map(row => row.id === item.id ? { ...row, is_read: true } : row));
      setUnreadCount(count => Math.max(0, count - (item.is_read ? 0 : 1)));
    } catch (err) {
      if (notify) notify(err.message, 'error');
    }
  }

  async function markAllRead() {
    try {
      await api('/notifications/read-all', { method: 'PATCH' });
      setItems(previous => previous.map(row => ({ ...row, is_read: true })));
      setUnreadCount(0);
    } catch (err) {
      if (notify) notify(err.message, 'error');
    }
  }

  async function openNotification(item) {
    if (!item.is_read) await markRead(item);
    if (item.task_id) onOpenTask(item.task_id);
    setOpen(false);
  }

  return (
    <div className="notification-wrap" ref={notificationRef}>
      <button className="notification-button" onClick={() => { setOpen(!open); if (!open) load(); }} aria-label="Notifications">
        <Bell size={18} />
        {unreadCount > 0 && <span>{unreadCount > 99 ? '99+' : unreadCount}</span>}
      </button>
      {open && (
        <div className="notification-panel">
          <div className="notification-head">
            <div>
              <strong>Notifications</strong>
              <small>{unreadCount} unread</small>
            </div>
            <button onClick={markAllRead} disabled={!unreadCount}><CheckCheck size={15} /> Mark all</button>
          </div>
          <div className="notification-list">
            {loading && items.length === 0 ? <div className="notification-empty">Loading notifications...</div> : null}
            {!loading && items.length === 0 ? <div className="notification-empty">No notifications yet.</div> : null}
            {items.map(item => (
              <button key={item.id} className={className('notification-item', !item.is_read && 'unread')} onClick={() => openNotification(item)}>
                <span />
                <div>
                  <div className="notification-item-title">
                    <strong>{item.title}</strong>
                    {!item.is_read && <em>New</em>}
                  </div>
                  <p>{item.message}</p>
                  <div className="notification-item-meta">
                    {item.task_code && <b>{item.task_code}</b>}
                    {item.brand_name && <span>{item.brand_name}</span>}
                    <small>{formatDate(item.created_at)}</small>
                  </div>
                </div>
              </button>
            ))}
          </div>
          <div className="notification-footer">
            <button onClick={() => { setOpen(false); onViewAll?.(); }}>View all notifications <ChevronRight size={17} /></button>
          </div>
        </div>
      )}
    </div>
  );
}

function NotificationsPage({ onOpenTask, notify, refreshKey }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [queryText, setQueryText] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  async function load() {
    setLoading(true);
    try {
      const data = await api('/notifications?limit=500');
      setItems(data.notifications || []);
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [refreshKey]);

  async function markRead(item) {
    if (item.is_read) return;
    try {
      await api(`/notifications/${item.id}/read`, { method: 'PATCH' });
      setItems(previous => previous.map(row => row.id === item.id ? { ...row, is_read: true } : row));
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  async function markAllRead() {
    try {
      await api('/notifications/read-all', { method: 'PATCH' });
      setItems(previous => previous.map(row => ({ ...row, is_read: true })));
      notify('All notifications marked as read.');
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  async function openNotification(item) {
    await markRead(item);
    if (item.task_id) onOpenTask(item.task_id);
  }

  const unreadCount = items.filter(item => !item.is_read).length;
  const filteredItems = useMemo(() => {
    const search = queryText.trim().toLowerCase();
    return items.filter(item => {
      if (filter === 'unread' && item.is_read) return false;
      if (!search) return true;
      return [item.title, item.message, item.task_code, item.brand_name, item.task_title, item.task_status]
        .filter(Boolean)
        .some(value => String(value).toLowerCase().includes(search));
    });
  }, [items, filter, queryText]);

  useEffect(() => { setPage(1); }, [filter, queryText, pageSize]);

  return (
    <section className="notifications-page">
      <div className="notifications-page-head">
        <div>
          <p className="eyebrow">Task communication center</p>
          <h2>Notifications</h2>
          <p>Review all task assignments, acceptances, completions, file updates and status changes in one place.</p>
        </div>
        <div className="notifications-page-actions">
          <button className="secondary-button" onClick={load}><RefreshCw size={17} /> Refresh</button>
          <button className="primary-button" onClick={markAllRead} disabled={!unreadCount}><CheckCheck size={17} /> Mark all read</button>
        </div>
      </div>

      <div className="notifications-summary">
        <div><span>All notifications</span><strong>{items.length}</strong></div>
        <div><span>Unread</span><strong>{unreadCount}</strong></div>
        <div><span>Read</span><strong>{items.length - unreadCount}</strong></div>
      </div>

      <div className="notifications-toolbar">
        <div className="notification-filter-tabs">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button>
          <button className={filter === 'unread' ? 'active' : ''} onClick={() => setFilter('unread')}>Unread ({unreadCount})</button>
        </div>
        <label className="notification-search">
          <Search size={18} />
          <input value={queryText} onChange={event => setQueryText(event.target.value)} placeholder="Search task, brand or notification..." />
        </label>
      </div>

      <div className="notifications-full-list">
        {loading && items.length === 0 ? <div className="loading-card">Loading notifications...</div> : null}
        {!loading && filteredItems.length === 0 ? <EmptyState title="No notifications found" text="There are no notifications matching this view." /> : null}
        {paginate(filteredItems, page, pageSize).map(item => (
          <article key={item.id} className={className('notification-full-card', !item.is_read && 'unread')}>
            <div className="notification-full-marker"><Bell size={19} /></div>
            <div className="notification-full-content">
              <div className="notification-full-title">
                <div>
                  <h3>{item.title}</h3>
                  {!item.is_read && <span>New</span>}
                </div>
                <time>{formatDate(item.created_at)}</time>
              </div>
              <p>{item.message}</p>
              <div className="notification-full-meta">
                {item.task_code && <span><strong>Task</strong>{item.task_code}</span>}
                {item.brand_name && <span><strong>Brand</strong>{item.brand_name}</span>}
                {item.task_status && <span><strong>Status</strong>{item.task_status}</span>}
              </div>
            </div>
            <div className="notification-full-actions">
              {!item.is_read && <button className="secondary-button" onClick={() => markRead(item)}>Mark read</button>}
              {item.task_id && <button className="primary-button" onClick={() => openNotification(item)}>Open Task <ChevronRight size={17} /></button>}
            </div>
          </article>
        ))}
      </div>
      <Pagination page={page} pageSize={pageSize} totalItems={filteredItems.length} onPageChange={setPage} onPageSizeChange={setPageSize} />
    </section>
  );
}

function LoginScreen({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [selectedRole, setSelectedRole] = useState('');
  const [allowEmailInput, setAllowEmailInput] = useState(false);
  const [allowPasswordInput, setAllowPasswordInput] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const fieldNonce = useMemo(() => Math.random().toString(36).slice(2), []);

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const user = await login(email.trim(), password, rememberMe);
      onLogin(user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function selectRole(role) {
    setSelectedRole(role);
    setEmail('');
    setPassword('');
    setError('');
  }

  const selectedRoleLabel = selectedRole === 'admin' ? 'Admin' : selectedRole === 'manager' ? 'BD' : selectedRole === 'planning_lead' ? 'Planning Lead' : selectedRole === 'planner' ? 'Planner' : '';

  return (
    <main className="login-page">
      <div className="login-orb orb-one" />
      <div className="login-orb orb-two" />
      <section className="login-hero">
        <div className="brand-chip">Planning Team Workspace</div>
        <img src={logo} alt="ADINN" className="login-logo" />
        <h1>Allocate, accept, track and complete every planning request in one premium workspace.</h1>
        <p>Built for ADINN BDs and planners to manage campaign planning, route planning, media planning, deadlines, rework and complete task history.</p>
        <div className="login-points">
          <span><CheckCircle2 size={18} /> Role based access</span>
          <span><CheckCircle2 size={18} /> Decline with reason</span>
          <span><CheckCircle2 size={18} /> Status history</span>
        </div>
      </section>
      <form className="login-card professional-login-card" onSubmit={submit} autoComplete="off">
        <div>
          <p className="eyebrow">Secure access</p>
          <h2>Sign in</h2>
          <p className="muted">Enter your ADINN Planning Desk credentials. Details are never pre-filled on this screen.</p>
        </div>
        <label>
          Email
          <input
            value={email}
            onChange={event => setEmail(event.target.value)}
            type="email"
            name={`adinn_email_${fieldNonce}`}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            placeholder="name@adinn.co.in"
            required
            readOnly={!allowEmailInput}
            onFocus={() => setAllowEmailInput(true)}
          />
        </label>
        <label>
          Password
          <input
            value={password}
            onChange={event => setPassword(event.target.value)}
            type="password"
            name={`adinn_pass_${fieldNonce}`}
            autoComplete="new-password"
            placeholder="Enter password"
            required
            readOnly={!allowPasswordInput}
            onFocus={() => setAllowPasswordInput(true)}
          />
        </label>
        <div className="login-options-row">
          <label className="remember-option">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={event => setRememberMe(event.target.checked)}
            />
            <span>Remember me on this device</span>
          </label>
          <span className="session-note">Leave unchecked for a session-only login.</span>
        </div>
        {error && <div className="error-box">{error}</div>}
        <button className="primary-button" disabled={loading}>{loading ? 'Signing in...' : 'Sign in securely'}</button>
        <div className="role-hints">
          <p>Role reference</p>
          <div className="demo-buttons">
            <button type="button" className={selectedRole === 'admin' ? 'selected' : ''} onClick={() => selectRole('admin')}>Admin</button>
            <button type="button" className={selectedRole === 'manager' ? 'selected' : ''} onClick={() => selectRole('manager')}>BD</button>
            <button type="button" className={selectedRole === 'planning_lead' ? 'selected' : ''} onClick={() => selectRole('planning_lead')}>Lead</button>
            <button type="button" className={selectedRole === 'planner' ? 'selected' : ''} onClick={() => selectRole('planner')}>Planner</button>
          </div>
          <small>{selectedRoleLabel ? `${selectedRoleLabel} selected. Enter the email and password manually.` : 'Choose a role reference if needed. Credentials are not inserted automatically.'}</small>
        </div>
      </form>
    </main>
  );
}

function Shell({ user, activeView, setActiveView, onLogout, onOpenTask, refreshKey, notify, children }) {
  const [open, setOpen] = useState(false);
  const nav = [
    { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, roles: ['admin', 'manager', 'planning_lead', 'planner'] },
    { key: 'tasks', label: user.role === 'planner' ? 'My Tasks' : 'All Tasks', icon: ClipboardList, roles: ['admin', 'manager', 'planning_lead', 'planner'] },
    { key: 'other_tasks', label: 'Others Tasks', icon: Users, roles: ['planner'] },
    { key: 'completed', label: 'Completed', icon: CheckCircle2, roles: ['admin', 'manager', 'planning_lead', 'planner'] },
    { key: 'notifications', label: 'Notification', icon: Bell, roles: ['admin', 'manager', 'planning_lead', 'planner'] },
    { key: 'create', label: 'Create Task', icon: Plus, roles: ['admin', 'manager', 'planning_lead'] },
    { key: 'reports', label: 'Reports', icon: BarChart3, roles: ['admin', 'manager', 'planning_lead', 'planner'] },
    { key: 'users', label: 'Users', icon: Users, roles: ['admin'] }
  ].filter(item => item.roles.includes(user.role));

  return (
    <div className="app-shell">
      <aside className={className('sidebar', open && 'open')}>
        <div className="sidebar-brand">
          <img src={logo} alt="ADINN" />
          <span>Planning Desk</span>
        </div>
        <nav>
          {nav.map(item => {
            const Icon = item.icon;
            return (
              <button key={item.key} className={activeView === item.key ? 'active' : ''} onClick={() => { setActiveView(item.key); setOpen(false); }}>
                <Icon size={19} /> {item.label}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <div className="user-badge">
            <div>{user.name?.slice(0, 1)}</div>
            <span>{user.name}<small>{roleLabel(user.role)}</small></span>
          </div>
          <button className="logout-button" onClick={onLogout}><LogOut size={18} /> Logout</button>
        </div>
      </aside>
      <main className="content-area">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setOpen(!open)}><Menu /></button>
          <div>
            <p className="eyebrow">ADINN Advertising Services Ltd.</p>
            <h1>{nav.find(item => item.key === activeView)?.label || 'Dashboard'}</h1>
          </div>
          <div className="top-actions">
            <NotificationBell onOpenTask={onOpenTask} onViewAll={() => setActiveView('notifications')} refreshKey={refreshKey} notify={notify} />
            <span className="role-chip"><ShieldCheck size={16} /> {roleLabel(user.role)}</span>
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}

function Dashboard({ user, setActiveView, onOpenTask, notify, refreshKey }) {
  const [overview, setOverview] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const [reportData, taskData] = await Promise.all([
        api('/reports/overview'),
        api(`/tasks?view=active${user.role === 'planner' ? '&scope=assigned' : ''}`)
      ]);
      setOverview(reportData);
      setTasks(taskData.tasks || []);
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [refreshKey]);

  const urgentTasks = useMemo(() => tasks.filter(task => task.priority === 'Urgent' || isOverdue(task)).slice(0, 5), [tasks]);
  const pendingAcceptance = useMemo(() => tasks.filter(task => task.status === 'Pending Acceptance').slice(0, 5), [tasks]);

  if (loading) return <div className="loading-card">Loading dashboard...</div>;

  return (
    <section className="dashboard-grid">
      <div className="stats-grid">
        <StatCard icon={ClipboardList} label="Total Tasks" value={overview?.total} accent="red" sub="All accessible records" />
        <StatCard icon={Clock3} label="Due Today" value={overview?.dueToday} accent="amber" sub="Needs attention" />
        <StatCard icon={CalendarClock} label="Overdue" value={overview?.overdue} accent="red" sub="Not yet closed" />
        <StatCard icon={CheckCircle2} label="Completed" value={overview?.completed} accent="green" sub="Closed tasks" />
      </div>

      <div className="panel wide hero-panel">
        <div>
          <p className="eyebrow">Planning command center</p>
          <h2>Keep every campaign planning request visible from assignment to completion.</h2>
          <p>BDs assign work to Planning Leads, leads allocate it to planners, and planners can accept or decline with reason, and every status change is captured in the task history.</p>
        </div>
        <button className="primary-button" onClick={() => setActiveView(user.role === 'planner' ? 'tasks' : 'create')}>
          {user.role === 'planner' ? 'View Tasks' : 'Create New Task'} <ChevronRight size={18} />
        </button>
      </div>

      <div className="panel">
        <div className="panel-title">
          <h3>Urgent / Overdue Tasks</h3>
          <button onClick={load}><RefreshCw size={16} /></button>
        </div>
        {urgentTasks.length === 0 ? <EmptyState title="No urgent blockers" text="Everything looks controlled right now." /> : (
          <div className="compact-list">
            {urgentTasks.map(task => (
              <button key={task.id} onClick={() => onOpenTask(task.id)}>
                <span><strong>{task.task_code}</strong>{task.title}</span>
                <Pill type="priority">{isOverdue(task) ? 'Overdue' : task.priority}</Pill>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-title"><h3>Pending Acceptance</h3></div>
        {pendingAcceptance.length === 0 ? <EmptyState title="No pending acceptance" text="Newly assigned tasks will appear here." /> : (
          <div className="compact-list">
            {pendingAcceptance.map(task => (
              <button key={task.id} onClick={() => onOpenTask(task.id)}>
                <span><strong>{task.assigned_to_name}</strong>{task.title}</span>
                <Pill>{task.status}</Pill>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="panel wide">
        <div className="panel-title">
          <div>
            <h3>Planner Workload Board</h3>
            <p className="panel-subtitle">Based on the Design Task Manager reference: planner-wise active load, pending acceptance, review/rework and overdue visibility.</p>
          </div>
        </div>
        <div className="workload-board">
          {(overview?.workload || []).map(row => (
            <div className="planner-load-card" key={row.id}>
              <div className="planner-load-head">
                <div>
                  <strong>{row.name}</strong>
                  <span>{row.verticals || 'No planning option mapped'}</span>
                </div>
                <div className="load-number">{row.active || 0}</div>
              </div>
              <div className="load-metrics">
                <span>Pending <b>{row.pending || 0}</b></span>
                <span>Review <b>{row.review || 0}</b></span>
                <span>Overdue <b>{row.overdue || 0}</b></span>
                <span>Done <b>{row.completed || 0}</b></span>
              </div>
              <div className="progress-track"><span style={{ width: `${Math.min(100, ((row.active || 0) / Math.max(1, row.total || 1)) * 100)}%` }} /></div>
            </div>
          ))}
          {(!overview?.workload || overview.workload.length === 0) && <EmptyState title="No planners found" text="Create planner users to see workload split." />}
        </div>
      </div>

      <div className="panel wide">
        <div className="panel-title"><h3>Active Planner Timing</h3></div>
        {(!overview?.workloadTasks || overview.workloadTasks.length === 0) ? <EmptyState title="No active tasks" text="Accepted and ongoing planning requests will appear here with deadline timing." /> : (
          <div className="timing-list">
            {overview.workloadTasks.map(item => (
              <button key={item.id} onClick={() => onOpenTask(item.id)}>
                <span>
                  <strong>{item.task_code} • {valueOrDash(item.brand_name)}</strong>
                  {item.title}
                </span>
                <span>{item.planner_name}</span>
                <span>{formatDate(item.submission_deadline || item.due_date)}</span>
                <Pill>{item.status}</Pill>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function TaskFilters({ filters, setFilters, planners, managers, user, showStatus = true }) {
  return (
    <div className="filters-bar advanced-filters">
      <div className="search-box">
        <Search size={18} />
        <input placeholder="Search brand, agency, location, audience..." value={filters.search} onChange={e => setFilters({ ...filters, search: e.target.value })} />
      </div>
      {showStatus && (
        <select value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })}>
          <option value="all">All statuses</option>
          {statuses.filter(status => status !== 'Completed').map(status => <option key={status}>{status}</option>)}
        </select>
      )}
      <select value={filters.plan_format} onChange={e => setFilters({ ...filters, plan_format: e.target.value })}>
        <option value="all">All plan types</option>
        {planFormats.filter(Boolean).map(format => <option key={format}>{format}</option>)}
      </select>
      {user.role === 'admin' && (
        <select value={filters.assigned_by} onChange={e => setFilters({ ...filters, assigned_by: e.target.value })}>
          <option value="all">All creators</option>
          {managers.map(manager => <option key={manager.id} value={manager.id}>{manager.name}</option>)}
        </select>
      )}
      {user.role !== 'planner' && (
        <select value={filters.assigned_to} onChange={e => setFilters({ ...filters, assigned_to: e.target.value })}>
          <option value="all">All planners</option>
          {planners.map(planner => <option key={planner.id} value={planner.id}>{planner.name}{planner.verticals ? ` • ${planner.verticals}` : ''}</option>)}
        </select>
      )}
      <label className="compact-date-filter">From<input type="date" value={filters.from} onChange={e => setFilters({ ...filters, from: e.target.value })} /></label>
      <label className="compact-date-filter">To<input type="date" value={filters.to} onChange={e => setFilters({ ...filters, to: e.target.value })} /></label>
    </div>
  );
}

function PlannerAllocationEditor({ planners, assignments, onChange, disabled = false }) {
  const selectedById = new Map((assignments || []).map(item => [Number(item.planner_id), item]));

  function toggle(planner) {
    const plannerId = Number(planner.id);
    if (selectedById.has(plannerId)) {
      onChange((assignments || []).filter(item => Number(item.planner_id) !== plannerId));
      return;
    }
    onChange([...(assignments || []), { planner_id: plannerId, assigned_locations: '', status: 'Pending Acceptance', planner_name: planner.name }]);
  }

  function updateLocations(plannerId, value) {
    onChange((assignments || []).map(item => Number(item.planner_id) === Number(plannerId)
      ? { ...item, assigned_locations: value }
      : item));
  }

  return (
    <div className="planner-allocation-editor">
      {planners.map(planner => {
        const assignment = selectedById.get(Number(planner.id));
        return (
          <div key={planner.id} className={className('planner-allocation-option', assignment && 'selected')}>
            <label className="planner-check-row">
              <input
                type="checkbox"
                checked={Boolean(assignment)}
                disabled={disabled}
                onChange={() => toggle(planner)}
              />
              <span>
                <strong>{planner.name}</strong>
                <small>{planner.verticals || 'Planning'}</small>
              </span>
              {assignment?.status && <Pill>{assignment.status}</Pill>}
            </label>
            {assignment && (
              <textarea
                value={assignment.assigned_locations || ''}
                disabled={disabled}
                onChange={event => updateLocations(planner.id, event.target.value)}
                placeholder="Locations / districts / zones assigned to this planner"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function paginate(items, page, pageSize) {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

const PAGE_SIZE_OPTIONS = [10, 50, 100];

function Pagination({ page, pageSize, totalItems, onPageChange, onPageSizeChange }) {
  if (totalItems === 0) return null;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const clampedPage = Math.min(Math.max(page, 1), totalPages);
  return (
    <div className="pagination-bar">
      <label className="pagination-size">
        Show
        <select value={pageSize} onChange={event => onPageSizeChange(Number(event.target.value))}>
          {PAGE_SIZE_OPTIONS.map(size => <option key={size} value={size}>{size}</option>)}
        </select>
        per page
      </label>
      <div className="pagination-controls">
        <button
          type="button"
          className="ghost-button"
          disabled={clampedPage <= 1}
          onClick={() => onPageChange(1)}
        >
          First
        </button>
        <button
          type="button"
          className="ghost-button"
          disabled={clampedPage <= 1}
          onClick={() => onPageChange(clampedPage - 1)}
        >
          Previous
        </button>
        <span>Page {clampedPage} of {totalPages}</span>
        <button
          type="button"
          className="ghost-button"
          disabled={clampedPage >= totalPages}
          onClick={() => onPageChange(clampedPage + 1)}
        >
          Next
        </button>
        <button
          type="button"
          className="ghost-button"
          disabled={clampedPage >= totalPages}
          onClick={() => onPageChange(totalPages)}
        >
          Last
        </button>
      </div>
    </div>
  );
}

function TaskListTable({
  tasks,
  onOpenTask,
  summaryOnly = false,
  completedOnly = false,
  user,
  onConversionChange
}) {
  const canEditConversion = completedOnly && ['admin', 'manager', 'planning_lead'].includes(user?.role);
  return (
    <div className="task-table-wrap">
      <table className="task-table company-task-table">
        <thead>
          <tr>
            <th>Created By</th>
            <th>Task</th>
            <th>Brand / Client Type</th>
            <th>Target Areas / Location</th>
            <th>Current Assignee</th>
            <th>Submission Deadline</th>
            <th>{completedOnly ? 'Conversion' : 'Status'}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {tasks.map(task => (
            <tr key={task.id} className={className(isOverdue(task) && 'overdue-row', summaryOnly && 'summary-only-row')}>
              <td className="created-by-cell" data-label="Created By">
                <strong>{valueOrDash(task.assigned_by_name)}</strong>
                <span>{roleLabel(task.assigned_by_role)}</span>
              </td>
              <td data-label="Task">
                <strong>{task.task_code}</strong>
                <span>{task.title}</span>
              </td>
              <td data-label="Brand / Client Type">
                <strong>{valueOrDash(task.brand_name)}</strong>
                <span>{[task.direct_client_or_agency, task.agency_name].filter(Boolean).join(' • ') || '-'}</span>
              </td>
              <td className="target-area-cell" data-label="Target Areas / Location">
                <strong title={task.my_assigned_locations || task.target_areas || ''}>{valueOrDash(task.my_assigned_locations || task.target_areas)}</strong>
              </td>
              <td data-label="Current Assignee">
                <strong>{task.assigned_planner_names || task.assigned_to_name}</strong>
                <span>{task.planner_count > 1 ? `${task.planner_completed_count || 0}/${task.planner_count} portions completed` : (task.planning_lead_name ? `Lead: ${task.planning_lead_name}` : '')}</span>
              </td>
              <td data-label="Submission Deadline">{formatDate(task.submission_deadline || task.due_date)} {isOverdue(task) && <Pill type="priority">Overdue</Pill>}</td>
              <td data-label="Status">
                {completedOnly ? (
                  canEditConversion ? (
                    <select
                      className={className('conversion-select', `conversion-${String(task.conversion_status || 'Pending').toLowerCase()}`)}
                      value={task.conversion_status || 'Pending'}
                      onChange={event => onConversionChange?.(task.id, event.target.value)}
                      aria-label={`Conversion status for ${task.task_code}`}
                    >
                      <option value="Pending">-</option>
                      <option value="Won">Won – Plan Converted</option>
                      <option value="Loss">Loss – Plan Not Converted</option>
                    </select>
                  ) : (
                    <span className={className('conversion-badge', `conversion-${String(task.conversion_status || 'Pending').toLowerCase()}`)}>
                      {conversionLabel(task.conversion_status)}
                    </span>
                  )
                ) : <Pill>{task.my_assignment_status || task.status}</Pill>}
              </td>
              <td data-label="Action" className="task-action-cell">
                {summaryOnly || task.is_summary_only
                  ? <span className="summary-only-note">Summary only</span>
                  : <button className="table-action" onClick={() => onOpenTask(task.id)}>Open</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TasksPage({ user, onOpenTask, notify, refreshKey, completedOnly = false, plannerScope = 'mine' }) {
  const [tasks, setTasks] = useState([]);
  const [planners, setPlanners] = useState([]);
  const [creators, setCreators] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ search: '', status: 'all', assigned_to: 'all', assigned_by: 'all', plan_format: 'all', from: '', to: '' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  async function load() {
    setLoading(true);
    try {
      const queryParams = new URLSearchParams(Object.entries(filters).filter(([, v]) => v && v !== 'all'));
      queryParams.set('view', completedOnly ? 'completed' : 'active');
      const query = queryParams.toString();
      const [taskData, userData] = await Promise.all([
        api(`/tasks?${query}`),
        api('/users?status=active')
      ]);
      setTasks(taskData.tasks || []);
      setPlanners((userData.users || []).filter(item => item.role === 'planner'));
      setCreators((userData.users || []).filter(item => ['admin', 'manager', 'planning_lead'].includes(item.role)));
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [filters, refreshKey, completedOnly]);
  useEffect(() => { setPage(1); }, [filters, completedOnly, plannerScope, pageSize]);

  const myTasks = user.role === 'planner'
    ? tasks.filter(task => {
        const isMine = ((task.planner_ids || []).map(Number).includes(Number(user.id)) || Number(task.assigned_to) === Number(user.id)) && !task.is_summary_only;
        if (!isMine) return false;
        const ownStatus = task.my_assignment_status || task.status;
        return completedOnly ? ownStatus === 'Completed' : ownStatus !== 'Completed';
      })
    : tasks;
  const otherTasks = user.role === 'planner'
    ? tasks.filter(task => {
        const isMine = (task.planner_ids || []).map(Number).includes(Number(user.id)) || Number(task.assigned_to) === Number(user.id);
        return !isMine || task.is_summary_only;
      })
    : [];

  async function updateConversionStatus(taskId, conversionStatus) {
    const previousTasks = tasks;
    setTasks(current => current.map(task => (
      Number(task.id) === Number(taskId)
        ? { ...task, conversion_status: conversionStatus }
        : task
    )));
    try {
      await api(`/tasks/${taskId}/conversion-status`, {
        method: 'PATCH',
        body: JSON.stringify({ conversion_status: conversionStatus })
      });
      notify(`Updated as ${conversionLabel(conversionStatus)}.`);
    } catch (err) {
      setTasks(previousTasks);
      notify(err.message, 'error');
    }
  }

  return (
    <section className="panel full-panel">
      <div className="panel-title">
        <div>
          <p className="eyebrow">{completedOnly ? 'Completed archive' : 'Task tracker'}</p>
          <h2>{completedOnly ? 'Completed Tasks' : (user.role === 'planner' ? (plannerScope === 'others' ? 'Others Tasks' : 'My Tasks') : 'Planning Work Allocation')}</h2>
        </div>
        <button className="ghost-button" onClick={load}><RefreshCw size={16} /> Refresh</button>
      </div>
      <TaskFilters filters={filters} setFilters={setFilters} planners={planners} managers={creators} user={user} showStatus={!completedOnly} />
      {loading ? <div className="loading-card">Loading tasks...</div> : user.role === 'planner' ? (
        <div className="planner-task-sections">
          {plannerScope === 'others' ? (
            <section className="task-list-section other-company-tasks">
              <div className="task-list-section-title">
                <div>
                  <p className="eyebrow">Company visibility</p>
                  <h3>Others Tasks</h3>
                  <p className="panel-subtitle">These tasks are assigned to other planners. Only summary information is available.</p>
                </div>
                <Pill>{otherTasks.length}</Pill>
              </div>
              {otherTasks.length === 0
                ? <EmptyState title="No other company tasks found" text="Adjust the filters or refresh this page." />
                : (
                  <>
                    <TaskListTable tasks={paginate(otherTasks, page, pageSize)} onOpenTask={onOpenTask} summaryOnly completedOnly={completedOnly} user={user} onConversionChange={updateConversionStatus} />
                    <Pagination page={page} pageSize={pageSize} totalItems={otherTasks.length} onPageChange={setPage} onPageSizeChange={setPageSize} />
                  </>
                )}
            </section>
          ) : (
            <section className="task-list-section">
              <div className="task-list-section-title">
                <div>
                  <p className="eyebrow">Your workload</p>
                  <h3>{completedOnly ? 'My Completed Tasks' : 'My Tasks'}</h3>
                </div>
                <Pill>{myTasks.length}</Pill>
              </div>
              {myTasks.length === 0
                ? <EmptyState title={completedOnly ? 'No completed tasks assigned to you' : 'No tasks assigned to you'} text="Your assigned planning tasks will appear here." />
                : (
                  <>
                    <TaskListTable tasks={paginate(myTasks, page, pageSize)} onOpenTask={onOpenTask} completedOnly={completedOnly} user={user} onConversionChange={updateConversionStatus} />
                    <Pagination page={page} pageSize={pageSize} totalItems={myTasks.length} onPageChange={setPage} onPageSizeChange={setPageSize} />
                  </>
                )}
            </section>
          )}
        </div>
      ) : tasks.length === 0 ? (
        <EmptyState
          title={completedOnly ? 'No completed tasks found' : 'No active tasks found'}
          text={completedOnly ? 'Tasks marked Completed will appear in this section.' : 'Create a new request or adjust your filters.'}
        />
      ) : (
        <>
          <TaskListTable tasks={paginate(tasks, page, pageSize)} onOpenTask={onOpenTask} completedOnly={completedOnly} user={user} onConversionChange={updateConversionStatus} />
          <Pagination page={page} pageSize={pageSize} totalItems={tasks.length} onPageChange={setPage} onPageSizeChange={setPageSize} />
        </>
      )}
    </section>
  );
}

function CreateTask({ user, notify, setActiveView, onCreated }) {
  const [planningLeads, setPlanningLeads] = useState([]);
  const [planners, setPlanners] = useState([]);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    assigned_to: '',
    planner_assignments: [],
    brand_name: '',
    direct_client_or_agency: '',
    agency_name: '',
    campaign_start_date: '',
    campaign_duration: '',
    campaign_budget: '',
    display_cost_min: '',
    display_cost_max: '',
    display_cost_range: '',
    target_areas: '',
    target_audience_profile: '',
    site_preferences: '',
    ownership_type: '',
    location_type: '',
    size_preference: '',
    additional_specifications: '',
    plan_format: '',
    submission_deadline: ''
  });

  useEffect(() => {
    Promise.all([
      api('/users?role=planning_lead&status=active'),
      user.role === 'planning_lead' ? api('/users?role=planner&status=active') : Promise.resolve({ users: [] })
    ])
      .then(([leadData, plannerData]) => {
        setPlanningLeads(leadData.users || []);
        setPlanners(plannerData.users || []);
      })
      .catch(err => notify(err.message, 'error'));
  }, [user.role]);

  function update(key, value) {
    setForm(previous => {
      const next = { ...previous, [key]: value };
      if (key === 'direct_client_or_agency' && value === 'Direct Client' && !previous.agency_name) next.agency_name = 'NA';
      return next;
    });
  }

  const displayCostRange = useMemo(() => {
    if (form.display_cost_range.trim()) return form.display_cost_range.trim();
    const min = form.display_cost_min.trim();
    const max = form.display_cost_max.trim();
    if (min && max) return `${min} - ${max}`;
    return min || max || '';
  }, [form.display_cost_range, form.display_cost_min, form.display_cost_max]);

  async function submit(event) {
    event.preventDefault();
    if (user.role === 'planning_lead' && form.planner_assignments.length === 0) {
      notify('Select at least one Planner.', 'error');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        assigned_to: form.assigned_to,
        planner_assignments: user.role === 'planning_lead' ? form.planner_assignments.map(item => ({
          planner_id: Number(item.planner_id),
          assigned_locations: item.assigned_locations || ''
        })) : undefined,
        brand_name: form.brand_name,
        direct_client_or_agency: form.direct_client_or_agency,
        agency_name: form.agency_name,
        campaign_start_date: form.campaign_start_date,
        campaign_duration: form.campaign_duration,
        campaign_budget: form.campaign_budget,
        display_cost_range: displayCostRange,
        target_areas: form.target_areas,
        target_audience_profile: form.target_audience_profile,
        site_preferences: form.site_preferences,
        ownership_type: form.ownership_type,
        location_type: form.location_type,
        size_preference: form.size_preference,
        additional_specifications: form.additional_specifications,
        plan_format: form.plan_format,
        submission_deadline: form.submission_deadline,
        title: form.brand_name ? `Planning Request - ${form.brand_name}` : 'Planning Request'
      };
      await api('/tasks', { method: 'POST', body: JSON.stringify(payload) });
      notify(user.role === 'planning_lead' ? 'Planning task created and assigned to the selected Planners.' : 'Planning task assigned to Planning Lead.');
      onCreated();
      setActiveView('tasks');
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="panel full-panel create-form enhanced-create-form" onSubmit={submit}>
      <div className="assignment-hero exact-field-hero">
        <div>
          <p className="eyebrow">New planning request</p>
          <h2>Create Planning Task</h2>
          <p>{user.role === 'planning_lead'
            ? 'Select the responsible Planning Lead and assign one or more active Planners, with optional location-wise allocation.'
            : 'Select the responsible Planning Lead. The Lead can assign a Planner after receiving the task.'}</p>
        </div>
        <button className="primary-button hero-submit" disabled={saving}>{saving ? 'Creating...' : (user.role === 'planning_lead' ? 'Create & Assign' : 'Assign to Lead')}</button>
      </div>

      <div className="professional-form-layout exact-field-layout">
        <div className="form-main-column">
          <div className="form-block required-card">
            <div className="form-section-title">Task Assignment</div>
            <div className="form-grid">
              <label className={user.role === 'planning_lead' ? '' : 'span-2'}>Assign Planning Lead <span className="required-mark">required</span>
                <select required value={form.assigned_to} onChange={e => update('assigned_to', e.target.value)}>
                  <option value="">Select Planning Lead</option>
                  {planningLeads.map(lead => <option key={lead.id} value={lead.id}>{lead.name}{lead.verticals ? ` • ${lead.verticals}` : ''}</option>)}
                </select>
              </label>
              {user.role === 'planning_lead' && (
                <div className="span-2 multi-planner-create">
                  <div className="field-label">Assign one or more Planners <span className="required-mark">required</span></div>
                  <p className="field-help">Select planners and optionally split the South India / Tamil Nadu locations between them.</p>
                  <PlannerAllocationEditor
                    planners={planners}
                    assignments={form.planner_assignments}
                    onChange={value => update('planner_assignments', value)}
                  />
                </div>
              )}
            </div>
          </div>

          <div className="form-block">
            <div className="form-section-title">1. Brand Name</div>
            <div className="form-grid">
              <label className="span-2">Brand Name
                <input value={form.brand_name} onChange={e => update('brand_name', e.target.value)} placeholder="Brand name" />
              </label>
            </div>
          </div>

          <div className="form-block">
            <div className="form-section-title">2 - 3. Client Source</div>
            <div className="form-grid">
              <label>Direct Client or Ad Agency
                <select value={form.direct_client_or_agency} onChange={e => update('direct_client_or_agency', e.target.value)}>
                  {clientTypes.map(item => <option key={item} value={item}>{item || 'Select type'}</option>)}
                </select>
              </label>
              <label>In case of Agency - Specify name or NA
                <input value={form.agency_name} onChange={e => update('agency_name', e.target.value)} placeholder="Agency name or NA" />
              </label>
            </div>
          </div>

          <div className="form-block">
            <div className="form-section-title">4 - 7. Campaign Timeline & Budget</div>
            <div className="form-grid">
              <label>Campaign Start Date
                <input type="date" value={form.campaign_start_date} onChange={e => update('campaign_start_date', e.target.value)} />
              </label>
              <label>Campaign Duration
                <input value={form.campaign_duration} onChange={e => update('campaign_duration', e.target.value)} placeholder="Example: 10 days / 30 days / 3 months" />
              </label>
              <label>Campaign Budget
                <input value={form.campaign_budget} onChange={e => update('campaign_budget', e.target.value)} placeholder="Example: ₹5,00,000" />
              </label>
              <div className="cost-range-field">
                <span>Display Cost Range (Min - Max)</span>
                <div>
                  <input value={form.display_cost_min} onChange={e => update('display_cost_min', e.target.value)} placeholder="Min cost" />
                  <input value={form.display_cost_max} onChange={e => update('display_cost_max', e.target.value)} placeholder="Max cost" />
                </div>
                <input value={form.display_cost_range} onChange={e => update('display_cost_range', e.target.value)} placeholder="Or type full range note" />
              </div>
            </div>
          </div>

          <div className="form-block">
            <div className="form-section-title">8 - 10. Location, Audience & Site Preferences</div>
            <div className="form-grid">
              <label className="span-2">Target Areas / Location
                <textarea value={form.target_areas} onChange={e => update('target_areas', e.target.value)} placeholder="Target areas, locations, routes, cities, districts or zones" />
              </label>
              <label className="span-2">Target Audience Profile
                <textarea value={form.target_audience_profile} onChange={e => update('target_audience_profile', e.target.value)} placeholder="Audience profile, demographic, income group, interests or purchase intent" />
              </label>
              <label className="span-2">Site Preferences
                <textarea value={form.site_preferences} onChange={e => update('site_preferences', e.target.value)} placeholder="Preferred media/site type, visibility, nearby landmarks, approach roads or notes" />
              </label>
            </div>
          </div>

          <div className="form-block">
            <div className="form-section-title">10.1 - 10.3. Site Preference Details</div>
            <div className="form-grid">
              <label>Ownership Type
                <input value={form.ownership_type} onChange={e => update('ownership_type', e.target.value)} placeholder="Own / Trade" />
              </label>
              <label>Location Type
                <input value={form.location_type} onChange={e => update('location_type', e.target.value)} placeholder="Prime / Urban" />
              </label>
              <label>Size Preference
                <input value={form.size_preference} onChange={e => update('size_preference', e.target.value)} placeholder="Small / Medium / Large" />
              </label>
            </div>
          </div>

          <div className="form-block">
            <div className="form-section-title">11. Additional Specifications</div>
            <label>Additional Specifications
              <textarea rows="6" value={form.additional_specifications} onChange={e => update('additional_specifications', e.target.value)} placeholder="Any special instruction, client expectation, reference, restriction, mandatory location, output note, budget logic or presentation note" />
            </label>
          </div>

          <div className="form-block">
            <div className="form-section-title">12 - 13. Plan Output & Submission Deadline</div>
            <div className="form-grid">
              <label>Plan Required as Customized or Normal PPT
                <select value={form.plan_format} onChange={e => update('plan_format', e.target.value)}>
                  {planFormats.map(item => <option key={item} value={item}>{item || 'Select plan type'}</option>)}
                </select>
              </label>
              <label>Plan Submission Timeline / Deadline
                <input type="datetime-local" value={form.submission_deadline} onChange={e => update('submission_deadline', e.target.value)} />
              </label>
            </div>
          </div>

          <div className="form-submit-row">
            <button className="primary-button" disabled={saving}>{saving ? 'Creating...' : (user.role === 'planning_lead' ? 'Create & Assign' : 'Assign to Lead')}</button>
          </div>
        </div>
      </div>
    </form>
  );
}

function AttachmentPreview({ file, onClose, onDownload, downloading }) {
  const [loading, setLoading] = useState(file?.preview_kind === 'spreadsheet');
  const [error, setError] = useState('');
  const [sheets, setSheets] = useState([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [previewLoadFailed, setPreviewLoadFailed] = useState(false);

  useEffect(() => {
    setPreviewLoadFailed(false);
  }, [file?.id]);

  useEffect(() => {
    let cancelled = false;
    async function loadSpreadsheet() {
      if (!file || file.preview_kind !== 'spreadsheet' || !file.available || !file.preview_url) return;
      setLoading(true);
      setError('');
      try {
        const response = await fetch(fileUrl(file.preview_url));
        if (!response.ok) throw new Error(`Unable to load spreadsheet (${response.status})`);
        const XLSX = await import('xlsx');
        const workbook = XLSX.read(await response.arrayBuffer(), { type: 'array' });
        const parsedSheets = workbook.SheetNames.map(name => {
          const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '' });
          return {
            name,
            rows: rows.slice(0, 250).map(row => row.slice(0, 60))
          };
        });
        if (!cancelled) setSheets(parsedSheets);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Unable to preview this spreadsheet.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadSpreadsheet();
    return () => { cancelled = true; };
  }, [file]);

  if (!file) return null;
  const previewUrl = file.preview_url ? fileUrl(file.preview_url) : '';
  const downloadUrl = file.download_url ? fileUrl(file.download_url) : '';
  const currentSheet = sheets[activeSheet];

  return (
    <div className="attachment-preview-backdrop" role="dialog" aria-modal="true" aria-label={`Preview ${file.file_name}`}>
      <section className="attachment-preview-modal">
        <header className="attachment-preview-header">
          <div>
            <p className="eyebrow">Attachment Preview</p>
            <h2>{file.file_name}</h2>
            <span>Uploaded by {file.name || 'User'}</span>
          </div>
          <div className="attachment-preview-actions">
            {file.available && !previewLoadFailed && downloadUrl && (
              <button
                type="button"
                className="ghost-button"
                onClick={() => onDownload(file)}
                disabled={downloading}
              >
                <Download size={17} /> {downloading ? 'Downloading...' : 'Download'}
              </button>
            )}
            <button type="button" className="modal-close preview-close" onClick={onClose} aria-label="Close attachment preview">×</button>
          </div>
        </header>

        {!file.available || previewLoadFailed ? (
          <div className="attachment-unavailable">
            <XCircle size={44} />
            <h3>File unavailable</h3>
            <p>{file.unavailable_reason || 'This file is no longer available. Please upload the original file again.'}</p>
          </div>
        ) : file.preview_kind === 'image' ? (
          <div className="image-preview-stage">
            <img src={previewUrl} alt={file.file_name} onError={() => setPreviewLoadFailed(true)} />
          </div>
        ) : file.preview_kind === 'pdf' ? (
          <iframe className="document-preview-frame" src={previewUrl} title={file.file_name} />
        ) : file.preview_kind === 'presentation' ? (
          <div className="presentation-preview-wrap">
            <iframe
              className="document-preview-frame"
              src={`https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(previewUrl)}`}
              title={file.file_name}
            />
            <p>PowerPoint preview is provided by Microsoft Office for the web. Use Download if the external viewer cannot render the file.</p>
          </div>
        ) : file.preview_kind === 'spreadsheet' ? (
          <div className="spreadsheet-preview">
            {loading && <div className="loading-card">Loading spreadsheet preview...</div>}
            {error && <div className="attachment-preview-error">{error}</div>}
            {!loading && !error && sheets.length > 0 && (
              <>
                <div className="sheet-tabs" role="tablist" aria-label="Workbook sheets">
                  {sheets.map((sheet, index) => (
                    <button
                      type="button"
                      key={`${sheet.name}-${index}`}
                      className={index === activeSheet ? 'active' : ''}
                      onClick={() => setActiveSheet(index)}
                    >
                      {sheet.name}
                    </button>
                  ))}
                </div>
                <div className="spreadsheet-table-wrap">
                  <table className="spreadsheet-table">
                    <tbody>
                      {(currentSheet?.rows || []).map((row, rowIndex) => (
                        <tr key={rowIndex}>
                          <th>{rowIndex + 1}</th>
                          {row.map((cell, cellIndex) => <td key={cellIndex}>{String(cell)}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {(currentSheet?.rows || []).length === 0 && <p className="muted">This sheet is empty.</p>}
              </>
            )}
          </div>
        ) : (
          <iframe className="document-preview-frame" src={previewUrl} title={file.file_name} />
        )}
      </section>
    </div>
  );
}

function TaskDetail({ taskId, user, onClose, notify, onChanged }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [remarks, setRemarks] = useState('');
  const [status, setStatus] = useState('In Progress');
  const [comment, setComment] = useState('');
  const [files, setFiles] = useState([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [uploadQueue, setUploadQueue] = useState([]);
  const uploadAbortsRef = useRef({});
  const uploadCancelledRef = useRef(new Set());
  const [deletingFileId, setDeletingFileId] = useState(null);
  const [previewFile, setPreviewFile] = useState(null);
  const [downloadingFileId, setDownloadingFileId] = useState(null);
  const [planners, setPlanners] = useState([]);
  const [plannerAssignments, setPlannerAssignments] = useState([]);
  const [savingAssignments, setSavingAssignments] = useState(false);
  const [planningLeads, setPlanningLeads] = useState([]);
  const [planningLeadId, setPlanningLeadId] = useState('');
  const [reassigning, setReassigning] = useState('');

  const task = data?.task;

  async function load() {
    setLoading(true);
    try {
      const detail = await api(`/tasks/${taskId}`);
      setData(detail);
      const plannerStatuses = ['In Progress', 'Waiting for Details', 'Completed'];
      const ownStatus = detail.my_assignment?.status || detail.task.status;
      const nextStatus = ownStatus === 'Accepted'
        ? 'In Progress'
        : (user.role === 'planner' && !plannerStatuses.includes(ownStatus) ? 'In Progress' : ownStatus);
      setStatus(nextStatus);
      setPlannerAssignments((detail.planner_assignments || []).map(item => ({
        ...item,
        planner_id: Number(item.planner_id),
        assigned_locations: item.assigned_locations || ''
      })));
      setPlanningLeadId(detail.task.planning_lead_id ? String(detail.task.planning_lead_id) : '');
      if (user.role !== 'planner') {
        const users = await api('/users?role=planner&status=active');
        setPlanners(users.users || []);
      }
      if (['admin', 'manager'].includes(user.role)) {
        const users = await api('/users?role=planning_lead&status=active');
        setPlanningLeads(users.users || []);
      }
    } catch (err) {
      notify(err.message, 'error');
      onClose();
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [taskId]);

  async function runAction(action, body = {}) {
    try {
      if (action === 'accept') await api(`/tasks/${task.id}/accept`, { method: 'POST', body: JSON.stringify(body) });
      if (action === 'decline') await api(`/tasks/${task.id}/decline`, { method: 'POST', body: JSON.stringify(body) });
      if (action === 'status') await api(`/tasks/${task.id}/status`, { method: 'PATCH', body: JSON.stringify(body) });
      if (action === 'reassignLead') await api(`/tasks/${task.id}/reassign-lead`, { method: 'PATCH', body: JSON.stringify(body) });
      notify('Task updated.');
      setRemarks('');
      await load();
      onChanged();
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  async function savePlannerAssignments() {
    if (plannerAssignments.length === 0) {
      notify('Select at least one Planner.', 'error');
      return;
    }
    setSavingAssignments(true);
    try {
      await api(`/tasks/${task.id}/planner-assignments`, {
        method: 'PUT',
        body: JSON.stringify({
          assignments: plannerAssignments.map(item => ({
            planner_id: Number(item.planner_id),
            assigned_locations: item.assigned_locations || ''
          }))
        })
      });
      notify('Planner allocation updated.');
      await load();
      onChanged();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setSavingAssignments(false);
    }
  }

  async function addNewComment(event) {
    event.preventDefault();
    if (!comment.trim()) return;
    try {
      await api(`/tasks/${task.id}/comments`, { method: 'POST', body: JSON.stringify({ comment }) });
      setComment('');
      await load();
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  function cancelQueuedUpload(itemId) {
    uploadCancelledRef.current.add(itemId);
    const controller = uploadAbortsRef.current[itemId];
    if (controller) {
      controller.abort();
    } else {
      // Still waiting for a free concurrency slot -- nothing to abort yet,
      // just mark it so the worker skips it once its turn comes.
      setUploadQueue(prev => prev.map(item => (item.id === itemId ? { ...item, status: 'cancelled' } : item)));
    }
  }

  async function uploadFile(event) {
    event.preventDefault();
    if (files.length === 0) return;
    const form = event.currentTarget;
    setUploadingFiles(true);
    uploadCancelledRef.current = new Set();
    uploadAbortsRef.current = {};
    try {
      const preparedFiles = await Promise.all(files.map(compressImageFile));
      const queueItems = preparedFiles.map((file, index) => ({
        id: `${Date.now()}-${index}`,
        file,
        name: file.name,
        status: 'pending',
        progress: 0
      }));
      setUploadQueue(queueItems);

      const results = [];
      let nextIndex = 0;
      async function worker() {
        while (nextIndex < queueItems.length) {
          const item = queueItems[nextIndex];
          nextIndex += 1;
          if (uploadCancelledRef.current.has(item.id)) {
            results.push({ id: item.id, status: 'cancelled' });
            continue;
          }
          const controller = new AbortController();
          uploadAbortsRef.current[item.id] = controller;
          setUploadQueue(prev => prev.map(q => (q.id === item.id ? { ...q, status: 'uploading' } : q)));
          try {
            const formData = new FormData();
            formData.append('files', item.file);
            formData.append('silent', 'true');
            await uploadWithProgress(`/tasks/${task.id}/files`, formData, {
              signal: controller.signal,
              onProgress: pct => {
                // Cap at 99 while still uploading: 100 is reserved for the
                // real "done" state (server confirmed), since bytes fully
                // sent to the server doesn't mean it's finished storing yet.
                setUploadQueue(prev => prev.map(q => (q.id === item.id ? { ...q, progress: Math.min(pct, 99) } : q)));
              }
            });
            setUploadQueue(prev => prev.map(q => (q.id === item.id ? { ...q, status: 'done', progress: 100 } : q)));
            results.push({ id: item.id, status: 'done' });
          } catch (err) {
            const cancelled = uploadCancelledRef.current.has(item.id) || err.message === 'Upload cancelled';
            setUploadQueue(prev => prev.map(q => (q.id === item.id ? { ...q, status: cancelled ? 'cancelled' : 'error' } : q)));
            results.push({ id: item.id, status: cancelled ? 'cancelled' : 'error', error: err.message });
          } finally {
            delete uploadAbortsRef.current[item.id];
          }
        }
      }
      const workerCount = Math.min(UPLOAD_CONCURRENCY, queueItems.length);
      await Promise.all(Array.from({ length: workerCount }, worker));

      const succeeded = results.filter(r => r.status === 'done').length;
      const cancelled = results.filter(r => r.status === 'cancelled').length;
      const failed = results.filter(r => r.status === 'error').length;

      if (succeeded > 0) {
        await api(`/tasks/${task.id}/files/notify-batch`, { method: 'POST', body: JSON.stringify({ count: succeeded }) });
      }

      const parts = [];
      if (succeeded > 0) parts.push(`${succeeded} uploaded`);
      if (failed > 0) parts.push(`${failed} failed`);
      if (cancelled > 0) parts.push(`${cancelled} cancelled`);
      notify(parts.join(', ') || 'No files uploaded.', failed > 0 ? 'error' : 'success');

      setFiles([]);
      setUploadQueue([]);
      form.reset();
      if (succeeded > 0) await load();
    } finally {
      setUploadingFiles(false);
    }
  }

  async function downloadFile(item) {
    if (!item?.download_url) {
      notify('Download link is unavailable. Please refresh the task and try again.', 'error');
      return;
    }
    setDownloadingFileId(item.id);
    try {
      await saveAttachmentToDevice(item);
    } catch (err) {
      notify(err.message || 'Unable to download this attachment.', 'error');
    } finally {
      setDownloadingFileId(null);
    }
  }

  async function deleteFile(item) {
    const confirmed = window.confirm(`Delete ${item.file_name}? This will permanently remove the attachment from this task.`);
    if (!confirmed) return;
    setDeletingFileId(item.id);
    try {
      await api(`/tasks/${task.id}/files/${item.id}`, { method: 'DELETE' });
      notify('File deleted.');
      await load();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setDeletingFileId(null);
    }
  }

  function declineTask() {
    const reason = window.prompt('Enter decline reason');
    if (reason?.trim()) runAction('decline', { reason: reason.trim() });
  }

  if (!taskId) return null;

  return (
    <div className="modal-backdrop">
      <section className="task-modal">
        <button className="modal-close" onClick={onClose}>×</button>
        {loading ? <div className="loading-card">Loading task...</div> : task && (
          <>
            <div className="task-modal-header">
              <div>
                <p className="eyebrow">{task.task_code}</p>
                <h2>{task.title}</h2>
                <div className="task-tags"><Pill>{task.status}</Pill>{isOverdue(task) && <Pill type="priority">Overdue</Pill>}</div>
              </div>
              <div className="due-card"><span>Submission Deadline</span><strong>{formatDate(task.submission_deadline || task.due_date)}</strong></div>
            </div>

            <div className="detail-grid">
              <DetailField label="Brand Name" value={task.brand_name} />
              <DetailField label="Client Type" value={task.direct_client_or_agency || task.client_name} />
              <DetailField label="Agency Name" value={task.agency_name} />
              <DetailField label="Plan Required" value={task.plan_format} />
              <DetailField label="Planning Lead" value={task.planning_lead_name || (task.assigned_to_role === 'planning_lead' ? task.assigned_to_name : '')} />
              <DetailField label="Assigned Planners" value={task.assigned_planner_names || task.assigned_to_name} />
              <DetailField label="Created By" value={`${task.assigned_by_name} (${roleLabel(task.assigned_by_role)})`} />
              <DetailField label="Submission Deadline" value={formatDate(task.submission_deadline || task.due_date)} />
            </div>

            <div className="task-section planner-progress-section">
              <div className="planner-progress-heading">
                <div>
                  <h3><Users size={18} /> Planner Allocation & Progress</h3>
                  <p>{(data.planner_assignments || []).length > 0
                    ? `${task.planner_completed_count || 0} of ${task.planner_count || data.planner_assignments.length} planner portions completed`
                    : 'No Planner has been assigned yet.'}</p>
                </div>
                {(data.planner_assignments || []).length > 0 && <Pill>{task.status}</Pill>}
              </div>
              <div className="planner-progress-grid">
                {(data.planner_assignments || []).map(item => (
                  <article key={item.id} className={className('planner-progress-card', Number(item.planner_id) === Number(user.id) && 'my-planner-card')}>
                    <div>
                      <strong>{item.planner_name}</strong>
                      <Pill>{item.status}</Pill>
                    </div>
                    <p>{item.assigned_locations || 'All locations / common task scope'}</p>
                    <small>{item.status === 'Completed' && item.completed_at ? `Completed ${formatDate(item.completed_at)}` : (item.status === 'Pending Acceptance' ? 'Waiting for acceptance' : 'Work in progress')}</small>
                  </article>
                ))}
              </div>
            </div>

            <div className="task-section">
              <h3>Planning Brief Fields</h3>
              <div className="field-review-grid">
                <DetailField label="Campaign Start Date" value={formatDate(task.campaign_start_date || task.start_date)} />
                <DetailField label="Campaign Duration" value={task.campaign_duration} />
                <DetailField label="Campaign Budget" value={task.campaign_budget} />
                <DetailField label="Display Cost Range" value={task.display_cost_range} />
                <DetailField label="Target Areas / Location" value={task.target_areas} />
                <DetailField label="Target Audience Profile" value={task.target_audience_profile} />
                <DetailField label="Site Preferences" value={task.site_preferences} />
                <DetailField label="Ownership Type" value={task.ownership_type} />
                <DetailField label="Location Type" value={task.location_type} />
                <DetailField label="Size Preference" value={task.size_preference} />
                <DetailField label="Additional Specifications" value={task.additional_specifications || task.description} />
              </div>
            </div>

            {(data.declines || []).length > 0 && (
              <div className="task-section decline-reason-section">
                <h3><XCircle size={18} /> Decline Reason</h3>
                {(data.declines || []).map(item => (
                  <div className="decline-note" key={item.id}>
                    <strong>{item.name}</strong>
                    <p>{item.reason}</p>
                    <small>{formatDate(item.created_at)}</small>
                  </div>
                ))}
              </div>
            )}

            <div className="action-panel">
              <div>
                <h3>Actions</h3>
                <p>All Planning Leads can assign multiple Planners and divide locations between them. Each Planner updates only their own portion.</p>
              </div>
              {user.role === 'planner' && data.my_assignment?.status === 'Pending Acceptance' && (
                <div className="action-row">
                  <button className="primary-button" onClick={() => runAction('accept', { remarks: 'Accepted. I will start working on this task.' })}><CheckCircle2 size={16} /> Accept</button>
                  <button className="danger-button" onClick={declineTask}><XCircle size={16} /> Decline</button>
                </div>
              )}
              {user.role === 'planner' && data.my_assignment && !['Pending Acceptance', 'Completed', 'Declined'].includes(data.my_assignment.status) && (
                <div className="action-row status-action">
                  <select value={status} onChange={e => setStatus(e.target.value)}>
                    {['In Progress', 'Waiting for Details', 'Completed'].map(item => <option key={item}>{item}</option>)}
                  </select>
                  <input value={remarks} onChange={e => setRemarks(e.target.value)} placeholder="Remarks / update note" />
                  <button className="primary-button" onClick={() => runAction('status', { status, remarks })}>Update</button>
                </div>
              )}
              {user.role !== 'planner' && (
                <div className="manager-actions">
                  <div className="action-row status-action">
                    <select value={status} onChange={e => setStatus(e.target.value)}>
                      {statuses.filter(item => item !== 'Declined').map(item => <option key={item}>{item}</option>)}
                    </select>
                    <input value={remarks} onChange={e => setRemarks(e.target.value)} placeholder="Review note / remarks" />
                    <button className="primary-button" onClick={() => runAction('status', { status, remarks })}>Update Status</button>
                  </div>

                  {task.status !== 'Completed' && ['admin', 'manager'].includes(user.role) && (
                    <div className="action-row status-action">
                      <select value={planningLeadId} onChange={e => setPlanningLeadId(e.target.value)}>
                        <option value="">Select Planning Lead</option>
                        {planningLeads.map(lead => <option key={lead.id} value={lead.id}>{lead.name}{lead.verticals ? ` • ${lead.verticals}` : ''}</option>)}
                      </select>
                      <button
                        className="ghost-button"
                        disabled={!planningLeadId || Number(planningLeadId) === Number(task.planning_lead_id) || reassigning === 'lead'}
                        onClick={async () => {
                          setReassigning('lead');
                          await runAction('reassignLead', { planning_lead_id: planningLeadId });
                          setReassigning('');
                        }}
                      >
                        {reassigning === 'lead' ? 'Reassigning...' : 'Reassign Planning Lead'}
                      </button>
                    </div>
                  )}

                  {task.status !== 'Completed' && ['admin', 'manager', 'planning_lead'].includes(user.role) && (
                    <div className="multi-planner-management">
                      <div className="multi-planner-management-head">
                        <div>
                          <strong>Planner Allocation</strong>
                          <span>Select multiple Planners and specify each person’s locations.</span>
                        </div>
                        <button
                          className="ghost-button"
                          disabled={plannerAssignments.length === 0 || savingAssignments}
                          onClick={savePlannerAssignments}
                        >
                          {savingAssignments ? 'Saving...' : 'Save Planner Allocation'}
                        </button>
                      </div>
                      <PlannerAllocationEditor
                        planners={planners}
                        assignments={plannerAssignments}
                        onChange={setPlannerAssignments}
                        disabled={savingAssignments}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="modal-columns">
              <div className="task-section">
                <h3><MessageCircle size={18} /> Comments</h3>
                <form className="comment-form" onSubmit={addNewComment}>
                  <input value={comment} onChange={e => setComment(e.target.value)} placeholder="Add a comment or clarification..." />
                  <button className="primary-button">Send</button>
                </form>
                <div className="comment-list">
                  {(data.comments || []).map(item => (
                    <div className="comment-item" key={item.id}>
                      <strong>{item.name}<span>{roleLabel(item.role)}</span></strong>
                      <p>{item.comment}</p>
                      <small>{formatDate(item.created_at)}</small>
                    </div>
                  ))}
                </div>
              </div>

              <div className="task-section">
                <h3><Upload size={18} /> Files</h3>
                <form className="upload-form" onSubmit={uploadFile}>
                  <input type="file" multiple onChange={e => setFiles(Array.from(e.target.files || []))} />
                  <button className="ghost-button" disabled={files.length === 0 || uploadingFiles}>
                    {uploadingFiles ? 'Uploading...' : (files.length > 1 ? `Upload ${files.length} Files` : 'Upload')}
                  </button>
                </form>
                {uploadQueue.length > 0 && (
                  <div className="upload-queue">
                    {uploadQueue.map(item => (
                      <div className={className('upload-queue-item', `upload-queue-${item.status}`)} key={item.id}>
                        <span className="upload-queue-name">{item.name}</span>
                        <div className="upload-queue-progress-track">
                          <div className="upload-queue-progress-fill" style={{ width: `${item.status === 'pending' ? 0 : item.progress}%` }} />
                        </div>
                        <span className="upload-queue-status">
                          {item.status === 'pending' && 'Pending'}
                          {item.status === 'uploading' && `${item.progress}%`}
                          {item.status === 'done' && 'Done'}
                          {item.status === 'error' && 'Failed'}
                          {item.status === 'cancelled' && 'Cancelled'}
                        </span>
                        {(item.status === 'pending' || item.status === 'uploading') && (
                          <button
                            type="button"
                            className="upload-queue-cancel"
                            onClick={() => cancelQueuedUpload(item.id)}
                            title={`Cancel ${item.name}`}
                          >
                            <XCircle size={15} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <div className="file-list">
                  {(data.files || []).map(item => (
                    <div className={className('file-item', !item.available && 'file-unavailable')} key={item.id}>
                      <div className="file-link file-info">
                        <FileText size={16} />
                        <span>
                          {item.file_name}
                          <small>Uploaded by {item.name}</small>
                          {!item.available && <small className="file-unavailable-text">File unavailable — please re-upload</small>}
                        </span>
                      </div>
                      <div className="file-actions">
                        <button
                          type="button"
                          className="file-action-button"
                          onClick={() => setPreviewFile(item)}
                          disabled={!item.available}
                          title={`Preview ${item.file_name}`}
                        >
                          <Eye size={16} /> Preview
                        </button>
                        {item.available && item.download_url && (
                          <button
                            type="button"
                            className="file-action-button"
                            onClick={() => downloadFile(item)}
                            disabled={downloadingFileId === item.id}
                            title={`Download ${item.file_name}`}
                          >
                            <Download size={16} /> {downloadingFileId === item.id ? 'Downloading...' : 'Download'}
                          </button>
                        )}
                        <button
                          type="button"
                          className="file-delete-button"
                          onClick={() => deleteFile(item)}
                          disabled={deletingFileId === item.id}
                          title={`Delete ${item.file_name}`}
                          aria-label={`Delete ${item.file_name}`}
                        >
                          <Trash2 size={17} />
                        </button>
                      </div>
                    </div>
                  ))}
                  {(data.files || []).length === 0 && <p className="muted">No files uploaded yet.</p>}
                </div>
              </div>
            </div>

            <div className="task-section">
              <h3>Status History</h3>
              <div className="history-list">
                {(data.history || []).map(item => (
                  <div className="history-item" key={item.id}>
                    <span />
                    <div><strong>{item.action}</strong><p>{item.old_status || '-'} → {item.new_status || '-'} {item.remarks && `• ${item.remarks}`}</p><small>{item.name} • {formatDate(item.created_at)}</small></div>
                  </div>
                ))}
              </div>
            </div>
            {previewFile && (
              <AttachmentPreview
                file={previewFile}
                onClose={() => setPreviewFile(null)}
                onDownload={downloadFile}
                downloading={downloadingFileId === previewFile.id}
              />
            )}
          </>
        )}
      </section>
    </div>
  );
}

function Reports({ notify }) {
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setOverview(await api('/reports/overview'));
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function downloadReport() {
    setExporting(true);
    try {
      const blob = await api('/reports/export');
      if (!(blob instanceof Blob)) throw new Error('The Excel report could not be generated.');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ADINN_Task_Manager_Report_${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify('XLSX report downloaded successfully.');
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setExporting(false);
    }
  }

  if (loading) return <div className="loading-card">Loading reports...</div>;

  return (
    <section className="dashboard-grid">
      <div className="stats-grid">
        <StatCard icon={ClipboardList} label="Total" value={overview?.total} accent="red" />
        <StatCard icon={Clock3} label="Due Today" value={overview?.dueToday} accent="amber" />
        <StatCard icon={CalendarClock} label="Overdue" value={overview?.overdue} accent="red" />
        <StatCard icon={CheckCircle2} label="Completed" value={overview?.completed} accent="green" />
      </div>
      <div className="panel">
        <div className="panel-title"><h3>Status Split</h3></div>
        <div className="report-list">
          {(overview?.statusCounts || []).map(row => <div key={row.status}><span>{row.status}</span><strong>{row.count}</strong></div>)}
        </div>
      </div>
      <div className="panel">
        <div className="panel-title"><h3>Priority Split</h3></div>
        <div className="report-list">
          {(overview?.priorityCounts || []).map(row => <div key={row.priority}><span>{row.priority}</span><strong>{row.count}</strong></div>)}
        </div>
      </div>
      <div className="panel wide conversion-report-panel">
        <div className="panel-title">
          <div>
            <p className="eyebrow">Completed plan outcome</p>
            <h3>Plan Conversion</h3>
          </div>
          <span className="conversion-rate">{overview?.conversion?.conversionRate ?? 0}% conversion rate</span>
        </div>
        <div className="conversion-report-grid">
          <div><span>Won – Plan Converted</span><strong>{overview?.conversion?.won ?? 0}</strong></div>
          <div><span>Loss – Plan Not Converted</span><strong>{overview?.conversion?.loss ?? 0}</strong></div>
          <div><span>Pending Decision</span><strong>{overview?.conversion?.pending ?? 0}</strong></div>
          <div><span>Total Completed</span><strong>{overview?.completed ?? 0}</strong></div>
        </div>
      </div>
      <div className="panel wide export-panel">
        <div>
          <p className="eyebrow">Export</p>
          <h2>Download ADINN Task Manager Report</h2>
          <p>The XLSX follows the revised report format with planner-wise assignment, completion time, duration and conversion status.</p>
        </div>
        <button className="primary-button" onClick={downloadReport} disabled={exporting}>
          <Download size={18} /> {exporting ? 'Preparing XLSX…' : 'Download XLSX'}
        </button>
      </div>
    </section>
  );
}

function UsersPage({ notify }) {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'planner', department: 'Planning', phone: '', verticals: [] });
  const [loading, setLoading] = useState(true);
  const [editingPlanningUserId, setEditingPlanningUserId] = useState(null);
  const [editingPlanningOptions, setEditingPlanningOptions] = useState([]);

  async function load() {
    setLoading(true);
    try {
      const data = await api('/users?status=all');
      setUsers(data.users || []);
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  function update(key, value) {
    setForm(previous => ({ ...previous, [key]: value }));
  }

  function toggleVertical(vertical) {
    setForm(previous => {
      const selected = new Set(previous.verticals || []);
      if (selected.has(vertical)) selected.delete(vertical);
      else selected.add(vertical);
      return { ...previous, verticals: Array.from(selected) };
    });
  }

  async function createUser(event) {
    event.preventDefault();
    try {
      await api('/users', { method: 'POST', body: JSON.stringify({ ...form, verticals: (form.verticals || []).join(',') }) });
      notify('User created.');
      setForm({ name: '', email: '', password: '', role: 'planner', department: 'Planning', phone: '', verticals: [] });
      load();
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  async function toggleStatus(user) {
    try {
      await api(`/users/${user.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: user.status === 'active' ? 'inactive' : 'active' })
      });
      notify('User updated.');
      load();
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  function startPlanningEdit(user) {
    const selected = String(user.verticals || '')
      .split(',')
      .map(item => item.trim())
      .filter(item => planningVerticals.includes(item));
    setEditingPlanningUserId(user.id);
    setEditingPlanningOptions(selected);
  }

  function toggleEditingPlanningOption(option) {
    setEditingPlanningOptions(previous => {
      const selected = new Set(previous || []);
      if (selected.has(option)) selected.delete(option);
      else selected.add(option);
      return Array.from(selected);
    });
  }

  async function savePlanningOptions(user) {
    try {
      await api(`/users/${user.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ verticals: editingPlanningOptions.join(',') })
      });
      notify('Planner planning options updated.');
      setEditingPlanningUserId(null);
      setEditingPlanningOptions([]);
      load();
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  async function deleteUser(user) {
    if (user.role === 'admin') {
      notify('Admin accounts cannot be deleted.', 'error');
      return;
    }
    const confirmed = window.confirm(`Delete ${user.name}? This will permanently remove the user and linked task records for that user.`);
    if (!confirmed) return;
    try {
      await api(`/users/${user.id}`, { method: 'DELETE' });
      notify('User deleted successfully.');
      load();
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  function isProtectedAdmin(user) {
    return user.role === 'admin';
  }

  return (
    <section className="dashboard-grid">
      <form className="panel create-user-card" onSubmit={createUser}>
        <div className="panel-title"><h2>Create User</h2></div>
        <label>Name<input required value={form.name} onChange={e => update('name', e.target.value)} /></label>
        <label>Email<input required type="email" value={form.email} onChange={e => update('email', e.target.value)} /></label>
        <label>Password<input required value={form.password} onChange={e => update('password', e.target.value)} /></label>
        <label>Role<select value={form.role} onChange={e => update('role', e.target.value)}><option value="planner">Planner</option><option value="planning_lead">Planning Lead</option><option value="manager">BD</option><option value="admin">Admin</option></select></label>
        <label>Department<input value={form.department} onChange={e => update('department', e.target.value)} /></label>
        <label>Phone<input value={form.phone} onChange={e => update('phone', e.target.value)} /></label>
        <div className="vertical-picker">
          <span>Planner / Lead Planning Option Mapping</span>
          <div>
            {planningVerticals.map(vertical => (
              <button type="button" key={vertical} className={(form.verticals || []).includes(vertical) ? 'selected' : ''} onClick={() => toggleVertical(vertical)}>{vertical}</button>
            ))}
          </div>
        </div>
        <button className="primary-button"><UserCog size={17} /> Create User</button>
      </form>

      <div className="panel wide full-panel">
        <div className="panel-title">
          <div>
            <h2>Users & Planning Team Roles</h2>
            <p className="panel-subtitle">Reference from Design Task Manager: create BDs, Planning Leads and Planners. BDs assign requests to Planning Leads; Planning Leads allocate tasks to planners.</p>
          </div>
          <button className="ghost-button" onClick={load}><RefreshCw size={16} /> Refresh</button>
        </div>
        {loading ? <div className="loading-card">Loading users...</div> : (
          <div className="task-table-wrap">
            <table className="task-table">
              <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Department</th><th>Planning Options</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {users.map(user => (
                  <tr key={user.id}>
                    <td><strong>{user.email === 'manager@adinn.co.in' ? 'Business Developer' : user.name}</strong></td>
                    <td>{user.email === 'manager@adinn.co.in' ? 'bd@adinn.co.in' : user.email}</td>
                    <td><Pill>{user.role_label || roleLabel(user.role)}</Pill></td>
                    <td>{user.department}</td>
                    <td>
                      {['planner', 'planning_lead'].includes(user.role) ? (
                        editingPlanningUserId === user.id ? (
                          <div className="planning-option-editor">
                            <div>
                              {planningVerticals.map(option => (
                                <button
                                  type="button"
                                  key={option}
                                  className={editingPlanningOptions.includes(option) ? 'selected' : ''}
                                  onClick={() => toggleEditingPlanningOption(option)}
                                >
                                  {option}
                                </button>
                              ))}
                            </div>
                            <div className="planning-editor-actions">
                              <button type="button" className="inline-link" onClick={() => savePlanningOptions(user)}>Save</button>
                              <button type="button" className="inline-link muted-link" onClick={() => setEditingPlanningUserId(null)}>Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <><span>{user.verticals || '-'}</span><button type="button" className="inline-link" onClick={() => startPlanningEdit(user)}>Edit</button></>
                        )
                      ) : '-'}
                    </td>
                    <td><Pill type="priority">{user.status}</Pill></td>
                    <td>
                      <div className="user-actions">
                        {isProtectedAdmin(user) ? (
                          <span className="system-user-note">Protected admin</span>
                        ) : (
                          <>
                            <button type="button" className="table-action" onClick={() => toggleStatus(user)}>{user.status === 'active' ? 'Deactivate' : 'Activate'}</button>
                            <button type="button" className="danger-button compact-danger" onClick={() => deleteUser(user)}>Delete</button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

export default function App() {
  const [user, setUser] = useState(getSavedUser());
  const [activeView, setActiveView] = useState('dashboard');
  const [toast, setToast] = useState({ message: '', kind: 'success' });
  const [selectedTask, setSelectedTask] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  function notify(message, kind = 'success') {
    setToast({ message, kind });
    window.clearTimeout(window.__adinnToastTimer);
    window.__adinnToastTimer = window.setTimeout(() => setToast({ message: '', kind: 'success' }), 3500);
  }

  useEffect(() => {
    const handleAuthExpired = (event) => {
      clearSession();
      setUser(null);
      setSelectedTask(null);
      setActiveView('dashboard');
      notify(event.detail?.message || 'Session expired. Please sign in again.', 'error');
    };
    window.addEventListener('adinn-auth-expired', handleAuthExpired);
    return () => window.removeEventListener('adinn-auth-expired', handleAuthExpired);
  }, []);

  function logout() {
    clearSession();
    setUser(null);
    setActiveView('dashboard');
  }

  function changed() {
    setRefreshKey(key => key + 1);
  }

  if (!user) return <LoginScreen onLogin={setUser} />;

  return (
    <>
      <Shell user={user} activeView={activeView} setActiveView={setActiveView} onLogout={logout} onOpenTask={setSelectedTask} refreshKey={refreshKey} notify={notify}>
        {activeView === 'dashboard' && <Dashboard user={user} setActiveView={setActiveView} onOpenTask={setSelectedTask} notify={notify} refreshKey={refreshKey} />}
        {activeView === 'tasks' && <TasksPage user={user} onOpenTask={setSelectedTask} notify={notify} refreshKey={refreshKey} plannerScope="mine" />}
        {activeView === 'other_tasks' && <TasksPage user={user} onOpenTask={setSelectedTask} notify={notify} refreshKey={refreshKey} plannerScope="others" />}
        {activeView === 'completed' && <TasksPage user={user} onOpenTask={setSelectedTask} notify={notify} refreshKey={refreshKey} completedOnly plannerScope="mine" />}
        {activeView === 'create' && <CreateTask user={user} notify={notify} setActiveView={setActiveView} onCreated={changed} />}
        {activeView === 'reports' && <Reports notify={notify} />}
        {activeView === 'notifications' && <NotificationsPage onOpenTask={setSelectedTask} notify={notify} refreshKey={refreshKey} />}
        {activeView === 'users' && <UsersPage notify={notify} />}
      </Shell>
      {selectedTask && <TaskDetail taskId={selectedTask} user={user} onClose={() => setSelectedTask(null)} notify={notify} onChanged={changed} />}
      <Toast message={toast.message} kind={toast.kind} onClose={() => setToast({ message: '', kind: 'success' })} />
    </>
  );
}
