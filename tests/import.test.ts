import { describe, it, expect } from "vitest";
import { parseAccountImport } from "../packages/shared/src/import.js";
describe("account bulk import", () => {
  it("roundtrips exported JSON without accepting ownership or IDs", () => {
    expect(parseAccountImport('[{"id":"old-id","ownerId":"other","email":"a@alpha.test","registered":true,"tags":["测试"]}]'))
      .toEqual([{ email: "a@alpha.test", registered: true, tags: ["测试"] }]);
  });
  it("parses BOM, quoted commas, escaped quotes and multiline CSV", () => {
    const rows = parseAccountImport('\uFEFFemail,note,registered,tags,kycExpiresAt\r\na@alpha.test,"hello,\r\n""world""",false,"one,two",\r\n');
    expect(rows).toEqual([{ email: "a@alpha.test", note: 'hello,\r\n"world"', registered: false, tags: ["one", "two"], kycExpiresAt: null }]);
  });
  it("accepts newline addresses and rejects oversized batches or malformed flags", () => {
    expect(parseAccountImport("a@alpha.test\nb@beta.test")).toHaveLength(2);
    expect(() => parseAccountImport(Array(201).fill("a@alpha.test").join("\n"))).toThrow();
    expect(() => parseAccountImport("email,registered\na@alpha.test,maybe")).toThrow();
    expect(() => parseAccountImport('email,note\na@alpha.test,"unterminated')).toThrow();
  });
});
