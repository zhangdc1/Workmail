import type { FastifyInstance } from "fastify";
import { Type as T } from "@sinclair/typebox";
import type { Context } from "../context.js";
import { requireAdmin, requireMailUser, requireUser, paging } from "../context.js";
import { toCamel } from "../db/index.js";
import { notFound } from "../security.js";
import { statfs } from "node:fs/promises";
export async function dashboardRoutes(app: FastifyInstance, { db, config }: Context) {
  app.get("/api/v1/dashboard", async req => {
    const user = requireMailUser(req);
    const [counts] = await db.query(`SELECT
      (SELECT count(*)::int FROM domains d WHERE $1='admin' OR EXISTS(SELECT 1 FROM mailboxes b WHERE b.domain_id=d.id AND b.owner_id=$2)) domains,
      count(*)::int mailboxes,COALESCE(sum(b.used_bytes),0)::bigint used_bytes,
      (SELECT count(*)::int FROM messages m JOIN mailboxes x ON x.id=m.mailbox_id WHERE $1='admin' OR x.owner_id=$2) messages,
      (SELECT count(*)::int FROM messages m JOIN mailboxes x ON x.id=m.mailbox_id WHERE NOT m.is_read AND ($1='admin' OR x.owner_id=$2)) unread,
      (SELECT count(*)::int FROM messages m JOIN mailboxes x ON x.id=m.mailbox_id WHERE m.received_at>=date_trunc('day',now()) AND ($1='admin' OR x.owner_id=$2)) received_today,
      (SELECT count(*)::int FROM business_accounts a WHERE $1='admin' OR a.owner_id=$2) accounts,
      (SELECT count(*)::int FROM business_accounts a WHERE a.kyc_status='pending' AND ($1='admin' OR a.owner_id=$2)) pending,
      (SELECT count(*)::int FROM business_accounts a WHERE a.kyc_status='passed' AND ($1='admin' OR a.owner_id=$2)) passed
      FROM mailboxes b WHERE $1='admin' OR b.owner_id=$2`, [user.role, user.id]);
    const daily = await db.query(`SELECT to_char(bucket,'MM/DD') AS "day",
      (SELECT count(*)::int FROM messages m JOIN mailboxes b ON b.id=m.mailbox_id WHERE m.received_at>=bucket AND m.received_at<bucket+interval '1 day'
      AND ($1='admin' OR b.owner_id=$2)) AS count FROM generate_series(date_trunc('day',now())-interval '6 days',date_trunc('day',now()),interval '1 day') AS series(bucket)`, [user.role, user.id]);
    const heartbeats = await db.query("SELECT name,updated_at>now()-interval '60 seconds' alive FROM service_heartbeats");
    const alive = (name: string) => heartbeats.find(x => x.name === name)?.alive ? "online" : "unknown";
    return { ...toCamel<Record<string, unknown>>(counts), usedBytes: Number(counts.used_bytes), daily, services: { database: "online", receiver: alive("receiver"), worker: alive("worker") } };
  });
  app.get("/api/v1/system", async req => {
    requireAdmin(req);
    const heartbeats = await db.query("SELECT * FROM service_heartbeats ORDER BY name");
    const disk = await statfs(config.dataDir).then(s => ({
      totalBytes: s.blocks * s.bsize, availableBytes: s.bavail * s.bsize,
      warning: s.bavail * s.bsize < 2 * 1024 ** 3 || (s.blocks > 0 && s.bavail / s.blocks < 0.1),
    })).catch(() => null);
    const capacity = await db.query(`SELECT id,address,used_bytes,quota_bytes FROM mailboxes
      WHERE used_bytes>=quota_bytes*0.9 ORDER BY used_bytes DESC LIMIT 50`);
    return { version: "1.0.0", mailHostname: config.mailHostname, origin: config.origin, databaseMode: config.databaseMode,
      heartbeats: heartbeats.map(toCamel), retention: "manual", receiveOnly: true, disk, capacityAlerts: capacity.map(toCamel) };
  });
  app.get("/api/v1/audit", async req => {
    requireAdmin(req); const { page, pageSize, offset } = paging(req.query);
    const [total] = await db.query("SELECT count(*)::int n FROM audit_events");
    const items = await db.query("SELECT e.*,u.username actor FROM audit_events e LEFT JOIN users u ON u.id=e.actor_id ORDER BY e.created_at DESC LIMIT $1 OFFSET $2", [pageSize, offset]);
    return { items: items.map(toCamel), page, pageSize, total: total.n };
  });
  app.get("/api/v1/tasks", async req => {
    const user = requireUser(req); const { page, pageSize, offset } = paging(req.query);
    const items = await db.query(`SELECT id,kind,state,progress,total,result,error,cancel_requested,created_at FROM jobs
      WHERE owner_id IS NOT NULL AND ($1='admin' OR owner_id=$2) ORDER BY created_at DESC LIMIT $3 OFFSET $4`, [user.role, user.id, pageSize, offset]);
    return { items: items.map(toCamel), page, pageSize };
  });
  app.post<{ Params: { id: string } }>("/api/v1/tasks/:id/cancel", { schema: { tags: ["tasks"], params: T.Object({ id: T.String({ format: "uuid" }) }) } }, async req => {
    const user = requireUser(req);
    const rows = await db.query("UPDATE jobs SET cancel_requested=true WHERE id=$1 AND ($2='admin' OR owner_id=$3) AND owner_id IS NOT NULL RETURNING id", [req.params.id, user.role, user.id]);
    if (!rows.length) throw notFound(); return { success: true };
  });
  app.get("/api/v1/events", async (req, reply) => {
    const user = requireUser(req);
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" });
    const send = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("connected", { at: new Date().toISOString() });
    let previous = "", running = false;
    const timer = setInterval(() => {
      if (running) return; running = true;
      void (async () => {
        const [session] = await db.query("SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=$1 AND expires_at>now() AND NOT u.disabled", [req.sessionHash]);
        if (!session) { send("expired", {}); reply.raw.end(); clearInterval(timer); return; }
        const [state] = await db.query(`SELECT count(*)::int n,max(m.updated_at) latest,
          (SELECT max(j.updated_at) FROM jobs j WHERE j.owner_id=$2) tasks
          FROM messages m JOIN mailboxes b ON b.id=m.mailbox_id WHERE $1='admin' OR b.owner_id=$2`, [user.role, user.id]);
        const next = JSON.stringify(state);
        if (next !== previous) { send("change", { at: new Date().toISOString() }); previous = next; }
        else reply.raw.write(": heartbeat\n\n");
      })().catch(() => { reply.raw.end(); clearInterval(timer); }).finally(() => { running = false; });
    }, 3000);
    req.raw.on("close", () => clearInterval(timer));
  });
}
