import type { FastifyInstance } from "fastify";
import { Type as T } from "@sinclair/typebox";
import { randomUUID, randomBytes } from "node:crypto";
import type { Context } from "../context.js";
import { audit, mailboxAccess, paging, requireAdmin, requireMailUser } from "../context.js";
import { toCamel, type Database } from "../db/index.js";
import type { User } from "../../../../packages/shared/src/index.js";
import { badRequest, forbidden, normalizeEmail } from "../security.js";
const idParams = T.Object({ id: T.String({ format: "uuid" }) });
const tags = T.Array(T.String({ maxLength: 40 }), { maxItems: 20 });
export async function createMailbox(db: Database, user: User, input: { domainId?: string; address?: string; prefix?: string; ownerId?: string; label?: string; tags?: string[]; note?: string }) {
  if (user.role === "kyc_viewer") throw forbidden();
  const id = randomUUID(), ownerId = user.role === "admin" ? input.ownerId || user.id : user.id;
  return db.transaction(async tx => {
    const [owner] = await tx.query("SELECT * FROM users WHERE id=$1 AND NOT disabled FOR UPDATE", [ownerId]);
    if (!owner || owner.role === "kyc_viewer") throw badRequest("目标成员不可拥有邮箱");
    const [domain] = input.address
      ? await tx.query("SELECT * FROM domains WHERE name=$1 FOR UPDATE", [normalizeEmail(input.address).split("@")[1]])
      : await tx.query("SELECT * FROM domains WHERE id=$1 FOR UPDATE", [input.domainId]);
    if (!domain || domain.state !== "active") throw badRequest("域名未启用或已经退役");
    if (user.role !== "admin") {
      const [grant] = await tx.query("SELECT 1 FROM domain_grants WHERE user_id=$1 AND domain_id=$2", [user.id, domain.id]);
      if (!grant) throw forbidden();
    }
    const [count] = await tx.query("SELECT count(*)::int AS n FROM mailboxes WHERE owner_id=$1", [ownerId]);
    if (count.n >= owner.mailbox_quota) throw badRequest("成员邮箱数量已达到配额");
    const address = input.address ? normalizeEmail(input.address) : normalizeEmail(`${input.prefix || randomBytes(5).toString("hex")}@${domain.name}`);
    const [box] = await tx.query("INSERT INTO mailboxes(id,domain_id,owner_id,address,label,tags,note) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
      [id, domain.id, ownerId, address, input.label || "", JSON.stringify(input.tags || []), input.note || ""]);
    await tx.query("INSERT INTO addresses(address,mailbox_id,domain_id,is_primary) VALUES($1,$2,$3,true)", [address, id, domain.id]);
    await tx.query("INSERT INTO business_accounts(id,mailbox_id,email,owner_id) VALUES($1,$2,$3,$4)", [randomUUID(), id, address, ownerId]);
    await audit(tx, user.id, "mailbox.create", id, { address });
    return toCamel(box);
  });
}
export async function mailboxRoutes(app: FastifyInstance, { db }: Context) {
  app.get("/api/v1/mailboxes", async req => {
    const user = requireMailUser(req), { page, pageSize, offset, q, query } = paging(req.query);
    const values: unknown[] = [user.role, user.id, `%${q}%`];
    let where = `($1='admin' OR m.owner_id=$2 OR EXISTS(SELECT 1 FROM mailbox_grants g WHERE g.mailbox_id=m.id AND g.user_id=$2))
      AND (m.address ILIKE $3 OR m.label ILIKE $3 OR m.tags::text ILIKE $3)`;
    if (query.domainId && /^[0-9a-f-]{36}$/i.test(query.domainId)) { values.push(query.domainId); where += ` AND m.domain_id=$${values.length}`; }
    const [count] = await db.query(`SELECT count(*)::int total FROM mailboxes m WHERE ${where}`, values);
    values.push(pageSize, offset);
    const items = await db.query(`SELECT m.*,u.username owner_name,
      (SELECT count(*)::int FROM messages x WHERE x.mailbox_id=m.id) message_count,
      (SELECT count(*)::int FROM messages x WHERE x.mailbox_id=m.id AND NOT x.is_read) unread_count,
      COALESCE((SELECT jsonb_agg(a.address) FROM addresses a WHERE a.mailbox_id=m.id AND NOT a.is_primary),'[]') aliases
      FROM mailboxes m JOIN users u ON u.id=m.owner_id WHERE ${where} ORDER BY m.created_at DESC,m.id LIMIT $${values.length-1} OFFSET $${values.length}`, values);
    return { items: items.map(toCamel), total: count.total, page, pageSize };
  });
  app.post<{ Body: { domainId: string; prefix?: string; count?: number; ownerId?: string; label?: string; tags?: string[] } }>("/api/v1/mailboxes", {
    schema: { tags: ["mailboxes"], body: T.Object({
      domainId: T.String({ format: "uuid" }), prefix: T.Optional(T.String({ maxLength: 64 })),
      count: T.Optional(T.Integer({ minimum: 1, maximum: 200 })), ownerId: T.Optional(T.String({ format: "uuid" })),
      label: T.Optional(T.String({ maxLength: 100 })), tags: T.Optional(tags),
    }, { additionalProperties: false }) },
  }, async req => {
    const user = requireMailUser(req), count = req.body.count || 1;
    if (req.body.prefix && count > 1) throw badRequest("指定前缀时一次只能创建一个；批量指定地址请使用导入");
    const items = [];
    for (let i = 0; i < count; i++) {
      try { items.push({ state: "created", mailbox: await createMailbox(db, user, req.body) }); }
      catch (error) { items.push({ state: "failed", error: error instanceof Error ? error.message : "创建失败" }); }
    }
    return { items };
  });
  app.post<{ Body: { addresses: string[] } }>("/api/v1/mailboxes/import", {
    schema: { tags: ["mailboxes"], body: T.Object({ addresses: T.Array(T.String({ maxLength: 254 }), { minItems: 1, maxItems: 200 }) }) },
  }, async req => {
    const user = requireMailUser(req), items = [];
    for (const input of req.body.addresses) {
      try {
        const address = normalizeEmail(input);
        const [existing] = await db.query("SELECT id FROM addresses WHERE address=$1", [address]);
        if (existing) { items.push({ input, state: "skipped" }); continue; }
        items.push({ input, state: "created", mailbox: await createMailbox(db, user, { address }) });
      } catch (error) { items.push({ input, state: "failed", error: error instanceof Error ? error.message : "导入失败" }); }
    }
    return { items };
  });
  app.patch<{ Params: { id: string }; Body: { label?: string; tags?: string[]; note?: string; quotaBytes?: number } }>("/api/v1/mailboxes/:id", {
    schema: { tags: ["mailboxes"], params: idParams, body: T.Object({
      label: T.Optional(T.String({ maxLength: 100 })), note: T.Optional(T.String({ maxLength: 5000 })), tags: T.Optional(tags),
      quotaBytes: T.Optional(T.Integer({ minimum: 1048576, maximum: 107374182400 })),
    }, { additionalProperties: false }) },
  }, async req => {
    const user = requireMailUser(req);
    if (req.body.quotaBytes !== undefined && user.role !== "admin") throw forbidden();
    const fields: string[] = [], values: unknown[] = [req.params.id];
    for (const [key, value] of Object.entries({ label: req.body.label, tags: req.body.tags ? JSON.stringify(req.body.tags) : undefined, note: req.body.note, quota_bytes: req.body.quotaBytes })) {
      if (value !== undefined) { values.push(value); fields.push(`${key}=$${values.length}`); }
    }
    if (!fields.length) throw badRequest("没有需要更新的字段");
    return db.transaction(async tx => {
      await mailboxAccess(tx, user, req.params.id, true);
      const [row] = await tx.query(`UPDATE mailboxes SET ${fields.join(",")} WHERE id=$1 RETURNING *`, values);
      await audit(tx, user.id, "mailbox.update", req.params.id);
      return toCamel(row);
    });
  });
  app.post<{ Params: { id: string }; Body: { address: string } }>("/api/v1/mailboxes/:id/aliases", {
    schema: { tags: ["mailboxes"], params: idParams, body: T.Object({ address: T.String({ maxLength: 254 }) }) },
  }, async req => {
    const user = requireMailUser(req), address = normalizeEmail(req.body.address);
    await db.transaction(async tx => {
      const [domain] = await tx.query("SELECT * FROM domains WHERE name=$1 AND state='active' FOR UPDATE", [address.split("@")[1]]);
      if (!domain) throw badRequest("别名域名不可用");
      const box = await mailboxAccess(tx, user, req.params.id, true);
      if (user.role !== "admin") {
        const [grant] = await tx.query("SELECT 1 FROM domain_grants WHERE user_id=$1 AND domain_id=$2", [user.id, domain.id]);
        if (!grant) throw forbidden();
      }
      await tx.query("INSERT INTO addresses(address,mailbox_id,domain_id) VALUES($1,$2,$3)", [address, box.id, domain.id]);
      await audit(tx, user.id, "mailbox.alias", box.id, { address });
    });
    return { success: true };
  });
  app.delete<{ Params: { id: string }; Body: { address: string } }>("/api/v1/mailboxes/:id/aliases", {
    schema: { tags: ["mailboxes"], params: idParams, body: T.Object({ address: T.String({ maxLength: 254 }) }) },
  }, async req => {
    const user = requireMailUser(req);
    await db.transaction(async tx => {
      await mailboxAccess(tx, user, req.params.id, true);
      await tx.query("DELETE FROM addresses WHERE mailbox_id=$1 AND address=$2 AND NOT is_primary", [req.params.id, normalizeEmail(req.body.address)]);
      await audit(tx, user.id, "mailbox.alias.remove", req.params.id);
    });
    return { success: true };
  });
  app.post<{ Params: { id: string }; Body: { ownerId: string } }>("/api/v1/mailboxes/:id/transfer", {
    schema: { tags: ["mailboxes"], params: idParams, body: T.Object({ ownerId: T.String({ format: "uuid" }) }) },
  }, async req => {
    const actor = requireAdmin(req);
    await db.transaction(async tx => {
      const [snapshot] = await tx.query("SELECT owner_id FROM mailboxes WHERE id=$1", [req.params.id]);
      if (!snapshot) throw badRequest("邮箱不可用");
      // Same lock order as ingestion: users (sorted), then mailbox.
      for (const id of [...new Set([snapshot.owner_id, req.body.ownerId])].sort()) await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [id]);
      const [box] = await tx.query("SELECT * FROM mailboxes WHERE id=$1 FOR UPDATE", [req.params.id]);
      if (!box || box.owner_id !== snapshot.owner_id) throw badRequest("邮箱归属刚刚发生变化，请重试");
      const [target] = await tx.query("SELECT * FROM users WHERE id=$1 AND NOT disabled AND role<>'kyc_viewer' FOR UPDATE", [req.body.ownerId]);
      if (!box || !target) throw badRequest("邮箱或目标成员不可用");
      const [usage] = await tx.query("SELECT count(*)::int n,COALESCE(sum(used_bytes),0)::bigint bytes FROM mailboxes WHERE owner_id=$1", [target.id]);
      if (box.owner_id !== target.id && (usage.n >= target.mailbox_quota || Number(usage.bytes) + Number(box.used_bytes) > Number(target.storage_quota))) throw badRequest("目标成员配额不足");
      await tx.query("UPDATE mailboxes SET owner_id=$2 WHERE id=$1", [box.id, target.id]);
      await tx.query("UPDATE business_accounts SET owner_id=$2,revision=revision+1 WHERE mailbox_id=$1", [box.id, target.id]);
      await tx.query("DELETE FROM certification_grants WHERE account_id IN (SELECT id FROM business_accounts WHERE mailbox_id=$1)", [box.id]);
      await tx.query("DELETE FROM mailbox_grants WHERE mailbox_id=$1", [box.id]);
      await tx.query("UPDATE shares SET revoked=true WHERE mailbox_id=$1", [box.id]);
      await audit(tx, actor.id, "mailbox.transfer", box.id, { previousOwner: box.owner_id, newOwner: target.id });
    });
    return { success: true };
  });
}
