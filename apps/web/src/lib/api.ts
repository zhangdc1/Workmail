import { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 15000, refetchOnWindowFocus: true } } });
let csrf = "";
export function setCsrf(value: string) { csrf = value; }
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json"); if (csrf) headers.set("X-CSRF-Token", csrf);
  const r = await fetch("/api/v1" + path, { ...options, headers, credentials: "same-origin", redirect: "error" });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && !path.startsWith("/auth") && !path.startsWith("/public")) queryClient.invalidateQueries({ queryKey: ["session"] });
    throw new Error(data.error?.message || `请求失败 (${r.status})`);
  }
  return r.json();
}
export const post = <T = any>(path: string, data: unknown = {}) => api<T>(path, { method: "POST", body: JSON.stringify(data) });
export const patch = <T = any>(path: string, data: unknown) => api<T>(path, { method: "PATCH", body: JSON.stringify(data) });
export const put = <T = any>(path: string, data: unknown) => api<T>(path, { method: "PUT", body: JSON.stringify(data) });
export const remove = (path: string, data?: unknown) => api(path, { method: "DELETE", ...(data ? { body: JSON.stringify(data) } : {}) });
export function refresh() { void queryClient.invalidateQueries(); }
export async function act(fn: () => Promise<unknown>, message = "操作成功") {
  try { const data = await fn(); if (message) toast.success(message); refresh(); return data; }
  catch (error) { toast.error(error instanceof Error ? error.message : "操作失败"); throw error; }
}
export function copy(value: string) { void navigator.clipboard.writeText(value).then(() => toast.success("已复制到剪贴板")).catch(() => toast.error("复制失败，请手动复制")); }
export function bytes(value: number) {
  if (value >= 1073741824) return (value / 1073741824).toFixed(1) + " GB";
  if (value >= 1048576) return (value / 1048576).toFixed(1) + " MB";
  return (value / 1024).toFixed(1) + " KB";
}
export const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";
export const relativeDate = (value: string) => {
  const seconds = Math.max(0, (Date.now() - Date.parse(value)) / 1000);
  return seconds < 60 ? "刚刚" : seconds < 3600 ? `${Math.floor(seconds / 60)} 分钟前` : seconds < 86400 ? `${Math.floor(seconds / 3600)} 小时前` : date(value);
};
export async function downloadExport(ids: string[], format: string, includeSecrets: boolean) {
  const r = await fetch("/api/v1/accounts/export", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ ids, format, includeSecrets }) });
  if (!r.ok) { const d = await r.json(); throw new Error(d.error?.message || "导出失败"); }
  const url = URL.createObjectURL(await r.blob()), a = document.createElement("a");
  a.href = url; a.download = `accounts-${new Date().toISOString().slice(0, 10)}.${format}`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
