import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { resolve, dirname, sep } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import PostalMime from "postal-mime";
import sanitizeHtml from "sanitize-html";
import type { Context } from "./context.js";
import { enqueue } from "./context.js";
import { normalizeEmail } from "./security.js";
import type { Executor } from "./db/index.js";
import type { User } from "../../../packages/shared/src/index.js";
import { mailboxAccess } from "./context.js";

export function storagePath(root: string, relative: string) {
  const target = resolve(root, relative), base = resolve(root);
  if (!target.startsWith(base + sep)) throw new Error("Invalid storage path");
  return target;
}
export async function durableWrite(root: string, path: string, bytes: Buffer) {
  const full = storagePath(root, path);
  await mkdir(dirname(full), { recursive: true, mode: 0o700 });
  const temporary = `${full}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  await rename(temporary, full);
  // fsync directory metadata on POSIX before acknowledging SMTP.
  if (process.platform !== "win32") {
    const dir = await open(dirname(full), "r"); try { await dir.sync(); } finally { await dir.close(); }
  }
}
export function safeHtml(input: string) {
  return sanitizeHtml(input, {
    allowedTags: ["p", "div", "span", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "i", "em", "u", "s", "blockquote", "pre", "code", "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "a"],
    allowedAttributes: { a: ["href", "title", "target", "rel"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan"] },
    allowedSchemes: ["https", "http", "mailto"],
    transformTags: { a: (_tag, attrs) => ({ tagName: "a", attribs: { ...attrs, target: "_blank", rel: "noopener noreferrer nofollow" } }) },
    disallowedTagsMode: "discard",
  });
}
export function extractVerification(subject: string, text: string, html = "") {
  const combined = `${subject}\n${text}\n${sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })}`;
  const contextual = combined.match(/(?:验证码|验证代码|verification\s*code|security\s*code|one[- ]time\s*(?:password|code)|your\s*code|OTP)[^\d]{0,40}(\d{4,8})/i);
  const otp = contextual?.[1] || subject.match(/(?:^|\D)(\d{6})(?:\D|$)/)?.[1] || null;
  const candidates = [...combined.matchAll(/https:\/\/[^\s<>"']+/g)].map(x => x[0]);
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) candidates.push(m[1].replace(/&amp;/g, "&"));
  const links = [...new Set(candidates.filter(value => {
    try {
      const u = new URL(value);
      return u.protocol === "https:" && !u.username && !u.password && /verify|verification|magic-link|login|auth|sign[-_]?in/i.test(u.pathname);
    } catch { return false; }
  }))].slice(0, 8);
  return { otp, links };
}
export async function receivingMailbox(db: Executor, input: string) {
  let address: string; try { address = normalizeEmail(input); } catch { return null; }
  const [box] = await db.query(`SELECT m.*,a.address recipient FROM addresses a
    JOIN domains d ON d.id=a.domain_id JOIN mailboxes m ON m.id=a.mailbox_id
    JOIN users u ON u.id=m.owner_id WHERE a.address=$1 AND a.enabled AND d.state IN ('active','retired') AND NOT u.disabled`, [address]);
  return box || null;
}
export async function ingestMail(ctx: Context, bytes: Buffer, envelope: { from: string; recipients: string[] }) {
  if (bytes.length > ctx.config.smtpMaxBytes) throw Object.assign(new Error("Message too large"), { responseCode: 552 });
  const digest = createHash("sha256").update(bytes).digest("hex");
  const path = `raw/${digest.slice(0, 2)}/${digest}.eml`;
  const rawId = randomUUID();
  // Every retry must find the same raw bytes. The Postfix-added Received header
  // distinguishes a new delivery from a retry of its queued copy.
  try { await stat(storagePath(ctx.config.dataDir, path)); }
  catch { await durableWrite(ctx.config.dataDir, path, bytes); }
  return ctx.db.transaction(async tx => {
    const targets = new Map<string, { box: any; address: string }>();
    for (const input of [...new Set(envelope.recipients.map(x => x.toLowerCase()))].sort()) {
      const box = await receivingMailbox(tx, input);
      if (!box) throw Object.assign(new Error("Recipient unavailable"), { responseCode: 550 });
      targets.set(box.id, { box, address: input });
    }
    if (!targets.size) throw Object.assign(new Error("No recipients"), { responseCode: 550 });
    // Serialize quota reservations by owner, then mailbox, in stable order.
    for (const owner of [...new Set([...targets.values()].map(x => x.box.owner_id))].sort()) {
      await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [owner]);
    }
    await tx.query("INSERT INTO raw_messages(id,digest,path,size,envelope_from) VALUES($1,$2,$3,$4,$5) ON CONFLICT(digest) DO NOTHING", [rawId, digest, path, bytes.length, envelope.from]);
    const [raw] = await tx.query("SELECT id FROM raw_messages WHERE digest=$1", [digest]);
    const ids: string[] = [];
    for (const [mailboxId, target] of [...targets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const [box] = await tx.query("SELECT * FROM mailboxes WHERE id=$1 FOR UPDATE", [mailboxId]);
      if (!box || box.owner_id !== target.box.owner_id) {
        throw Object.assign(new Error("Recipient ownership changed, retry delivery"), { responseCode: 451 });
      }
      const current = await receivingMailbox(tx, target.address);
      if (!current || current.id !== mailboxId) throw Object.assign(new Error("Recipient unavailable"), { responseCode: 550 });
      const [existing] = await tx.query("SELECT id FROM messages WHERE mailbox_id=$1 AND raw_id=$2", [mailboxId, raw.id]);
      if (existing) { ids.push(existing.id); continue; }
      const [usage] = await tx.query(`SELECT u.storage_quota,COALESCE((SELECT sum(used_bytes) FROM mailboxes WHERE owner_id=u.id),0) used
        FROM users u WHERE id=$1`, [box.owner_id]);
      if (Number(box.used_bytes) + bytes.length > Number(box.quota_bytes) || Number(usage.used) + bytes.length > Number(usage.storage_quota)) {
        throw Object.assign(new Error("Mailbox capacity temporarily unavailable"), { responseCode: 452 });
      }
      const id = randomUUID();
      await tx.query("INSERT INTO messages(id,mailbox_id,raw_id,envelope_recipient,size) VALUES($1,$2,$3,$4,$5)", [id, mailboxId, raw.id, target.address, bytes.length]);
      await tx.query("UPDATE mailboxes SET used_bytes=used_bytes+$2 WHERE id=$1", [mailboxId, bytes.length]);
      await enqueue(tx, "parse_mail", null, { messageId: id });
      ids.push(id);
    }
    return ids;
  });
}
export async function parseMail(ctx: Context, messageId: string) {
  const [message] = await ctx.db.query(`SELECT m.*,r.path FROM messages m JOIN raw_messages r ON r.id=m.raw_id WHERE m.id=$1`, [messageId]);
  if (!message || message.parse_state === "ready") return;
  try {
    const bytes = await readFile(storagePath(ctx.config.dataDir, message.path));
    const parsed = await PostalMime.parse(bytes, { maxNestingDepth: 30 });
    const subject = (parsed.subject || "(无主题)").slice(0, 1000);
    const text = (parsed.text || sanitizeHtml(parsed.html || "", { allowedTags: [], allowedAttributes: {} })).slice(0, 2000000);
    const html = safeHtml((parsed.html || "").slice(0, 2000000));
    const { otp, links } = extractVerification(subject, text, parsed.html || "");
    const attachments: { id: string; path: string; size: number; name: string; type: string }[] = [];
    for (const item of (parsed.attachments || []).slice(0, 100)) {
      const id = randomUUID(), path = `attachments/${messageId}/${id}`;
      const content = typeof item.content === "string" ? Buffer.from(item.content, "base64") : Buffer.from(new Uint8Array(item.content as ArrayBuffer));
      await durableWrite(ctx.config.dataDir, path, content);
      attachments.push({ id, path, size: content.length, name: (item.filename || "attachment").slice(0, 255).replace(/[\r\n/\\]/g, "_"), type: (item.mimeType || "application/octet-stream").slice(0, 100) });
    }
    await ctx.db.transaction(async tx => {
      const [current] = await tx.query("SELECT parse_state FROM messages WHERE id=$1 FOR UPDATE", [messageId]);
      if (!current || current.parse_state === "ready") return;
      await tx.query(`UPDATE messages SET from_address=$2,from_name=$3,subject=$4,preview=$5,text_body=$6,html_body=$7,
        otp=$8,links=$9,parse_state='ready',parse_error=NULL,updated_at=now(),search_document=to_tsvector('simple',$4||' '||$6||' '||$2) WHERE id=$1`,
      [messageId, parsed.from?.address || "", parsed.from?.name || "", subject, text.replace(/\s+/g, " ").slice(0, 220), text, html, otp, JSON.stringify(links)]);
      for (const a of attachments) await tx.query("INSERT INTO attachments(id,message_id,name,content_type,size,path) VALUES($1,$2,$3,$4,$5,$6)", [a.id, messageId, a.name, a.type, a.size, a.path]);
      // Mail-derived evidence is a separate history event, not an upstream
      // authentication result. Never mark registration merely for receiving OTP.
      const evidence = /(?:subscription|receipt|invoice|订阅|收据)/i.test(subject) ? "subscription_notice"
        : /(?:account.{0,20}suspended|账号.{0,8}封禁)/i.test(subject) ? "suspension_notice" : null;
      if (evidence) {
        const accounts = await tx.query("SELECT id FROM business_accounts WHERE mailbox_id=$1", [message.mailbox_id]);
        for (const account of accounts) await tx.query("INSERT INTO certification_events(id,account_id,source,status,detail) VALUES($1,$2,'mail','evidence',$3)",
          [randomUUID(), account.id, JSON.stringify({ messageId, evidence, senderAuthenticated: false })]);
      }
    });
  } catch (error) {
    await ctx.db.query("UPDATE messages SET parse_state='failed',parse_error='MIME 解析失败；原文仍保留' WHERE id=$1 AND parse_state<>'ready'", [messageId]);
    throw error;
  }
}
export async function deleteMessages(ctx: Context, mailboxId: string, ids: string[], user?: User) {
  return ctx.db.transaction(async tx => {
    if (user) await mailboxAccess(tx, user, mailboxId, true);
    else await tx.query("SELECT id FROM mailboxes WHERE id=$1 FOR UPDATE", [mailboxId]);
    const removed = await tx.query("DELETE FROM messages WHERE mailbox_id=$1 AND id=ANY($2::uuid[]) RETURNING size", [mailboxId, ids]);
    const bytes = removed.reduce((n, r) => n + r.size, 0);
    await tx.query("UPDATE mailboxes SET used_bytes=GREATEST(0,used_bytes-$2) WHERE id=$1", [mailboxId, bytes]);
    return removed.length;
  });
}
