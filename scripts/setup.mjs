import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
if (existsSync(".env")) { console.log(".env 已存在，未覆盖"); process.exit(0); }
let source = readFileSync(".env.example", "utf8")
  .replace("REPLACE_WITH_64_HEX_CHARACTERS", randomBytes(32).toString("hex"))
  .replace("REPLACE_WITH_A_LONG_UNIQUE_PASSWORD", randomBytes(18).toString("base64url"));
if (process.argv.includes("--local")) source = source.replace("DATABASE_MODE=postgres", "DATABASE_MODE=pglite");
writeFileSync(".env", source, { mode: 0o600 });
console.log(".env 已生成。管理员密码保存在 .env 的 BOOTSTRAP_PASSWORD，请自行查看；不要提交此文件。");
