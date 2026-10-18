import type { FastifyInstance } from "fastify";
import { Type as T } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import ExcelJS from "exceljs";
import type { Context } from "../context.js";
import { accountAccess, audit, enqueue, paging, requireUser, requireAdmin } from "../context.js";
import { toCamel } from "../db/index.js";
import { badRequest, forbidden, normalizeEmail } from "../security.js";
import { cleanKycUrl, normalizeProxy, normalizeSession, readCredential, saveCredential } from "../credentials.js";
const uuid = T.String({ format: "uuid" });
const params = T.Object({ id: uuid });
const statuses = T.Union(["unqueried", "pending", "passed", "denied", "expired", "not_required"].map(x => T.Literal(x)));
const editable = {
  registered: T.Optional(T.Boolean()), subscribed: T.Optional(T.Boolean()), suspended: T.Optional(T.Boolean()),
  note: T.Optional(T.String({ maxLength: 5000 })), tags: T.Optional(T.Array(T.String({ maxLength: 40 }), { maxItems: 20 })),
  assignedIp: T.Optional(T.String({ maxLength: 50 })), kycStatus: T.Optional(statuses),
  kycUrl: T.Optional(T.String({ maxLength: 4096 })), kycExpiresAt: T.Optional(T.Union([T.Null(), T.String({ format: "date-time" })])),
};
const safeColumns = `a.*,EXISTS(SELECT 1 FROM credentials c WHERE c.account_id=a.id AND kind='session') has_session,
  EXISTS(SELECT 1 FROM credentials c WHERE c.account_id=a.id AND kind='proxy') has_proxy`;
