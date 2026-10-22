# Ubuntu 生产部署与运行手册

此文档提供通用部署步骤。2026-10-22 的实际服务器部署和验收进度单独记录于 `PRODUCTION-2026-10-22.md`；不要把本地测试或健康检查等同于全部公网收件验收通过。

## 1. 前提

- 目标 Ubuntu 22.04/24.04 LTS，2 核/4 GB/至少 40 GB SSD，公网 IPv4，时间同步。
- 已安装 Docker Engine 与 Compose 插件；`docker info`、`docker compose version` 成功。
- 公网允许 TCP 25 入站、80、443；宿主机没有其他服务占用这些端口。
- SSH 保留管理来源访问规则，不要在调整防火墙时锁掉管理连接。
- 网页主机名和 SMTP 主机名分开，例如 `mail.example.com` / `mx.example.com`。
- SMTP 示例仅启用 IPv4；不要给 MX 主机发布无有效 IPv6 服务的 AAAA。网页若有 AAAA，也必须可达。
- 为 MX 主机使用直连 DNS，不经仅支持 HTTP 的 CDN 代理。

将本项目源码放在 `/opt/inboxlab`。不要复制开发 `.env`、`data`、`node_modules`、明文导出或旧项目数据。以下命令均在 `/opt/inboxlab` 下执行。

## 2. 配置与目录

若主机有 Node.js 24：

```bash
cd /opt/inboxlab
node scripts/setup-production.mjs mail.example.com mx.example.com admin@example.com
```

否则通过一次性 Node 容器生成：

```bash
docker run --rm -u "$(id -u):$(id -g)" \
  -v "$PWD:/workspace" -w /workspace node:24-bookworm-slim \
  node scripts/setup-production.mjs mail.example.com mx.example.com admin@example.com
```

```bash
chmod 600 .env.production
sudo install -d -m 700 -o 1000 -g 1000 runtime/mail
```

`.env.production` 中有随机管理员密码、数据库密码、Postfix 独立只读密码、独立 32 字节加密密钥。通过安全途径单独保存密钥和配置；不要在终端共享或日志中展开全部环境变量。

默认 Caddy 专用内部网段 `172.30.84.0/29`、Caddy 地址 `172.30.84.2`、API 地址 `172.30.84.3`。如与已有网段冲突，在 `.env.production` 同时调整 `EDGE_SUBNET`、`CADDY_EDGE_IP` 和 `API_EDGE_IP`，确保两个容器地址在该网段内且不重复。API 仅信任 `CADDY_EDGE_IP` 提供的转发信息；不要改成信任所有代理。

约定下面每条 Compose 命令都带 `--env-file .env.production`。此参数不仅供容器读取，还用于 Compose 密码和主机名插值，不能省略或改用开发 `.env`。

## 3. 首次建库与启动网页

```bash
docker compose --env-file .env.production --profile tools --profile mail config --quiet
docker compose --env-file .env.production build api rspamd postfix
docker compose --env-file .env.production up -d postgres
docker compose --env-file .env.production run --rm migrate
docker compose --env-file .env.production exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U inboxlab -d inboxlab < deploy/grant-postfix.sql
docker compose --env-file .env.production run --rm bootstrap
docker compose --env-file .env.production up -d api smtp worker rspamd caddy
```

数据库首次启动脚本创建 `postfix` 独立角色，迁移完成后再授予两个路由视图的 SELECT。不要漏执行 `grant-postfix.sql`，也不要给此角色应用表读取权限。`bootstrap` 已存在用户名时不会重置密码。

网页登录使用 `.env.production` 的管理员初始密码。先修改密码，再创建成员及域名授权；不在生产执行开发 seed。

## 4. DNS 与 SMTP 证书

在 DNS 提供商处设置（替换为真实 IP）：

```text
mail.example.com. A 服务器公网IPv4
mx.example.com.   A 服务器公网IPv4
example.com.     MX 10 mx.example.com.
second-domain.com. MX 10 mx.example.com.
```

所有接入域名可以指向同一个 MX。网页 HTTPS 由 Caddy 管理；SMTP 证书由独立 Certbot webroot 验证：

```bash
# 确认两个主机名已经解析，80 可达，Caddy 已启动，再申请
docker compose --env-file .env.production run --rm certbot certonly \
  --webroot -w /var/www/acme \
  -d mx.example.com --email admin@example.com \
  --agree-tos --no-eff-email --non-interactive

docker compose --env-file .env.production --profile mail up -d postfix cert-renew
docker compose --env-file .env.production --profile mail ps
```

Postfix 没有证书时拒绝启动，不以临时自签名证书冒充上线。Certbot 每 12 小时检查续期；Postfix 每 5 分钟检查证书摘要并平滑 reload。后续验证一次续期演练：

```bash
docker compose --env-file .env.production run --rm certbot renew --dry-run --no-random-sleep-on-renew
```

仅收件工作台不需要配置用户 SMTP AUTH、发信服务或 IMAP。公网仅发布 25/80/443。PostgreSQL、2525 内部 SMTP、Rspamd、Worker 不发布主机端口。

