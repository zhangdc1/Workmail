import type { FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import type { Database, Executor, Row } from "./db/index.js";
import type { User } from "../../../packages/shared/src/index.js";
import { randomUUID } from "node:crypto";
import { forbidden, notFound } from "./security.js";
export interface Context { db: Database; config: Config }
declare module "fastify" {
  interface FastifyRequest { user: User | null; csrf: string | null; sessionHash: string | null; extensionAuth: boolean }
}
export function requireUser(req: FastifyRequest): User {
  if (!req.user) throw forbidden(); return req.user;
}
export function requireAdmin(req: FastifyRequest) {
  const user = requireUser(req); if (user.role !== "admin") throw forbidden(); return user;
}
export function requireMailUser(req: FastifyRequest) {
  const user = requireUser(req); if (user.role === "kyc_viewer") throw forbidden(); return user;
}
export async function mailboxAccess(db: Executor, user: User, id: string, lock = false): Promise<Row> {
  if (user.role === "kyc_viewer") throw forbidden();
  const [box] = await db.query(`SELECT m.* FROM mailboxes m WHERE m.id=$1 AND
    ($2='admin' OR m.owner_id=$3 OR EXISTS(SELECT 1 FROM mailbox_grants g WHERE g.mailbox_id=m.id AND g.user_id=$3))${lock ? " FOR UPDATE OF m" : ""}`,
  [id, user.role, user.id]);
  if (!box) throw notFound(); return box;
}
export async function accountAccess(db: Executor, user: User, id: string) {
  const [account] = await db.query(`SELECT * FROM business_accounts a WHERE id=$1 AND
    ($2='admin' OR ($2<>'kyc_viewer' AND owner_id=$3) OR ($2='kyc_viewer' AND EXISTS(SELECT 1 FROM certification_grants g WHERE g.account_id=a.id AND g.user_id=$3)))`, [id, user.role, user.id]);
  if (!account) throw notFound(); return account;
}
export async function audit(db: Executor, actor: string | null, action: string, target: string, detail: unknown = {}) {
  await db.query("INSERT INTO audit_events(id,actor_id,action,target_id,detail) VALUES($1,$2,$3,$4,$5)", [randomUUID(), actor, action, target, JSON.stringify(detail)]);
}
export function paging(input: unknown) {
  const query = input as Record<string, string>;
  const page = Math.max(1, Math.min(100000, Number(query.page) || 1));
  const pageSize = Math.max(1, Math.min(200, Number(query.pageSize) || 50));
  return { page: Math.floor(page), pageSize: Math.floor(pageSize), offset: (Math.floor(page) - 1) * Math.floor(pageSize), q: (query.q || "").slice(0, 200), query };
}
export async function enqueue(db: Executor, kind: string, ownerId: string | null, payload: unknown, total = 1) {
  const id = randomUUID();
  await db.query("INSERT INTO jobs(id,kind,owner_id,payload,total) VALUES($1,$2,$3,$4,$5)", [id, kind, ownerId, JSON.stringify(payload), total]);
  return id;
}
