import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import type { Context } from "./context.js";
import { readCredential, normalizeProxy, cleanKycUrl } from "./credentials.js";
// Independently reviewed, secret-free extraction logic from the reference project.
// @ts-expect-error The reference module is intentionally retained as an ES module.
import { collectClaudeKyc } from "../../../integrations/claude-browser-kyc.mjs";
export interface QueryResult {
  ok: boolean; state: string; message: string; snapshot?: any;
}
export type AccountTransport = (account: any, ctx: Context, requireProxy?: boolean) => Promise<QueryResult>;
export const queryUpstream: AccountTransport = async (account, ctx, requireProxy = false) => {
  if (account.platform !== "claude") return { ok: false, state: "unsupported_platform", message: "此平台目前仅支持台账管理，不调用其他平台的会话接口" };
  const session = await readCredential(ctx, account.id, "session");
  if (!session) return { ok: false, state: "session_missing", message: "尚未保存 Session key" };
  if (session.metadata.expiresAt && Date.parse(session.metadata.expiresAt) <= Date.now()) return { ok: false, state: "session_invalid", message: "保存的会话已到期，请重新登录" };
  const proxyCredential = await readCredential(ctx, account.id, "proxy");
  if (requireProxy && !proxyCredential) return { ok: false, state: "proxy_unconfigured", message: "此任务要求账号代理，未发起查询" };
  let proxy = "";
  if (proxyCredential) {
    try { proxy = await normalizeProxy(proxyCredential.value, ctx.config.allowPrivateProxy); }
    catch { return { ok: false, state: "proxy_failed", message: "代理地址不可用，未回退直连" }; }
  }
  const child = spawn(ctx.config.python, [resolve("integrations/claude-http.py")], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, PYTHONIOENCODING: "utf-8" } });
  const lines = createInterface({ input: child.stdout });
  const pending: { resolve: (v: any) => void; reject: (e: Error) => void }[] = [];
  let failed = false;
  const abort = () => { failed = true; for (const p of pending.splice(0)) p.reject(new Error("transport_unavailable")); };
  child.on("error", abort); child.on("exit", abort);
  child.stderr.resume(); // Never log transport exceptions: may contain credentials.
  lines.on("line", line => {
    const next = pending.shift(); if (!next) return;
    try { next.resolve(JSON.parse(line)); } catch { next.reject(new Error("unknown_response")); }
  });
  const exchange = (payload: unknown) => new Promise<any>((resolve, reject) => {
    if (failed) return reject(new Error("transport_unavailable"));
    pending.push({ resolve, reject }); child.stdin.write(JSON.stringify(payload) + "\n");
  });
  child.stdin.on("error", abort);
  child.stdin.write(JSON.stringify({ sessionKey: session.value, proxy: proxy || null }) + "\n");
  const timeout = setTimeout(() => { child.kill(); abort(); }, 65000);
  let cookie = "sessionKeyLC";
  const getJson = async (path: string) => {
    const data = await exchange({ path, cookie });
    if (data.error) throw new Error(data.error);
    if (data.challenge) throw new Error("blocked");
    const upstreamCode = JSON.stringify(data.payload?.error || data.payload?.error_code || "").slice(0, 200);
    if (/account_(?:suspended|disabled|banned|deactivated)/.test(upstreamCode)) throw new Error("account_suspended");
    if (data.status === 401 || (data.status === 403 && /invalid_session|session_invalid|unauthorized/.test(upstreamCode))) throw new Error("session_invalid");
    if (data.status === 403 || data.status === 429) throw new Error("blocked");
    if (data.status !== 200 || !data.payload) throw new Error("unknown_response");
    return data.payload;
  };
  try {
    if (proxy) {
      const before = await exchange({ op: "egress" });
      if (!before.ip || before.error) throw new Error("proxy_failed");
      if (account.assigned_ip && before.ip !== account.assigned_ip) throw new Error("proxy_mismatch");
    }
    let organizations: unknown;
    for (const alias of ["sessionKeyLC", "sessionKeyV3LC", "sessionKey"]) {
      cookie = alias;
      try { organizations = await getJson("/api/organizations"); break; }
      catch (error) { if (!(error instanceof Error) || error.message !== "session_invalid" || alias === "sessionKey") throw error; }
    }
    const result = await collectClaudeKyc({
      expectedEmail: account.email, mode: "auto_link", preferredOrganization: account.organization_id || null,
      getJson: (path: string) => path === "/api/organizations" ? Promise.resolve(organizations) : getJson(path),
    });
    return result;
  } catch (error) {
    const state = error instanceof Error ? error.message : "unavailable";
    const messages: Record<string, string> = {
      session_invalid: "官网拒绝此会话，请登录官网核实或更新 Session key",
      account_suspended: "官网明确返回账号停用或封禁",
      blocked: "官网限制了本次请求，保留最近确认状态",
      proxy_failed: "账号代理连接或出口检测失败，未回退直连",
      proxy_mismatch: "代理出口与登记 IP 不一致，未发起账号查询",
      proxy_auth: "代理认证失败，未回退直连", proxy_timeout: "代理超时，未回退直连",
      proxy_connection_failed: "代理连接失败，未回退直连",
      transport_unavailable: "查询运行时未就绪或超时，请检查 Python 依赖",
    };
    return { ok: false, state: Object.hasOwn(messages, state) ? state : "network_unavailable", message: messages[state] || "未取得可信结果，保留最近确认状态" };
  } finally { clearTimeout(timeout); child.kill(); lines.close(); }
};
export function normalizeSnapshot(snapshot: any, email: string) {
  if (!snapshot || snapshot.email?.toLowerCase() !== email.toLowerCase()) throw new Error("identity_mismatch");
  const map: Record<string, string> = { verified: "passed", not_required: "not_required", in_progress: "pending", created: "pending", pending: "pending", denied: "denied", failed: "denied", expired: "expired" };
  const status = map[snapshot.kyc?.status]; if (!status) throw new Error("unknown_response");
  return {
    status, url: cleanKycUrl(snapshot.kyc.original_inquiry_url || snapshot.kyc.vendor_inquiry_url || ""),
    inquiry: String(snapshot.kyc.vendor_inquiry_id || "").slice(0, 100),
    organization: String(snapshot.organization_id || "").slice(0, 100),
  };
}
