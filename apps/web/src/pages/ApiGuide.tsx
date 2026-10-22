import { ExternalLink, Code2 } from "lucide-react";
import { Badge, Button, PageHeader } from "../components/ui";
import { CopyButton } from "../components/CopyButton";

const endpoints = [
  ["GET", "/domains", "获取可用域名及其 ID"],
  ["POST", "/domains", '添加域名（管理员），{"names":["example.com"]}'],
  ["GET", "/mailboxes?q=&page=1&pageSize=50", "搜索邮箱，返回 items / total / page / pageSize"],
  ["POST", "/mailboxes", '{"domainId":"UUID","prefix":"hello","count":1}；逐项检查 state'],
  ["POST", "/mailboxes/import", '{"addresses":["hello@example.com"]}；最多 200 条'],
  ["PATCH", "/mailboxes/{id}", "更新名称 label、标签 tags、备注 note；配额仅管理员"],
  ["GET", "/messages?mailboxId={id}&filter=unread", "搜索邮件，filter 支持 all / unread / starred"],
  ["GET", "/messages/{id}", "正文 text / html、验证码 otp、验证链接 links、附件 attachments"],
  ["GET", "/mailboxes/{id}/otp?since={ISO时间}", "只取 since 后的新验证码 / 验证链接，无新邮件返回 item: null"],
  ["PATCH", "/messages/{id}", '{"read":true,"starred":true}'],
  ["POST", "/messages/batch", '{"mailboxId":"UUID","ids":["UUID"],"action":"read"}；也支持 unread / star / delete'],
  ["GET", "/attachments/{id}", "下载附件；仅有对应邮箱权限才可访问"],
  ["GET", "/messages/{id}/raw", "下载邮件原文 .eml"],
  ["POST", "/shares", '{"mailboxId":"UUID","days":7,"password":"可选密码至少6位"}'],
  ["DELETE", "/shares/{id}", "撤销只读分享"],
  ["GET", "/accounts", "业务账号台账"],
  ["POST", "/accounts/query", '{"ids":["UUID"]}；返回 taskId，后台串行执行'],
  ["GET", "/tasks", "获取任务状态与逐项结果；此列表不返回 total"],
  ["POST", "/tasks/{id}/cancel", "请求停止任务"],
  ["GET", "/events", "SSE 更新通知；断线后重新拉取列表"],
];
function Example({ title, code }: { title: string; code: string }) {
  return <section className="card api-example"><div className="card-heading"><h2>{title}</h2>
    <CopyButton value={code} label={`复制${title}`} text="复制示例" /></div><pre><code>{code}</code></pre></section>;
}
export function ApiGuidePage() {
  const base = window.location.origin + "/api/v1";
  const login = `# Bash 示例，需要 curl、jq；在同一终端依次执行
set -e
umask 077
BASE='${base}'
WORK=$(mktemp -d)
trap 'rm -rf -- "$WORK"; unset INBOXLAB_PASSWORD' EXIT
read -r -p '用户名: ' INBOXLAB_USER
read -r -s -p '密码: ' INBOXLAB_PASSWORD; echo
export INBOXLAB_USER INBOXLAB_PASSWORD
jq -n '{username:env.INBOXLAB_USER,password:env.INBOXLAB_PASSWORD}' |
  curl --fail-with-body -sS -c "$WORK/cookies" \\
    -H 'Content-Type: application/json' --data-binary @- \\
    "$BASE/auth/login" > "$WORK/login.json"
unset INBOXLAB_PASSWORD
CSRF=$(jq -er '.csrf' "$WORK/login.json")
curl --fail-with-body -sS -b "$WORK/cookies" "$BASE/domains" | jq
curl --fail-with-body -sS -b "$WORK/cookies" "$BASE/mailboxes?pageSize=50" | jq`;
  const create = `# 接上一个示例，替换为 /domains 返回的真实域名 ID
DOMAIN_ID='替换为域名UUID'
jq -n --arg id "$DOMAIN_ID" '{domainId:$id,prefix:"hello",count:1}' |
  curl --fail-with-body -sS -b "$WORK/cookies" \\
    -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \\
    --data-binary @- "$BASE/mailboxes" > "$WORK/created.json"
# HTTP 200 不代表全部成功，必须检查每项 state / error
jq '.items[] | {state,mailbox,error}' "$WORK/created.json"
BOX_ID=$(jq -er '.items[] | select(.state=="created") | .mailbox.id' "$WORK/created.json")
curl --fail-with-body -sS -b "$WORK/cookies" \\
  "$BASE/messages?mailboxId=$BOX_ID&page=1&pageSize=50" | jq
# 等待前先记录 UTC 时间，后续请求复用此时间，不返回等待之前的旧码
SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
curl --fail-with-body -sS -G -b "$WORK/cookies" --data-urlencode "since=$SINCE" \\
  "$BASE/mailboxes/$BOX_ID/otp" | jq`;
  return <div className="api-guide"><PageHeader eyebrow="DEVELOPER ACCESS" title="API 调用文档"
    description="直接接入自己的脚本与自动化流程。所有请求均遵循当前账号的权限。">
    <Button asChild variant="secondary"><a href="/api/v1/openapi.json" target="_blank" rel="noopener noreferrer"><Code2 size={15} />OpenAPI JSON</a></Button>
    <Button asChild><a href="/api/docs" target="_blank" rel="noopener noreferrer"><ExternalLink size={15} />交互式 API 文档</a></Button>
  </PageHeader>
    <section className="card padded api-intro"><h2>基础地址</h2><div className="api-base"><code>{base}</code><CopyButton value={base} label="复制 API 基础地址" text="复制地址" /></div>
      <h3>先登录，再调用</h3><ol className="instruction-list">
        <li>POST /auth/login，提交 username、password，保存响应的会话 Cookie 与 csrf。</li>
        <li>GET 请求携带 Cookie；POST / PATCH / PUT / DELETE 还需请求头 X-CSRF-Token。</li>
        <li>浏览器打开 Swagger 时会携带当前登录 Cookie。写操作在 Authorize → csrfToken 填入 /auth/session 返回的 csrf。</li>
        <li>目前不提供通用 Bearer API Key；扩展令牌不能读取邮箱。401 时重新登录；403 时检查 CSRF、Origin 和角色权限。</li>
      </ol><p className="muted small">接口不提供发信或 IMAP。收件链接需要登录，免登录只读访问请显式生成分享链接。</p>
    </section>
    <Example title="登录并读取数据" code={login} /><Example title="创建邮箱与查询验证码" code={create} />
    <section className="card"><div className="card-heading"><h2>常用接口</h2><Badge tone="blue">以下路径均加 /api/v1</Badge></div>
      <div className="table-scroll"><table><thead><tr><th>方法</th><th>路径</th><th>用途 / 请求参数</th></tr></thead>
        <tbody>{endpoints.map(([method, path, info]) => <tr key={method + path}><td><Badge tone={method === "GET" ? "blue" : "neutral"}>{method}</Badge></td><td><code>{path}</code></td><td>{info}</td></tr>)}</tbody></table></div></section>
    <section className="card padded api-notes"><h2>响应、限制与调用约定</h2>
      <p>普通分页默认 50 条，最多 200 条。批量创建 / 导入 / 操作最多 200 条，请检查逐项 state，而不是只检查 HTTP 状态。</p>
      <p>验证码接口立即返回，不是长连接；item 为 null 时保留同一个 since，建议每 3 秒重试，结束后停止。</p>
      <p>普通账号每分钟默认最多 300 次请求（按来源 IP），登录每 15 分钟最多 8 次；遇到 429 请等待。第三方查询提交任务，不要持续循环查询第三方账号。</p>
      <p>错误结构：<code>{'{"error":{"code":"UNAUTHENTICATED","message":"请先登录","requestId":"..."}}'}</code>。常见 HTTP 状态：400 参数错误、401 未登录、403 权限 / CSRF、404 不存在或不可访问、409 冲突、429 限流。</p>
      <p>邮件详情的 links 是服务端识别的验证链接；网页还会从正文汇总普通 HTTP/HTTPS 链接。复制或等待验证码都不会自动打开一次性链接。</p>
      <p>完整脚本示例、分享接口及业务接口说明随仓库提供：<code>docs/API.md</code>、<code>scripts/api-example.mjs</code>。</p>
    </section>
  </div>;
}
