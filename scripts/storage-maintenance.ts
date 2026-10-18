import { readdir, stat, unlink } from "node:fs/promises";
import { configuration } from "../apps/api/src/config.js";
import { connectDb } from "../apps/api/src/db/index.js";
import { storagePath } from "../apps/api/src/mail.js";
// Explicit, offline-only garbage collection. Never scheduled automatically.
// Referenced raw messages and attachments are never eligible for deletion.
const apply = process.argv.includes("--apply");
if (apply && !process.argv.includes("--offline-confirm")) throw new Error("先停止 api/smtp/worker，等待 60 秒，再添加 --offline-confirm；默认仅报告");
const config = configuration(), db = await connectDb(config);
try {
  if (apply) {
    const active = await db.query("SELECT name FROM service_heartbeats WHERE updated_at>now()-interval '60 seconds'");
    if (active.length) throw new Error("检测到近期服务心跳；未删除任何文件。停止写入服务并等待 60 秒");
  }
  const liveRaw = await db.query("SELECT r.path FROM raw_messages r WHERE EXISTS(SELECT 1 FROM messages m WHERE m.raw_id=r.id)");
  const attachments = await db.query("SELECT path FROM attachments");
  const referenced = new Set([...liveRaw, ...attachments].map(r => r.path));
  const candidates: { path: string; bytes: number }[] = [];
  const cutoff = Date.now() - 86400000;
  const walk = async (dir: string) => {
    const entries = await readdir(storagePath(config.dataDir, dir), { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return []; throw e;
    });
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && !referenced.has(path)) {
        const meta = await stat(storagePath(config.dataDir, path));
        if (meta.mtimeMs < cutoff) candidates.push({ path, bytes: meta.size });
      }
    }
  };
  await walk("raw"); await walk("attachments");
  if (apply) {
    for (const file of candidates) await unlink(storagePath(config.dataDir, file.path));
    await db.query("DELETE FROM raw_messages r WHERE NOT EXISTS(SELECT 1 FROM messages m WHERE m.raw_id=r.id) AND created_at<now()-interval '1 day'");
  }
  console.log(JSON.stringify({ mode: apply ? "applied" : "report-only", unreferencedFiles: candidates.length,
    reclaimableBytes: candidates.reduce((sum, x) => sum + x.bytes, 0),
    note: "仅处理超过一天且无数据库引用的文件；有效邮件长期保留。配额按原文计量，不等于磁盘占用。" }, null, 2));
} finally { await db.close(); }
