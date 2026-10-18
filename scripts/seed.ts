import { randomUUID } from "node:crypto";
import { configuration } from "../apps/api/src/config.js";
import { connectDb } from "../apps/api/src/db/index.js";
import { createMailbox } from "../apps/api/src/routes/mailboxes.js";
import { ingestMail, parseMail } from "../apps/api/src/mail.js";
import type { User } from "../packages/shared/src/index.js";
const config = configuration();
if (config.secure || process.env.NODE_ENV === "production") throw new Error("生产环境禁止加载开发样例");
const db = await connectDb(config), ctx = { db, config };
try {
  const [owner] = await db.query("SELECT * FROM users WHERE role='admin' ORDER BY created_at LIMIT 1");
  if (!owner) throw new Error("请先执行 db:bootstrap");
  const user = { ...owner, id: owner.id, role: "admin" } as User;
  for (const name of ["studio.example.test", "orbit.example.test"]) {
    await db.query("INSERT INTO domains(id,name) VALUES($1,$2) ON CONFLICT(name) DO NOTHING", [randomUUID(), name]);
    const [domain] = await db.query("SELECT id FROM domains WHERE name=$1", [name]);
    for (const prefix of name.startsWith("studio") ? ["hello", "design", "accounts"] : ["team", "workspace"]) {
      const address = `${prefix}@${name}`;
      if (!(await db.query("SELECT id FROM mailboxes WHERE address=$1", [address])).length) await createMailbox(db, user, { address, label: ({ hello: "品牌与合作", design: "设计工作室", accounts: "账号事务", team: "团队协作", workspace: "我的工作空间" } as Record<string,string>)[prefix], tags: ["开发样例"] });
    }
  }
  const fixtures = [
    ["hello@studio.example.test", "InboxLab 团队", "welcome@example.test", "欢迎来到你的私有邮箱工作空间", "这是本地开发样例。你的邮件、域名与账号事务，都可以在这里井然有序地管理。"],
    ["design@studio.example.test", "Studio Design", "design@example.test", "设计周报：让每个细节，都恰到好处", "蓝白配色、克制的留白与清晰的信息层级。收件工作台已经准备就绪，开始你的专属工作流。"],
    ["accounts@studio.example.test", "测试验证服务", "verify@example.test", "Your verification code: 638201", "Your verification code is 638201. 此为开发样例，不对应任何真实账号。"],
    ["team@orbit.example.test", "Orbit Team", "team@example.test", "下一站，更高效的团队协作", "邀请团队成员，分配独立邮箱，把复杂事务变得简单。"],
  ];
  for (const [to, name, from, subject, text] of fixtures) {
    const body = Buffer.from(`Received: by local-fixture; seed-v1\r\nFrom: =?UTF-8?B?${Buffer.from(name).toString("base64")}?= <${from}>\r\nTo: ${to}\r\nSubject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<h2>${subject}</h2><p>${text}</p><p>仅用于本地开发预览。</p>`);
    const ids = await ingestMail(ctx, body, { from, recipients: [to] }); for (const id of ids) await parseMail(ctx, id);
  }
  console.log("开发样例已加载：两个 .test 域名、五个邮箱、四封样例邮件。未连接外部服务。");
} finally { await db.close(); }
