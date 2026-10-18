import { mkdir, copyFile } from "node:fs/promises";
await mkdir("dist/integrations", { recursive: true });
await copyFile("integrations/claude-browser-kyc.mjs", "dist/integrations/claude-browser-kyc.mjs");
