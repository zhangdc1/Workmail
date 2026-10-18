import type { FastifyInstance } from "fastify";
import { Type as T } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import type { Context } from "../context.js";
import { audit, requireAdmin, requireUser } from "../context.js";
import { hash, secret, verifyPassword, passwordHash, HttpError, badRequest } from "../security.js";
import { toCamel } from "../db/index.js";
const username = T.String({ minLength: 3, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9_.@-]+$" });
const password = T.String({ minLength: 12, maxLength: 256 });
export async function authRoutes(app: FastifyInstance, { db, config }: Context) {
  app.get("/api/v1/auth/session", async req => ({
    authenticated: !!req.user, user: req.user, csrf: req.csrf,
  }));
  app.post<{ Body: { username: string; password: string } }>("/api/v1/auth/login", {
    schema: { tags: ["auth"], body: T.Object({ username, password: T.String({ maxLength: 256 }) }, { additionalProperties: false }) },
    config: { rateLimit: { max: 8, timeWindow: "15 minutes" } },
  }, async (req, reply) => {
    const [user] = await db.query("SELECT * FROM users WHERE username=$1", [req.body.username]);
    // Equal-cost hash when the user does not exist, avoiding username timing leaks.
    const digest = user?.password_hash || "scrypt$00000000000000000000000000000000$" + "0".repeat(128);
    if (!await verifyPassword(req.body.password, digest) || !user || user.disabled) throw new HttpError(401, "账号或密码不正确", "INVALID_CREDENTIALS");
    const token = secret(), csrf = secret();
    await db.transaction(async tx => {
      const [current] = await tx.query("SELECT password_hash,disabled FROM users WHERE id=$1 FOR UPDATE", [user.id]);
      if (!current || current.disabled || current.password_hash !== digest) throw new HttpError(401, "账号或密码已变化，请重新登录", "INVALID_CREDENTIALS");
      await tx.query("DELETE FROM sessions WHERE expires_at < now()");
      await tx.query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,$4)", [hash(token), user.id, csrf, new Date(Date.now() + config.sessionHours * 3600000)]);
      await audit(tx, user.id, "auth.login", user.id);
    });
    reply.setCookie("inboxlab_session", token, { httpOnly: true, secure: config.secure, sameSite: "strict", path: "/", maxAge: config.sessionHours * 3600 });
    const { password_hash, ...safe } = user;
    return { authenticated: true, user: toCamel(safe), csrf };
  });
  app.post("/api/v1/auth/logout", async (req, reply) => {
    if (req.sessionHash) await db.query("DELETE FROM sessions WHERE token_hash=$1", [req.sessionHash]);
    reply.clearCookie("inboxlab_session", { path: "/" }); return { success: true };
  });
  app.post<{ Body: { currentPassword: string; password: string } }>("/api/v1/auth/password", {
    schema: { tags: ["auth"], body: T.Object({ currentPassword: T.String({ maxLength: 256 }), password }) },
  }, async req => {
    const user = requireUser(req);
    const [row] = await db.query("SELECT password_hash FROM users WHERE id=$1", [user.id]);
    if (!await verifyPassword(req.body.currentPassword, row.password_hash)) throw badRequest("当前密码不正确");
    const encoded = await passwordHash(req.body.password);
    await db.transaction(async tx => {
      const [current] = await tx.query("SELECT password_hash FROM users WHERE id=$1 FOR UPDATE", [user.id]);
      if (!current || current.password_hash !== row.password_hash) throw badRequest("密码刚刚发生变化，请重新登录");
      await tx.query("UPDATE users SET password_hash=$1 WHERE id=$2", [encoded, user.id]);
      await tx.query("DELETE FROM sessions WHERE user_id=$1", [user.id]);
      await tx.query("DELETE FROM extension_tokens WHERE user_id=$1", [user.id]);
      await tx.query("DELETE FROM extension_pairings WHERE user_id=$1", [user.id]);
      await audit(tx, user.id, "user.password", user.id);
    });
    return { success: true, relogin: true };
  });
  app.get("/api/v1/users", async req => {
    requireAdmin(req);
    return { items: (await db.query("SELECT id,username,role,disabled,mailbox_quota,storage_quota,created_at FROM users ORDER BY created_at")).map(toCamel) };
  });
  app.post<{ Body: { username: string; password: string; role: string; mailboxQuota?: number; storageQuota?: number } }>("/api/v1/users", {
    schema: { tags: ["users"], body: T.Object({
      username, password, role: T.Union([T.Literal("admin"), T.Literal("member"), T.Literal("kyc_viewer")]),
      mailboxQuota: T.Optional(T.Integer({ minimum: 0, maximum: 100000 })),
      storageQuota: T.Optional(T.Integer({ minimum: 0, maximum: 1099511627776 })),
    }, { additionalProperties: false }) },
  }, async req => {
    const actor = requireAdmin(req), id = randomUUID(), input = req.body;
    await db.transaction(async tx => {
      await tx.query("INSERT INTO users(id,username,password_hash,role,mailbox_quota,storage_quota) VALUES($1,$2,$3,$4,$5,$6)",
        [id, input.username, await passwordHash(input.password), input.role, input.mailboxQuota ?? 10000, input.storageQuota ?? 10737418240]);
      await audit(tx, actor.id, "user.create", id);
    });
    return { id };
  });
  app.patch<{ Params: { id: string }; Body: { disabled?: boolean; password?: string; mailboxQuota?: number; storageQuota?: number; domainIds?: string[] } }>("/api/v1/users/:id", {
    schema: { tags: ["users"], params: T.Object({ id: T.String({ format: "uuid" }) }), body: T.Object({
      disabled: T.Optional(T.Boolean()), password: T.Optional(password),
      mailboxQuota: T.Optional(T.Integer({ minimum: 0, maximum: 100000 })),
      storageQuota: T.Optional(T.Integer({ minimum: 0, maximum: 1099511627776 })),
      domainIds: T.Optional(T.Array(T.String({ format: "uuid" }), { maxItems: 200 })),
    }, { additionalProperties: false }) },
  }, async req => {
    const actor = requireAdmin(req), { id } = req.params, input = req.body;
    if (id === actor.id && input.disabled) throw badRequest("不可禁用当前管理员");
    await db.transaction(async tx => {
      const [target] = await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [id]);
      if (!target) throw badRequest("账号不存在");
      const fields: string[] = [], values: unknown[] = [id];
      for (const [key, value] of Object.entries({ disabled: input.disabled, mailbox_quota: input.mailboxQuota, storage_quota: input.storageQuota, password_hash: input.password ? await passwordHash(input.password) : undefined })) {
        if (value !== undefined) { values.push(value); fields.push(`${key}=$${values.length}`); }
      }
      if (fields.length) await tx.query(`UPDATE users SET ${fields.join(",")} WHERE id=$1`, values);
      if (input.password || input.disabled) {
        await tx.query("DELETE FROM sessions WHERE user_id=$1", [id]);
        await tx.query("DELETE FROM extension_tokens WHERE user_id=$1", [id]);
        await tx.query("DELETE FROM extension_pairings WHERE user_id=$1", [id]);
      }
      if (input.domainIds) {
        await tx.query("DELETE FROM domain_grants WHERE user_id=$1", [id]);
        for (const domainId of [...new Set(input.domainIds)]) await tx.query("INSERT INTO domain_grants(user_id,domain_id) VALUES($1,$2)", [id, domainId]);
      }
      await audit(tx, actor.id, "user.update", id, { passwordChanged: !!input.password, disabled: input.disabled });
    });
    return { success: true };
  });
}
