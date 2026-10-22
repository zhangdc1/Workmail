import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { configuration } from "../apps/api/src/config.js";
import { connectDb } from "../apps/api/src/db/index.js";
import { migrate } from "../apps/api/src/db/migrate.js";
import { makeApp } from "../apps/api/src/app.js";
import { passwordHash, seal, unseal } from "../apps/api/src/security.js";
import { ingestMail, parseMail, safeHtml, extractVerification, receivingMailbox } from "../apps/api/src/mail.js";
import { createMailbox } from "../apps/api/src/routes/mailboxes.js";
import { saveCredential, normalizeProxy } from "../apps/api/src/credentials.js";
import { checkAccount, runOneJob } from "../apps/api/src/worker.js";
import type { User } from "../packages/shared/src/index.js";
const root = await mkdtemp(join(tmpdir(), "inboxlab-test-"));
const config = configuration({ encryptionKey: "ab".repeat(32), databaseMode: "pglite", pgliteDir: ":memory:", dataDir: root, origin: "http://localhost:5173", secure: false });
const db = await connectDb(config), ctx = { config, db }, app = await makeApp(ctx);
const adminId = randomUUID(), aliceId = randomUUID(), bobId = randomUUID(), viewerId = randomUUID(), d1 = randomUUID(), d2 = randomUUID();
let admin: User, alice: User, aliceBox: any, bobBox: any, messageId: string, attachmentId: string, accountId: string;
type Auth = { cookie: string; csrf: string };
let a: Auth, b: Auth, v: Auth, ad: Auth;
const request = (method: any, url: string, auth?: Auth, payload?: any, extra: Record<string, string> = {}) => app.inject({ method, url: "/api/v1" + url, headers: { ...(auth ? { cookie: auth.cookie, "x-csrf-token": auth.csrf } : {}), ...extra }, ...(payload === undefined ? {} : { payload }) });
async function login(username: string) {
  const res = await request("POST", "/auth/login", undefined, { username, password: "test-password-012345" });
  expect(res.statusCode).toBe(200);
  return { cookie: String(res.headers["set-cookie"]).split(";")[0], csrf: res.json().csrf };
}
beforeAll(async () => {
  await migrate(db);
  const password = await passwordHash("test-password-012345");
  for (const [id, name, role] of [[adminId, "admin", "admin"], [aliceId, "alice", "member"], [bobId, "bob", "member"], [viewerId, "viewer", "kyc_viewer"]]) {
    await db.query("INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,$4)", [id, name, password, role]);
  }
  for (const [id, name] of [[d1, "alpha.test"], [d2, "beta.test"]]) await db.query("INSERT INTO domains(id,name) VALUES($1,$2)", [id, name]);
  await db.query("INSERT INTO domain_grants(user_id,domain_id) VALUES($1,$2)", [aliceId, d1]);
  admin = { id: adminId, role: "admin" } as User; alice = { id: aliceId, role: "member" } as User;
  aliceBox = await createMailbox(db, admin, { domainId: d1, prefix: "alice", ownerId: aliceId });
  bobBox = await createMailbox(db, admin, { domainId: d2, prefix: "bob", ownerId: bobId });
  [a, b, v, ad] = await Promise.all([login("alice"), login("bob"), login("viewer"), login("admin")]);
  accountId = (await db.query("SELECT id FROM business_accounts WHERE mailbox_id=$1", [aliceBox.id]))[0].id;
});
afterAll(async () => { await app.close(); await db.close(); await rm(root, { recursive: true, force: true }); });
describe("authentication and validation", () => {
  it("serves authenticated Swagger and accurate OpenAPI auth/query documentation", async () => {
    expect((await request("GET", "/openapi.json")).statusCode).toBe(401);
    const res = await request("GET", "/openapi.json", ad);
    expect(res.statusCode, res.body).toBe(200);
    const spec = res.json();
    expect(spec.components.securitySchemes.csrfToken.name).toBe("X-CSRF-Token");
    expect(spec.paths["/api/v1/auth/login"].post.security).toEqual([]);
    expect(spec.paths["/api/v1/mailboxes"].post.security).toEqual([{ cookieAuth: [], csrfToken: [] }]);
    expect(spec.paths["/api/v1/messages"].get.parameters.map((p: any) => p.name)).toEqual(
      expect.arrayContaining(["mailboxId", "filter", "pageSize", "q"]),
    );
    const swagger = await app.inject({ method: "GET", url: "/api/docs/", headers: { cookie: ad.cookie } });
    expect(swagger.statusCode).toBe(200);
    expect(swagger.body).toContain("swagger");
  });
  it("requires session and CSRF; rejects foreign origin", async () => {
    expect((await request("GET", "/mailboxes")).statusCode).toBe(401);
    expect((await request("POST", "/domains", { ...ad, csrf: "invalid" }, { names: ["evil.test"] })).statusCode).toBe(403);
    expect((await request("POST", "/domains", ad, { names: ["evil.test"] }, { origin: "https://foreign.test" })).statusCode).toBe(403);
    expect((await request("POST", "/domains", ad, { names: Array(201).fill("too-many.test") })).statusCode).toBe(400);
  });
  it("migrations are repeatable and dashboard runs on real SQL", async () => {
    await migrate(db);
    const result = await request("GET", "/dashboard", ad);
    expect(result.statusCode, result.body).toBe(200); expect(result.json().domains).toBe(2);
    expect(result.json().daily).toHaveLength(7);
  });
  it("invalid JSON is a client error, not an internal failure", async () => {
    const result = await app.inject({ method: "POST", url: "/api/v1/auth/login",
      headers: { "content-type": "application/json" }, payload: '{"username":' });
    expect(result.statusCode).toBe(400);
    expect(result.json().error.code).toBe("INVALID_REQUEST");
  });
  it("isolates members and certification viewers", async () => {
    expect((await request("GET", "/mailboxes", b)).json().items).toHaveLength(1);
    expect((await request("GET", "/messages", v)).statusCode).toBe(403);
    expect((await request("GET", "/accounts", v)).json().items).toHaveLength(0);
    expect((await request("PUT", `/accounts/${accountId}/viewers`, ad, { userIds: [viewerId] })).statusCode).toBe(200);
    const record = (await request("GET", "/accounts", v)).json().items[0];
    expect(record.id).toBe(accountId); expect(record).not.toHaveProperty("assignedIp"); expect(record).not.toHaveProperty("hasSession");
    expect((await request("POST", `/accounts/${accountId}/credentials/session/reveal`, v, { confirm: true })).statusCode).toBe(403);
  });
  it("imports mailbox addresses and skips primary addresses and aliases on replay", async () => {
    const addresses = ["import-check@alpha.test", "invalid-address", "import-check@alpha.test"];
    const imported = await request("POST", "/mailboxes/import", ad, { addresses });
    expect(imported.statusCode, imported.body).toBe(200);
    expect(imported.json().items.map((item: any) => item.state)).toEqual(["created", "failed", "skipped"]);
    const box = imported.json().items[0].mailbox;
    expect(await receivingMailbox(db, addresses[0])).toHaveProperty("id", box.id);
    await request("POST", `/mailboxes/${box.id}/aliases`, ad, { address: "import-alias@alpha.test" });
    const replay = await request("POST", "/mailboxes/import", ad, {
      addresses: [addresses[0], "import-alias@alpha.test"],
    });
    expect(replay.json().items.map((item: any) => item.state)).toEqual(["skipped", "skipped"]);
    // Keep the shared test fixture unchanged for later assertions.
    await db.query("DELETE FROM business_accounts WHERE mailbox_id=$1", [box.id]);
    await db.query("DELETE FROM addresses WHERE mailbox_id=$1", [box.id]);
    await db.query("DELETE FROM mailboxes WHERE id=$1", [box.id]);
  });
});
describe("durable receive, parser and access", () => {
  const raw = Buffer.from([
    "Received: from fixture by mx.alpha.test; Sun, 18 Oct 2026 02:00:00 +0800",
    "From: Fixture <sender@outside.test>", "To: wrong@beta.test", "Subject: Verification code 482951",
    "Message-ID: <same-id@fixture.test>", "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="fixture"', "",
    "--fixture", "Content-Type: text/html; charset=utf-8", "",
    '<p>Your verification code: 482951</p><script>alert(1)</script><img src="https://tracker.test/pixel"><a href="https://example.test/login?t=xyz">Login</a>',
    "--fixture", 'Content-Type: text/plain; name="receipt.txt"', 'Content-Disposition: attachment; filename="receipt.txt"', "Content-Transfer-Encoding: base64", "", "aGVsbG8gZml4dHVyZQ==", "--fixture--", "",
  ].join("\r\n"));
  it("routes by envelope, persists before return, parses attachment and deduplicates retries", async () => {
    const ids = await ingestMail(ctx, raw, { from: "sender@outside.test", recipients: ["alice@alpha.test"] }); messageId = ids[0];
    expect(await ingestMail(ctx, raw, { from: "", recipients: ["alice@alpha.test"] })).toEqual(ids);
    expect((await db.query("SELECT * FROM messages WHERE mailbox_id=$1", [bobBox.id]))).toHaveLength(0);
    const [r] = await db.query("SELECT path FROM raw_messages"); expect(await readFile(join(root, r.path))).toEqual(raw);
    await parseMail(ctx, messageId);
    const res = await request("GET", `/messages/${messageId}`, a);
    expect(res.statusCode, res.body).toBe(200);
    const detail = res.json(); expect(detail.otp).toBe("482951"); expect(detail.html).not.toMatch(/script|<img/i);
    expect(detail.attachments).toHaveLength(1); attachmentId = detail.attachments[0].id;
    expect((await request("GET", `/attachments/${attachmentId}`, a)).body).toBe("hello fixture");
    await parseMail(ctx, messageId); expect(await db.query("SELECT * FROM attachments WHERE message_id=$1", [messageId])).toHaveLength(1);
  });
  it("separate deliveries with same Message-ID remain separate; domains remain independent", async () => {
    const changed = Buffer.from(raw.toString().replace("02:00:00", "02:00:01"));
    const ids = await ingestMail(ctx, changed, { from: "", recipients: ["alice@alpha.test", "bob@beta.test"] });
    expect(ids).toHaveLength(2); expect(ids).not.toContain(messageId);
    expect((await request("GET", "/messages", b)).json().total).toBe(1);
  });
  it("rejects unknown recipients, private-network proxies and quota overflow", async () => {
    expect(await receivingMailbox(db, "unknown@alpha.test")).toBeNull();
    expect(await receivingMailbox(db, "relay@outside.test")).toBeNull();
    await expect(ingestMail(ctx, raw, { from: "", recipients: ["unknown@alpha.test"] })).rejects.toHaveProperty("responseCode", 550);
    await expect(normalizeProxy("http://127.0.0.1:8080")).rejects.toThrow();
    await expect(normalizeProxy("http://[::ffff:127.0.0.1]:8080")).rejects.toThrow();
    await db.query("UPDATE mailboxes SET quota_bytes=used_bytes WHERE id=$1", [aliceBox.id]);
    await expect(ingestMail(ctx, Buffer.from(raw.toString().replace("02:00:00", "02:00:02")), { from: "", recipients: ["alice@alpha.test"] })).rejects.toHaveProperty("responseCode", 452);
    await db.query("UPDATE mailboxes SET quota_bytes=104857600 WHERE id=$1", [aliceBox.id]);
  });
  it("cross-user reads and attachments are denied; fresh OTP waiting excludes older email", async () => {
    expect((await request("GET", `/messages/${messageId}`, b)).statusCode).toBe(404);
    expect((await request("GET", `/attachments/${attachmentId}`, b)).statusCode).toBe(404);
    expect((await request("GET", "/messages?q=482951", a)).json().total).toBeGreaterThan(0);
    expect((await request("GET", `/mailboxes/${aliceBox.id}/otp?since=${encodeURIComponent(new Date(Date.now() + 1000).toISOString())}`, a)).json().item).toBeNull();
  });
  it("retired domains keep receiving but reject creation", async () => {
    await db.query("UPDATE domains SET state='retired' WHERE id=$1", [d1]);
    expect(await receivingMailbox(db, "alice@alpha.test")).not.toBeNull();
    await expect(createMailbox(db, alice, { domainId: d1, prefix: "new" })).rejects.toThrow();
    await db.query("UPDATE domains SET state='active' WHERE id=$1", [d1]);
  });
  it("aliases explicitly deliver to the selected box instead of creating a new box", async () => {
    const created = await request("POST", `/mailboxes/${aliceBox.id}/aliases`, a, { address: "alias@alpha.test" });
    expect(created.statusCode, created.body).toBe(200);
    expect((await receivingMailbox(db, "alias@alpha.test"))?.id).toBe(aliceBox.id);
    const aliasRaw = Buffer.from(raw.toString().replace("02:00:00", "02:00:03"));
    const ids = await ingestMail(ctx, aliasRaw, { from: "", recipients: ["alias@alpha.test", "alice@alpha.test"] });
    expect(ids).toHaveLength(1);
    expect((await db.query("SELECT mailbox_id FROM messages WHERE id=$1", [ids[0]]))[0].mailbox_id).toBe(aliceBox.id);
    expect((await request("DELETE", `/mailboxes/${aliceBox.id}/aliases`, a, { address: "alias@alpha.test" })).statusCode).toBe(200);
    expect(await receivingMailbox(db, "alias@alpha.test")).toBeNull();
  });
});
describe("credentials and account tasks", () => {
  it("supports SOCKS5 URLs and standard HTTP proxy ports without corrupting auth", async () => {
    expect(await normalizeProxy("socks5://user:p%40ss@127.0.0.1:1080", true)).toBe("socks5://user:p%40ss@127.0.0.1:1080");
    expect(await normalizeProxy("http://127.0.0.1:80", true)).toBe("http://127.0.0.1:80");
    expect(await normalizeProxy("https://127.0.0.1:443", true)).toBe("https://127.0.0.1:443");
  });
  it("accepts public numeric proxies while rejecting private and IPv4-mapped addresses", async () => {
    expect(await normalizeProxy("http://103.23.149.55:9")).toBe("http://103.23.149.55:9");
    expect(await normalizeProxy("http://[2606:4700:4700::1111]:8080")).toBe("http://[2606:4700:4700::1111]:8080");
    for (const host of ["10.0.0.1", "100.64.0.1", "192.168.1.1", "[fc00::1]", "[::ffff:103.23.149.55]"]) {
      await expect(normalizeProxy(`http://${host}:8080`)).rejects.toThrow("代理必须使用可公开路由的地址");
    }
  });
  it("authenticated encryption binds account and field", () => {
    const ciphertext = seal("secret", config.encryptionKey, "a:session");
    expect(unseal(ciphertext, config.encryptionKey, "a:session")).toBe("secret");
    expect(() => unseal(ciphertext, config.encryptionKey, "b:session")).toThrow();
  });
  it("network/proxy/session failures preserve last confirmed KYC", async () => {
    await db.query("UPDATE business_accounts SET kyc_status='passed' WHERE id=$1", [accountId]);
    for (const state of ["network_unavailable", "proxy_failed", "session_invalid"]) {
      await checkAccount(ctx, accountId, aliceId, false, async () => ({ ok: false, state, message: state }));
      const [r] = await db.query("SELECT * FROM business_accounts WHERE id=$1", [accountId]);
      expect(r.kyc_status).toBe("passed"); expect(r.sync_state).toBe(state); expect(r.suspended).toBe(false);
    }
  });
  it("discards in-flight results if credentials change", async () => {
    const outcome = await checkAccount(ctx, accountId, aliceId, false, async () => {
      await db.transaction(tx => saveCredential(tx, accountId, "session", "fake-test-session-key-012345", ctx));
      return { ok: true, state: "ok", message: "", snapshot: { email: "alice@alpha.test", kyc: { status: "denied" } } };
    });
    expect(outcome.state).toBe("stale");
    expect((await db.query("SELECT kyc_status FROM business_accounts WHERE id=$1", [accountId]))[0].kyc_status).toBe("passed");
    const rawCredential = (await db.query("SELECT ciphertext FROM credentials WHERE account_id=$1", [accountId]))[0];
    expect(rawCredential.ciphertext).not.toContain("fake-test");
  });
  it("prevents concurrent account queries", async () => {
    await db.query("INSERT INTO account_query_locks(account_id,token,expires_at) VALUES($1,$2,now()+interval '90 seconds')", [accountId, randomUUID()]);
    expect((await checkAccount(ctx, accountId, aliceId, false, async () => { throw new Error("must not run"); })).state).toBe("busy");
    await db.query("DELETE FROM account_query_locks WHERE account_id=$1", [accountId]);
  });
  it("cancelled queued batch does not query", async () => {
    const queued = await request("POST", "/accounts/query", a, { ids: [accountId] });
    expect(queued.statusCode).toBe(200);
    await request("POST", `/tasks/${queued.json().taskId}/cancel`, a, {});
    await runOneJob(ctx, ["query_accounts"], async () => { throw new Error("must not run"); });
    expect((await db.query("SELECT state FROM jobs WHERE id=$1", [queued.json().taskId]))[0].state).toBe("cancelled");
  });
});
describe("sharing, transfer and token lifecycle", () => {
  let share: any;
  it("requires a real token and password, and only exposes one mailbox", async () => {
    const created = await request("POST", "/shares", a, { mailboxId: aliceBox.id, password: "private-share-123" });
    expect(created.statusCode, created.body).toBe(200); share = created.json();
    expect((await request("GET", `/public/shares/${share.token}/messages`)).statusCode).toBe(401);
    const unlocked = await request("POST", `/public/shares/${share.token}/unlock`, undefined, { password: "private-share-123" });
    expect(unlocked.statusCode).toBe(200);
    const cookie = String(unlocked.headers["set-cookie"]).split(";")[0];
    const list = await request("GET", `/public/shares/${share.token}/messages`, undefined, undefined, { cookie });
    expect(list.statusCode).toBe(200); expect(list.json().items.length).toBeGreaterThan(0);
    expect((await request("GET", "/public/shares/alice@alpha.test/messages")).statusCode).toBe(400);
    expect(Date.parse(share.expiresAt) - Date.now()).toBeGreaterThan(6.9 * 86400000);
    const expired = (await request("POST", "/shares", a, { mailboxId: aliceBox.id })).json();
    await db.query("UPDATE shares SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.id]);
    expect((await request("GET", `/public/shares/${expired.token}`)).statusCode).toBe(404);
    const revoked = (await request("POST", "/shares", a, { mailboxId: aliceBox.id })).json();
    expect((await request("DELETE", `/shares/${revoked.id}`, a)).statusCode).toBe(200);
    expect((await request("GET", `/public/shares/${revoked.token}/messages`)).statusCode).toBe(404);
  });
  it("transfer atomically revokes old owner, shares and certification grants", async () => {
    expect((await request("POST", `/mailboxes/${aliceBox.id}/transfer`, ad, { ownerId: bobId })).statusCode).toBe(200);
    expect((await request("GET", `/messages/${messageId}`, a)).statusCode).toBe(404);
    expect((await request("GET", `/attachments/${attachmentId}`, a)).statusCode).toBe(404);
    expect((await request("GET", `/messages/${messageId}`, b)).statusCode).toBe(200);
    expect((await request("GET", `/public/shares/${share.token}`)).statusCode).toBe(404);
    expect((await request("GET", "/accounts", v)).json().items).toHaveLength(0);
    expect((await request("PATCH", `/mailboxes/${aliceBox.id}`, a, { note: "old-owner" })).statusCode).toBe(404);
    expect((await request("PATCH", `/messages/${messageId}`, a, { read: true })).statusCode).toBe(404);
    expect((await request("POST", "/messages/batch", a, { mailboxId: aliceBox.id, ids: [messageId], action: "delete" })).statusCode).toBe(404);
    expect((await request("POST", `/mailboxes/${aliceBox.id}/aliases`, a, { address: "revoked@alpha.test" })).statusCode).toBe(404);
  });
  it("pair codes are single-use and connector tokens have narrow scope", async () => {
    const pair = (await request("POST", "/extensions/pair", b, {})).json();
    const connected = await request("POST", "/public/extensions/connect", undefined, { code: pair.code, name: "test" });
    expect(connected.statusCode, connected.body).toBe(200);
    expect((await request("POST", "/public/extensions/connect", undefined, { code: pair.code, name: "replay" })).statusCode).toBe(400);
    const headers = { authorization: "Bearer " + connected.json().token };
    expect((await request("GET", "/extensions/accounts", undefined, undefined, headers)).statusCode).toBe(200);
    expect((await request("GET", "/messages", undefined, undefined, headers)).statusCode).toBe(403);
    expect((await request("POST", "/extensions/capture", undefined, { accountId, confirmedEmail: "wrong@alpha.test", sessionKey: "fake-session-key-0123456789" }, headers)).statusCode).toBe(400);
    expect((await request("POST", "/auth/password", b, { currentPassword: "test-password-012345", password: "new-password-012345" })).statusCode).toBe(200);
    expect((await request("GET", "/auth/session", b)).json().authenticated).toBe(false);
    expect((await request("GET", "/extensions/accounts", undefined, undefined, headers)).statusCode).toBe(401);
  });
});