const certificationColumns = "a.id,a.email,a.platform,a.registered,a.subscribed,a.suspended,a.tags,a.note,a.kyc_status,a.kyc_url,a.kyc_expires_at,a.kyc_passed_at,a.last_checked_at,a.sync_state,a.sync_message,a.created_at";
function certificationProjection(row: Record<string, any>) {
  return Object.fromEntries(certificationColumns.split(",").map(x => x.slice(2)).map(k => [k, row[k]]));
}
function mutable(req: Parameters<typeof requireUser>[0]) {
  const user = requireUser(req); if (user.role === "kyc_viewer") throw forbidden(); return user;
}
export async function accountRoutes(app: FastifyInstance, ctx: Context) {
  const { db } = ctx;
  app.get("/api/v1/accounts", async req => {
    const user = requireUser(req), { page, pageSize, offset, q, query } = paging(req.query);
    const args: unknown[] = [user.role, user.id, `%${q}%`];
    let where = "($1='admin' OR ($1<>'kyc_viewer' AND a.owner_id=$2) OR ($1='kyc_viewer' AND EXISTS(SELECT 1 FROM certification_grants g WHERE g.account_id=a.id AND g.user_id=$2))) AND (a.email ILIKE $3 OR a.note ILIKE $3 OR a.tags::text ILIKE $3)";
    if (query.status) { args.push(query.status); where += ` AND a.kyc_status=$${args.length}`; }
    const [count] = await db.query(`SELECT count(*)::int n FROM business_accounts a WHERE ${where}`, args);
    args.push(pageSize, offset);
    const rows = await db.query(`SELECT ${user.role === "kyc_viewer" ? certificationColumns : safeColumns} FROM business_accounts a WHERE ${where} ORDER BY a.created_at DESC,a.id LIMIT $${args.length-1} OFFSET $${args.length}`, args);
    return { items: rows.map(toCamel), total: count.n, page, pageSize };
  });
  app.patch<{ Params: { id: string }; Body: Record<string, any> }>("/api/v1/accounts/:id", {
    schema: { tags: ["accounts"], params, body: T.Object(editable, { additionalProperties: false }) },
  }, async req => {
    const user = mutable(req); await accountAccess(db, user, req.params.id);
    const input = req.body;
    if (input.assignedIp && !isIP(input.assignedIp)) throw badRequest("IP 格式不正确");
    if (input.kycUrl !== undefined) input.kycUrl = cleanKycUrl(input.kycUrl);
    const map: Record<string, string> = { registered: "registered", subscribed: "subscribed", suspended: "suspended", note: "note", tags: "tags", assignedIp: "assigned_ip", kycStatus: "kyc_status", kycUrl: "kyc_url", kycExpiresAt: "kyc_expires_at" };
    await db.transaction(async tx => {
      await tx.query("SELECT id FROM business_accounts WHERE id=$1 FOR UPDATE", [req.params.id]);
      await accountAccess(tx, user, req.params.id);
      const fields: string[] = [], values: unknown[] = [req.params.id];
      for (const [key, value] of Object.entries(input)) {
        values.push(key === "tags" ? JSON.stringify(value) : value); fields.push(`${map[key]}=$${values.length}`);
      }
      if (!fields.length) throw badRequest("没有需要更新的字段");
      if (input.kycStatus === "passed") fields.push("kyc_passed_at=COALESCE(kyc_passed_at,now())");
      await tx.query(`UPDATE business_accounts SET ${fields.join(",")},revision=revision+1 WHERE id=$1`, values);
      await tx.query("INSERT INTO certification_events(id,account_id,actor_id,source,status,detail) VALUES($1,$2,$3,'manual',$4,$5)",
        [randomUUID(), req.params.id, user.id, input.kycStatus || "edited", JSON.stringify(input)]);
      await audit(tx, user.id, "account.update", req.params.id, { fields: Object.keys(input) });
    });
    return { success: true };
  });
  app.get<{ Params: { id: string } }>("/api/v1/accounts/:id/events", { schema: { tags: ["accounts"], params } }, async req => {
    const user = requireUser(req); await accountAccess(db, user, req.params.id);
    return { items: (await db.query(`SELECT id,source,status,${user.role === "kyc_viewer" ? "'{}'::jsonb" : "detail"} detail,created_at FROM certification_events WHERE account_id=$1 ORDER BY created_at DESC LIMIT 30`, [req.params.id])).map(toCamel) };
  });
  app.put<{ Params: { id: string }; Body: { userIds: string[] } }>("/api/v1/accounts/:id/viewers", {
    schema: { tags: ["accounts"], params, body: T.Object({ userIds: T.Array(uuid, { maxItems: 200 }) }, { additionalProperties: false }) },
  }, async req => {
    const actor = requireAdmin(req);
    await db.transaction(async tx => {
      await tx.query("SELECT id FROM business_accounts WHERE id=$1 FOR UPDATE", [req.params.id]);
      await accountAccess(tx, actor, req.params.id);
      await tx.query("DELETE FROM certification_grants WHERE account_id=$1", [req.params.id]);
      for (const id of [...new Set(req.body.userIds)]) {
        const [viewer] = await tx.query("SELECT id FROM users WHERE id=$1 AND role='kyc_viewer' AND NOT disabled", [id]);
        if (!viewer) throw badRequest("只能分配给启用的认证只读用户");
        await tx.query("INSERT INTO certification_grants(account_id,user_id) VALUES($1,$2)", [req.params.id, id]);
      }
      await audit(tx, actor.id, "account.viewers", req.params.id, { count: req.body.userIds.length });
    }); return { success: true };
  });
  app.get<{ Params: { id: string } }>("/api/v1/accounts/:id/viewers", { schema: { tags: ["accounts"], params } }, async req => {
    requireAdmin(req); return { userIds: (await db.query("SELECT user_id FROM certification_grants WHERE account_id=$1", [req.params.id])).map(x => x.user_id) };
  });
  app.put<{ Params: { id: string; kind: "session" | "proxy" }; Body: { value: string; expiresAt?: string | null; source?: string } }>("/api/v1/accounts/:id/credentials/:kind", {
    schema: { tags: ["credentials"], params: T.Object({ id: uuid, kind: T.Union([T.Literal("session"), T.Literal("proxy")]) }),
      body: T.Object({ value: T.String({ maxLength: 16384 }), expiresAt: T.Optional(T.Union([T.Null(), T.String({ format: "date-time" })])), source: T.Optional(T.Union([T.Literal("manual"), T.Literal("extension")])) }, { additionalProperties: false }) },
  }, async req => {
    const user = mutable(req); await accountAccess(db, user, req.params.id);
    const { id, kind } = req.params;
    const value = kind === "session" ? normalizeSession(req.body.value) : await normalizeProxy(req.body.value, ctx.config.allowPrivateProxy);
    const [before] = await db.query("SELECT 1 FROM credentials WHERE account_id=$1 AND kind='session'", [id]);
    await db.transaction(async tx => {
      await tx.query("SELECT id FROM business_accounts WHERE id=$1 FOR UPDATE", [id]);
      await accountAccess(tx, user, id);
      await saveCredential(tx, id, kind, value, ctx, { expiresAt: req.body.expiresAt || null, source: req.body.source || "manual" });
      await audit(tx, user.id, `credential.${kind}.save`, id);
      if (kind === "session") await enqueue(tx, "query_accounts", user.id, { ids: [id] });
    });
    return { success: true };
  });
  app.post<{ Params: { id: string; kind: string }; Body: { confirm: boolean } }>("/api/v1/accounts/:id/credentials/:kind/reveal", {
    schema: { tags: ["credentials"], params: T.Object({ id: uuid, kind: T.Union([T.Literal("session"), T.Literal("proxy")]) }), body: T.Object({ confirm: T.Literal(true) }) },
  }, async req => {
    const user = mutable(req); await accountAccess(db, user, req.params.id);
    const credential = await readCredential(ctx, req.params.id, req.params.kind);
    await audit(db, user.id, `credential.${req.params.kind}.reveal`, req.params.id);
    return credential || { value: null };
  });
  app.delete<{ Params: { id: string; kind: string } }>("/api/v1/accounts/:id/credentials/:kind", {
    schema: { tags: ["credentials"], params: T.Object({ id: uuid, kind: T.Union([T.Literal("session"), T.Literal("proxy")]) }) },
  }, async req => {
    const user = mutable(req); await accountAccess(db, user, req.params.id);
    await db.transaction(async tx => {
      await tx.query("SELECT id FROM business_accounts WHERE id=$1 FOR UPDATE", [req.params.id]);
      await accountAccess(tx, user, req.params.id);
      await tx.query("DELETE FROM credentials WHERE account_id=$1 AND kind=$2", [req.params.id, req.params.kind]);
      await tx.query("UPDATE business_accounts SET revision=revision+1 WHERE id=$1", [req.params.id]);
      await audit(tx, user.id, `credential.${req.params.kind}.delete`, req.params.id);
    }); return { success: true };
  });
  app.post<{ Body: { ids: string[]; requireProxy?: boolean } }>("/api/v1/accounts/query", {
    schema: { tags: ["accounts"], body: T.Object({ ids: T.Array(uuid, { minItems: 1, maxItems: 200 }), requireProxy: T.Optional(T.Boolean()) }, { additionalProperties: false }) },
  }, async req => {
    const user = mutable(req);
    for (const id of [...new Set(req.body.ids)]) await accountAccess(db, user, id);
    return { taskId: await enqueue(db, "query_accounts", user.id, { ids: [...new Set(req.body.ids)], requireProxy: req.body.requireProxy || false }, req.body.ids.length) };
  });
  app.post<{ Params: { id: string }; Body: { email: string; captured_at: string; organization_id?: string; kyc: { status: string; vendor_inquiry_url?: string; original_inquiry_url?: string; vendor_inquiry_id?: string } } }>("/api/v1/accounts/:id/capture", {
    schema: { tags: ["accounts"], params, body: T.Object({
      email: T.String({ maxLength: 254 }), captured_at: T.String({ format: "date-time" }),
      organization_id: T.Optional(T.String({ maxLength: 100 })),
      kyc: T.Object({ status: T.String({ maxLength: 40 }), vendor_inquiry_url: T.Optional(T.String({ maxLength: 8192 })), original_inquiry_url: T.Optional(T.String({ maxLength: 8192 })), vendor_inquiry_id: T.Optional(T.String({ maxLength: 100 })) }),
    }, { additionalProperties: false }) },
  }, async req => {
    const user = mutable(req), account = await accountAccess(db, user, req.params.id);
    if (normalizeEmail(req.body.email) !== account.email) throw badRequest("采集邮箱与账号不一致");
    if (Math.abs(Date.now() - Date.parse(req.body.captured_at)) > 600000) throw badRequest("采集结果超过十分钟，请重新采集");
    const map: Record<string, string> = { verified: "passed", passed: "passed", not_required: "not_required", in_progress: "pending", created: "pending", pending: "pending", denied: "denied", failed: "denied", expired: "expired" };
    const status = map[req.body.kyc.status]; if (!status) throw badRequest("未知认证状态");
    const url = cleanKycUrl(req.body.kyc.original_inquiry_url || req.body.kyc.vendor_inquiry_url || "");
    await db.transaction(async tx => {
      await tx.query("SELECT id FROM business_accounts WHERE id=$1 FOR UPDATE", [account.id]);
      await accountAccess(tx, user, account.id);
      await tx.query(`UPDATE business_accounts SET kyc_status=$2,kyc_url=$3,inquiry_id=$4,organization_id=$5,
        revision=revision+1,last_checked_at=now(),sync_state='ok',sync_message='',kyc_passed_at=CASE WHEN $2='passed' THEN COALESCE(kyc_passed_at,now()) ELSE kyc_passed_at END WHERE id=$1`,
      [account.id, status, url, req.body.kyc.vendor_inquiry_id || "", req.body.organization_id || ""]);
      await tx.query("INSERT INTO certification_events(id,account_id,actor_id,source,status,detail) VALUES($1,$2,$3,'browser',$4,$5)",
        [randomUUID(), account.id, user.id, status, JSON.stringify({ url, capturedAt: req.body.captured_at })]);
      await audit(tx, user.id, "account.capture", account.id, { status });
    }); return { success: true };
  });
  app.post<{ Body: { rows: Record<string, any>[] } }>("/api/v1/accounts/import", {
    schema: { tags: ["accounts"], body: T.Object({ rows: T.Array(T.Object({
      email: T.String({ maxLength: 254 }), platform: T.Optional(T.Union([T.Literal("claude"), T.Literal("chatgpt"), T.Literal("other")])),
      ...editable, sessionKey: T.Optional(T.String({ maxLength: 16384 })), proxy: T.Optional(T.String({ maxLength: 2048 })),
    }, { additionalProperties: false }), { minItems: 1, maxItems: 200 }) }) },
  }, async req => {
    const user = mutable(req), items = [], queued: string[] = [];
    for (const row of req.body.rows) {
      try {
        const email = normalizeEmail(row.email), platform = row.platform || "claude", kycUrl = cleanKycUrl(row.kycUrl || "");
        if (row.assignedIp && !isIP(row.assignedIp)) throw badRequest("IP 格式不正确");
        const sessionValue = row.sessionKey ? normalizeSession(row.sessionKey) : null;
        const proxyValue = row.proxy ? await normalizeProxy(row.proxy, ctx.config.allowPrivateProxy) : null;
        const id = await db.transaction(async tx => {
          const [existing] = await tx.query("SELECT * FROM business_accounts WHERE email=$1 AND platform=$2 FOR UPDATE", [email, platform]);
          if (existing && user.role !== "admin" && existing.owner_id !== user.id) throw forbidden();
          const id = existing?.id || randomUUID();
          if (!existing) {
            const [box] = await tx.query("SELECT id FROM mailboxes WHERE address=$1 AND ($2='admin' OR owner_id=$3)", [email, user.role, user.id]);
            await tx.query("INSERT INTO business_accounts(id,mailbox_id,email,owner_id,platform) VALUES($1,$2,$3,$4,$5)", [id, box?.id || null, email, user.id, platform]);
          }
          const fields: string[] = [], values: unknown[] = [id];
          const map: Record<string, string> = { registered: "registered", subscribed: "subscribed", suspended: "suspended", tags: "tags", note: "note", assignedIp: "assigned_ip", kycStatus: "kyc_status", kycExpiresAt: "kyc_expires_at" };
          for (const [key, column] of Object.entries(map)) if (row[key] !== undefined) { values.push(key === "tags" ? JSON.stringify(row[key]) : row[key]); fields.push(`${column}=$${values.length}`); }
          if (row.kycUrl !== undefined) { values.push(kycUrl); fields.push(`kyc_url=$${values.length}`); }
          if (fields.length) await tx.query(`UPDATE business_accounts SET ${fields.join(",")},revision=revision+1 WHERE id=$1`, values);
          if (row.kycStatus === "passed") await tx.query("UPDATE business_accounts SET kyc_passed_at=COALESCE(kyc_passed_at,now()) WHERE id=$1", [id]);
          if (sessionValue) await saveCredential(tx, id, "session", sessionValue, ctx, { source: "import" });
          if (proxyValue) await saveCredential(tx, id, "proxy", proxyValue, ctx);
          await tx.query("INSERT INTO certification_events(id,account_id,actor_id,source,status,detail) VALUES($1,$2,$3,'import',$4,$5)",
            [randomUUID(), id, user.id, row.kycStatus || "imported", JSON.stringify({ fields: Object.keys(row).filter(k => !["sessionKey", "proxy"].includes(k)) })]);
          await audit(tx, user.id, "account.import", id);
          return id;
        });
        if (sessionValue) queued.push(id);
        items.push({ input: email, state: "imported", id });
      } catch (error) { items.push({ input: row.email, state: "failed", error: error instanceof Error ? error.message : "导入失败" }); }
    }
    const taskId = queued.length ? await enqueue(db, "query_accounts", user.id, { ids: queued }, queued.length) : null;
    return { items, taskId };
  });
  app.post<{ Body: { ids: string[]; format: "json" | "csv" | "xlsx"; includeSecrets?: boolean } }>("/api/v1/accounts/export", {
    schema: { tags: ["accounts"], body: T.Object({ ids: T.Array(uuid, { minItems: 1, maxItems: 200 }), format: T.Union([T.Literal("json"), T.Literal("csv"), T.Literal("xlsx")]), includeSecrets: T.Optional(T.Boolean()) }, { additionalProperties: false }) },
  }, async (req, reply) => {
    const user = requireUser(req); if (req.body.includeSecrets && user.role === "kyc_viewer") throw forbidden();
    const rows: Record<string, unknown>[] = [];
    for (const id of [...new Set(req.body.ids)]) {
      const account = await accountAccess(db, user, id);
      const row = toCamel<Record<string, unknown>>(user.role === "kyc_viewer" ? certificationProjection(account) : account);
      if (req.body.includeSecrets) {
        row.sessionKey = (await readCredential(ctx, id, "session"))?.value || "";
        row.proxy = (await readCredential(ctx, id, "proxy"))?.value || "";
      }
      rows.push(row);
    }
    await audit(db, user.id, "account.export", "batch", { count: rows.length, includeSecrets: !!req.body.includeSecrets });
    const name = `accounts-${new Date().toISOString().slice(0, 10)}.${req.body.format}`;
    reply.header("Content-Disposition", `attachment; filename="${name}"`);
    if (req.body.format === "json") return reply.type("application/json").send(rows);
    const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet("Accounts");
    const columns = [...new Set(rows.flatMap(Object.keys))];
    sheet.columns = columns.map(key => ({ header: key, key, width: key === "email" ? 36 : 24 }));
    for (const row of rows) {
      // Neutralize spreadsheet formula injection for both XLSX and CSV.
      const safe = Object.fromEntries(Object.entries(row).map(([k, v]) => {
        let value = Array.isArray(v) ? v.join(",") : v && typeof v === "object" ? JSON.stringify(v) : v;
        if (typeof value === "string" && /^[=+\-@\t\r]/.test(value)) value = "'" + value;
        return [k, value];
      }));
      sheet.addRow(safe);
    }
    if (req.body.format === "xlsx") return reply.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").send(Buffer.from(await workbook.xlsx.writeBuffer()));
    return reply.type("text/csv; charset=utf-8").send(Buffer.concat([Buffer.from("\ufeff"), Buffer.from(await workbook.csv.writeBuffer())]));
  });
}
