# 验收记录与复现步骤

2026-10-22 更新：新服务器实际 SMTP、队列恢复、TLS 续期、备份恢复及生产浏览器验收见 `PRODUCTION-2026-10-22.md`；当前回归测试为 28 项。以下保留 2026-10-18 本地验收时点的原始记录，不代表此后没有进行服务器部署。

记录日期：2026-10-18，Windows 本地开发环境。所有开发样本显式标记为 `.test`/开发样例，不包含真实邮件和第三方会话。

## 本地已验证

| 检查 | 方式 | 结果 |
| --- | --- | --- |
| TypeScript、前端/后端生产构建 | `npm run check` | 通过 |
| API/权限/迁移/收件解析/任务/PAC/导入解析 | `npm test` | 26 项通过；PGlite 真实 SQL、临时存储；不访问第三方账号 |
| 实际 TCP SMTP | 包含在上述测试中，`tests/smtp.test.ts` | 未知/外域 RCPT 550、写入失败 451、持久化后 250、同字节重试一次入库 |
| 桌面和手机浏览器 | `npm run test:e2e` | 2 项通过；实际已安装 Chrome headless；登录、页面导航、收件阅读、无页面溢出 |
| 扩展构建 | `npm run extension:build` | full/compat 均生成 |
| 扩展代理基础策略 | 离线测试 | 不包含 DIRECT、拒绝 PAC 注入/SOCKS5 密码、重启缺凭据设为阻断 |
| Compose 配置 | `docker compose ... config --quiet` | 静态通过，使用占位配置，不输出真实凭据 |
| Shell/Python | Git Bash `bash -n` / Python AST | 语法通过，不代表容器/网络行为通过 |

API 测试覆盖：

- 会话、CSRF、跨站来源、批次上限、畸形 JSON 的 400。
- 域名、成员/认证只读隔离、只读授权；邮箱转移后邮件/附件/写入/分享和只读授权撤销。
- SMTP envelope 与正文不同归属仍正确；两个域名独立；同 Message-ID 不同原文仍为两次投递。
- 显式别名进入目标箱，主地址和别名同一投递不重复显示。
- 原文保存、附件字节、重复解析、HTML 清洗、验证码、搜索、配额临时错误与域名退役。
- AES-GCM 跨账号 AAD 校验，网络/代理/会话失败保留确认状态，revision 变化丢弃结果，账号查询锁，取消排队任务。
- 分享密码、随机 token、到期约束的读取条件、主动配对单次使用、扩展令牌范围、密码修改撤销。
- JSON/CSV 重新导入剥离 ownerId/id 等只读字段，CSV 引号/换行/布尔值与 200 项上限。

本地从空开发数据库复现：

1. 在独立空目录复制源码，不复制原 `.env` 和 `data`。
2. 执行 README 本地启动命令，迁移、bootstrap、开发 seed。
3. 运行 `npm run check` 和 `npm run extension:build`。
4. 保持 `npm run dev` 运行，另一个终端运行 `npm run test:e2e`；需要安装 Chrome。
5. `tests/platform.test.ts` / `tests/smtp.test.ts` 每轮新建隔离临时数据库和文件目录，结束自动删除；不使用开发用户数据。

当前截图位于 `artifacts/screenshots`：

```text
login-desktop.png
dashboard-desktop.png
inbox-desktop.png
domains-desktop.png
accounts-desktop.png
dashboard-mobile.png
inbox-mobile.png
```

## 仍待生产环境验证

以下均未标为通过：

| 项目 | 当前前提缺口 |
| --- | --- |
| 空环境 Compose 部署及 PostgreSQL 真机事务/并发 | 已尝试启动 Docker Desktop，dockerInference 套接字初始化错误导致引擎不可用 |
| Postfix/Rspamd 镜像运行、只读视图路由、真实队列暂停恢复 | 需要可用容器环境 |
| 两个真实域名的公网收件、外域转发拒绝 | 未提供 VPS、域名/入站 25 |
| Caddy/SMTP 正式证书申请与续期 | 需要真实 DNS 与 80/443 |
| 第三方正常/失效/代理失败的真实响应 | 未提供真实账号与代理 |
| 用户真实浏览器扩展安装、采集、暂停及无痕代理 | 未提供已登录浏览器验证环境 |
| 每日备份后在空环境恢复，并验证凭据解密 | 需要真实 PostgreSQL/Docker；当前只有脚本与静态校验 |

本机 Docker 阻塞证据（2026-10-18 03:31，Asia/Shanghai）：backend 日志报告 `starting services: initializing Inference manager`，随后在 `<LOCALAPPDATA>\Docker\run\dockerInference` 执行 socket remove/listen 时出现 `The file cannot be accessed by the system`。未恢复出厂设置、未删除 Docker 卷或内部状态。网页开发服务不依赖该引擎，仍可访问。

## 上线验收步骤

