import { randomUUID } from "node:crypto";
import { configuration } from "../apps/api/src/config.js";
import { connectDb } from "../apps/api/src/db/index.js";
import { users } from "../apps/api/src/db/schema.js";
import { passwordHash } from "../apps/api/src/security.js";
const username = process.env.BOOTSTRAP_USERNAME || "admin";
const password = process.env.BOOTSTRAP_PASSWORD || "";
if (password.length < 12 || password.startsWith("REPLACE_")) throw new Error("设置至少 12 位的 BOOTSTRAP_PASSWORD");
const db = await connectDb(configuration());
try {
  const [existing] = await db.query("SELECT id FROM users WHERE username=$1", [username]);
  if (existing) console.log("账号已存在，未重置密码");
  else {
    await db.orm.insert(users).values({ id: randomUUID(), username, passwordHash: await passwordHash(password), role: "admin" });
    console.log("管理员已创建；密码不会输出到日志");
  }
} finally { await db.close(); }
