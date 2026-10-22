# 2026-10-23：API 文档与一键复制上线记录

## 发布内容

代码版本：`89dda42`，已推送 GitHub `main` 并在 `/opt/inboxlab` 构建、部署。无数据库迁移，无密钥重建，不修改现有密码或邮箱配置。

- `/api-guide`：中文调用指南、可复制 Bash 示例、常用接口表、权限及错误说明。
- `/api/docs`：交互式 Swagger；补全 Cookie、CSRF、连接器 Bearer 范围和邮箱/邮件搜索参数说明。
- `/api/v1/openapi.json`：登录后可读取。
- `docs/API.md`：完整 API 使用文档。
- `scripts/api-example.mjs`：Node.js 24 无依赖调用脚本；默认只读，结束时退出自己的会话。
- 邮箱列表、创建/导入结果、树、收件箱、别名、分享页与账号页提供地址复制；邮箱目录及创建结果可复制需登录的收件链接。
- 分享链接、验证码、认证链接、全部可识别的邮件 HTTP/HTTPS 链接支持复制；保留完整 query/hash，不自动打开链接。
- 复制提供成功/失败提示，Clipboard API 不可用时尝试兼容复制。

## 验证结果

本地：`npm run check` 通过（类型检查、34 项 Vitest、生产构建）；4 项 Chrome Playwright 测试通过；调用脚本实际登录本地 API、读取真实 SQL 数据并退出成功。

本地浏览器测试覆盖创建结果弹窗、邮箱地址/收件链接、单条/全部链接复制、分享阅读页、剪贴板兼容及失败分支、移动端无横向溢出。创建结果和分享阅读的特定样本采用明确的 UI fixture，不冒称这些样本来自公网投递。

生产实际验证：

| 检查 | 结果 |
| --- | --- |
| API、内部 SMTP 健康 | healthy；Postfix 队列为空 |
| API 指南 | 登录态页面可见，基础地址复制正确 |
| OpenAPI | 成功读取，写接口同时声明 Cookie 和 CSRF |
| Swagger | 登录态返回 200 |
| 邮箱地址、收件链接 | 实际浏览器剪贴板内容正确 |
| 邮件内单条链接 | query、百分号编码、hash 完整 |
| 全部邮件链接 | 去重并换行复制成功 |
| 自动打开行为 | 复制前后只有一个标签，无导航 |
| 手机布局 | 390×844 下无页面横向溢出 |
| 浏览器脚本错误 | 0 |
| 清理 | 测试邮件删除，验证会话已撤销 |

生产测试邮件经服务器本机 `127.0.0.1:25` → Postfix → 内部 SMTP → Worker → API → 浏览器处理。主题 `InboxLab copy regression 20261023T1728` 是测试标识，不是投递时间。包含两个 `example.invalid` 测试 URL，未访问这些链接；截图后只删除该测试邮件，不删除用户邮件。本次没有重新进行外部邮件服务商投递验收。

生产现用密码与初始化配置不同，因此没有重置密码。界面验证使用通过服务器管理权限建立、写入审计的十分钟临时会话；结束后正常调用 logout，并在数据库确认该会话不存在。未更改认证逻辑，未提交 Cookie、CSRF 或密码。

## 发布前备份及回退

- 数据备份：`/opt/inboxlab/backups/daily/20261022T171930Z`（UTC；北京时间 2026-10-23）。
- 旧镜像：`inboxlab:before-copy-api-20261023`。
- 服务器证据：`/opt/inboxlab-ops/20261023-copy-api/backup-before.log`、`build.log`。

只回退应用镜像，不删除数据卷：

```bash
cd /opt/inboxlab
docker image tag inboxlab:before-copy-api-20261023 inboxlab:local
docker compose --env-file .env.production up -d --no-deps api worker smtp
docker compose --env-file .env.production --profile mail ps
```

此命令回退运行镜像，不回退 Git 文件；以后重新 build 会恢复当前源码版本。不要执行 `down -v`、重新 bootstrap 或重新生成 `.env.production`。

## 手动复核

1. 打开 `https://99app.top` 并使用现有账号登录；必要时 Ctrl+F5 刷新。
2. 侧栏打开“API 调用文档”；复制示例，或打开 Swagger / OpenAPI。
3. 邮箱管理中点击地址旁复制按钮；悬停区分“复制邮箱地址”与“复制收件链接”。
4. 创建邮箱后，可在结果弹窗逐项复制地址/链接，或复制全部成功地址。
5. 打开带链接的邮件，在“邮件中的链接”区域逐项复制或“复制全部”；不会访问这些链接。
6. 需要免登录收件阅读时，单独生成只读分享链接；普通收件链接不绕过登录。

本地截图：`artifacts/screenshots/copy-api/`。生产截图留在本机 `artifacts/screenshots/production-20261023-copy-api/`，不随本次代码公开推送。
