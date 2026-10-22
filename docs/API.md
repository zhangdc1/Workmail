# InboxLab API 调用指南

生产基础地址：`https://99app.top/api/v1`。其他部署使用自己的 HTTPS 网页域名，不使用收件域名 `roio.top` 调用网页 API。

## 1. 文档入口与鉴权

- 网页指南：`https://99app.top/api-guide`。
- Swagger 交互文档：`https://99app.top/api/docs`。
- OpenAPI JSON：`https://99app.top/api/v1/openapi.json`。
- 文档需先登录；同源浏览器使用当前会话。Swagger 写操作在 Authorize 的 `csrfToken` 中填入 `GET /api/v1/auth/session` 返回的 `csrf`。Cookie 由浏览器自动携带，不需要读取 HttpOnly Cookie。

当前没有通用 API Key。脚本先用账号密码登录，保存响应 Cookie 和 CSRF。扩展 Bearer 令牌只能调用连接器专用接口，不能调用邮箱、邮件或普通业务接口。

| 请求 | 鉴权 |
| --- | --- |
| `GET /health`、`GET /auth/session`、`POST /auth/login` | 无需预先登录 |
| 普通 `GET` | `Cookie: inboxlab_session=...` |
| 普通 `POST/PATCH/PUT/DELETE` | Cookie + `X-CSRF-Token: 登录响应的csrf` |
| `/public/shares/{token}/...` | 分享 token；密码分享还需解锁 Cookie |

登录：`POST /auth/login`，JSON `{"username":"自己的用户名","password":"自己的密码"}`。响应包含 `authenticated`、`user`、`csrf`，并通过 `Set-Cookie` 设置 `inboxlab_session`。不要输出或提交该响应、Cookie 文件和密码。

会话到期、修改密码或禁用用户后需重新登录。管理员管理全局；成员只能操作自己的或获授权的邮箱；认证只读角色不能读取邮件或凭据。跨用户附件、邮件访问可能返回 404，而非暴露对象是否存在。脚本无需发送 Origin；如发送，必须与部署网页 origin 完全一致。

## 2. 可直接运行的 Node.js 示例

随仓库提供 `scripts/api-example.mjs`，Node.js 24，无第三方依赖。默认只读取域名和邮箱；指定邮箱 ID 还会读取邮件列表并检查新验证码。示例不输出 Cookie、CSRF、验证码和登录链接，运行结束自动退出自己的会话，不影响浏览器会话。

PowerShell：

```powershell
$env:INBOXLAB_URL = 'https://99app.top'
$env:INBOXLAB_USER = Read-Host '用户名'
$credential = Get-Credential -UserName $env:INBOXLAB_USER -Message '输入平台登录密码'
$env:INBOXLAB_PASSWORD = $credential.GetNetworkCredential().Password
try {
  node scripts/api-example.mjs
} finally {
  Remove-Item Env:INBOXLAB_PASSWORD -ErrorAction SilentlyContinue
  $credential = $null
}
```

Bash：

```bash
export INBOXLAB_URL='https://99app.top'
read -r -p '用户名: ' INBOXLAB_USER
read -r -s -p '密码: ' INBOXLAB_PASSWORD; echo
export INBOXLAB_USER INBOXLAB_PASSWORD
node scripts/api-example.mjs
unset INBOXLAB_PASSWORD
```

可选环境变量：

| 变量 | 作用 |
| --- | --- |
| `INBOXLAB_MAILBOX_ID` | 指定读取邮件的邮箱 UUID |
| `INBOXLAB_DOMAIN_ID` | 创建邮箱的域名 UUID，从 `/domains` 获取 |
| `INBOXLAB_CREATE_PREFIX` | 显式设置才会创建一个邮箱，例如 `hello`；重复创建会报错 |

## 3. curl 登录与调用

以下为 Bash，需要 `curl`、`jq`。在同一个终端依次执行，敏感临时文件使用仅当前用户可访问的权限，退出终端时清理。

