import { configuration } from "./config.js";
import { connectDb } from "./db/index.js";
import { makeApp } from "./app.js";
const config = configuration(), db = await connectDb(config);
const app = await makeApp({ config, db }, true);
if (config.databaseMode === "pglite") {
  // Local single-process mode only: no second process opens the same WASM DB.
  const { runOneJob } = await import("./worker.js");
  const { makeSmtp } = await import("./smtp.js");
  const smtp = makeSmtp({ config, db });
  await new Promise<void>((resolve, reject) => { smtp.once("error", reject); smtp.listen(config.smtpPort, config.smtpHost, resolve); });
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return; busy = true;
    void runOneJob({ config, db }).catch(() => {}).finally(() => { busy = false; });
  }, 500);
  await db.query("INSERT INTO service_heartbeats(name) VALUES('receiver'),('worker') ON CONFLICT(name) DO UPDATE SET updated_at=now()");
  const pulse = setInterval(() => void db.query("UPDATE service_heartbeats SET updated_at=now() WHERE name IN ('receiver','worker')").catch(() => {}), 15000);
  app.addHook("onClose", async () => { clearInterval(timer); clearInterval(pulse); await new Promise<void>(r => smtp.close(r)); });
}
await app.listen({ host: config.host, port: config.port });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void app.close().then(() => db.close()).then(() => process.exit(0)); });
