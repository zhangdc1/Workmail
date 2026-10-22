import { useEffect, useState, createContext, useContext, lazy, Suspense, type FormEvent } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowUpRight, Bell, ChevronDown, ChevronRight, CircleHelp, Command, Globe2, Inbox, LayoutDashboard, LogOut, Mail, Menu, Search, Settings2, ShieldCheck, Users, Workflow, X } from "lucide-react";
import type { User } from "../../../packages/shared/src";
import { api, post, queryClient, setCsrf } from "./lib/api";
import { Button, Input, Field, Loading, SubmitButton, Failure } from "./components/ui";
import { toast } from "sonner";
const DashboardPage = lazy(() => import("./pages/Dashboard").then(m => ({ default: m.DashboardPage })));
const InboxPage = lazy(() => import("./pages/Inbox").then(m => ({ default: m.InboxPage })));
const DomainsPage = lazy(() => import("./pages/Domains").then(m => ({ default: m.DomainsPage })));
const MailboxesPage = lazy(() => import("./pages/Mailboxes").then(m => ({ default: m.MailboxesPage })));
const AccountsPage = lazy(() => import("./pages/Accounts").then(m => ({ default: m.AccountsPage })));
const UsersPage = lazy(() => import("./pages/Management").then(m => ({ default: m.UsersPage })));
const SystemPage = lazy(() => import("./pages/Management").then(m => ({ default: m.SystemPage })));
const TasksPage = lazy(() => import("./pages/Management").then(m => ({ default: m.TasksPage })));
const ExtensionsPage = lazy(() => import("./pages/Management").then(m => ({ default: m.ExtensionsPage })));
const SharePage = lazy(() => import("./pages/Management").then(m => ({ default: m.SharePage })));
const ApiGuidePage = lazy(() => import("./pages/ApiGuide").then(m => ({ default: m.ApiGuidePage })));
const SessionContext = createContext<User | null>(null);
export const useUser = () => useContext(SessionContext)!;
const navigation = [
  { to: "/", label: "工作台概览", icon: LayoutDashboard, group: "workspace" },
  { to: "/inbox", label: "统一收件箱", icon: Inbox, group: "workspace" },
  { to: "/mailboxes", label: "邮箱管理", icon: Mail, group: "workspace" },
  { to: "/domains", label: "域名与接入", icon: Globe2, group: "workspace" },
  { to: "/accounts", label: "账号与认证", icon: ShieldCheck, group: "business" },
  { to: "/tasks", label: "任务中心", icon: Workflow, group: "business" },
  { to: "/extensions", label: "浏览器连接器", icon: Command, group: "business" },
  { to: "/api-guide", label: "API 调用文档", icon: CircleHelp, group: "business" },
  { to: "/users", label: "团队与权限", icon: Users, group: "admin" },
  { to: "/settings", label: "系统设置", icon: Settings2, group: "admin" },
];
function Brand({ compact = false }: { compact?: boolean }) { return <div className="brand"><div className="brand-icon"><Mail size={23} strokeWidth={2} /></div><div><strong>Inbox<span>Lab</span></strong>{!compact && <small>PRIVATE MAIL WORKSPACE</small>}</div></div>; }
function Login() {
  const [username, setUsername] = useState(""), [password, setPassword] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const login = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError("");
    try { const result = await post("/auth/login", { username, password }); setCsrf(result.csrf); await queryClient.invalidateQueries({ queryKey: ["session"] }); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return <div className="login-page"><div className="login-art"><Brand /><div className="login-copy"><span className="login-pill"><span className="live-dot" /> 专属你的邮件工作空间</span><h1>每一封邮件，<br />都井井有条。</h1><p>将域名、邮箱与账号事务连接在一起。<br />让复杂的管理，回归简单。</p><div className="login-illustration"><div className="illustration-orbit orbit-one" /><div className="illustration-orbit orbit-two" /><div className="illustration-envelope"><Mail size={80} strokeWidth={1.2} /></div><div className="floating-card floating-one"><ShieldCheck size={19} /><div><strong>私有、安全、可控</strong><span>邮件留在自己的服务器</span></div></div><div className="floating-card floating-two"><Globe2 size={19} /><div><strong>一个工作台 · 多个域名</strong><span>所有收件，尽在掌握</span></div></div></div></div><div className="login-art-footer">Designed for a quieter, more focused workflow.</div></div><div className="login-form-side"><div className="login-mobile-brand"><Brand compact /></div><form className="login-form" onSubmit={login}><div className="eyebrow">WELCOME BACK</div><h2>欢迎回来</h2><p>登录你的 InboxLab 私有工作空间</p><Field label="用户名"><Input autoFocus autoComplete="username" placeholder="输入管理员或成员账号" required value={username} onChange={e => setUsername(e.target.value)} /></Field><Field label="密码"><Input type="password" autoComplete="current-password" placeholder="输入你的密码" required value={password} onChange={e => setPassword(e.target.value)} /></Field>{error && <div className="form-error" role="alert">{error}</div>}<SubmitButton busy={busy}>登录工作空间 <ArrowUpRight size={16} /></SubmitButton><div className="login-security"><ShieldCheck size={14} /> 账号由管理员创建，不开放公开注册</div></form><footer>InboxLab · 你的域名，你的邮箱。</footer></div></div>;
}
function Shell({ user }: { user: User }) {
  const [mobile, setMobile] = useState(false), location = useLocation();
  const [globalSearch, setGlobalSearch] = useState("");
  const title = navigation.find(n => n.to === location.pathname)?.label || "工作空间";
  useEffect(() => { setMobile(false); }, [location.pathname]);
  useEffect(() => {
    const stream = new EventSource("/api/v1/events");
    stream.addEventListener("change", () => { for (const key of ["message", "messages", "mailboxes", "dashboard", "accounts", "tasks"]) void queryClient.invalidateQueries({ queryKey: [key] }); });
    stream.addEventListener("expired", () => { stream.close(); void queryClient.invalidateQueries({ queryKey: ["session"] }); });
    stream.onopen = () => { for (const key of ["message", "messages", "mailboxes", "dashboard", "accounts", "tasks"]) void queryClient.invalidateQueries({ queryKey: [key] }); };
    return () => stream.close();
  }, [user.id]);
  const visible = navigation.filter(n => user.role === "kyc_viewer" ? n.to === "/accounts" : n.group !== "admin" || user.role === "admin");
  return <SessionContext.Provider value={user}><div className="app-shell">
    {mobile && <button className="sidebar-scrim" onClick={() => setMobile(false)} aria-label="关闭导航" />}
    <aside className={"sidebar " + (mobile ? "is-open" : "")}><Brand />
      <div className="workspace-switch"><div className="workspace-avatar">P</div><div><strong>私人工作空间</strong><span>Personal workspace</span></div><ChevronDown size={14} /></div>
      <nav className="main-nav">{["workspace", "business", "admin"].map(group => {
        const entries = visible.filter(n => n.group === group); if (!entries.length) return null;
        return <div className="nav-section" key={group}><div className="nav-caption">{{ workspace: "邮件工作空间", business: "业务管理", admin: "管理与设置" }[group]}</div>
          {entries.map(({ to, label, icon: Icon }) => <NavLink to={to} end={to === "/"} key={to} className={({ isActive }) => "nav-item " + (isActive ? "active" : "")}><Icon size={18} /><span>{label}</span>{to === "/inbox" && <span className="nav-live" />}</NavLink>)}
        </div>;
      })}</nav>
      <div className="sidebar-bottom"><div className="private-note"><div className="private-note-icon"><ShieldCheck size={19} /></div><strong>数据，由你掌控</strong><p>自有域名，独立存储。<br />专注每一封重要来信。</p><a href="/settings">查看系统状态 <ArrowUpRight size={13} /></a></div>
        <div className="sidebar-user"><div className="avatar avatar-blue">{user.username.slice(0, 1).toUpperCase()}</div><div><strong>{user.username}</strong><small>{{ admin: "工作空间管理员", member: "团队成员", kyc_viewer: "认证只读用户" }[user.role]}</small></div><Button variant="ghost" size="icon" aria-label="退出登录" onClick={() => void post("/auth/logout").then(() => { queryClient.clear(); location && window.location.assign("/"); })}><LogOut size={16} /></Button></div>
      </div></aside>
    <div className="app-body"><header className="topbar"><div className="breadcrumb"><Button className="mobile-menu" variant="ghost" size="icon" onClick={() => setMobile(true)} aria-label="打开导航"><Menu size={20} /></Button><span>工作空间</span><ChevronRight size={13} /><strong>{title}</strong></div>
      <div className="topbar-right"><form className="global-search" action="/inbox"><Search size={15} /><input name="q" value={globalSearch} onChange={e => setGlobalSearch(e.target.value)} placeholder="搜索邮件、发件人…" aria-label="全局搜索" /><kbd>↵</kbd></form><span className="topbar-divider" /><Button variant="ghost" size="icon" onClick={() => toast.info("新邮件会自动同步到收件箱")} aria-label="通知"><Bell size={18} /></Button><Button variant="ghost" size="icon" onClick={() => window.open("/api/docs", "_blank", "noopener")} aria-label="API 文档"><CircleHelp size={18} /></Button><div className="avatar avatar-small">{user.username[0].toUpperCase()}</div></div></header>
      <main className="main-content"><Suspense fallback={<Loading />}><Routes>
        <Route path="/" element={user.role === "kyc_viewer" ? <Navigate to="/accounts" replace /> : <DashboardPage />} />
        <Route path="/inbox" element={<InboxPage />} /><Route path="/domains" element={<DomainsPage />} />
        <Route path="/mailboxes" element={<MailboxesPage />} /><Route path="/accounts" element={<AccountsPage />} />
        <Route path="/users" element={<UsersPage />} /><Route path="/settings" element={<SystemPage />} />
        <Route path="/tasks" element={<TasksPage />} /><Route path="/extensions" element={<ExtensionsPage />} />
        <Route path="/api-guide" element={<ApiGuidePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes></Suspense></main><footer className="app-footer"><span>InboxLab <span className="footer-dot">·</span> 私有域名邮箱工作台</span><span><span className="live-dot" /> {window.location.protocol === "https:" ? "HTTPS 连接" : "本地开发连接"} <span className="footer-dot">·</span> v1.0.0</span></footer>
    </div></div></SessionContext.Provider>;
}
export default function App() {
  const location = useLocation();
  const session = useQuery({ queryKey: ["session"], queryFn: () => api<{ authenticated: boolean; user: User; csrf: string }>("/auth/session"), retry: false });
  useEffect(() => { if (session.data?.csrf) setCsrf(session.data.csrf); }, [session.data]);
  if (location.pathname.startsWith("/share/")) return <Suspense fallback={<Loading />}><SharePage token={location.pathname.split("/")[2]} /></Suspense>;
  if (session.isPending) return <div className="initial-loading"><Loading /></div>;
  if (session.isError) return <Failure error={session.error} retry={() => void session.refetch()} />;
  if (!session.data.authenticated) return <Login />;
  return <Shell user={session.data.user} />;
}
