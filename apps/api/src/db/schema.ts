import { pgTable, uuid, text, boolean, integer, bigint, timestamp, jsonb } from "drizzle-orm/pg-core";
const id = () => uuid("id").primaryKey();
const created = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
export const users = pgTable("users", {
  id: id(), username: text("username").notNull().unique(), passwordHash: text("password_hash").notNull(),
  role: text("role").notNull(), disabled: boolean("disabled").notNull().default(false),
  mailboxQuota: integer("mailbox_quota").notNull().default(10000),
  storageQuota: bigint("storage_quota", { mode: "number" }).notNull().default(10737418240),
  createdAt: created(),
});
export const domains = pgTable("domains", {
  id: id(), name: text("name").notNull().unique(), state: text("state").notNull().default("active"),
  dns: jsonb("dns").notNull().default({}), createdAt: created(),
});
export const mailboxes = pgTable("mailboxes", {
  id: id(), domainId: uuid("domain_id").notNull().references(() => domains.id),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  address: text("address").notNull().unique(), label: text("label").notNull().default(""),
  tags: jsonb("tags").notNull().default([]), note: text("note").notNull().default(""),
  quotaBytes: bigint("quota_bytes", { mode: "number" }).notNull().default(104857600),
  usedBytes: bigint("used_bytes", { mode: "number" }).notNull().default(0), createdAt: created(),
});
export const accounts = pgTable("business_accounts", {
  id: id(), email: text("email").notNull(), ownerId: uuid("owner_id").notNull().references(() => users.id),
  mailboxId: uuid("mailbox_id").references(() => mailboxes.id), platform: text("platform").notNull().default("claude"),
  registered: boolean("registered").notNull().default(false), subscribed: boolean("subscribed").notNull().default(false),
  suspended: boolean("suspended").notNull().default(false), tags: jsonb("tags").notNull().default([]),
  note: text("note").notNull().default(""), assignedIp: text("assigned_ip").notNull().default(""),
  kycStatus: text("kyc_status").notNull().default("unqueried"),
  kycUrl: text("kyc_url").notNull().default(""), revision: integer("revision").notNull().default(0),
  createdAt: created(),
});
