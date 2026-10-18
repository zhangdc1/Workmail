import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { X, Loader2, Inbox, AlertCircle, ChevronLeft, ChevronRight, Search } from "lucide-react";
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
const buttonVariants = cva("btn", { variants: { variant: { default: "btn-primary", secondary: "btn-secondary", ghost: "btn-ghost", danger: "btn-danger" }, size: { default: "", sm: "btn-sm", icon: "btn-icon" } }, defaultVariants: { variant: "default", size: "default" } });
export function Button({ className, variant, size, asChild, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) { return <input {...props} className={cn("input", props.className)} />; }
export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea {...props} className={cn("input textarea", props.className)} />; }
export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) { return <select {...props} className={cn("input select", props.className)} />; }
export function Badge({ children, tone = "neutral", className = "" }: { children: React.ReactNode; tone?: string; className?: string }) { return <span className={cn("badge", "badge-" + tone, className)}>{children}</span>; }
export function Modal({ open, onOpenChange, title, description, children, wide = false }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; children: React.ReactNode; wide?: boolean }) {
  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
    <DialogPrimitive.Portal><DialogPrimitive.Overlay className="dialog-overlay" />
      <DialogPrimitive.Content className={cn("dialog", wide && "dialog-wide")}>
        <div className="dialog-header"><div><DialogPrimitive.Title className="dialog-title">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="dialog-description">{description || "填写并确认以下信息。"}</DialogPrimitive.Description></div>
          <DialogPrimitive.Close asChild><Button variant="ghost" size="icon" aria-label="关闭"><X size={18} /></Button></DialogPrimitive.Close>
        </div>{children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
export function Empty({ title = "这里还没有内容", description = "开始创建，建立属于自己的邮箱工作空间。", action }: { title?: string; description?: string; action?: React.ReactNode }) {
  return <div className="empty-state"><div className="empty-icon"><Inbox size={28} strokeWidth={1.5} /></div><h3>{title}</h3><p>{description}</p>{action}</div>;
}
export function Loading() { return <div className="loading"><Loader2 className="spin" size={22} /><span>正在加载工作空间…</span></div>; }
export function Failure({ error, retry }: { error: Error | null; retry?: () => void }) { return <div className="error-state"><AlertCircle size={22} /><p>{error?.message || "加载失败"}</p>{retry && <Button variant="secondary" onClick={retry}>重新加载</Button>}</div>; }
export function Pagination({ page, total, pageSize = 50, onPage }: { page: number; total: number; pageSize?: number; onPage: (page: number) => void }) {
  return <div className="pagination"><span>共 {total.toLocaleString()} 条记录 · 每页 {pageSize} 条</span><div><Button variant="ghost" size="icon" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="上一页"><ChevronLeft size={16} /></Button><span>{page} / {Math.max(1, Math.ceil(total / pageSize))}</span><Button variant="ghost" size="icon" disabled={page * pageSize >= total} onClick={() => onPage(page + 1)} aria-label="下一页"><ChevronRight size={16} /></Button></div></div>;
}
export function SearchInput({ value, onChange, placeholder = "搜索…" }: { value: string; onChange: (value: string) => void; placeholder?: string }) {
  return <div className="search-input"><Search size={16} /><Input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />{value && <button onClick={() => onChange("")} aria-label="清除搜索"><X size={14} /></button>}</div>;
}
export function PageHeader({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children?: React.ReactNode }) {
  return <header className="page-header"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div><div className="header-actions">{children}</div></header>;
}
export function SubmitButton({ busy, children = "确认保存" }: { busy: boolean; children?: React.ReactNode }) { return <Button type="submit" disabled={busy}>{busy && <Loader2 size={15} className="spin" />}{children}</Button>; }