## 5. 健康与故障排查

```bash
curl -fsS https://mail.example.com/api/v1/health
docker compose --env-file .env.production --profile mail ps
docker compose --env-file .env.production logs --tail 100 api smtp worker rspamd postfix
docker compose --env-file .env.production exec postfix postqueue -p
docker compose --env-file .env.production exec postfix postconf -n
docker compose --env-file .env.production exec rspamd rspamadm configtest
docker compose --env-file .env.production exec postgres \
  psql -U inboxlab -d inboxlab -c 'SELECT name,updated_at FROM service_heartbeats'
```

系统设置显示文件卷可用空间：剩余低于 10% 或 2 GiB 告警，邮箱达到原文配额 90% 告警。该告警需管理员查看，尚未连接短信/邮件通知。配额满时内部 SMTP 返回临时容量错误，由 Postfix 队列重试；默认不删除旧邮件。

DNS 检查成功、HTTP health 成功和内部心跳在线，都不能代替公网真实投递。按 `ACCEPTANCE.md` 验证未知地址拒绝、外域转发拒绝、暂停恢复和两个域名收件。

## 6. 每日备份

```bash
bash deploy/backup.sh
```

脚本短暂停止 API、内部 SMTP 和 Worker，保留 Postfix 在线排队；生成 PostgreSQL dump、`runtime/mail` 压缩包、清单与 SHA-256 校验。完成后恢复原本运行的服务，保留 7 个日备份、每周日另保留一份，共 4 份周备份。周备份需运行至少到第一个周日后才产生。

配置自动执行：

```bash
sudo cp deploy/inboxlab-backup.service deploy/inboxlab-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now inboxlab-backup.timer
sudo systemctl list-timers inboxlab-backup.timer
```

默认每日 UTC 03:30。项目不在 `/opt/inboxlab` 时先修改 service 的路径。备份位置默认为项目下 `backups`，可设置 `BACKUP_DIR` 指向独立挂载卷；应再把备份复制到异机存储。

重要边界：

- 脚本校验的是文件完整性，不是已通过恢复演练。
- 备份不包含 `.env.production` 和加密密钥，需独立加密保管。
- 数据库里仍包含账号资料和加密凭据，邮件备份包含正文和附件，备份本身须受限保存。
- Postfix 排队卷 `postfixqueue` 是独立持久卷，不包含在上述数据库/邮件归档中。灾难时未入库邮件可能丢失；需要时在 Postfix 停机一致性窗口另做该卷快照，或使用服务器全卷一致性快照。
- 不要执行 `docker compose down -v`，此命令会删除持久卷。

## 7. 恢复演练与升级

在一台隔离测试服务器或空目录进行，使用独立 Compose 项目名（设置 `COMPOSE_PROJECT_NAME`），并避免端口冲突。不要在现有生产库上尝试恢复。

1. 放入相同版本源码和独立保管的原 `.env.production`，核对 `ENCRYPTION_KEY` 一致。
2. 新环境如需独立主机名，修改网页/MX 地址，保留原加密密钥。不要连回旧服务器。
3. 只启动空 PostgreSQL；不要先执行迁移和 bootstrap。

```bash
docker compose --env-file .env.production build api
bash deploy/restore.sh /absolute/path/to/backup
docker compose --env-file .env.production run --rm migrate
docker compose --env-file .env.production up -d api smtp worker
```

恢复脚本要求数据库和邮件目录都为空；否则停止，不删除原数据。随后核对用户、两个域名、邮件数量、原文、附件及受控的凭据解密，再按本手册重新准备 Caddy/SMTP 证书。浏览器会话和分享记录也被恢复，灾后如需撤销所有已有访问，应由管理员执行并记录。

日常升级先备份：

```bash
docker compose --env-file .env.production stop -t 100 api smtp worker
docker compose --env-file .env.production build api
docker compose --env-file .env.production run --rm migrate
docker compose --env-file .env.production exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U inboxlab -d inboxlab < deploy/grant-postfix.sql
docker compose --env-file .env.production up -d api smtp worker
```

保留上一个版本镜像及其配套备份。不要修改已执行的 SQL 迁移；新增递增编号迁移。数据库结构回退必须结合版本与备份方案，不假定旧镜像能读所有新结构。

## 8. 显式文件整理

手动删除邮件会删数据库邮件/附件索引并释放逻辑配额，文件副本先保留。默认不定时清理。仅在备份后、停止全部写入服务时整理超过一天的无引用文件：

```bash
docker compose --env-file .env.production stop -t 100 api smtp worker
sleep 65
# 先报告，不删除
docker compose --env-file .env.production run --rm maintenance
# 确认报告和备份后，显式离线删除无引用文件
docker compose --env-file .env.production run --rm maintenance \
  node dist/scripts/storage-maintenance.js --apply --offline-confirm
docker compose --env-file .env.production up -d api smtp worker
```

保留中的邮件原文与附件不在删除候选中。不支持多实例滚动在线 GC；`--offline-confirm` 的前提是所有写入实例确实已停止。
