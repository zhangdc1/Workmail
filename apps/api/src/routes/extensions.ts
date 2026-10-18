import type { FastifyInstance } from "fastify";
import { Type as T } from "@sinclair/typebox";
import { randomBytes, randomUUID } from "node:crypto";
import type { Context } from "../context.js";
import { requireMailUser, accountAccess, audit, enqueue } from "../context.js";
import { badRequest, forbidden, hash, normalizeEmail, secret } from "../security.js";
import { normalizeSession, readCredential, saveCredential } from "../credentials.js";
import { normalizeSnapshot } from "../integration.js";
export async function extensionRoutes(app: FastifyInstance, ctx: Context) {
  const { db, config } = ctx;
  app.post("/api/v1/extensions/pair", async req => {
    const user = requireMailUser(req), code = randomBytes(12).toString("hex");
    await db.query("DELETE FROM extension_pairings WHERE expires_at<now() OR user_id=$1", [user.id]);
    await db.query("INSERT INTO extension_pairings(code_hash,user_id) VALUES($1,$2)", [hash(code), user.id]);
    return { code, expiresIn: 300, origin: config.origin };
  });
  app.get("/api/v1/extensions/connections", async req => {
    const user = requireMailUser(req);
    return { items: await db.query("SELECT name,created_at,expires_at FROM extension_tokens WHERE user_id=$1", [user.id]) };
  });
  app.delete("/api/v1/extensions/connections", async req => {
    const user = requireMailUser(req);
    await db.transaction(async tx => {
      await tx.query("DELETE FROM extension_tokens WHERE user_id=$1", [user.id]);
      await tx.query("DELETE FROM extension_pairings WHERE user_id=$1", [user.id]);
      await audit(tx, user.id, "extension.revoke_all", user.id);
    });
    return { success: true };
  });
  app.post<{ Body: { code: string; name: string } }>("/api/v1/public/extensions/connect", {
    schema: { tags: ["extensions"], body: T.Object({ code: T.String({ pattern: "^[a-f0-9]{24}$" }), name: T.String({ minLength: 1, maxLength: 60 }) }, { additionalProperties: false }) },
    config: { rateLimit: { max: 8, timeWindow: "15 minutes" } },
  }, async req => db.transaction(async tx => {
    const [pair] = await tx.query(`DELETE FROM extension_pairings WHERE code_hash=$1 AND expires_at>now()
      AND EXISTS(SELECT 1 FROM users u WHERE u.id=user_id AND NOT u.disabled AND u.role<>'kyc_viewer') RETURNING user_id`, [hash(req.body.code)]);
    if (!pair) throw badRequest("配对码失效或已使用，请在平台重新生成");
    const value = secret();
    await tx.query("INSERT INTO extension_tokens(token_hash,user_id,name) VALUES($1,$2,$3)", [hash(value), pair.user_id, req.body.name]);
    await audit(tx, pair.user_id, "extension.connect", pair.user_id);
    return { token: value, origin: config.origin, expiresIn: 2592000 };
  }));
  app.get("/api/v1/extensions/accounts", async req => {
    const user = requireMailUser(req);
    return { items: await db.query(`SELECT id,email,platform FROM business_accounts WHERE platform='claude'
      AND ($1='admin' OR owner_id=$2) ORDER BY email LIMIT 200`, [user.role, user.id]) };
  });
  app.post<{ Body: { accountId: string; confirmedEmail: string; sessionKey: string; snapshot?: any } }>("/api/v1/extensions/capture", {
    schema: { tags: ["extensions"], body: T.Object({ accountId: T.String({ format: "uuid" }), confirmedEmail: T.String({ maxLength: 254 }), sessionKey: T.String({ maxLength: 4096 }),
      snapshot: T.Optional(T.Object({ email: T.String({ maxLength: 254 }), captured_at: T.String({ format: "date-time" }), organization_id: T.Optional(T.String({ maxLength: 100 })), kyc: T.Object({ status: T.String({ maxLength: 40 }), vendor_inquiry_url: T.Optional(T.String({ maxLength: 8192 })), original_inquiry_url: T.Optional(T.String({ maxLength: 8192 })), vendor_inquiry_id: T.Optional(T.String({ maxLength: 100 })) }, { additionalProperties: false }) }, { additionalProperties: false })) }, { additionalProperties: false }) },
  }, async req => {
    const user = requireMailUser(req), value = normalizeSession(req.body.sessionKey);
    const normalized = req.body.snapshot ? normalizeSnapshot(req.body.snapshot, req.body.confirmedEmail) : null;
    if (req.body.snapshot && Math.abs(Date.now() - Date.parse(req.body.snapshot.captured_at)) > 600000) throw badRequest("采集结果已过期");
    return db.transaction(async tx => {
      await tx.query("SELECT id FROM business_accounts WHERE id=$1 FOR UPDATE", [req.body.accountId]);
      const account = await accountAccess(tx, user, req.body.accountId);
      if (normalizeEmail(req.body.confirmedEmail) !== account.email || account.platform !== "claude") throw badRequest("浏览器登录邮箱与目标账号不一致");
      const previous = await readCredential({ ...ctx, db: { ...db, query: tx.query } }, account.id, "session");
      if (previous?.value !== value) {
        await saveCredential(tx, account.id, "session", value, ctx, { source: "extension" });
        if (!normalized) await enqueue(tx, "query_accounts", user.id, { ids: [account.id] });
      }
      if (normalized) {
        await tx.query(`UPDATE business_accounts SET kyc_status=$2,kyc_url=$3,inquiry_id=$4,organization_id=$5,revision=revision+1,
          last_checked_at=now(),sync_state='ok',sync_message='浏览器核对后采集',
          kyc_passed_at=CASE WHEN $2='passed' THEN COALESCE(kyc_passed_at,now()) ELSE kyc_passed_at END WHERE id=$1`,
        [account.id, normalized.status, normalized.url, normalized.inquiry, normalized.organization]);
        await tx.query("INSERT INTO certification_events(id,account_id,actor_id,source,status,detail) VALUES($1,$2,$3,'browser',$4,$5)", [randomUUID(), account.id, user.id, normalized.status, JSON.stringify({ url: normalized.url })]);
      }
      await audit(tx, user.id, "extension.capture", account.id, { matchedEmail: true, certification: !!normalized });
      return { success: true };
    });
  });
  app.post<{ Body: { accountId: string } }>("/api/v1/extensions/proxy", {
    schema: { tags: ["extensions"], body: T.Object({ accountId: T.String({ format: "uuid" }) }, { additionalProperties: false }) },
  }, async req => {
    const user = requireMailUser(req), account = await accountAccess(db, user, req.body.accountId);
    const value = await readCredential(ctx, account.id, "proxy");
    if (!value) throw badRequest("此账号没有配置代理");
    await audit(db, user.id, "credential.proxy.extension_reveal", account.id);
    return { value: value.value, assignedIp: account.assigned_ip };
  });
  app.post("/api/v1/extensions/disconnect", async req => {
    if (!req.extensionAuth) throw forbidden();
    await db.query("DELETE FROM extension_tokens WHERE token_hash=$1", [hash(req.headers.authorization!.slice(7))]);
    return { success: true };
  });
}
