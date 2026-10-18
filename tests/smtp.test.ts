import { beforeAll, afterAll, it, expect } from "vitest";
import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectDb } from "../apps/api/src/db/index.js";
import { configuration } from "../apps/api/src/config.js";
import { migrate } from "../apps/api/src/db/migrate.js";
import { makeSmtp } from "../apps/api/src/smtp.js";
import { createMailbox } from "../apps/api/src/routes/mailboxes.js";
import { passwordHash } from "../apps/api/src/security.js";
import type { User } from "../packages/shared/src/index.js";
const root = await mkdtemp(join(tmpdir(), "inboxlab-smtp-"));
const config = configuration({ encryptionKey: "cc".repeat(32), databaseMode: "pglite", pgliteDir: ":memory:", dataDir: root });
const db = await connectDb(config), ctx = { config, db };
let failStorage = false;
const server = makeSmtp({ ...ctx, db: { ...db, transaction: work => { if (failStorage) return Promise.reject(new Error("fixture storage failure")); return db.transaction(work); } } });
let port: number;
async function client() {
  const socket = connect(port, "127.0.0.1");
  socket.setEncoding("utf8"); socket.setTimeout(10000, () => socket.destroy());
  let pending: { resolve: (s: string) => void; reject: (e: Error) => void } | null = null, partial = "", batch = "", completed: string[] = [];
  socket.on("data", chunk => {
    partial += chunk;
    while (partial.includes("\n")) {
      const offset = partial.indexOf("\n"), line = partial.slice(0, offset + 1); partial = partial.slice(offset + 1); batch += line;
      if (/^\d{3} /.test(line)) { const value = batch; batch = ""; if (pending) { pending.resolve(value); pending = null; } else completed.push(value); }
    }
  });
  socket.on("error", error => { pending?.reject(error); pending = null; });
  const next = () => new Promise<string>((resolve, reject) => { if (completed.length) resolve(completed.shift()!); else pending = { resolve, reject }; });
  const greeting = await next(); expect(greeting.startsWith("220")).toBe(true);
  return {
    command: async (line: string) => { socket.write(line + "\r\n"); return next(); },
    close: () => socket.end(),
  };
}
beforeAll(async () => {
  await migrate(db);
  const uid = randomUUID(), domain = randomUUID();
  await db.query("INSERT INTO users(id,username,password_hash,role) VALUES($1,'smtp-admin',$2,'admin')", [uid, await passwordHash("smtp-test-password-123")]);
  await db.query("INSERT INTO domains(id,name) VALUES($1,'delivery.test')", [domain]);
  await createMailbox(db, { id: uid, role: "admin" } as User, { domainId: domain, prefix: "inbox" });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server as any).server.address().port;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); await rm(root, { recursive: true, force: true }); });
it("real SMTP RCPT rejects unknown and external recipients, ACK follows committed persistence", async () => {
  const s = await client();
  try {
    expect((await s.command("EHLO test.local")).startsWith("250")).toBe(true);
    expect((await s.command("MAIL FROM:<sender@external.test>")).startsWith("250")).toBe(true);
    expect((await s.command("RCPT TO:<unknown@delivery.test>")).startsWith("550")).toBe(true);
    expect((await s.command("RCPT TO:<relay@external.test>")).startsWith("550")).toBe(true);
    expect((await s.command("RCPT TO:<inbox@delivery.test>")).startsWith("250")).toBe(true);
    expect((await s.command("DATA")).startsWith("354")).toBe(true);
    expect((await s.command("From: sender@external.test\r\nTo: forged@wrong.test\r\nSubject: Actual socket delivery\r\n\r\nTest\r\n.")).startsWith("250")).toBe(true);
    expect(await db.query("SELECT envelope_recipient FROM messages")).toEqual([{ envelope_recipient: "inbox@delivery.test" }]);
    await s.command("QUIT");
  } finally { s.close(); }
});
it("storage outage returns 451 instead of a false success; retry is accepted once", async () => {
  const raw = "Received: by fixture queued-copy\r\nSubject: Retry\r\n\r\nqueued copy\r\n.";
  const deliver = async () => {
    const s = await client();
    try {
      await s.command("EHLO test.local"); await s.command("MAIL FROM:<sender@external.test>"); await s.command("RCPT TO:<inbox@delivery.test>"); await s.command("DATA");
      const result = await s.command(raw); await s.command("QUIT"); return result;
    } finally { s.close(); }
  };
  failStorage = true; expect((await deliver()).startsWith("451")).toBe(true);
  expect((await db.query("SELECT count(*)::int n FROM messages"))[0].n).toBe(1);
  failStorage = false; expect((await deliver()).startsWith("250")).toBe(true); expect((await deliver()).startsWith("250")).toBe(true);
  expect((await db.query("SELECT count(*)::int n FROM messages"))[0].n).toBe(2);
});
