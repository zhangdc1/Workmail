import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { Context } from "./context.js";
import { parseMail } from "./mail.js";
import { configuration } from "./config.js";
import { connectDb } from "./db/index.js";
import { normalizeSnapshot, queryUpstream, type AccountTransport } from "./integration.js";
export async function checkAccount(ctx: Context, id: string, ownerId: string | null, requireProxy = false, transport: AccountTransport = queryUpstream) {
  const token = randomUUID();
  const lock = await ctx.db.query(`INSERT INTO account_query_locks(account_id,token,expires_at) VALUES($1,$2,now()+interval '90 seconds')
    ON CONFLICT(account_id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at
    WHERE account_query_locks.expires_at<now() RETURNING token`, [id, token]);
  if (!lock.length) return { id, state: "busy", message: "此账号已有查询任务" };
  try {
    const [account] = await ctx.db.query(`SELECT a.* FROM business_accounts a JOIN users u ON u.id=$2
      WHERE a.id=$1 AND NOT u.disabled AND u.role<>'kyc_viewer' AND (u.role='admin' OR a.owner_id=u.id)`, [id, ownerId]);
    if (!account) return { id, state: "skipped", message: "账号已转移或当前操作者失去权限" };
    const result = await transport(account, ctx, requireProxy);
    return ctx.db.transaction(async tx => {
      const [current] = await tx.query("SELECT * FROM business_accounts WHERE id=$1 FOR UPDATE", [id]);
      if (!current || current.revision !== account.revision || current.owner_id !== account.owner_id) return { id, state: "stale", message: "凭据或归属已变化，丢弃旧结果" };
      const [validLock] = await tx.query("SELECT 1 FROM account_query_locks WHERE account_id=$1 AND token=$2 AND expires_at>now()", [id, token]);
      if (!validLock) return { id, state: "stale", message: "查询锁已过期，丢弃结果" };
      if (result.ok) {
        const normalized = normalizeSnapshot(result.snapshot, account.email);
        await tx.query(`UPDATE business_accounts SET kyc_status=$2,kyc_url=$3,inquiry_id=$4,organization_id=$5,
          last_checked_at=now(),sync_state='ok',sync_message=$6,
          kyc_passed_at=CASE WHEN $2='passed' THEN COALESCE(kyc_passed_at,now()) ELSE kyc_passed_at END WHERE id=$1`,
        [id, normalized.status, normalized.url, normalized.inquiry, normalized.organization, result.message || ""]);
        await tx.query("INSERT INTO certification_events(id,account_id,actor_id,source,status,detail) VALUES($1,$2,$3,'server',$4,$5)",
          [randomUUID(), id, ownerId, normalized.status, JSON.stringify({ message: result.message || "", url: normalized.url })]);
      } else {
        // Session errors are not KYC denial; network failure must not overwrite
        // the last confirmed certification or mark the account banned.
        await tx.query(`UPDATE business_accounts SET sync_state=$2,sync_message=$3,last_checked_at=now(),
          suspended=CASE WHEN $2='account_suspended' THEN true ELSE suspended END WHERE id=$1`, [id, result.state, result.message]);
        await tx.query("INSERT INTO certification_events(id,account_id,actor_id,source,status,detail) VALUES($1,$2,$3,'server',$4,$5)",
          [randomUUID(), id, ownerId, result.state, JSON.stringify({ message: result.message })]);
      }
      return { id, state: result.ok ? "success" : result.state, message: result.message || "" };
    });
  } finally { await ctx.db.query("DELETE FROM account_query_locks WHERE account_id=$1 AND token=$2", [id, token]); }
}
export async function runOneJob(ctx: Context, kinds = ["parse_mail", "query_accounts"], transport: AccountTransport = queryUpstream) {
  const runToken = randomUUID();
  const job = await ctx.db.transaction(async tx => {
    // User-facing queries are never automatically replayed after a crash.
    await tx.query("UPDATE jobs SET state='failed',error='Worker 中断，请手动重新查询',updated_at=now() WHERE kind='query_accounts' AND state='running' AND lease_until<now()");
    await tx.query("UPDATE jobs SET state='queued',run_token=NULL WHERE kind='parse_mail' AND state='running' AND lease_until<now()");
    const [row] = await tx.query("SELECT * FROM jobs WHERE state='queued' AND kind=ANY($1::text[]) ORDER BY CASE WHEN kind='parse_mail' THEN 0 ELSE 1 END,created_at FOR UPDATE SKIP LOCKED LIMIT 1", [kinds]);
    if (!row) return null;
    await tx.query("UPDATE jobs SET state='running',attempts=attempts+1,lease_until=now()+interval '120 seconds',run_token=$2,updated_at=now() WHERE id=$1", [row.id, runToken]);
    return row;
  });
  if (!job) return false;
  const heartbeat = setInterval(() => void ctx.db.query("UPDATE jobs SET lease_until=now()+interval '120 seconds' WHERE id=$1 AND run_token=$2 AND state='running'", [job.id, runToken]).catch(() => {}), 15000);
  try {
    if (job.cancel_requested) {
      await ctx.db.query("UPDATE jobs SET state='cancelled',updated_at=now() WHERE id=$1 AND run_token=$2", [job.id, runToken]); return true;
    }
    let result: unknown = null, cancelled = false;
    if (job.kind === "parse_mail") {
      await parseMail(ctx, job.payload.messageId); result = { parsed: true };
    } else if (job.kind === "query_accounts") {
      const results: unknown[] = [];
      for (const id of job.payload.ids) {
        const [latest] = await ctx.db.query("SELECT cancel_requested FROM jobs WHERE id=$1 AND run_token=$2", [job.id, runToken]);
        if (!latest || latest.cancel_requested) { cancelled = true; break; }
        results.push(await checkAccount(ctx, id, job.owner_id, job.payload.requireProxy || false, transport));
        await ctx.db.query("UPDATE jobs SET progress=$2,result=$3,updated_at=now() WHERE id=$1 AND run_token=$4", [job.id, results.length, JSON.stringify(results), runToken]);
        if (results.length < job.payload.ids.length) await new Promise(r => setTimeout(r, 1000));
      }
      result = results;
    } else throw new Error("Unknown job type");
    await ctx.db.query("UPDATE jobs SET state=$2,result=$3,progress=CASE WHEN $2='completed' THEN total ELSE progress END,updated_at=now(),lease_until=NULL WHERE id=$1 AND run_token=$4",
      [job.id, cancelled ? "cancelled" : "completed", JSON.stringify(result), runToken]);
  } catch {
    await ctx.db.query("UPDATE jobs SET state='failed',error='处理失败；请查看相关记录并手动重试',updated_at=now(),lease_until=NULL WHERE id=$1 AND run_token=$2", [job.id, runToken]);
  } finally { clearInterval(heartbeat); }
  return true;
}
async function main() {
  const config = configuration(), db = await connectDb(config), ctx = { config, db };
  let stopped = false; const sleep = () => new Promise(r => setTimeout(r, 1000));
  const pulse = async () => { await db.query("INSERT INTO service_heartbeats(name) VALUES('worker') ON CONFLICT(name) DO UPDATE SET updated_at=now()"); };
  await pulse(); const timer = setInterval(() => void pulse().catch(() => {}), 15000);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { stopped = true; });
  // Dedicated loops prevent a slow third-party account request blocking mail parsing.
  const loop = async (kind: string) => { while (!stopped) { if (!await runOneJob(ctx, [kind]).catch(() => false)) await sleep(); } };
  await Promise.all([loop("parse_mail"), loop("query_accounts")]);
  clearInterval(timer); await db.close();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
