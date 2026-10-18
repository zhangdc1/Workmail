import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { ArrowUpRight, CheckCircle2, Circle, Copy, Globe2, HelpCircle, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import type { Domain } from "../../../../packages/shared/src";
import { api, post, patch, act, copy, date } from "../lib/api";
import { Badge, Button, Empty, Failure, Field, Loading, Modal, PageHeader, Select, SubmitButton, Textarea } from "../components/ui";
import { useUser } from "../App";
export function DomainsPage() {
  const user = useUser(), [params] = useSearchParams();
  const [open, setOpen] = useState(params.has("create")), [text, setText] = useState(""), [busy, setBusy] = useState(false);
  const [dnsDomain, setDnsDomain] = useState<Domain | null>(null);
  const query = useQuery({ queryKey: ["domains"], queryFn: () => api<{ items: Domain[]; mxHost: string }>("/domains") });
  const create = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true);
    try {
      const result = await act(() => post("/domains", { names: text.split(/[\s,;，；]+/).filter(Boolean) })) as any;
      const failures = result.items.filter((x: any) => x.state === "failed");
      if (failures.length) setText(failures.map((x: any) => x.input).join("\n"));
      else { setText(""); setOpen(false); }
    } catch {} finally { setBusy(false); }
  };
  return <div><PageHeader eyebrow="DOMAINS & CONNECTIONS" title="你的域名，你的身份。" description="将多个域名连接到同一个工作空间，集中创建和管理专属邮箱。">{user.role === "admin" && <Button onClick={() => setOpen(true)}><Plus size={17} />添加域名</Button>}</PageHeader>
    <div className="info-banner"><ShieldCheck size={20} /><div><strong>只需一条 MX，开启独立收件。</strong><p>邮件主机使用普通 DNS 解析，不启用 HTTP 代理。DNS 检查通过后，仍需从外部发送邮件验证投递。</p></div><Button variant="secondary" size="sm" onClick={() => setDnsDomain(query.data?.items[0] || null)}>接入指南 <ArrowUpRight size={13} /></Button></div>
    {query.isPending ? <Loading /> : query.isError ? <Failure error={query.error} /> : query.data.items.length ? <div className="domain-grid">{query.data.items.map(d => <section className="panel domain-card" key={d.id}><div className="domain-card-top"><div className="domain-large-icon"><Globe2 size={25} /></div><Badge tone={d.state === "disabled" ? "neutral" : d.state === "retired" ? "amber" : d.dns.mxReady ? "green" : "blue"}>{d.state === "disabled" ? "已停用" : d.state === "retired" ? "仅保留收件" : d.dns.mxReady ? "DNS 已就绪" : "等待 DNS 配置"}</Badge></div><h2>{d.name}</h2><p className="muted">添加于 {date(d.createdAt)}</p><div className="domain-metrics"><div><strong>{d.mailboxCount}</strong><span>邮箱地址</span></div><div><strong>{d.dns.mxReady ? <CheckCircle2 size={22} className="text-green" /> : "—"}</strong><span>MX 解析</span></div></div><div className="domain-checks"><div><span className={d.dns.mxReady ? "text-green" : "muted"}>{d.dns.mxReady ? <CheckCircle2 size={15} /> : <Circle size={15} />}</span> MX 指向目标主机 <small>{d.dns.mxReady ? "已确认" : "待确认"}</small></div><div><HelpCircle size={15} className="muted" />真实外部投递 <small>需邮件验证</small></div></div>{d.dns.error && <p className="form-error">{d.dns.error}</p>}<div className="domain-card-actions"><Button variant="secondary" size="sm" onClick={() => setDnsDomain(d)}>DNS 设置</Button>{user.role === "admin" && <><Button variant="ghost" size="sm" onClick={() => void act(() => post(`/domains/${d.id}/check`), "DNS 检查已完成").catch(() => {})}><RefreshCw size={14} />检查</Button><Select aria-label={`${d.name} 状态`} value={d.state} onChange={e => void act(() => patch(`/domains/${d.id}`, { state: e.target.value })).catch(() => {})}><option value="active">启用</option><option value="retired">退役</option><option value="disabled">停用</option></Select></>}</div></section>)}</div> : <Empty title="连接你的第一个域名" description="接入自有域名后，即可批量创建独立邮箱。" action={<Button onClick={() => setOpen(true)}><Plus size={16} />添加域名</Button>} />}
    <Modal open={open} onOpenChange={setOpen} title="添加收件域名" description="每行一个域名，一次最多 200 个。添加不会自动修改 DNS。"><form onSubmit={create}><Field label="域名列表" hint="例如：yourbrand.com，直接填写域名，不包含 https://"><Textarea rows={6} value={text} onChange={e => setText(e.target.value)} placeholder={"yourbrand.com\nanother-domain.com"} required /></Field><div className="dialog-actions"><Button type="button" variant="secondary" onClick={() => setOpen(false)}>取消</Button><SubmitButton busy={busy}>添加域名</SubmitButton></div></form></Modal>
    <Modal open={!!dnsDomain} onOpenChange={v => !v && setDnsDomain(null)} title="DNS 接入指南" description={dnsDomain?.name || "为你的域名添加以下 DNS 记录"} wide><div className="dns-steps"><div><span>1</span><div><h3>解析收信主机</h3><p>为 {query.data?.mxHost || "mx.example.com"} 添加 A 记录，指向 VPS 公网 IPv4；不启用代理。仅在 IPv6 入站和路由均可用时添加 AAAA。</p></div></div><div><span>2</span><div><h3>添加域名 MX</h3><div className="dns-record"><code>MX　@　10　{query.data?.mxHost || "mx.example.com"}.</code><Button variant="ghost" size="icon" onClick={() => copy(`10 ${query.data?.mxHost || "mx.example.com"}.`)} aria-label="复制 MX"><Copy size={15} /></Button></div><p>邮箱域名无需添加网站 A 记录。不要同时保留其他邮件提供商的 MX。</p></div></div><div><span>3</span><div><h3>检查并完成真实投递</h3><p>确认 TCP 25 入站及 SMTP TLS 证书正常，点击“检查”，创建邮箱，再从外部邮箱发送测试邮件。DNS 正常不等同于已确认收件。</p></div></div></div><div className="dialog-actions"><Button onClick={() => setDnsDomain(null)}>知道了</Button></div></Modal>
  </div>;
}
