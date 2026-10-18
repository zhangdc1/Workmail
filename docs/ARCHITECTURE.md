# 设计与实现约定

## 数据与进程

生产链路：

```text
发送方 -> 公网 Postfix :25 -> Rspamd milter -> Postfix 持久队列
       -> 私网 SMTP :2525 -> 原文持久化 + SQL 事务 + 解析任务 -> Worker
       -> PostgreSQL 邮件索引 / 文件卷附件 -> Fastify -> React 工作台
```

SMTP 原文先写临时文件，文件 fsync 后 rename；POSIX 同步目录，再提交原文索引、邮件行、容量预留及任务的数据库事务。成功后才返回 DATA 250。写入失败返回临时错误；未知收件人在 RCPT 阶段拒绝。正文 To/Cc 不参与归属。

Postfix 从 `postfix_domains` 和 `postfix_recipients` 视图获取路由，仅对接入域名中有效地址收件；显式拒绝外域转发。退役域名继续接受已有地址，禁用域名停止接收。只读角色不能查询普通应用表。

重试幂等键为原文 SHA-256 与目标邮箱。公网 Postfix 添加的入站 Received 头包含在原文里，新的一次投递与队列重试可区分；不依赖 Message-ID。直接向本地内部 SMTP 重投完全相同字节被当作重试，这是开发端点的预期行为。

原文/附件保存在 DATA_DIR，数据库分别存用户、域名、邮箱、地址、授权、原文、邮件、附件、业务账号、凭据、认证事件、任务、分享和审计。没有 JSON 整库重写。Drizzle 定义核心实体，跨实体事务和队列使用显式参数化 SQL，SQL 迁移为真实结构来源。

PG 队列通过 `FOR UPDATE SKIP LOCKED` 和租约认领任务。生产 Worker 分开执行邮件解析和账号查询；第三方慢请求不阻塞解析。解析中断可重新认领；账号查询中断后标失败，要求手动重试，不无限重放第三方请求。

## 权限与访问

| 角色 | 权限 |
| --- | --- |
| admin | 所有邮箱/台账、域名、用户、配额、授权和审计 |
| member | 自己或显式授权邮箱，自己的业务账号；仅在已授权域名创建 |
| kyc_viewer | 仅分配的认证台账与脱敏历史，不读取邮件、Session、代理、IP |
| 分享访问者 | 高熵 token 对应的单邮箱只读；可选密码；受过期/撤销限制 |
| 扩展连接器 | 用户主动配对后的 accounts/capture/proxy/disconnect 接口，不可读邮件 |

登录使用 scrypt 哈希、随机服务端会话、HttpOnly SameSite Cookie；修改密码或禁用用户撤销登录会话和扩展连接。状态修改同时校验来源与 CSRF。API JSON 不缓存；日志隐去认证头、Cookie、分享 token、请求正文。

邮箱归属转移在事务中撤销旧授权/分享/认证授权，并改变对应账号的归属和 revision。修改邮箱/邮件等操作持有邮箱行锁后重新鉴权，避免转移竞态；收件和转移统一按用户、邮箱的顺序锁定配额。

邮件 HTML 白名单清洗，阅读 iframe sandbox 无脚本权限和远程图片。原文与附件强制下载，不将上传内容作为站内 HTML 执行。未配置杀毒扫描；Rspamd 只是基础垃圾邮件检查，不意味着附件无风险。

## 凭据与第三方查询

Session 和代理密码以 AES-256-GCM 加密，独立随机 nonce，以 accountId/kind 绑定 AAD，无法跨账号/字段置换。ENCRYPTION_KEY 为独立配置，不从管理员密码派生。

普通读取不返回凭据。显式查看和敏感导出需要当前用户权限并记录审计；敏感导出文件本身是明文，不归入普通文件备份策略。

查询通过 Python `curl_cffi` 子进程传输，凭据仅写 stdin，不放 argv，不记录异常原文；只允许 Claude 身份、组织与认证相关固定路由，不开放任意 URL 查询。代理地址解析、校验并固定为数值 IP，默认不允许私网代理；若确需私有代理需明确修改配置。代理失败不回退直连。

每账号只允许一个有效查询锁；凭据或归属 revision 变化后丢弃结果。网络错误、会话失效、代理失败与真实认证拒绝区分，保留最近确认的 KYC。只有明确上游封禁返回才改变封禁标记。第三方状态解析和参考模块复用不等于已经通过真实官网验收。

默认不周期轮询第三方。只有手动、导入含 Session、会话更新触发查询；批量串行、项间间隔、可停止。停止不强制回滚已经完成的单项；正在执行的一项按超时结束后不再开启下一项。

## API

统一前缀 `/api/v1`；交互式文档 `/api/docs`，规范 `/api/v1/openapi.json`，均需登录。写入请求使用 TypeBox 校验，公共 TypeScript 类型位于 packages/shared；部分只读列表使用通用分页解析，并未逐个声明完整响应 schema。

主要资源：

```text
auth/session, auth/login, auth/logout, auth/password
users, domains, domains/:id/check
mailboxes, mailboxes/import, mailboxes/:id/aliases, mailboxes/:id/transfer
messages, messages/:id, messages/batch, messages/:id/raw, attachments/:id
mailboxes/:id/otp?since=ISO8601
accounts, accounts/import, accounts/export, accounts/query
accounts/:id/events, accounts/:id/viewers, accounts/:id/credentials/:kind
shares, public/shares/:token/...
extensions/pair, public/extensions/connect, extensions/accounts/capture/proxy
tasks, tasks/:id/cancel, events, dashboard, system, audit
```

确切方法和字段以源码及生成的 OpenAPI 为准。列表默认 50，最多 200；批次最多 200，返回逐项结果。邮箱导出按钮导出当前页选择项/当前页，不伪装为全库备份。账号导出最多 200 条。

验证码查询必须传入开始时间，严格只选其后收到的邮件，不在开始等待时取旧验证码。前端默认使用客户端开始时间，需保证客户端时钟同步；不自动访问一次性链接。

## 保留、容量和维护

- 默认永久保留邮件、附件、账号和认证记录，没有定时删除任务。
- 邮箱/用户逻辑配额按该邮箱邮件原文大小计量。多邮箱收到同一原文分别计费配额；磁盘上的原文可共用。
- MIME 解码附件、搜索索引、数据库、队列、备份另占磁盘，逻辑配额不是总磁盘限制。
- 系统设置展示邮件卷磁盘可用空间与阈值告警；尚无带外告警渠道。
- 手动删邮件立即释放逻辑配额，文件只由显式离线维护工具处理；工具默认报告、不删除。
- MIME 失败保留原文和失败提示。后台失败任务不无限循环，必要时由维护人员在查清原因后重新提交解析。
- SSE 为轻量数据库状态同步提示，每 3 秒检查，断线重新同步。不是每个第三方账号的周期查询，也不是 Redis。
