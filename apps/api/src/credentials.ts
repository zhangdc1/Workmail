import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { BlockList } from "node:net";
import { badRequest, seal, unseal } from "./security.js";
import type { Context } from "./context.js";
import type { Executor } from "./db/index.js";
const blocked = new BlockList();
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["100.64.0.0", 10], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(network, prefix, "ipv4");
// BlockList also matches IPv4 against IPv4-mapped IPv6 ranges. Keeping the
// families separate avoids ::ffff:0:0/96 accidentally rejecting every IPv4.
const blockedV6 = new BlockList();
blockedV6.addAddress("::", "ipv6"); blockedV6.addAddress("::1", "ipv6"); blockedV6.addSubnet("fc00::", 7, "ipv6"); blockedV6.addSubnet("fe80::", 10, "ipv6"); blockedV6.addSubnet("ff00::", 8, "ipv6"); blockedV6.addSubnet("::ffff:0:0", 96, "ipv6");
export function normalizeSession(input: string) {
  const raw = input.trim();
  const match = raw.match(/(?:^|[;\s])sessionKey(?:V3LC|LC)?=([A-Za-z0-9._~-]+)/);
  const value = match ? match[1] : raw;
  if (!/^[A-Za-z0-9._~-]{20,4096}$/.test(value)) throw badRequest("Session key 格式不正确");
  return value;
}
export async function normalizeProxy(input: string, allowPrivate = false) {
  let value = input.trim();
  if (!value.includes("://")) {
    const parts = value.split(":");
    if (parts.length === 4) value = `http://${encodeURIComponent(parts[2])}:${encodeURIComponent(parts[3])}@${parts[0]}:${parts[1]}`;
    else value = "http://" + value;
  }
  let url: URL; try { url = new URL(value); } catch { throw badRequest("代理格式不正确"); }
  const port = url.port || (url.protocol === "http:" ? "80" : url.protocol === "https:" ? "443" : "");
  if (!["http:", "https:", "socks5:"].includes(url.protocol) || !["", "/"].includes(url.pathname) || url.search || url.hash || !port) throw badRequest("使用 HTTP/HTTPS 代理或带端口的 SOCKS5 代理");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const answers = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true }).catch(() => []);
  if (!answers.length) throw badRequest("代理主机无法解析");
  if (!allowPrivate && answers.some(x => x.family === 6 ? blockedV6.check(x.address, "ipv6") : blocked.check(x.address, "ipv4"))) throw badRequest("代理必须使用可公开路由的地址");
  // Pin numeric host after validation to prevent DNS rebinding between checks.
  url.hostname = answers[0].family === 6 ? `[${answers[0].address}]` : answers[0].address;
  const auth = url.username ? `${url.username}${url.password ? ":" + url.password : ""}@` : "";
  return `${url.protocol}//${auth}${url.hostname}:${port}`;
}
export async function saveCredential(tx: Executor, accountId: string, kind: "session" | "proxy", value: string, ctx: Context, metadata: unknown = {}) {
  const ciphertext = seal(value, ctx.config.encryptionKey, `${accountId}:${kind}`);
  await tx.query(`INSERT INTO credentials(account_id,kind,ciphertext,metadata) VALUES($1,$2,$3,$4)
    ON CONFLICT(account_id,kind) DO UPDATE SET ciphertext=excluded.ciphertext,metadata=excluded.metadata,updated_at=now()`,
  [accountId, kind, ciphertext, JSON.stringify(metadata)]);
  await tx.query("UPDATE business_accounts SET revision=revision+1 WHERE id=$1", [accountId]);
}
export async function readCredential(ctx: Context, id: string, kind: string) {
  const [row] = await ctx.db.query("SELECT * FROM credentials WHERE account_id=$1 AND kind=$2", [id, kind]);
  return row ? { value: unseal(row.ciphertext, ctx.config.encryptionKey, `${id}:${kind}`), metadata: row.metadata } : null;
}
export function cleanKycUrl(value: string) {
  if (!value) return "";
  let u: URL; try { u = new URL(value); } catch { throw badRequest("认证链接格式不正确"); }
  if (u.protocol !== "https:" || !["withpersona.com", "inquiry.withpersona.com"].includes(u.hostname) || u.username || u.password || u.port ||
    !(u.pathname === "/verify" || /^\/l\/[A-Za-z0-9_-]{4,200}$/.test(u.pathname))) throw badRequest("只接受 Persona 官方认证链接");
  if (u.pathname === "/verify" && !u.searchParams.get("inquiry-id") && !u.searchParams.get("code")) throw badRequest("认证链接缺少任务标识");
  u.searchParams.delete("session-token"); u.hash = ""; return u.href;
}
