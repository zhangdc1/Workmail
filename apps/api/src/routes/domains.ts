import type { FastifyInstance } from "fastify";
import { Type as T } from "@sinclair/typebox";
import { Resolver } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { domains } from "../db/schema.js";
import { toCamel } from "../db/index.js";
import type { Context } from "../context.js";
import { audit, requireAdmin, requireMailUser } from "../context.js";
import { normalizeDomain, notFound } from "../security.js";
const idParams = T.Object({ id: T.String({ format: "uuid" }) });
export async function domainRoutes(app: FastifyInstance, { db, config }: Context) {
  app.get("/api/v1/domains", async req => {
    const user = requireMailUser(req);
    const items = await db.query(`SELECT d.*,(SELECT count(*)::int FROM mailboxes m WHERE m.domain_id=d.id
      AND ($1='admin' OR m.owner_id=$2)) mailbox_count FROM domains d
      WHERE $1='admin' OR EXISTS(SELECT 1 FROM domain_grants g WHERE g.domain_id=d.id AND g.user_id=$2)
      OR EXISTS(SELECT 1 FROM mailboxes m WHERE m.domain_id=d.id AND m.owner_id=$2) ORDER BY d.name`, [user.role, user.id]);
    return { items: items.map(toCamel), mxHost: config.mailHostname };
  });
  app.post<{ Body: { names: string[] } }>("/api/v1/domains", {
    schema: { tags: ["domains"], body: T.Object({ names: T.Array(T.String({ maxLength: 253 }), { minItems: 1, maxItems: 200 }) }, { additionalProperties: false }) },
  }, async req => {
    const user = requireAdmin(req);
    const result = [];
    for (const input of req.body.names) {
      try {
        const name = normalizeDomain(input);
        const [existing] = await db.query("SELECT id FROM domains WHERE name=$1", [name]);
        if (existing) { result.push({ input, state: "skipped", id: existing.id }); continue; }
        const id = randomUUID();
        await db.orm.insert(domains).values({ id, name });
        await audit(db, user.id, "domain.create", id, { name });
        result.push({ input, state: "created", id });
      } catch (error) { result.push({ input, state: "failed", error: error instanceof Error ? error.message : "导入失败" }); }
    }
    return { items: result };
  });
  app.patch<{ Params: { id: string }; Body: { state: string } }>("/api/v1/domains/:id", {
    schema: { tags: ["domains"], params: idParams, body: T.Object({ state: T.Union([T.Literal("active"), T.Literal("retired"), T.Literal("disabled")]) }, { additionalProperties: false }) },
  }, async req => {
    const user = requireAdmin(req);
    const [row] = await db.query("UPDATE domains SET state=$2 WHERE id=$1 RETURNING *", [req.params.id, req.body.state]);
    if (!row) throw notFound();
    await audit(db, user.id, "domain.state", row.id, { state: row.state }); return toCamel(row);
  });
  app.post<{ Params: { id: string } }>("/api/v1/domains/:id/check", {
    schema: { tags: ["domains"], params: idParams }, config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  }, async req => {
    requireAdmin(req);
    const [row] = await db.query("SELECT * FROM domains WHERE id=$1", [req.params.id]); if (!row) throw notFound();
    const resolver = new Resolver({ timeout: 4000, tries: 1 });
    const result: Record<string, unknown> = { checkedAt: new Date().toISOString(), mxReady: false };
    try {
      const mx = await resolver.resolveMx(row.name);
      result.mx = mx.map(v => `${v.priority} ${v.exchange}`);
      result.mxReady = mx.some(v => v.exchange.toLowerCase().replace(/\.$/, "") === config.mailHostname.toLowerCase());
      result.addresses = await resolver.resolve4(config.mailHostname).catch(() => []);
      result.note = "仅检查 DNS；公网端口和实际投递需独立外部邮件验证";
    } catch { result.error = "未查到有效 MX 或 DNS 查询超时"; }
    await db.query("UPDATE domains SET dns=$2 WHERE id=$1", [row.id, JSON.stringify(result)]);
    return result;
  });
}
