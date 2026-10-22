import { describe, expect, it } from "vitest";
import { normalizeMailLink, textMailLinks } from "../apps/web/src/lib/mail-links";
import { documentRoute } from "../apps/api/src/api-docs";

describe("mail link extraction", () => {
  it("retains complete query strings, percent encoding, hashes and balanced parentheses", () => {
    expect(textMailLinks("https://example.test/login?t=a%2Fb&x=1#code https://example.test/wiki/Hello_(world)."))
      .toEqual(["https://example.test/login?t=a%2Fb&x=1#code", "https://example.test/wiki/Hello_(world)"]);
  });
  it("removes surrounding punctuation without including the sentence", () => {
    expect(textMailLinks("验证码（https://example.test/login?t=1）。 (http://example.test/a)."))
      .toEqual(["https://example.test/login?t=1", "http://example.test/a"]);
  });
  it("does not turn executable, credential-bearing or relative URLs into actionable links", () => {
    for (const link of ["javascript:alert(1)", "data:text/html,test", "file:///etc/passwd", "/login", "https://user:pass@example.test"]) {
      expect(normalizeMailLink(link)).toBeNull();
    }
    expect(normalizeMailLink("http://example.test")).toBe("http://example.test");
  });
});

describe("documentation-only OpenAPI metadata", () => {
  it("describes session and CSRF without changing runtime schemas", () => {
    const schema = { body: { type: "object" } };
    const result = documentRoute({ schema, url: "/api/v1/mailboxes", route: { method: "POST" } });
    expect(result.schema.security).toEqual([{ cookieAuth: [], csrfToken: [] }]);
    expect(result.schema.summary).toContain("创建");
    expect(schema).toEqual({ body: { type: "object" } });
    expect(result.schema.body).toBe(schema.body);
  });
  it("marks public routes and restricts bearer documentation to connector routes", () => {
    const route = (path: string, method = "GET") => documentRoute({ schema: {}, url: "/api/v1" + path, route: { method } }).schema;
    expect(route("/auth/login", "POST").security).toEqual([]);
    expect(route("/public/shares/:token/messages").security).toEqual([]);
    expect(route("/messages").security).toEqual([{ cookieAuth: [] }]);
    expect(route("/extensions/capture", "POST").security).toContainEqual({ extensionToken: [] });
    expect(route("/extensions/pair", "POST").security).toEqual([{ cookieAuth: [], csrfToken: [] }]);
  });
});