### A. DNS、TLS、真实域名

按 DEPLOYMENT.md 启动服务。用真实域名替换以下示例，不将 `.test` 当作公共 DNS：

```bash
dig +short A mx.example.com
dig +short MX example.com
dig +short MX second-domain.com
openssl s_client -starttls smtp -connect mx.example.com:25 -servername mx.example.com </dev/null
curl -fsS https://mail.example.com/api/v1/health
```

管理员创建两个域名、不同邮箱；从外部邮箱各发送一封带唯一测试编号的邮件，网页确认实际 envelope 收件地址、时间、正文与附件。保存编号、服务日志和网页截图；不要保存第三方会话明文。

### B. 拒绝未知地址和外域转发

从服务器外部网络使用 SMTP 客户端或 `swaks`（单次、指定收件人）：

```bash
swaks --server mx.example.com --port 25 \
  --from known-sender@example.net --to nonexistent@example.com --quit-after RCPT
swaks --server mx.example.com --port 25 \
  --from known-sender@example.net --to relay-target@unmanaged-domain.test --quit-after RCPT
```

两者须在 RCPT 阶段拒绝，不能 DATA 接受后再当作“成功”。使用实际接入域名和一个未接入域名。若报临时 DNS/数据库错误，不算正确拒绝验收。

### C. 队列、恢复与幂等

1. 记录目标邮箱的现有数量，停止内部 `smtp` 服务，保持 Postfix/Rspamd 运行。
2. 从外部发送唯一主题及编号的一封测试邮件；发送方应被 Postfix 接收，`postqueue -p` 显示等待投递。
3. 重启 API/Worker，确认队列仍在；不要删除 Postfix 持久卷。
4. 恢复内部 SMTP，刷新队列：

```bash
docker compose --env-file .env.production stop smtp
# 现在从外部发送测试邮件
docker compose --env-file .env.production exec postfix postqueue -p
docker compose --env-file .env.production up -d smtp
docker compose --env-file .env.production exec postfix postqueue -f
```

5. 网页只增加一封；队列消失；数据库与文件原文一致。
6. 为验证 ACK 丢失重试，使用受控 TCP 代理/测试环境丢弃内部最终 250，让同一 Postfix 队列重新投递；目标箱仍只增加一封。不要把重新发送的另一封邮件当作队列重试：新的 Received 本来就应形成另一封。

### D. 归属与权限

- SMTP envelope 发送到 A 邮箱，但正文 To 写 B：只有 A 收件。
- 地址 A 的显式别名进入 A；独立地址 B 不进入 A。
- Alice 不能用邮件 ID、附件 ID、原文 URL 或账号 ID 读取 Bob 数据。
- 认证只读用户不能读取邮件、Session、代理、IP；只显示管理员分配台账。
- 创建分享，验证需要 token/密码；撤销后新请求拒绝；转移邮箱到 Bob 后 Alice 的读写请求与旧分享均拒绝。
- 撤销不能抹除访问者此前已下载的内容，只能阻止新的服务端访问。

### E. 正文、验证码与 UI

- 带远程图片、脚本、表单的邮件：不自动请求远端、不执行脚本；保留可读正文和原文下载。
- 下载附件核对 SHA-256；跨用户附件请求拒绝。
- 开始验证码等待前先存在一封旧验证码邮件：不返回旧邮件；开始后新信才触发。
- 搜索、分页、星标、未读、批量选择、空状态与失败重试；手机列表/详情切换。
- 邮件卷空间低于阈值显示告警；不要在生产用填满磁盘方式测试，可在隔离小卷演练。

### F. 第三方及扩展

只在准备好账号后显式触发：

1. 记录最近确认 KYC，正常查询核对官网结果。
2. 过期会话、不可达代理、错误代理认证、出口 IP 不一致分别显示不同同步状态。
3. 网络失败不得改写最近确认 KYC 为 denied，也不得默认为封禁。
4. 批量任务串行，停止后不再查询下一项；查询中更新 Session 后旧结果被丢弃。
5. ChatGPT/其他台账不调用 Claude 接口。
6. 扩展真实浏览器步骤见 EXTENSIONS.md，完成全/兼容两版，不使用 API 测试代替采集验收。

### G. 备份恢复

1. 发送带附件的真实测试信并创建受控测试凭据，记录数据库各实体数量和文件 SHA-256。
2. 执行备份，检查 SHA256SUMS；确认暂停的服务已恢复、Postfix 期间可排队。
3. 在独立空环境使用相同加密密钥恢复，比较邮件/附件/账号/认证事件数量和原文字节。
4. 登录恢复后的系统，受控查看一个测试凭据证明可解密，记录审计事件但不截图凭据。
5. 验证空库限制、已有库保护、密钥错误时解密失败；测试正式证书需在恢复环境单独配置。

完成并归档以上生产证据后，才能将此工程标记为“上线验收完成”。
