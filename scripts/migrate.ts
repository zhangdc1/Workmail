import { configuration } from "../apps/api/src/config.js";
import { connectDb } from "../apps/api/src/db/index.js";
import { migrate } from "../apps/api/src/db/migrate.js";
const db = await connectDb(configuration());
try { await migrate(db); console.log("数据库迁移完成"); } finally { await db.close(); }
