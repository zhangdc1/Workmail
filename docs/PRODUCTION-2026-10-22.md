# 2026-10-22 生产部署记录

## 1. 实际环境

- 新服务器：`103.23.149.55`，Ubuntu 22.04，约 4 GB 内存、49 GB 系统盘。
- 项目目录：`/opt/inboxlab`。
- 网页入口：`https://99app.top`；管理员用户名：`admin`。
- SMTP 主机名：`roio.top`，公网 TCP 25；内部 SMTP、数据库不发布宿主机端口。
- 已启动 PostgreSQL、API、Worker、内部 SMTP、Rspamd、Postfix、Caddy、Certbot 续期服务。
- SMTP 正式证书已签发，到期日为 2027-01-20；Certbot staging 续期演练通过。
- 证书联系邮箱仅用于 ACME 注册，不代表自动转发收件邮件到 QQ。
- 未修改旧服务器，不导入旧数据，不接入任何真实第三方账号或代理。

生产密码和加密密钥只保存在受限的 `.env.production` 中，不写入此记录或 Git。若尚未修改管理员初始密码，请登录后修改；不要重新生成生产环境文件。

## 2. 已通过的实际验证

| 项目 | 结果 |
| --- | --- |
| 网站与健康检查 | 公网 HTTPS 页面及 `/api/v1/health` 返回 200 |
| SMTP STARTTLS | 从服务器外的 Windows 本机经物理网卡连接公网 25，正式证书校验成功，TLS 1.3 |
| 未知收件人 | RCPT 阶段返回 550，而非临时 DNS/数据库错误 |
| 外域转发 | RCPT 阶段返回 554 Relay access denied |
| 接收入库 | Postfix → 内部 SMTP → Worker → PostgreSQL/持久卷 → 网页 API 完成 |
| Envelope 归属 | Envelope 为 `test@roio.top`，正文 To 为其他地址，邮件仍归属 test 邮箱 |
| MIME、附件与验证码 | 两封测试信均解析成功；识别验证码；下载附件 SHA-256 与发送端一致 |
| HTML 隔离 | 测试信脚本、远程追踪图片移除；生产浏览器隔离阅读面板可见 |
| 排队与重启恢复 | 内部 SMTP 停止时公网 Postfix 接受并排队；重启 API、Worker、Postfix 后队列号保持；恢复 SMTP 后队列清空，网页只增加一封 |
| SMTP 续期 | Certbot `renew --dry-run` 成功 |
| 备份恢复 | 实际备份在独立空 Compose 项目中恢复；17 张业务/迁移表的行数及内容摘要完全一致；两份原文、两份附件字节摘要完全一致 |
| 加密凭据恢复 | 使用明确标记的虚构代理凭据验证同密钥可解密、错误密钥失败；不连接代理或第三方服务；生产测试凭据已移除 |
| 生产浏览器 | 桌面 Chrome 登录态、概览、收件列表、隔离阅读、域名页验证通过，无 pageerror |
| 本地回归 | 28 项测试及 TypeScript 检查通过；生产镜像构建成功 |

测试邮件编号：

```text
20261022T133613Z-mail
20261022T134031Z-queue-send
```

第二封的 Postfix 队列号为 `088997FD9B`，停止与重启后均存在，恢复后消失。两封测试信保留在 `test@roio.top`，方便网页登录核对。另建 `postmaster@roio.top`。不存在 catch-all，只有显式创建的地址接收邮件。

## 3. 尚需在 DNS 控制台添加 MX

2026-10-22 的服务器及公共 DoH 查询确认 `roio.top` 的 A 记录已指向本服务器，但当时没有 MX 记录。请在当前权威 DNS 服务商控制台添加：

| 类型 | 主机记录 | 记录值 | 优先级 |
| --- | --- | --- | --- |
| A | @ | 103.23.149.55 | 不适用 |
| MX | @ | roio.top | 10 |

A 已存在时不要重复添加。SMTP 主机 A 记录必须直连，不启用 HTTP CDN 代理；不要发布不可达的 AAAA。`99app.top` 仅作网站时不需要 MX。

多个收件域名均可指向同一台 SMTP 主机。例如后续接入 `another-domain.example`，先在平台添加域名和邮箱，再在该域名 DNS 添加 `MX @ → roio.top`，优先级 10。

