// Shared full connector implementation. Never exports a page bridge.
const scope = "incognito_persistent";
const deny = { mode: "pac_script", pacScript: { mandatory: true, data: 'function FindProxyForURL(url,host){return "PROXY 127.0.0.1:9";}' } };
export function proxyPac(config) {
  if (!["http", "https", "socks5"].includes(config.protocol) || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || !/^[a-z0-9.:-]+$/i.test(config.host)) throw new Error("代理配置不正确");
  if (config.protocol === "socks5" && (config.username || config.password)) throw new Error("Chrome 不支持 SOCKS5 密码认证，请使用 HTTP/HTTPS 代理入口");
  const route = { http: "PROXY", https: "HTTPS", socks5: "SOCKS5" }[config.protocol] + " " + (config.host.includes(":") ? "[" + config.host + "]" : config.host) + ":" + config.port;
  return { mode: "pac_script", pacScript: { mandatory: true, data: `function FindProxyForURL(url,host){return ${JSON.stringify(route)};}` } };
}
export function createProxyController(browser, platformApi) {
  let busy = false;
  const ensureClosed = async () => { if ((await browser.windows.getAll()).some(w => w.incognito)) throw new Error("请先关闭所有已有无痕窗口，再切换、关闭或启用代理"); };
  const remember = (state, message, accountId = "") => browser.storage.local.set({ proxyState: { state, message, accountId } });
  // A browser restart clears storage.session, while persistent proxy settings
  // may survive. Never present a stale "active" state without auth material.
  const ready = (async () => {
    const { proxyState } = await browser.storage.local.get("proxyState");
    if (!proxyState || proxyState.state === "off") return;
    const { proxySecret } = await browser.storage.session.get("proxySecret");
    if (proxyState.state === "active" && proxySecret) return;
    const settings = await browser.proxy.settings.get({ incognito: true });
    if (["controllable_by_this_extension", "controlled_by_this_extension"].includes(settings.levelOfControl)) {
      await browser.proxy.settings.set({ scope, value: deny });
      await browser.storage.session.remove("proxySecret");
      await remember("blocked", "浏览器重启或代理验证中断，请关闭无痕窗口后重新启用", proxyState.accountId);
    } else {
      await remember("blocked", "代理已被其他策略接管，无法确认出口；请先关闭所有无痕窗口", proxyState.accountId);
    }
  })();
  const authAttempts = new Map();
  if (browser.webRequest?.onAuthRequired) {
    browser.webRequest.onAuthRequired.addListener((details, respond) => {
      void (async () => {
        if (!details.isProxy) return {};
        const tab = details.tabId >= 0 ? await browser.tabs.get(details.tabId).catch(() => null) : null;
        if (!tab?.incognito) return {};
        const { proxySecret } = await browser.storage.session.get("proxySecret");
        if (!proxySecret || details.challenger?.host !== proxySecret.host || details.challenger?.port !== proxySecret.port) return { cancel: true };
        const count = (authAttempts.get(details.requestId) || 0) + 1; authAttempts.set(details.requestId, count);
        return count > 2 ? { cancel: true } : { authCredentials: { username: proxySecret.username, password: proxySecret.password } };
      })().then(respond, () => respond({ cancel: true }));
    }, { urls: ["<all_urls>"] }, ["asyncBlocking"]);
    const clear = d => authAttempts.delete(d.requestId);
    browser.webRequest.onCompleted.addListener(clear, { urls: ["<all_urls>"] });
    browser.webRequest.onErrorOccurred.addListener(clear, { urls: ["<all_urls>"] });
  }
  const verify = async () => {
    let windowId;
    try {
      const win = await browser.windows.create({ incognito: true, url: "about:blank", focused: false }); windowId = win.id;
      const tabId = win.tabs?.[0]?.id;
      if (!Number.isInteger(tabId)) throw new Error("无法创建无痕检测标签");
      await new Promise((resolve, reject) => {
        let timer;
        const finish = error => { clearTimeout(timer); browser.tabs.onUpdated.removeListener(updated); error ? reject(error) : resolve(); };
        const updated = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
        browser.tabs.onUpdated.addListener(updated);
        timer = setTimeout(() => finish(new Error("代理出口检测超时；未回退直连")), 20000);
        browser.tabs.update(tabId, { url: "https://api64.ipify.org/?format=json&_=" + crypto.randomUUID() }).catch(() => finish(new Error("代理出口检测失败")));
      });
      const [data] = await browser.scripting.executeScript({ target: { tabId }, func: () => {
        if (location.origin !== "https://api64.ipify.org") return null;
        try { return JSON.parse(document.body.innerText).ip; } catch { return null; }
      } });
      const ip = data?.result;
      if (typeof ip !== "string" || !/^[0-9a-f:.]+$/i.test(ip)) throw new Error("代理没有返回有效出口 IP");
      if ((await browser.windows.getAll()).some(w => w.incognito && w.id !== windowId)) throw new Error("检测时发现其他无痕窗口，请全部关闭后重试");
      return ip;
    } finally { if (windowId !== undefined) await browser.windows.remove(windowId).catch(() => {}); }
  };
  return {
    ready,
    async enable(accountId) {
      await ready;
      if (busy) throw new Error("代理正在切换"); busy = true;
      let controlled = false;
      try {
        await ensureClosed();
        if (!await browser.extension.isAllowedIncognitoAccess()) throw new Error("请先在扩展详情中允许无痕模式");
        const state = await browser.proxy.settings.get({ incognito: true });
        if (!["controllable_by_this_extension", "controlled_by_this_extension"].includes(state.levelOfControl)) throw new Error("代理由其他扩展或策略控制");
        await browser.proxy.settings.set({ scope, value: deny }); controlled = true;
        await remember("checking", "正在验证代理出口，账号访问暂时阻断", accountId);
        const data = await platformApi("/extensions/proxy", { accountId });
        const u = new URL(data.value), config = { protocol: u.protocol.slice(0, -1), host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port || (u.protocol === "https:" ? 443 : u.protocol === "http:" ? 80 : 0)), username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
        const value = proxyPac(config);
        await browser.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
        await browser.storage.session.set({ proxySecret: config });
        // During validation only the exit checker may use the configured proxy.
        const checking = { mode: "pac_script", pacScript: { mandatory: true, data: value.pacScript.data.replace("return ", 'if(host!=="api64.ipify.org")return "PROXY 127.0.0.1:9";return ') } };
        await browser.proxy.settings.set({ scope, value: checking });
        const ip = await verify();
        if (data.assignedIp && data.assignedIp !== ip) throw new Error("出口 IP 与账号登记不一致，访问已阻断");
        await browser.proxy.settings.set({ scope, value });
        await remember("active", "无痕代理已启用，出口：" + ip, accountId);
        return { message: "代理已启用：" + ip };
      } catch (error) {
        if (controlled) { await browser.proxy.settings.set({ scope, value: deny }); await browser.storage.session.remove("proxySecret"); await remember("blocked", "代理失败，已阻断无痕访问；未回退直连", accountId); }
        throw error;
      } finally { busy = false; }
    },
    async disable() {
      await ready;
      if (busy) throw new Error("代理正在切换");
      await ensureClosed();
      await browser.proxy.settings.clear({ scope }); await browser.storage.session.remove("proxySecret");
      await remember("off", "无痕代理已关闭"); return { message: "代理已关闭" };
    },
  };
}
