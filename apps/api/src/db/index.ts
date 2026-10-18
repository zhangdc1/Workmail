import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as pgDrizzle } from "drizzle-orm/node-postgres";
import { drizzle as liteDrizzle } from "drizzle-orm/pglite";
import * as schema from "./schema.js";
import type { Config } from "../config.js";
import { mkdir } from "node:fs/promises";
export type Row = Record<string, any>;
export interface Executor {
  query<T extends Row = Row>(text: string, values?: unknown[]): Promise<T[]>;
}
export interface Database extends Executor {
  orm: ReturnType<typeof pgDrizzle<typeof schema>> | ReturnType<typeof liteDrizzle<typeof schema>>;
  transaction<T>(work: (tx: Executor) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}
export async function connectDb(config: Pick<Config, "databaseMode" | "databaseUrl" | "pgliteDir">): Promise<Database> {
  if (config.databaseMode === "pglite") {
    if (config.pgliteDir !== ":memory:") await mkdir(config.pgliteDir, { recursive: true, mode: 0o700 });
    const client = new PGlite(config.pgliteDir === ":memory:" ? undefined : config.pgliteDir);
    await client.waitReady;
    // Serialize *all* access. PGlite has one connection; outside queries must
    // never accidentally become part of another request's transaction.
    let tail: Promise<unknown> = Promise.resolve();
    const serial = <T>(fn: () => Promise<T>): Promise<T> => {
      const next = tail.then(fn); tail = next.catch(() => {}); return next;
    };
    const direct: Executor = { query: async <T extends Row>(text: string, values: unknown[] = []) => (await client.query<T>(text, values)).rows };
    return {
      orm: liteDrizzle(client, { schema }),
      query: (text, values) => serial(() => direct.query(text, values)),
      transaction: work => serial(() => client.transaction(tx => work({
        query: async <T extends Row>(text: string, values: unknown[] = []) => (await tx.query<T>(text, values)).rows,
      }))),
      exec: sql => serial(async () => { await client.exec(sql); }),
      close: () => serial(() => client.close()),
    };
  }
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
  await pool.query("SELECT 1");
  return {
    orm: pgDrizzle(pool, { schema }),
    query: async <T extends Row>(text: string, values: unknown[] = []) => (await pool.query(text, values)).rows as T[],
    exec: async sql => { await pool.query(sql); },
    transaction: async work => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work({ query: async <T extends Row>(text: string, values: unknown[] = []) => (await client.query(text, values)).rows as T[] });
        await client.query("COMMIT"); return result;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    },
    close: () => pool.end(),
  };
}
export function toCamel<T = any>(row: Row): T {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
    value instanceof Date ? value.toISOString() : value,
  ])) as T;
}
