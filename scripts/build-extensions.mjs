import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
for (const variant of ["full", "compat"]) {
  const output = resolve("dist/extensions", variant); await mkdir(output, { recursive: true });
  for (const name of ["background.mjs", "capture.mjs", "proxy.mjs", "popup.html", "popup.css", "popup.mjs"]) await copyFile(resolve("extensions/shared", name), resolve(output, name));
  const manifest = {
    manifest_version: 3, name: `InboxLab ${variant === "full" ? "完整版" : "兼容版"}`, version: "1.0.0",
    description: "主动配对私有平台，核对账号邮箱后采集会话和认证结果。",
    permissions: ["storage", "cookies", "scripting", "tabs", "webNavigation", ...(variant === "full" ? ["proxy", "webRequest", "webRequestAuthProvider"] : [])],
    host_permissions: ["https://claude.ai/*", ...(variant === "full" ? ["https://api64.ipify.org/*", "<all_urls>"] : [])],
    optional_host_permissions: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
    background: { service_worker: "background.mjs", type: "module" }, action: { default_popup: "popup.html" },
    incognito: "spanning", content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
  };
  await writeFile(resolve(output, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`构建完成：${output}`);
}
