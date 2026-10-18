# InboxLab：多域名收件与账号认证工作台

独立新项目，不使用旧项目的数据库、部署和凭据。默认中文，蓝白界面；仅收件，不提供发信、IMAP 或公开注册。

## 交付状态

截至 2026-10-18，已实现可运行的前后端、数据库迁移、内部 SMTP、邮件解析 Worker、账号与权限、分享、认证台账、两套扩展源码、部署与备份脚本。

本地使用真实 SQL 执行、TCP SMTP 和 Chromium 浏览器验证。开发用 PGlite 不等于生产 PostgreSQL；开发样本不等于公网来信。已尝试启动 Docker Desktop，但 Linux 引擎被 dockerInference 套接字初始化错误阻塞；容器部署、公网 Postfix/Rspamd/TLS、真实第三方账号查询、用户浏览器扩展安装与代理以及生产备份恢复仍待验收。详见 `docs/ACCEPTANCE.md`。

## 本地启动

环境：Node.js 24，npm；项目已提供 `package-lock.json`。以下命令在项目根目录执行：

```powershell
Set-Location 'D:\gpt项目\自建域名邮箱'
npm ci
node scripts/setup.mjs --local
npm run db:migrate
npm run db:bootstrap
# 可选：仅用于开发，插入 .test 域名、样本邮件与账号
npm run db:seed
npm run dev
```

浏览器访问 `http://localhost:5173`。默认用户名 `admin`，随机初始密码保存在本机 `.env` 的 `BOOTSTRAP_PASSWORD` 中，不写入文档和日志。生成配置脚本不覆盖已有文件；若 `.env` 已存在，先确认 `DATABASE_MODE=pglite`。

本地端口：

| 服务 | 地址 | 用途 |
| --- | --- | --- |
| 网页 | `http://localhost:5173` | Vite 开发入口 |
| API | `http://127.0.0.1:3001` | `/api/v1`，网页开发代理同源转发 |
| 内部 SMTP | `127.0.0.1:2525` | 开发收件测试，不能代替公网 25 端口 |
| OpenAPI | `http://localhost:5173/api/docs` | 登录后打开 |

本地 PGlite 模式将 API、SMTP 和 Worker 放在一个进程中，避免多个进程打开同一目录。不要在此模式另运行 `npm run worker`、`npm run smtp` 或在服务运行时执行独立数据库脚本。生产环境只允许 PostgreSQL。

仅维护邮件和台账无需 Python。实际 Claude 查询另外需要：

```powershell
python -m venv .local/integration
.\.local\integration\Scripts\python.exe -m pip install -r integrations/requirements.txt
```

把 `.env` 的 `INTEGRATION_PYTHON` 设置为该 Python 的绝对路径并重启 API。不要把官网会话、代理密码放入命令行或截图。未配置第三方运行时只会显示查询不可用，不会把认证状态改为失败。

## 已实现功能

- 域名批量添加、DNS 检查、启用/禁用/退役；退役保留已有地址收件。
- 独立邮箱创建与导入、标签/备注、别名、配额接口、事务转移归属。
- 三栏收件、搜索、未读/星标、批量操作、附件/原文下载、验证码与登录链接提取。
- 清洗后的 HTML 在 sandbox iframe 中展示，不执行脚本、不加载远程图片；登录链接仅显式点击。
- SSE 新邮件/任务更新，断线重连重新同步；验证码等待传入开始时间。
- 七天默认分享，可设密码、撤销；邮箱地址不是访问凭证。转移撤销旧授权、分享和认证只读授权。
- 管理员、成员、认证只读用户；服务端会话、scrypt 密码哈希、CSRF、限流和审计。
- 账号注册/订阅/封禁/认证状态、链接/期限/备注/历史；JSON/CSV 文件或逐行邮箱导入，JSON/CSV/XLSX 导出。
- Session、代理凭据 AES-256-GCM 加密；普通列表不返回明文，显式查看/敏感导出经鉴权并审计。
- 手动/导入会话/会话更新触发查询，串行任务、可停止、同账号查询锁、旧凭据结果丢弃。
- Claude 适配器；ChatGPT/其他平台当前为台账，不使用 Claude 接口查询。
- 一次性扩展配对；完整版/兼容版共享核心，平台地址可配置，暂停移除监听。
- Docker Compose、Caddy、Postfix、基础 Rspamd、SMTP 证书续期、每日备份及空环境恢复脚本。

## 开发与检查

```powershell
npm run check
npm run extension:build
# 先按上面的步骤启动并放入开发样本；需要已安装 Chrome
npm run test:e2e
```

`npm run check` 执行类型检查、自动化测试和生产构建。浏览器截图写入 `artifacts/screenshots`，包含登录、工作台、收件箱、域名、账号、手机视图。

两套扩展生成于 `dist/extensions/full` 和 `dist/extensions/compat`。实际安装步骤和边界见 `docs/EXTENSIONS.md`。

## 目录

```text
apps/web/              React / TypeScript / Vite / Tailwind / Radix 界面
apps/api/src/          Fastify、鉴权、SMTP、邮件解析、任务与第三方适配
apps/api/migrations/   分实体 SQL 迁移、Postfix 只读视图
packages/shared/      前后端公共 TypeScript 类型
extensions/shared/    两套扩展的共享核心
integrations/         去凭据的参考解析逻辑与 Python 网络适配
deploy/               Postfix / Rspamd / Caddy / 备份恢复 / systemd
scripts/              初始化、迁移、构建与离线维护
tests/                SQL/API/SMTP/扩展策略/浏览器回归
docs/                 部署、验收、设计与运行说明
```

## 上线前必读

- 部署与 DNS：`docs/DEPLOYMENT.md`
- 验收步骤和未完成验证：`docs/ACCEPTANCE.md`
- 权限、数据、容量和接口：`docs/ARCHITECTURE.md`
- 扩展安装和真实浏览器验证：`docs/EXTENSIONS.md`
- 参考代码来源与复用边界：`docs/PROVENANCE.md`

不要提交 `.env`、`.env.production`、`data`、`runtime`、备份或明文敏感导出。密钥单独保存；丢失加密密钥后，数据库备份无法还原 Session 和代理凭据。
