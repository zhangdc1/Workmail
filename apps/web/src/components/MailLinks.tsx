import { useMemo } from "react";
import { ExternalLink } from "lucide-react";
import { collectMailLinks } from "../lib/mail-links";
import { CopyButton } from "./CopyButton";

export function MailLinks({ text, html, links }: { text?: string; html?: string; links?: string[] }) {
  const items = useMemo(() => collectMailLinks(text, html, links), [text, html, links]);
  if (!items.length) return null;
  return <section className="mail-links" aria-label="邮件中的链接">
    <div className="mail-links-heading"><span>邮件中的链接 · {items.length}</span>
      <CopyButton value={items.join("\n")} label="复制全部邮件链接" text="复制全部" /></div>
    <p className="muted small">包含登录、验证和正文链接；复制不会打开或访问链接。</p>
    <div className="mail-link-list">{items.map((link, i) => <div className="mail-link-row" key={link}>
      <a href={link} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" title={link}>{link}<ExternalLink size={13} /></a>
      <CopyButton value={link} label={`复制邮件链接 ${i + 1}`} text="复制链接" />
    </div>)}</div>
  </section>;
}
