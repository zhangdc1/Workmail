import { expect, test, type Page } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
const env = Object.fromEntries(readFileSync(".env", "utf8").split(/\r?\n/).filter(x => x.includes("=")).map(x => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)]));
const fixtureLink = "https://example.test/login?t=a%2Fb&second=2#confirm";
async function login(page: Page) {
  await page.goto("/");
  await page.getByPlaceholder("输入管理员或成员账号").fill(env.BOOTSTRAP_USERNAME);
  await page.getByPlaceholder("输入你的密码").fill(env.BOOTSTRAP_PASSWORD);
  await page.getByRole("button", { name: "登录工作空间" }).click();
  await expect(page.getByRole("heading", { name: "让每一封来信，都有归属。" })).toBeVisible();
}
test("mailbox address, inbox URL, API guide and clipboard fallback", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page);
  await page.getByRole("link", { name: "邮箱管理", exact: true }).click();
  const row = page.locator("tbody tr").first(), address = await row.locator(".cell-address strong").innerText();
  await row.getByRole("button", { name: `复制邮箱地址 ${address}`, exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(address);
  const href = await row.locator(".cell-address a").getAttribute("href");
  await row.getByRole("button", { name: `复制收件链接 ${address}（需登录）`, exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("http://localhost:5173" + href);
  const boxes = await (await page.request.get("/api/v1/mailboxes")).json();
  // Render the create-result dialog without adding permanent mailboxes to local data.
  await page.route("**/api/v1/mailboxes", route => route.request().method() === "POST"
    ? route.fulfill({ json: { items: [{ state: "created", mailbox: boxes.items[0] }] } }) : route.continue());
  await page.getByRole("button", { name: "创建邮箱", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "创建邮箱", exact: true }).click();
  const result = page.getByRole("dialog");
  await expect(result.getByText("批量操作结果", { exact: true })).toBeVisible();
  await result.getByRole("button", { name: "复制全部成功邮箱地址" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(address);
  await result.getByRole("button", { name: `复制收件链接 ${address}（需登录）`, exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("http://localhost:5173" + href);
  await result.getByRole("button", { name: "关闭", exact: true }).click();
  // Exercise the legacy fallback without changing other clipboard methods.
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error("blocked"); }; });
  await row.getByRole("button", { name: `复制邮箱地址 ${address}`, exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(address);
  await page.getByRole("link", { name: "API 调用文档", exact: true }).click();
  await expect(page.getByRole("heading", { name: "API 调用文档", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "复制 API 基础地址" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("http://localhost:5173/api/v1");
  const spec = await page.request.get("/api/v1/openapi.json");
  expect(spec.ok()).toBe(true);
  expect((await spec.json()).paths["/api/v1/mailboxes"].post.security).toEqual([{ cookieAuth: [], csrfToken: [] }]);
  mkdirSync("artifacts/screenshots/copy-api", { recursive: true });
  await page.screenshot({ path: "artifacts/screenshots/copy-api/api-guide.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => { document.execCommand = () => false; });
  await page.getByRole("button", { name: "复制 API 基础地址" }).click();
  await expect(page.getByText("复制失败，请选中文字手动复制", { exact: true })).toBeVisible();
});
test("all mail links copy without opening; shared reader has the same controls", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await login(page);
  await page.route(/\/api\/v1\/messages\/[0-9a-f-]+$/, async route => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch(), message = await response.json();
    await route.fulfill({ response, json: { ...message, text: "A plain URL http://example.test/help.",
      html: `<p>仅用于复制回归测试</p><a href="${fixtureLink.replaceAll("&", "&amp;")}">登录</a><a href="javascript:alert(1)">忽略</a>`,
      links: [fixtureLink, fixtureLink] } });
  });
  await page.getByRole("link", { name: "统一收件箱", exact: true }).click();
  await page.locator(".message-row").first().click();
  const links = page.getByRole("region", { name: "邮件中的链接" });
  await expect(links.locator(".mail-link-row")).toHaveCount(2);
  await links.getByRole("button", { name: "复制邮件链接 1", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(fixtureLink);
  expect(context.pages()).toHaveLength(1);
  await links.getByRole("button", { name: "复制全部邮件链接" }).click();
  await expect.poll(async () => (await page.evaluate(() => navigator.clipboard.readText())).replaceAll("\r\n", "\n")).toBe(fixtureLink + "\nhttp://example.test/help");
  await page.screenshot({ path: "artifacts/screenshots/copy-api/mail-links.png", fullPage: true });
  // Public-share presentation fixture; authorization itself is covered by real API tests.
  const token = "copy-regression-fixture-not-a-real-token";
  const id = "00000000-0000-4000-8000-000000000001";
  const message = { id, subject: "复制链接测试", fromAddress: "fixture@example.test", receivedAt: new Date().toISOString(),
    size: 100, parseState: "ready", text: fixtureLink, html: "", links: [fixtureLink], otp: "123456", attachments: [] };
  await page.route(`**/api/v1/public/shares/${token}**`, route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path.endsWith("/messages/" + id) ? message : path.endsWith("/messages") ? { items: [message] }
      : { address: "shared@example.test", expiresAt: new Date(Date.now() + 86400000).toISOString(), passwordRequired: false } });
  });
  await page.goto("/share/" + token);
  await page.getByRole("button", { name: "复制分享邮箱地址" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("shared@example.test");
  await page.locator(".mail-list-item").click();
  await page.getByRole("button", { name: "复制邮件链接 1", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(fixtureLink);
  expect(context.pages()).toHaveLength(1);
  expect(errors).toEqual([]);
});
