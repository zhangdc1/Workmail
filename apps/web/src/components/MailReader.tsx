import { useState } from "react";
import { ArrowDownToLine, File, Paperclip, ShieldCheck } from "lucide-react";
import type { Message } from "../../../../packages/shared/src";
import { bytes, date } from "../lib/api";
import { Badge } from "./ui";
import { CopyButton } from "./CopyButton";
import { MailLinks } from "./MailLinks";
export function MailReader({ message, publicToken }: { message: Message; publicToken?: string }) {
  const [mode, setMode] = useState<"html" | "text">("html");
  const attachmentBase = publicToken ? `/api/v1/public/shares/${publicToken}/attachments/` : "/api/v1/attachments/";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; form-action 'none'; base-uri 'none'"><style>body{font-family:Arial,'Microsoft YaHei',sans-serif;font-size:14px;line-height:1.85;color:#334155;margin:0;padding:24px;overflow-wrap:anywhere}a{color:#2563eb}table{max-width:100%;border-collapse:collapse}td,th{padding:6px}pre{white-space:pre-wrap}</style></head><body>${message.html || ""}</body></html>`;
  return <div className="mail-reader"><div className="reader-heading"><div className="reader-label">邮件详情 <span className="muted">/ MESSAGE</span></div><div className="reader-tags"><Badge tone="green"><ShieldCheck size={11} />隔离阅读</Badge></div></div><h2>{message.subject || "邮件正在解析"}</h2><div className="reader-sender"><div className="sender-avatar sender-0">{(message.fromName || message.fromAddress || "?")[0].toUpperCase()}</div><div><strong>{message.fromName || message.fromAddress || "未知发件人"}</strong><small>{message.fromAddress}</small></div><time>{date(message.receivedAt)}</time></div><div className="mail-meta"><span>收件于 {date(message.receivedAt)}</span><span>{bytes(message.size)}</span><span>发件人身份未由界面验证</span></div>
    {message.parseState === "failed" && <div className="form-error">邮件解析失败，原文仍保留。可下载原文检查。</div>}
    {message.address && <div className="recipient-copy"><span>收件邮箱：{message.address}</span><CopyButton value={message.address} label="复制收件邮箱地址" /></div>}
    {message.otp && <div className="otp-card"><div><span>邮件中识别的验证码</span><strong>{message.otp}</strong></div><CopyButton value={message.otp} label="复制验证码" text="复制验证码" /></div>}
    <MailLinks text={message.text} html={message.html} links={message.links} />
    <div className="reader-tabs"><button className={mode === "html" ? "active" : ""} onClick={() => setMode("html")}>邮件正文</button><button className={mode === "text" ? "active" : ""} onClick={() => setMode("text")}>纯文本</button><span>远程图片已禁用</span></div>
    {mode === "html" && message.html ? <iframe title="隔离邮件正文" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={html} className="mail-frame" /> : <pre className="mail-text">{message.text || (message.parseState === "pending" ? "邮件已持久化，正在解析…" : "邮件没有文本内容。")}</pre>}
    {!!message.attachments?.length && <div className="attachments"><h4><Paperclip size={14} />附件 · {message.attachments.length}</h4>{message.attachments.map(a => <a href={attachmentBase + a.id} key={a.id} className="attachment"><div className="file-icon"><File size={18} /></div><div><strong>{a.name}</strong><small>{bytes(a.size)} · 下载文件</small></div><ArrowDownToLine size={16} /></a>)}</div>}
    {!publicToken && <div className="raw-download"><a href={`/api/v1/messages/${message.id}/raw`}><ArrowDownToLine size={13} />下载邮件原文 (.eml)</a></div>}
  </div>;
}
