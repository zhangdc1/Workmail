import { randomBytes, createHash, scrypt as scryptCb, timingSafeEqual, createCipheriv, createDecipheriv } from "node:crypto";
import { promisify } from "node:util";
import { domainToASCII } from "node:url";
const scrypt = promisify(scryptCb);
export const secret = () => randomBytes(32).toString("base64url");
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  const digest = await scrypt(password, salt, 64) as Buffer;
  return `scrypt$${salt}$${digest.toString("hex")}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [kind, salt, value] = encoded.split("$");
  if (kind !== "scrypt" || !salt || !/^[0-9a-f]{128}$/.test(value || "")) return false;
  const digest = await scrypt(password, salt, 64) as Buffer;
  return timingSafeEqual(digest, Buffer.from(value, "hex"));
}
export function seal(value: string, key: string, context: string) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}
export function unseal(encoded: string, key: string, context: string) {
  const [version, iv, tag, value] = encoded.split(".");
  if (version !== "v1") throw new Error("未知加密版本");
  const cipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), Buffer.from(iv, "base64url"));
  cipher.setAAD(Buffer.from(context)); cipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([cipher.update(Buffer.from(value, "base64url")), cipher.final()]).toString("utf8");
}
export function normalizeDomain(input: string) {
  const domain = domainToASCII(input.trim().toLowerCase().replace(/\.$/, ""));
  if (!domain || domain.length > 253 || !domain.includes(".") ||
    !domain.split(".").every(x => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x)) ||
    /^\d+(?:\.\d+){3}$/.test(domain)) throw badRequest("域名格式不正确");
  return domain;
}
export function normalizeEmail(input: string) {
  const pieces = input.trim().toLowerCase().split("@");
  if (pieces.length !== 2 || !/^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/.test(pieces[0])) throw badRequest("邮箱地址格式不正确");
  return pieces[0] + "@" + normalizeDomain(pieces[1]);
}
export class HttpError extends Error {
  constructor(public statusCode: number, message: string, public code = "REQUEST_FAILED") { super(message); }
}
export const badRequest = (message: string) => new HttpError(400, message, "VALIDATION_ERROR");
export const forbidden = () => new HttpError(403, "没有操作此资源的权限", "FORBIDDEN");
export const notFound = () => new HttpError(404, "资源不存在或不可访问", "NOT_FOUND");
