import { runCapture } from "./capture.mjs";
import { createProxyController } from "./proxy.mjs";
let capturing = false, listening = false;
const FULL = chrome.runtime.getManifest().name.includes("完整版");
const settings = () => chrome.storage.local.get(["origin", "token", "accountId", "expectedEmail", "auto"]);
async function platform(path, payload) {
  const s = await settings(); if (!s.origin || !s.token) throw new Error("请先主动连接平台");
  const r = await fetch(s.origin + "/api/v1" + path, { method: payload ? "POST" : "GET", headers: { "Content-Type": "application/json", Authorization: "Bearer " + s.token }, ...(payload ? { body: JSON.stringify(payload) } : {}), redirect: "error", credentials: "omit", signal: AbortSignal.timeout(25000) });
  const data = await r.json(); if (!r.ok) throw new Error(data.error?.message || "平台请求失败"); return data;
}
const proxy = FULL ? createProxyController(chrome, platform) : null;
if (proxy) void proxy.ready.catch(() => chrome.storage.local.set({
  proxyState: { state: "blocked", message: "代理状态初始化失败，请关闭无痕窗口并检查扩展权限" },
}));
async function capture(tabId, withKyc, automatic = false) {
  if (capturing) throw new Error("采集正在进行"); capturing = true;
  try {
    const s = await settings();
    if (!s.accountId || !s.expectedEmail) throw new Error("请选择目标账号");
    if (automatic && !s.auto) return;
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || new URL(tab.url).origin !== "https://claude.ai") throw new Error("请在已登录的 Claude 官网标签中采集");
    const identity = async () => {
      const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: async () => {
        if (location.origin !== "https://claude.ai") return null;
        for (const path of ["/api/account", "/edge-api/bootstrap", "/api/bootstrap"]) {
          try {
            const r = await fetch(path, { credentials: "include", redirect: "error", signal: AbortSignal.timeout(10000) });
            if (!r.ok) continue; const data = await r.json(), user = data.account || data.user || data;
            const email = user.email_address || user.email; if (typeof email === "string") return email.toLowerCase();
          } catch {}
        } return null;
      } });
      return r?.result;
    };
    const before = await identity();
    if (before !== s.expectedEmail.toLowerCase()) throw new Error("当前官网登录邮箱与目标账号不一致，未读取或回填会话");
    const storeId = tab.incognito ? (await chrome.cookies.getAllCookieStores()).find(x => x.tabIds.includes(tabId))?.id : undefined;
    let cookie;
    for (const name of ["sessionKeyLC", "sessionKeyV3LC", "sessionKey"]) {
      cookie = await chrome.cookies.get({ url: "https://claude.ai/", name, ...(storeId ? { storeId } : {}) });
      if (cookie?.value) break;
    }
    if (!cookie?.value) throw new Error("尚未取得会话，请完成官网登录");
    let snapshot;
    if (withKyc) {
      const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: runCapture, args: [s.expectedEmail, "auto_link"] });
      if (!r?.result?.ok) throw new Error(r?.result?.message || "认证采集失败");
      snapshot = r.result.snapshot;
    }
    if (await identity() !== before) throw new Error("采集时登录账号发生变化，结果已丢弃");
    const latest = await settings();
    if (latest.accountId !== s.accountId || latest.token !== s.token || latest.origin !== s.origin || automatic && !latest.auto) throw new Error("采集期间配置已改变或已暂停，结果已丢弃");
    await platform("/extensions/capture", { accountId: s.accountId, confirmedEmail: before, sessionKey: cookie.value, ...(snapshot ? { snapshot } : {}) });
    await chrome.storage.local.set({ lastResult: "核对邮箱后已回填：" + before, lastAt: new Date().toISOString() });
    return { message: snapshot ? "Session 与认证状态已回填" : "Session 已安全回填" };
  } finally { capturing = false; }
}
const autoCapture = async tabId => {
  const s = await settings(); if (!s.auto) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.url?.startsWith("https://claude.ai/")) await capture(tabId, false, true).catch(error => chrome.storage.local.set({ lastResult: error.message }));
};
const navigation = details => { if (details.frameId === 0) void autoCapture(details.tabId); };
const cookieChanged = async change => {
  if (change.removed || !["sessionKeyLC", "sessionKeyV3LC", "sessionKey"].includes(change.cookie.name) || !/(^|\.)claude\.ai$/.test(change.cookie.domain.replace(/^\./, ""))) return;
  for (const tab of await chrome.tabs.query({ url: "https://claude.ai/*" })) await autoCapture(tab.id);
};
function listen(on) {
  if (on === listening) return; listening = on;
  if (on) { chrome.webNavigation.onCompleted.addListener(navigation, { url: [{ hostEquals: "claude.ai" }] }); chrome.cookies.onChanged.addListener(cookieChanged); }
  else { chrome.webNavigation.onCompleted.removeListener(navigation); chrome.cookies.onChanged.removeListener(cookieChanged); }
}
void settings().then(s => listen(!!s.auto));
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL("popup.html")) return;
  void (async () => {
    if (message.action === "connect") {
      const u = new URL(message.origin);
      if (u.origin !== message.origin || u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname))) throw new Error("平台地址必须为 HTTPS origin（本机允许 HTTP）");
      if (!await chrome.permissions.contains({ origins: [u.origin + "/*"] })) throw new Error("尚未授权访问此平台");
      const r = await fetch(u.origin + "/api/v1/public/extensions/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: message.code, name: chrome.runtime.getManifest().name }), credentials: "omit", redirect: "error", signal: AbortSignal.timeout(15000) });
      const data = await r.json();
      if (!r.ok || data.origin !== u.origin) throw new Error(data.error?.message || "平台地址核对失败");
      await chrome.storage.local.set({ origin: u.origin, token: data.token, auto: false, accountId: "", expectedEmail: "" }); listen(false);
      return { message: "平台已确认连接" };
    }
    if (message.action === "accounts") return platform("/extensions/accounts");
    if (message.action === "select") { await chrome.storage.local.set({ accountId: message.id, expectedEmail: message.email, auto: false }); listen(false); return { message: "账号已选择，自动监听暂停" }; }
    if (message.action === "auto") { await chrome.storage.local.set({ auto: !!message.enabled }); listen(!!message.enabled); return { message: message.enabled ? "已开启登录后回填" : "已暂停并停止监听" }; }
    if (message.action === "capture") { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); return capture(tab.id, true); }
    if (message.action === "disconnect") { await platform("/extensions/disconnect", {}).catch(() => {}); await chrome.storage.local.remove(["token", "accountId", "expectedEmail"]); await chrome.storage.local.set({ auto: false }); listen(false); return { message: "已断开；若开启代理请单独关闭" }; }
    if (message.action === "proxy-on" && proxy) { const s = await settings(); return proxy.enable(s.accountId); }
    if (message.action === "proxy-off" && proxy) return proxy.disable();
    throw new Error("不支持的操作");
  })().then(data => respond({ ok: true, ...data }), error => respond({ ok: false, message: error.message || "操作失败" }));
  return true;
});
