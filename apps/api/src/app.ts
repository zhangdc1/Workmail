import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import staticFiles from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Context } from "./context.js";
import { hash, HttpError } from "./security.js";
import { toCamel } from "./db/index.js";
import { authRoutes } from "./routes/auth.js";
import { domainRoutes } from "./routes/domains.js";
import { mailboxRoutes } from "./routes/mailboxes.js";
import { messageRoutes } from "./routes/messages.js";
import { accountRoutes } from "./routes/accounts.js";
import { shareRoutes } from "./routes/shares.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { extensionRoutes } from "./routes/extensions.js";
export async function makeApp(ctx: Context, logger = false) {
  const { db, config } = ctx;
  const app = Fastify({
    logger: logger ? { redact: ["req.headers.cookie", "req.headers.authorization", "req.headers.x-csrf-token", "body", "res.headers.set-cookie"], serializers: { req: req => ({ method: req.method, url: req.url?.split("?")[0]?.replace(/\/public\/shares\/[^/]+/, "/public/shares/[redacted]"), hostname: req.hostname }) } } : false,
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: config.trustedProxies.length ? config.trustedProxies : false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  app.decorateRequest("user", null); app.decorateRequest("csrf", null); app.decorateRequest("sessionHash", null); app.decorateRequest("extensionAuth", false);
  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute", allowList: [] });
  await app.register(swagger, {
    openapi: { info: { title: "InboxLab API", version: "1.0.0" }, servers: [{ url: config.origin }], components: { securitySchemes: { cookieAuth: { type: "apiKey", in: "cookie", name: "inboxlab_session" } } } },
  });
  app.addHook("onRequest", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff").header("Referrer-Policy", "no-referrer").header("X-Frame-Options", "DENY");
    if (req.url.startsWith("/api")) reply.header("Cache-Control", "no-store");
    const token = req.cookies.inboxlab_session;
    if (token && token.length < 200) {
      const [user] = await db.query(`SELECT u.id,u.username,u.role,u.disabled,u.mailbox_quota,u.storage_quota,u.created_at,s.csrf
        FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT u.disabled`, [hash(token)]);
      if (user) { const { csrf, ...safe } = user; req.user = toCamel(safe); req.csrf = csrf; req.sessionHash = hash(token); }
    }
    const path = req.url.split("?")[0];
    if (req.headers.authorization?.startsWith("Bearer ")) {
      if (!path.startsWith("/api/v1/extensions/")) throw new HttpError(403, "扩展令牌仅允许调用连接器接口", "TOKEN_SCOPE");
      const [row] = await db.query(`SELECT u.id,u.username,u.role,u.disabled,u.mailbox_quota,u.storage_quota,u.created_at
        FROM extension_tokens t JOIN users u ON u.id=t.user_id
        WHERE t.token_hash=$1 AND t.expires_at>now() AND NOT u.disabled AND u.role<>'kyc_viewer'`, [hash(req.headers.authorization.slice(7))]);
      if (!row) throw new HttpError(401, "连接已失效，请重新配对", "UNAUTHENTICATED");
      req.user = toCamel(row); req.extensionAuth = true;
      if (!["/api/v1/extensions/accounts", "/api/v1/extensions/capture", "/api/v1/extensions/proxy", "/api/v1/extensions/disconnect"].includes(path)) throw new HttpError(403, "扩展令牌无此权限", "TOKEN_SCOPE");
    }
    const publicPath = path === "/api/v1/health" || path === "/api/v1/auth/session" || path === "/api/v1/auth/login" || path.startsWith("/api/v1/public/");
    if (path.startsWith("/api") && !publicPath && !req.user) throw new HttpError(401, "请先登录", "UNAUTHENTICATED");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.headers.origin;
      const connecting = path === "/api/v1/public/extensions/connect" && (!origin || /^chrome-extension:\/\/[a-p]{32}$/.test(origin));
      if (!req.extensionAuth && !connecting && origin && origin !== config.origin) throw new HttpError(403, "禁止跨站请求", "CSRF");
      if (!req.extensionAuth && req.user && !publicPath && req.headers["x-csrf-token"] !== req.csrf) throw new HttpError(403, "安全令牌已失效，请刷新页面", "CSRF");
    }
    if (req.user?.role === "kyc_viewer" && path.startsWith("/api/v1/") && !(
      path.startsWith("/api/v1/accounts") && req.method === "GET" ||
      path === "/api/v1/accounts/export" && req.method === "POST" ||
      path.startsWith("/api/v1/auth/") || path === "/api/v1/events"
    )) throw new HttpError(403, "此账号仅可查看分配的认证记录", "FORBIDDEN");
  });
  app.setErrorHandler((error, req, reply) => {
    const e = error as any;
    if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: { code: e.code, message: e.message, requestId: req.id } });
    if (e.validation) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "请求字段格式不正确", requestId: req.id } });
    if (e.code === "23505") return reply.code(409).send({ error: { code: "CONFLICT", message: "记录已经存在", requestId: req.id } });
    if (e.code === "23503" || e.code === "22P02") return reply.code(400).send({ error: { code: "INVALID_REFERENCE", message: "关联记录或标识不正确", requestId: req.id } });
    if (e.statusCode === 429) return reply.code(429).send({ error: { code: "RATE_LIMIT", message: "操作过于频繁，请稍后重试" } });
    if ([400, 413, 415].includes(e.statusCode)) return reply.code(e.statusCode).send({ error: {
      code: "INVALID_REQUEST", message: e.statusCode === 413 ? "请求超过大小限制" : "请求内容或格式不正确", requestId: req.id,
    } });
    req.log.error({ code: e.code || e.name, requestId: req.id }, "Request failed");
    return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "服务暂时不可用，请检查运行配置", requestId: req.id } });
  });
  app.get("/api/v1/health", async () => { await db.query("SELECT 1"); return { status: "ok", version: "1.0.0" }; });
  await authRoutes(app, ctx); await domainRoutes(app, ctx); await mailboxRoutes(app, ctx);
  await messageRoutes(app, ctx); await accountRoutes(app, ctx); await shareRoutes(app, ctx); await dashboardRoutes(app, ctx); await extensionRoutes(app, ctx);
  await app.register(swaggerUi, { routePrefix: "/api/docs" });
  app.get("/api/v1/openapi.json", async () => app.swagger());
  if (existsSync(resolve("dist/web/index.html"))) {
    await app.register(staticFiles, { root: resolve("dist/web"), prefix: "/" });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api")) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "接口不存在" } });
      return reply.sendFile("index.html");
    });
  }
  return app;
}
