import type { FastifySchema } from "fastify";

const summaries: Record<string, string> = {
  "GET /auth/session": "查询登录状态并获取当前 CSRF token",
  "POST /auth/login": "登录，返回 CSRF token 并设置会话 Cookie",
  "POST /auth/logout": "退出登录",
  "POST /auth/password": "修改密码并撤销所有会话",
  "GET /domains": "列出可见域名",
  "POST /domains": "批量添加域名（管理员）",
  "POST /domains/:id/check": "检查域名 DNS",
  "PATCH /domains/:id": "启用、禁用或退役域名（管理员）",
  "GET /mailboxes": "搜索邮箱，默认每页 50 条",
  "POST /mailboxes": "创建独立邮箱，一次最多 200 个；检查逐项 state",
  "POST /mailboxes/import": "导入完整邮箱地址，一次最多 200 条",
  "PATCH /mailboxes/:id": "修改邮箱名称、标签、备注或配额",
  "POST /mailboxes/:id/aliases": "创建投递到此邮箱的别名",
  "DELETE /mailboxes/:id/aliases": "删除收件别名",
  "POST /mailboxes/:id/transfer": "转移邮箱并撤销原授权和分享（管理员）",
  "GET /mailboxes/:id/otp": "查询 since 之后的新验证码或验证链接（非阻塞）",
  "GET /messages": "搜索邮件，支持邮箱、域名、未读和星标筛选",
  "GET /messages/:id": "读取邮件正文、验证码、验证链接及附件清单",
  "PATCH /messages/:id": "设置邮件已读、未读或星标",
  "POST /messages/batch": "批量处理同一邮箱的邮件，最多 200 条",
  "GET /messages/:id/raw": "下载邮件原文 .eml",
  "GET /attachments/:id": "下载附件，校验所属邮箱访问权限",
  "GET /shares": "查看指定邮箱的分享记录（不返回原始 token）",
  "POST /shares": "创建只读分享，token 仅返回一次",
  "DELETE /shares/:id": "立即撤销只读分享",
  "GET /accounts": "搜索可见业务账号",
  "POST /accounts/query": "提交串行认证查询任务，返回 taskId",
  "GET /tasks": "列出后台任务和逐项结果",
  "POST /tasks/:id/cancel": "请求停止后台任务",
  "GET /events": "SSE 更新通知；重连后重新获取列表",
  "GET /health": "数据库连通性健康检查（无需登录）",
};

// Documentation-only metadata: does not alter validation or response serialization.
export function documentRoute({ schema = {}, url, route }: {
  schema: FastifySchema; url: string; route: { method: string | string[] };
}) {
  if (!url.startsWith("/api/v1/")) return { schema, url };
  const path = url.slice("/api/v1".length), method = String(route.method).toUpperCase();
  const publicRoute = ["/auth/login", "/auth/session", "/health"].includes(path) || path.startsWith("/public/");
  const readOnly = ["GET", "HEAD", "OPTIONS"].includes(method);
  const sessionSecurity: Record<string, string[]> = readOnly ? { cookieAuth: [] } : { cookieAuth: [], csrfToken: [] };
  const security = publicRoute ? [] : path.startsWith("/extensions/")
    && ["/extensions/accounts", "/extensions/capture", "/extensions/proxy", "/extensions/disconnect"].includes(path)
    ? [sessionSecurity, { extensionToken: [] }] : [sessionSecurity];
  const documented: FastifySchema = {
    ...schema,
    tags: schema.tags || [path.split("/").filter(Boolean)[0]],
    summary: schema.summary || summaries[`${method} ${path}`],
    security,
  };
  if (method === "GET" && ["/mailboxes", "/messages"].includes(path)) {
    documented.querystring = {
      type: "object", properties: {
        page: { type: "string", default: "1", description: "页码，最小 1" },
        pageSize: { type: "string", default: "50", description: "每页数量，1–200" },
        q: { type: "string", description: path === "/messages" ? "主题、发件人或正文关键词" : "地址、名称或标签关键词" },
        domainId: { type: "string", format: "uuid", description: "域名 ID（可选）" },
        ...(path === "/messages" ? {
          mailboxId: { type: "string", format: "uuid", description: "邮箱 ID（可选）" },
          filter: { type: "string", enum: ["all", "unread", "starred"], default: "all" },
        } : {}),
      },
    };
  }
  return { schema: documented, url };
}
