import { SMTPServer } from "smtp-server";
import { pathToFileURL } from "node:url";
import type { Context } from "./context.js";
import { ingestMail, receivingMailbox } from "./mail.js";
import { configuration } from "./config.js";
import { connectDb } from "./db/index.js";
const smtpError = (code: number, message: string) => Object.assign(new Error(message), { responseCode: code });
export function makeSmtp(ctx: Context) {
  const server = new SMTPServer({
    name: ctx.config.mailHostname, secure: false, authOptional: true,
    disabledCommands: ["AUTH", "STARTTLS"], hideSMTPUTF8: true, hideDSN: true,
    disableReverseLookup: true, size: ctx.config.smtpMaxBytes, maxClients: 20, socketTimeout: 60000,
    onRcptTo(address, session, callback) {
      if (session.envelope.rcptTo.length >= 20) return callback(smtpError(452, "Too many recipients"));
      receivingMailbox(ctx.db, address.address).then(box => callback(box ? undefined : smtpError(550, "Recipient unavailable")), () => callback(smtpError(451, "Lookup temporarily unavailable")));
    },
    onData(stream, session, callback) {
      void (async () => {
        let length = 0; const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          length += chunk.length; if (length <= ctx.config.smtpMaxBytes) chunks.push(chunk);
        }
        if (stream.sizeExceeded || length > ctx.config.smtpMaxBytes) throw smtpError(552, "Message too large");
        await ingestMail(ctx, Buffer.concat(chunks), {
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
          recipients: session.envelope.rcptTo.map(x => x.address),
        });
      })().then(() => callback(), error => callback(error.responseCode ? error : smtpError(451, "Storage temporarily unavailable")));
    },
  });
  return server;
}
async function main() {
  const config = configuration(), db = await connectDb(config), server = makeSmtp({ config, db });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.smtpPort, config.smtpHost, resolve); });
  console.log(`Internal SMTP listening ${config.smtpHost}:${config.smtpPort}`);
  const pulse = async () => { await db.query("INSERT INTO service_heartbeats(name) VALUES('receiver') ON CONFLICT(name) DO UPDATE SET updated_at=now()"); };
  await pulse(); const timer = setInterval(() => void pulse().catch(() => {}), 15000);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { clearInterval(timer); server.close(() => void db.close().then(() => process.exit(0))); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
