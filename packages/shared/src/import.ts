const fields = new Set(["email", "platform", "registered", "subscribed", "suspended", "note", "tags", "assignedIp",
  "kycStatus", "kycUrl", "kycExpiresAt", "sessionKey", "proxy"]);
const flags = new Set(["registered", "subscribed", "suspended"]);
function csvRows(text: string) {
  const rows: string[][] = [], row: string[] = [];
  let value = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i++; }
      else if (quoted || value === "") quoted = !quoted;
      else throw new Error("CSV 引号格式不正确");
    } else if (ch === "," && !quoted) { row.push(value); value = ""; }
    else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(value); if (row.some(x => x.trim())) rows.push([...row]);
      row.length = 0; value = "";
      if (rows.length > 201) throw new Error("每次最多导入 200 条账号");
    } else value += ch;
  }
  if (quoted) throw new Error("CSV 存在未闭合的引号");
  row.push(value); if (row.some(x => x.trim())) rows.push([...row]);
  return rows;
}
export function parseAccountImport(input: string): Record<string, unknown>[] {
  if (input.length > 1024 * 1024) throw new Error("导入文本最多 1 MiB");
  const text = input.replace(/^\uFEFF/, "").trim();
  let rows: unknown[];
  if (text.startsWith("[") || text.startsWith("{")) {
    const parsed = JSON.parse(text);
    rows = Array.isArray(parsed) ? parsed : parsed.rows;
  } else if (/^(?:"?email"?)(?:,|\r?\n)/i.test(text) || text.split(/\r?\n/, 1)[0].includes(",email")) {
    const [header, ...data] = csvRows(text);
    const keys = header.map(k => k.trim());
    if (!keys.includes("email") || new Set(keys).size !== keys.length) throw new Error("CSV 需包含唯一的 email 列");
    rows = data.map(r => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ""])));
  } else rows = text.split(/\r?\n/).filter(Boolean).map(email => ({ email: email.trim() }));
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 200) throw new Error("请输入 1–200 条账号");
  return rows.map((input, i) => {
    const row = typeof input === "string" ? { email: input } : input;
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`第 ${i + 1} 行不是有效账号`);
    const normalized: Record<string, unknown> = {};
    // Export-only IDs/ownership/revision never become mutation input.
    for (const [key, value] of Object.entries(row)) {
      if (!fields.has(key)) continue;
      if (flags.has(key) && typeof value === "string") {
        if (!/^(true|false|1|0)$/i.test(value)) throw new Error(`第 ${i + 1} 行 ${key} 必须为 true/false`);
        normalized[key] = /^(true|1)$/i.test(value);
      } else if (key === "tags" && typeof value === "string") normalized[key] = value.split(/[,，]/).map(x => x.trim()).filter(Boolean);
      else if (key === "kycExpiresAt" && value === "") normalized[key] = null;
      else normalized[key] = value;
    }
    return normalized;
  });
}
