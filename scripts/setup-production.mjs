import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
if (existsSync(".env.production")) throw new Error(".env.production 已存在，未覆盖");
const hostname = process.argv[2], mailHostname = process.argv[3], email = process.argv[4];
if (!hostname || !mailHostname || !email || !/^[a-z0-9.-]+$/i.test(hostname) || !/^[a-z0-9.-]+$/i.test(mailHostname) || !/^[^@\s=]+@[^@\s=]+$/.test(email) || hostname === mailHostname) {
  throw new Error("用法：node scripts/setup-production.mjs mail.example.com mx.example.com admin@example.com（网页和 SMTP 必须不同主机名）");
}
const random = () => randomBytes(24).toString("hex");
writeFileSync(".env.production", `NODE_ENV=production
PUBLIC_ORIGIN=https://${hostname}
WEB_HOSTNAME=${hostname}
MAIL_HOSTNAME=${mailHostname}
ACME_EMAIL=${email}
POSTGRES_PASSWORD=${random()}
POSTFIX_PASSWORD=${random()}
ENCRYPTION_KEY=${randomBytes(32).toString("hex")}
BOOTSTRAP_USERNAME=admin
BOOTSTRAP_PASSWORD=${random()}
SESSION_HOURS=24
SMTP_PORT=2525
SMTP_MAX_BYTES=10485760
ALLOW_PRIVATE_PROXY=false
`, { mode: 0o600 });
console.log("已创建 .env.production，随机密码和独立密钥仅写入文件，未输出到日志。");