```bash
set -e
umask 077
BASE='https://99app.top/api/v1'
WORK=$(mktemp -d)
trap 'rm -rf -- "$WORK"; unset INBOXLAB_PASSWORD' EXIT
read -r -p '用户名: ' INBOXLAB_USER
read -r -s -p '密码: ' INBOXLAB_PASSWORD; echo
export INBOXLAB_USER INBOXLAB_PASSWORD
jq -n '{username:env.INBOXLAB_USER,password:env.INBOXLAB_PASSWORD}' |
  curl --fail-with-body -sS -c "$WORK/cookies" \
    -H 'Content-Type: application/json' --data-binary @- \
    "$BASE/auth/login" > "$WORK/login.json"
unset INBOXLAB_PASSWORD
CSRF=$(jq -er '.csrf' "$WORK/login.json")

# 域名
curl --fail-with-body -sS -b "$WORK/cookies" "$BASE/domains" | jq

# 获取邮箱
curl --fail-with-body -sS -b "$WORK/cookies" \
  "$BASE/mailboxes?page=1&pageSize=50" | jq

# 创建指定前缀邮箱；替换真实域名 ID
DOMAIN_ID='替换为域名UUID'
jq -n --arg id "$DOMAIN_ID" '{domainId:$id,prefix:"hello",count:1}' |
  curl --fail-with-body -sS -b "$WORK/cookies" \
    -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
    --data-binary @- "$BASE/mailboxes" > "$WORK/created.json"
jq '.items[] | {state,mailbox,error}' "$WORK/created.json"
BOX_ID=$(jq -er '.items[] | select(.state=="created") | .mailbox.id' "$WORK/created.json")

# 列出此邮箱邮件
curl --fail-with-body -sS -b "$WORK/cookies" \
  "$BASE/messages?mailboxId=$BOX_ID&page=1&pageSize=50" | jq

# 查询等待开始之后的新验证码 / 验证链接
# 应在触发发送验证码之前记录 SINCE；后续重试不要更新时间
SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
curl --fail-with-body -sS -G -b "$WORK/cookies" \
  --data-urlencode "since=$SINCE" "$BASE/mailboxes/$BOX_ID/otp" | jq

# 退出脚本自己的登录会话
curl --fail-with-body -sS -b "$WORK/cookies" \
  -H "X-CSRF-Token: $CSRF" -X POST "$BASE/auth/logout"
```

创建数量 `count` 最大 200；不提供 `prefix` 则随机生成。指定前缀时 `count` 必须为 1。返回示例：

```json
{"items":[{"state":"created","mailbox":{"id":"邮箱UUID","address":"hello@example.com"}}]}
```

批量接口可以部分成功，HTTP 200 不代表全部成功；每项检查 `state`（`created`、`skipped` 或 `failed`）及 `error`。

## 4. 邮箱与邮件接口

以下路径均相对于 `/api/v1`；UUID 使用实际接口返回值。

| 方法 | 路径 | 参数 / 用途 |
| --- | --- | --- |
| GET | `/domains` | 返回 `items` 与 `mxHost`；域名含 `id/name/state` |
| POST | `/domains` | 管理员；`{"names":["example.com"]}`，最多 200 条 |
| PATCH | `/domains/{id}` | 管理员；`{"state":"active"}`，也支持 `disabled/retired` |
| POST | `/domains/{id}/check` | 检查 DNS |
| GET | `/mailboxes` | `page/pageSize/q/domainId`；q 匹配地址、名称、标签 |
| POST | `/mailboxes` | `domainId` 必填，`prefix/count/ownerId/label/tags` 可选 |
| POST | `/mailboxes/import` | `{"addresses":["hello@example.com"]}`，最多 200 条 |
| PATCH | `/mailboxes/{id}` | `label/tags/note`；管理员可修改 `quotaBytes` |
| POST | `/mailboxes/{id}/aliases` | `{"address":"alias@example.com"}`；别名进入该邮箱 |
| DELETE | `/mailboxes/{id}/aliases` | 同上，JSON body 指定待删除的别名 |
| POST | `/mailboxes/{id}/transfer` | 管理员；`{"ownerId":"用户UUID"}`；撤销旧授权、分享 |
| GET | `/messages` | `mailboxId/domainId/q/filter/page/pageSize`；filter 为 `all/unread/starred` |
| GET | `/messages/{id}` | 获取正文 `text/html`、`otp/links` 和 `attachments` |
| PATCH | `/messages/{id}` | `{"read":true,"starred":true}`，字段可单独使用 |
| POST | `/messages/batch` | `{"mailboxId":"UUID","ids":["UUID"],"action":"read"}`；action 支持 `read/unread/star/delete`，最多 200 条，同一邮箱 |
| GET | `/mailboxes/{id}/otp?since={ISO8601}` | 非阻塞，只返回此时间之后的最新验证码或验证链接 |
| GET | `/attachments/{id}` | 附件下载（二进制） |
| GET | `/messages/{id}/raw` | 原文下载 `message/rfc822` |
| GET | `/events` | SSE 通知，断线重连后重新获取列表 |

