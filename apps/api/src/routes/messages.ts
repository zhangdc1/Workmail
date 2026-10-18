import type { FastifyInstance } from "fastify";
import { Type as T } from "@sinclair/typebox";
import { readFile } from "node:fs/promises";
import type { Context } from "../context.js";
import { audit, mailboxAccess, paging, requireMailUser } from "../context.js";
import { toCamel } from "../db/index.js";
import { notFound } from "../security.js";
import { deleteMessages, storagePath } from "../mail.js";
const id = T.String({ format: "uuid" });
export function presentMessage(row: Record<string, any>) {
  const { is_read, text_body, html_body, search_document, raw_id, ...rest } = row;
  return { ...toCamel(rest), read: is_read, ...(text_body !== undefined ? { text: text_body, html: html_body } : {}) };
}
export async function messageRoutes(app: FastifyInstance, ctx: Context) {
  const { db, config } = ctx;
  app.get("/api/v1/messages", async req => {
    const user = requireMailUser(req), { page, pageSize, offset, q, query } = paging(req.query);
    const values: unknown[] = [user.role, user.id];
    let where = `($1='admin' OR b.owner_id=$2 OR EXISTS(SELECT 1 FROM mailbox_grants g WHERE g.mailbox_id=b.id AND g.user_id=$2))`;
    if (query.mailboxId && /^[0-9a-f-]{36}$/i.test(query.mailboxId)) { values.push(query.mailboxId); where += ` AND m.mailbox_id=$${values.length}`; }
    if (query.domainId && /^[0-9a-f-]{36}$/i.test(query.domainId)) { values.push(query.domainId); where += ` AND b.domain_id=$${values.length}`; }
    if (query.filter === "unread") where += " AND NOT m.is_read";
    if (query.filter === "starred") where += " AND m.starred";
    if (q) { values.push(`%${q}%`, q); where += ` AND (m.subject ILIKE $${values.length-1} OR m.from_address ILIKE $${values.length-1} OR m.text_body ILIKE $${values.length-1} OR m.search_document @@ plainto_tsquery('simple',$${values.length}))`; }
    const [count] = await db.query(`SELECT count(*)::int total FROM messages m JOIN mailboxes b ON b.id=m.mailbox_id WHERE ${where}`, values);
    values.push(pageSize, offset);
    const items = await db.query(`SELECT m.id,m.mailbox_id,m.from_address,m.from_name,m.subject,m.preview,m.received_at,m.is_read,m.starred,m.parse_state,m.size,m.otp,b.address,
      (SELECT count(*)::int FROM attachments a WHERE a.message_id=m.id) attachment_count
      FROM messages m JOIN mailboxes b ON b.id=m.mailbox_id WHERE ${where} ORDER BY m.received_at DESC,m.id LIMIT $${values.length-1} OFFSET $${values.length}`, values);
    return { items: items.map(presentMessage), total: count.total, page, pageSize };
  });
  app.get<{ Params: { id: string } }>("/api/v1/messages/:id", {
    schema: { tags: ["messages"], params: T.Object({ id }) },
  }, async req => {
    const user = requireMailUser(req);
    const [row] = await db.query("SELECT * FROM messages WHERE id=$1", [req.params.id]); if (!row) throw notFound();
    await mailboxAccess(db, user, row.mailbox_id);
    const attachments = await db.query("SELECT id,name,content_type,size FROM attachments WHERE message_id=$1 ORDER BY name", [row.id]);
    return { ...presentMessage(row), attachments: attachments.map(toCamel) };
  });
  app.patch<{ Params: { id: string }; Body: { read?: boolean; starred?: boolean } }>("/api/v1/messages/:id", {
    schema: { tags: ["messages"], params: T.Object({ id }), body: T.Object({ read: T.Optional(T.Boolean()), starred: T.Optional(T.Boolean()) }, { additionalProperties: false }) },
  }, async req => {
    const user = requireMailUser(req);
    const [row] = await db.query("SELECT mailbox_id FROM messages WHERE id=$1", [req.params.id]); if (!row) throw notFound();
    await db.transaction(async tx => {
      await mailboxAccess(tx, user, row.mailbox_id, true);
      await tx.query("UPDATE messages SET is_read=COALESCE($2,is_read),starred=COALESCE($3,starred),updated_at=now() WHERE id=$1", [req.params.id, req.body.read ?? null, req.body.starred ?? null]);
    });
    return { success: true };
  });
  app.post<{ Body: { mailboxId: string; ids: string[]; action: "delete" | "read" | "unread" | "star" } }>("/api/v1/messages/batch", {
    schema: { tags: ["messages"], body: T.Object({
      mailboxId: id, ids: T.Array(id, { minItems: 1, maxItems: 200 }),
      action: T.Union([T.Literal("delete"), T.Literal("read"), T.Literal("unread"), T.Literal("star")]),
    }, { additionalProperties: false }) },
  }, async req => {
    const user = requireMailUser(req), { mailboxId, ids, action } = req.body;
    let count = 0;
    if (action === "delete") count = await deleteMessages(ctx, mailboxId, ids, user);
    else {
      const set = action === "star" ? "starred=true" : `is_read=${action === "read" ? "true" : "false"}`;
      count = await db.transaction(async tx => {
        await mailboxAccess(tx, user, mailboxId, true);
        return (await tx.query(`UPDATE messages SET ${set},updated_at=now() WHERE mailbox_id=$1 AND id=ANY($2::uuid[]) RETURNING id`, [mailboxId, ids])).length;
      });
    }
    await audit(db, user.id, `messages.${action}`, mailboxId, { count }); return { count };
  });
  app.get<{ Params: { id: string } }>("/api/v1/attachments/:id", { schema: { tags: ["messages"], params: T.Object({ id }) } }, async (req, reply) => {
    const user = requireMailUser(req);
    const [a] = await db.query("SELECT a.*,m.mailbox_id FROM attachments a JOIN messages m ON m.id=a.message_id WHERE a.id=$1", [req.params.id]);
    if (!a) throw notFound(); await mailboxAccess(db, user, a.mailbox_id);
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`);
    reply.type("application/octet-stream"); return readFile(storagePath(config.dataDir, a.path));
  });
  app.get<{ Params: { id: string } }>("/api/v1/messages/:id/raw", { schema: { tags: ["messages"], params: T.Object({ id }) } }, async (req, reply) => {
    const user = requireMailUser(req);
    const [m] = await db.query("SELECT m.mailbox_id,r.path FROM messages m JOIN raw_messages r ON r.id=m.raw_id WHERE m.id=$1", [req.params.id]);
    if (!m) throw notFound(); await mailboxAccess(db, user, m.mailbox_id);
    reply.type("message/rfc822").header("Content-Disposition", 'attachment; filename="message.eml"');
    return readFile(storagePath(config.dataDir, m.path));
  });
  app.get<{ Params: { id: string }; Querystring: { since: string } }>("/api/v1/mailboxes/:id/otp", {
    schema: { tags: ["messages"], params: T.Object({ id }), querystring: T.Object({ since: T.String({ format: "date-time" }) }) },
  }, async req => {
    const user = requireMailUser(req); await mailboxAccess(db, user, req.params.id);
    const [mail] = await db.query("SELECT id,otp,received_at,links FROM messages WHERE mailbox_id=$1 AND received_at>$2 AND (otp IS NOT NULL OR links<>'[]'::jsonb) ORDER BY received_at DESC LIMIT 1", [req.params.id, req.query.since]);
    return { item: mail ? toCamel(mail) : null };
  });
}
