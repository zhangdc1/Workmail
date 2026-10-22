// Node.js 24+, no dependencies. Read-only unless INBOXLAB_CREATE_PREFIX is set.
const origin = new URL(process.env.INBOXLAB_URL || "https://99app.top");
if (origin.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) {
  throw new Error("Remote API calls require HTTPS");
}
if (origin.username || origin.password) throw new Error("Do not put credentials in the URL");
const username = process.env.INBOXLAB_USER, password = process.env.INBOXLAB_PASSWORD;
if (!username || !password) throw new Error("Set INBOXLAB_USER and INBOXLAB_PASSWORD first");
let cookie = "", csrf = "";
async function call(path, method = "GET", body) {
  const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { "X-CSRF-Token": csrf } : {}) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(new URL("/api/v1" + path, origin), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${data.error?.code || "ERROR"} ${data.error?.message || ""}`);
  if (path === "/auth/login") {
    cookie = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    csrf = data.csrf;
    if (!cookie || !csrf) throw new Error("Login did not return cookie / csrf");
  }
  return data;
}
try {
  await call("/auth/login", "POST", { username, password });
  // Never log login response, Cookie, CSRF, or credentials.
  delete process.env.INBOXLAB_PASSWORD;
  const domains = await call("/domains");
  console.log("Domains:", domains.items.map(({ id, name, state }) => ({ id, name, state })));
  let mailboxId = process.env.INBOXLAB_MAILBOX_ID;
  if (process.env.INBOXLAB_CREATE_PREFIX) {
    const domainId = process.env.INBOXLAB_DOMAIN_ID;
    if (!domainId) throw new Error("Creation requires INBOXLAB_DOMAIN_ID");
    const created = await call("/mailboxes", "POST", { domainId, prefix: process.env.INBOXLAB_CREATE_PREFIX, count: 1 });
    for (const result of created.items) {
      if (result.state !== "created") throw new Error(`Mailbox creation failed: ${result.error}`);
      mailboxId = result.mailbox.id;
      console.log("Created mailbox:", result.mailbox.address, mailboxId);
    }
  }
  const boxes = await call("/mailboxes?" + new URLSearchParams({ pageSize: "50" }));
  console.log("Mailboxes:", boxes.items.map(({ id, address, unreadCount }) => ({ id, address, unreadCount })));
  if (mailboxId) {
    // Capture before triggering the upstream action that sends your verification mail.
    const since = new Date().toISOString();
    const messages = await call("/messages?" + new URLSearchParams({ mailboxId, pageSize: "50" }));
    console.log("Messages:", messages.items.map(({ id, subject, receivedAt }) => ({ id, subject, receivedAt })));
    const fresh = await call(`/mailboxes/${encodeURIComponent(mailboxId)}/otp?` + new URLSearchParams({ since }));
    console.log("Fresh verification mail:", fresh.item ? { id: fresh.item.id, receivedAt: fresh.item.receivedAt } : null);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (cookie && csrf) {
    try { await call("/auth/logout", "POST"); }
    catch { console.error("Logout failed; session will expire automatically"); process.exitCode = 1; }
  }
  cookie = ""; csrf = "";
}
