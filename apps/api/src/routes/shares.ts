import type { FastifyInstance, FastifyRequest } from "fastify";
import { Type as T } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Context } from "../context.js";
import { audit, mailboxAccess, requireMailUser } from "../context.js";
import { hash, secret, passwordHash, verifyPassword, notFound, HttpError } from "../security.js";
import { toCamel } from "../db/index.js";
import { presentMessage } from "./messages.js";
import { storagePath } from "../mail.js";
const uuid = T.String({ format: "uuid" });
const token = T.String({ minLength: 30, maxLength: 100, pattern: "^[A-Za-z0-9_-]+$" });
export async function shareRoutes(app: FastifyInstance, { db, config }: Context) {
  const find = async (input: string) => {
    const [share] = await db.query(`SELECT s.*,m.address FROM shares s JOIN mailboxes m ON m.id=s.mailbox_id
      WHERE token_hash=$1 AND NOT revoked AND expires_at>now()`, [hash(input)]);
    if (!share) throw notFound(); return share;
  };
  const authorize = async (req: FastifyRequest, input: string) => {
    const share = await find(input);
    if (share.password_hash) {
      const value = req.cookies[`inboxlab_share_${share.id}`];
      const [session] = value ? await db.query("SELECT 1 FROM share_sessions WHERE token_hash=$1 AND share_id=$2 AND expires_at>now()", [hash(value), share.id]) : [];
      if (!session) throw new HttpError(401, "此分享需要密码", "SHARE_PASSWORD_REQUIRED");
    }
    return share;
  };
  app.post<{ Body: { mailboxId: string; password?: string; days?: number } }>("/api/v1/shares", {
    schema: { tags: ["shares"], body: T.Object({ mailboxId: uuid, password: T.Optional(T.String({ minLength: 6, maxLength: 256 })), days: T.Optional(T.Integer({ minimum: 1, maximum: 30 })) }, { additionalProperties: false }) },
  }, async req => {
    const user = requireMailUser(req); await mailboxAccess(db, user, req.body.mailboxId);
    const value = secret(), id = randomUUID(), expires = new Date(Date.now() + (req.body.days || 7) * 86400000);
    await db.transaction(async tx => {
      await tx.query("SELECT id FROM mailboxes WHERE id=$1 FOR UPDATE", [req.body.mailboxId]);
      await mailboxAccess(tx, user, req.body.mailboxId);
      await tx.query("INSERT INTO shares(id,mailbox_id,token_hash,password_hash,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6)",
        [id, req.body.mailboxId, hash(value), req.body.password ? await passwordHash(req.body.password) : null, expires, user.id]);
      await audit(tx, user.id, "share.create", id, { passwordProtected: !!req.body.password });
    });
    return { id, token: value, url: `${config.origin}/share/${value}`, expiresAt: expires.toISOString() };
  });
  app.get<{ Querystring: { mailboxId: string } }>("/api/v1/shares", {
    schema: { tags: ["shares"], querystring: T.Object({ mailboxId: uuid }) },
  }, async req => {
    const user = requireMailUser(req); await mailboxAccess(db, user, req.query.mailboxId);
    return { items: (await db.query("SELECT id,expires_at,revoked,created_at,(password_hash IS NOT NULL) password_protected FROM shares WHERE mailbox_id=$1 ORDER BY created_at DESC", [req.query.mailboxId])).map(toCamel) };
  });
  app.delete<{ Params: { id: string } }>("/api/v1/shares/:id", { schema: { tags: ["shares"], params: T.Object({ id: uuid }) } }, async req => {
    const user = requireMailUser(req), [share] = await db.query("SELECT mailbox_id FROM shares WHERE id=$1", [req.params.id]);
    if (!share) throw notFound();
    await db.transaction(async tx => {
      await mailboxAccess(tx, user, share.mailbox_id, true);
      await tx.query("UPDATE shares SET revoked=true WHERE id=$1", [req.params.id]);
      await tx.query("DELETE FROM share_sessions WHERE share_id=$1", [req.params.id]);
      await audit(tx, user.id, "share.revoke", req.params.id);
    }); return { success: true };
  });
  app.get<{ Params: { token: string } }>("/api/v1/public/shares/:token", { schema: { tags: ["shares"], params: T.Object({ token }) } }, async req => {
    const share = await find(req.params.token);
    let authorized = true; try { await authorize(req, req.params.token); } catch { authorized = false; }
    return { address: share.address, expiresAt: share.expires_at, passwordRequired: !authorized };
  });
  app.post<{ Params: { token: string }; Body: { password: string } }>("/api/v1/public/shares/:token/unlock", {
    schema: { tags: ["shares"], params: T.Object({ token }), body: T.Object({ password: T.String({ maxLength: 256 }) }) },
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
  }, async (req, reply) => {
    const share = await find(req.params.token);
    if (share.password_hash && !await verifyPassword(req.body.password, share.password_hash)) throw new HttpError(401, "分享密码不正确");
    const value = secret();
    await db.query("INSERT INTO share_sessions(token_hash,share_id,expires_at) VALUES($1,$2,$3)", [hash(value), share.id, new Date(Math.min(Date.now() + 3600000, new Date(share.expires_at).getTime()))]);
    reply.setCookie(`inboxlab_share_${share.id}`, value, { httpOnly: true, secure: config.secure, sameSite: "strict", path: "/api/v1/public", maxAge: 3600 });
    return { success: true };
  });
  app.get<{ Params: { token: string } }>("/api/v1/public/shares/:token/messages", { schema: { tags: ["shares"], params: T.Object({ token }) } }, async req => {
    const share = await authorize(req, req.params.token);
    return { items: (await db.query("SELECT id,from_address,from_name,subject,preview,received_at,is_read,starred,parse_state,size,otp FROM messages WHERE mailbox_id=$1 ORDER BY received_at DESC LIMIT 200", [share.mailbox_id])).map(presentMessage) };
  });
  app.get<{ Params: { token: string; id: string } }>("/api/v1/public/shares/:token/messages/:id", {
    schema: { tags: ["shares"], params: T.Object({ token, id: uuid }) },
  }, async req => {
    const share = await authorize(req, req.params.token);
    const [message] = await db.query(`SELECT id,mailbox_id,from_address,from_name,subject,received_at,is_read,starred,parse_state,size,otp,text_body,html_body,links
      FROM messages WHERE id=$1 AND mailbox_id=$2`, [req.params.id, share.mailbox_id]);
    if (!message) throw notFound();
    const attachments = await db.query("SELECT id,name,content_type,size FROM attachments WHERE message_id=$1", [message.id]);
    return { ...presentMessage(message), attachments: attachments.map(toCamel) };
  });
  app.get<{ Params: { token: string; id: string } }>("/api/v1/public/shares/:token/attachments/:id", {
    schema: { tags: ["shares"], params: T.Object({ token, id: uuid }) },
  }, async (req, reply) => {
    const share = await authorize(req, req.params.token);
    const [a] = await db.query("SELECT a.* FROM attachments a JOIN messages m ON m.id=a.message_id WHERE a.id=$1 AND m.mailbox_id=$2", [req.params.id, share.mailbox_id]);
    if (!a) throw notFound();
    reply.type("application/octet-stream").header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`);
    return readFile(storagePath(config.dataDir, a.path));
  });
}
