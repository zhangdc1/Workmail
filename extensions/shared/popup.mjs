const $ = id => document.getElementById(id);
async function send(action, data = {}) {
  const r = await chrome.runtime.sendMessage({ action, ...data });
  if (!r?.ok) throw new Error(r?.message || "连接器未响应");
  return r;
}
async function show() {
  const s = await chrome.storage.local.get(null), connected = !!s.token;
  $("pair").hidden = connected; $("connected").hidden = !connected;
  $("proxy").hidden = !chrome.runtime.getManifest().name.includes("完整版") || !connected;
  $("origin").value = s.origin || ""; $("platform").textContent = s.origin || ""; $("auto").checked = !!s.auto;
  $("proxy-status").textContent = s.proxyState?.message || "未启用无痕代理";
  if (s.lastResult) $("result").textContent = s.lastResult;
  if (connected) {
    const { items } = await send("accounts"); $("accounts").replaceChildren(new Option("选择目标账号", ""));
    for (const a of items) { const option = new Option(a.email, a.id); option.dataset.email = a.email; $("accounts").add(option); }
    $("accounts").value = s.accountId || "";
  }
}
async function act(fn) {
  document.querySelectorAll("button").forEach(b => b.disabled = true);
  $("result").className = ""; $("result").textContent = "正在处理…";
  try { const r = await fn(); if (r?.message) $("result").textContent = r.message; }
  catch (e) { $("result").className = "error"; $("result").textContent = e.message; }
  finally { document.querySelectorAll("button").forEach(b => b.disabled = false); }
}
$("connect").onclick = () => {
  let origin; try { origin = new URL($("origin").value.trim()).origin; } catch { $("result").textContent = "平台地址不正确"; return; }
  // Permission request must start directly in the human click handler.
  const granted = chrome.permissions.request({ origins: [origin + "/*"] });
  void act(async () => { if (!await granted) throw new Error("未授权平台访问"); const r = await send("connect", { origin, code: $("code").value.trim() }); await show(); return r; });
};
$("refresh").onclick = () => void act(show);
$("accounts").onchange = () => void act(async () => { const option = $("accounts").selectedOptions[0]; const r = await send("select", { id: option.value, email: option.dataset.email || "" }); $("auto").checked = false; return r; });
$("capture").onclick = () => void act(() => send("capture"));
$("auto").onchange = () => void act(() => send("auto", { enabled: $("auto").checked }));
$("disconnect").onclick = () => void act(async () => { const r = await send("disconnect"); await show(); return r; });
$("proxy-on").onclick = () => void act(async () => { const r = await send("proxy-on"); await show(); return r; });
$("proxy-off").onclick = () => void act(async () => { const r = await send("proxy-off"); await show(); return r; });
void act(show);
