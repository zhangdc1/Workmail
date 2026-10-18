export type Role = "admin" | "member" | "kyc_viewer";
export interface User {
  id: string; username: string; role: Role; disabled: boolean;
  mailboxQuota: number; storageQuota: number; createdAt: string;
}
export interface Domain {
  id: string; name: string; state: "active" | "retired" | "disabled";
  dns: { mx?: string[]; mxReady?: boolean; addresses?: string[]; checkedAt?: string; error?: string };
  mailboxCount: number; createdAt: string;
}
export interface Mailbox {
  id: string; address: string; domainId: string; ownerId: string; ownerName?: string;
  label: string; tags: string[]; note: string; quotaBytes: number; usedBytes: number;
  unreadCount: number; messageCount: number; createdAt: string; aliases?: string[];
}
export interface Attachment { id: string; name: string; contentType: string; size: number }
export interface Message {
  id: string; mailboxId: string; fromAddress: string; fromName: string;
  subject: string; preview: string; receivedAt: string; read: boolean; starred: boolean;
  parseState: "pending" | "ready" | "failed"; size: number; otp: string | null;
  text?: string; html?: string; links?: string[]; attachments?: Attachment[]; address?: string;
}
export type KycStatus = "unqueried" | "pending" | "passed" | "denied" | "expired" | "not_required";
export interface BusinessAccount {
  id: string; mailboxId: string | null; email: string; ownerId: string; platform: string;
  registered: boolean; subscribed: boolean; suspended: boolean; tags: string[]; note: string;
  assignedIp: string; kycStatus: KycStatus; kycUrl: string; kycExpiresAt: string | null;
  kycPassedAt: string | null; lastCheckedAt: string | null; syncState: string;
  syncMessage: string; hasSession: boolean; hasProxy: boolean; revision: number; createdAt: string;
}
export interface Task {
  id: string; kind: string; state: string; progress: number; total: number;
  result: unknown; error: string | null; cancelRequested: boolean; createdAt: string;
}
export interface Page<T> { items: T[]; total: number; page: number; pageSize: number }
export interface ApiErrorBody { error: { code: string; message: string; requestId?: string } }
export interface Dashboard {
  domains: number; mailboxes: number; messages: number; unread: number; receivedToday: number;
  usedBytes: number; accounts: number; pending: number; passed: number;
  daily: { day: string; count: number }[];
  services: { database: string; receiver: string; worker: string };
}