邮件详情的 `links` 仅包含服务端提取的验证 / 登录链接，不是全部正文链接。网页另外汇总正文 HTTP/HTTPS 链接并提供复制。验证码查询无新信时 `{"item":null}`；有新信时 `item` 包含 `id/otp/receivedAt/links`，其中 `otp` 可能为空（仅包含验证链接）。建议每 3 秒重试同一个 since，收到后停止；不会返回等待之前的旧码，也不会自动打开一次性链接。邮件原文异步解析，刚收件时可能 `parseState=pending`。

普通分页返回 `{"items":[],"total":0,"page":1,"pageSize":50}`，默认 50、最大 200。`/domains` 不分页；`/tasks` 返回 `items/page/pageSize`，没有 `total`。

## 5. 只读分享 API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/shares` | `{"mailboxId":"UUID","days":7,"password":"可选至少6位"}`；days 1–30；返回 `id/token/url/expiresAt` |
| GET | `/shares?mailboxId={UUID}` | 列出现有分享，不返回原 token |
| DELETE | `/shares/{id}` | 撤销分享 |
| GET | `/public/shares/{token}` | 获取 `address/expiresAt/passwordRequired` |
| POST | `/public/shares/{token}/unlock` | `{"password":"分享密码"}`，保存返回的分享 Cookie |
| GET | `/public/shares/{token}/messages` | 最新 200 封，不支持分页 |
| GET | `/public/shares/{token}/messages/{id}` | 阅读分享邮箱中的一封邮件 |
| GET | `/public/shares/{token}/attachments/{id}` | 下载对应附件 |

无密码分享只需 token；密码分享需先解锁并在后续请求携带解锁 Cookie。分享密码解锁无需普通登录或 CSRF。撤销、到期或转移邮箱后立即失效。`token/url` 创建时仅返回一次，请妥善保存；邮箱地址及 `/inbox?mailbox=...` 链接本身不是免登录访问凭证。

## 6. 业务账号与任务

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/accounts` | 分页、q 搜索、status 筛选 |
| PATCH | `/accounts/{id}` | 更新注册、订阅、封禁、KYC、期限、标签、备注等；详见 Swagger body |
| GET | `/accounts/{id}/events` | 状态变更记录 |
| POST | `/accounts/import` | `{"rows":[{"email":"hello@example.com","platform":"claude"}]}`，最多 200 条 |
| POST | `/accounts/export` | `{"ids":["UUID"],"format":"json","includeSecrets":false}`；format 支持 `json/csv/xlsx` |
| PUT | `/accounts/{id}/credentials/{kind}` | kind 为 `session/proxy`，JSON `{"value":"凭据"}` |
| DELETE | `/accounts/{id}/credentials/{kind}` | 删除凭据 |
| POST | `/accounts/{id}/credentials/{kind}/reveal` | `{"confirm":true}`，显式读取明文且审计 |
| POST | `/accounts/query` | `{"ids":["UUID"],"requireProxy":false}`，最多 200；返回 `taskId` |
| GET | `/tasks` | 读取任务 `state/progress/total/result/error/cancelRequested` |
| POST | `/tasks/{id}/cancel` | 请求停止 |

任务状态：`queued/running/completed/failed/cancelled`。批量认证查询串行执行；配置代理失败不回退直连，网络异常不覆盖最近确认状态。默认不周期轮询第三方账号。普通 API 不返回 Session、代理明文；含敏感信息的导出、显式查看均需原有权限并审计。

## 7. 错误与限流

```json
{"error":{"code":"UNAUTHENTICATED","message":"请先登录","requestId":"req-123"}}
```

| HTTP | 常见原因 |
| --- | --- |
| 400 | 字段、UUID、JSON、引用或业务参数错误 |
| 401 | 未登录、会话到期、密码错误、分享未解锁 |
| 403 | 无权限、CSRF 不一致、外部 Origin、令牌范围不符 |
| 404 | 对象不存在、已撤销分享或对象不属于当前用户 |
| 409 | 记录已存在 |
| 413 | 请求超过大小限制 |
| 429 | 限流；遵循 `Retry-After`，延迟重试 |
| 500 | 服务暂时不可用，凭 requestId 排查日志 |

默认按来源 IP 每分钟最多 300 次；登录每 15 分钟最多 8 次；分享解锁每 15 分钟最多 5 次。反代环境按已配置的可信代理提取客户端 IP。不要通过重复登录获取每次请求所需的 Cookie，应复用会话。
