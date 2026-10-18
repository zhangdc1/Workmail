import { resolve } from "node:path";
export interface Config {
  host: string; port: number; origin: string; databaseUrl: string; databaseMode: string;
  pgliteDir: string; dataDir: string; encryptionKey: string; secure: boolean;
  smtpHost: string; smtpPort: number; smtpMaxBytes: number; mailHostname: string;
  sessionHours: number; python: string; allowPrivateProxy: boolean; trustedProxies: string[];
}
export function configuration(overrides: Partial<Config> = {}): Config {
  const config: Config = {
    host: process.env.HOST || "127.0.0.1", port: Number(process.env.PORT || 3001),
    origin: process.env.PUBLIC_ORIGIN || "http://localhost:5173",
    databaseUrl: process.env.DATABASE_URL || "", databaseMode: process.env.DATABASE_MODE || "postgres",
    pgliteDir: resolve(process.env.PGLITE_DIR || "./data/pglite"),
    dataDir: resolve(process.env.DATA_DIR || "./data/mail"),
    encryptionKey: process.env.ENCRYPTION_KEY || "", secure: process.env.NODE_ENV === "production",
    smtpHost: process.env.SMTP_HOST || "127.0.0.1", smtpPort: Number(process.env.SMTP_PORT || 2525),
    smtpMaxBytes: Number(process.env.SMTP_MAX_BYTES || 10485760),
    mailHostname: process.env.MAIL_HOSTNAME || "mx.example.com",
    sessionHours: Number(process.env.SESSION_HOURS || 24),
    python: process.env.INTEGRATION_PYTHON || (process.platform === "win32" ? "python" : "python3"),
    allowPrivateProxy: process.env.ALLOW_PRIVATE_PROXY === "true",
    trustedProxies: (process.env.TRUST_PROXY_CIDRS || "").split(",").map(x => x.trim()).filter(Boolean), ...overrides,
  };
  if (!/^[0-9a-f]{64}$/i.test(config.encryptionKey)) throw new Error("ENCRYPTION_KEY 必须为独立的 32 字节 hex 密钥；运行 node scripts/setup.mjs 生成");
  const url = new URL(config.origin);
  if (url.origin !== config.origin || url.username || url.password) throw new Error("PUBLIC_ORIGIN 必须是无路径的 origin");
  if (config.secure && url.protocol !== "https:") throw new Error("生产环境必须启用 HTTPS");
  if (config.secure && config.databaseMode !== "postgres") throw new Error("生产环境只支持 PostgreSQL");
  return config;
}
