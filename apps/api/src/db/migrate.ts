import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Database } from "./index.js";
export async function migrate(db: Database) {
  await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, digest text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
  const path = resolve("apps/api/migrations");
  for (const name of (await readdir(path)).filter(n => n.endsWith(".sql")).sort()) {
    const source = await readFile(resolve(path, name), "utf8");
    const digest = createHash("sha256").update(source).digest("hex");
    const [existing] = await db.query("SELECT digest FROM schema_migrations WHERE name=$1", [name]);
    if (existing) {
      if (existing.digest !== digest) throw new Error(`已执行的迁移被修改: ${name}`);
      continue;
    }
    await db.transaction(async tx => {
      // Statements have no procedural blocks; splitting makes migration atomic
      // on both node-postgres and the local PGlite executor.
      for (const statement of source.split(";").filter(s => s.trim())) await tx.query(statement);
      await tx.query("INSERT INTO schema_migrations(name,digest) VALUES($1,$2)", [name, digest]);
    });
  }
}