验证命令：

```bash
dig +short A roio.top @1.1.1.1
dig +short MX roio.top @1.1.1.1
```

预期分别为 `103.23.149.55` 和 `10 roio.top.`。随后在网页“域名与接入”执行 DNS 检查，再从已登录 QQ 邮箱发送一封带唯一主题、正文和附件的邮件到 `test@roio.top`，核对网页实际出现。此次已完成“外部客户端直连公网 SMTP 投递”，没有冒称已从 QQ/Gmail 邮件服务商成功发送，也没有完成第二个真实收件域名验收。

## 4. 备份与恢复证据

- 每日备份定时器已启用；UTC 03:30 附近执行，存在随机延迟。
- 已实际恢复的备份：`/opt/inboxlab/backups/daily/20261022T134238Z`。
- 独立恢复目录及项目名：`/opt/inboxlab-restorecheck-20261022` / `inboxlab-restorecheck-20261022`。
- 恢复验证结束后已停止并移除测试容器和网络，保留恢复数据卷，不占用公网端口。
- 证据目录：`/opt/inboxlab-ops/20261022`。
  - `queue-recovery.log`
  - `cert-renew-dry-run.log`
  - `backup.log`、`restore.log`
  - `source-snapshot.json`、`restored-snapshot.json`
  - `verify-restored.mjs`（仅输出摘要和验证布尔值，不输出凭据明文）

摘要比较：

```bash
cmp /opt/inboxlab-ops/20261022/source-snapshot.json \
    /opt/inboxlab-ops/20261022/restored-snapshot.json
```

请仍将备份复制到独立存储，单独保管加密密钥。当前备份保存在同一服务器，不能抵御整台服务器丢失。Postfix 尚未入库的队列卷不在数据库/邮件归档中。

## 5. 本次修复

1. 显式分配 Caddy/API 的不同内部地址，避免 Compose 地址争用。
2. 邮箱导入按 `addresses.address` 判断重复，不再查询不存在的 `id`。
3. 精简镜像移除 Postfix 权限清单中的缺失 manpage 条目，保留运行文件权限检查。
4. Postfix 所有后台服务均关闭 chroot，确保负责 SQL 域名查询的 `trivial-rewrite` 可以访问 Docker DNS/libpq。
5. IPv4/IPv6 代理地址封锁规则分离，修复 IPv4-mapped IPv6 段误封所有公网 IPv4 的问题，继续拒绝内网及 mapped 地址。
6. 运行镜像仅授予邮件数据目录写权限，应用代码和依赖保持 root-owned，避免递归 chown 带来的慢速构建。

原服务器文件在证据目录留有 `.before` 副本。没有修改已执行的 SQL 迁移，没有关闭 CSRF 或放宽数据库权限。

## 6. 日常操作

以下命令均在服务器执行：

```bash
cd /opt/inboxlab

# 查看服务、健康及队列
docker compose --env-file .env.production --profile mail ps
curl -fsS https://99app.top/api/v1/health
docker compose --env-file .env.production exec -T postfix postqueue -p

# 日志
docker compose --env-file .env.production --profile mail \
  logs --tail=100 api smtp worker postfix

# 手动备份
bash /opt/inboxlab/deploy/backup.sh

# 续期演练，不替换正式证书
docker compose --env-file .env.production --profile tools run --rm certbot \
  renew --dry-run --no-random-sleep-on-renew

# 查看定时任务
systemctl list-timers inboxlab-backup.timer --no-pager
```

不要运行 `docker compose down -v`，不要删除 `.env.production`，不要启动开发 seed。

## 7. 明确未验收项

- MX 生效后的 QQ/其他实际服务商投递、第二个真实收件域名。
- 第三方账号正常/失效/代理失败的真实响应，以及用户浏览器扩展采集。
- SMTP ACK 丢失时完全相同原文重试的生产故障注入（本地幂等测试通过；生产已验证普通排队恢复不重复）。
- 灾难恢复后的全套公网服务切换（本次为空数据库及文件恢复、内容核对与凭据解密演练）。

生产截图存于 `artifacts/screenshots/production-20261022/`，均为明确标记的部署测试邮件，不含真实会话或密码。
