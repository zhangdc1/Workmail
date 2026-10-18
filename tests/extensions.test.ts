import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
const source = await readFile(new URL("../extensions/shared/proxy.mjs", import.meta.url), "utf8");
// Evaluate the exact shared extension source without Chrome/network access.
const sandbox = createContext({ Map, URL, setTimeout, clearTimeout });
runInContext(source.replace(/export /g, "") + "\nthis.api={proxyPac,createProxyController};", sandbox);
const { proxyPac, createProxyController } = sandbox.api;
describe("shared browser proxy policy (offline)", () => {
  it("generates only the selected proxy, never DIRECT or code from hostname", () => {
    for (const protocol of ["http", "https", "socks5"]) {
      const result = proxyPac({ protocol, host: "proxy.example.test", port: 8080 });
      expect(result.pacScript.mandatory).toBe(true);
      expect(result.pacScript.data).not.toContain("DIRECT");
      const pac = createContext({});
      runInContext(result.pacScript.data + ';this.route=FindProxyForURL("https://claude.ai/","claude.ai");', pac);
      expect(pac.route).toMatch(/^(PROXY|HTTPS|SOCKS5) proxy\.example\.test:8080$/);
    }
    expect(() => proxyPac({ protocol: "http", host: 'x";return "DIRECT', port: 80 })).toThrow();
    expect(() => proxyPac({ protocol: "socks5", host: "127.0.0.1", port: 8080, username: "user" })).toThrow();
  });
  it("blocks a persisted proxy on restart when session auth is gone", async () => {
    let state: any = { state: "active", accountId: "account-1" }, applied: any;
    const browser = {
      storage: {
        local: { get: async () => ({ proxyState: state }), set: async (v: any) => { state = v.proxyState; } },
        session: { get: async () => ({}), remove: async () => {} },
      },
      proxy: { settings: {
        get: async () => ({ levelOfControl: "controlled_by_this_extension" }),
        set: async (v: any) => { applied = v; },
      } },
    };
    const controller = createProxyController(browser, async () => { throw new Error("No external calls expected"); });
    await controller.ready;
    expect(applied.scope).toBe("incognito_persistent");
    expect(applied.value.pacScript.data).toContain("PROXY 127.0.0.1:9");
    expect(state.state).toBe("blocked");
    expect(state.accountId).toBe("account-1");
  });
});
