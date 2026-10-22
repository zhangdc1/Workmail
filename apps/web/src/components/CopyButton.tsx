import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { copy } from "../lib/api";
import { Button } from "./ui";

export function CopyButton({ value, label = "复制", text, className }: {
  value: string; label?: string; text?: string; className?: string;
}) {
  const [copied, setCopied] = useState(false), [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { setCopied(false); clearTimeout(timer.current); }, [value]);
  return <Button type="button" variant="ghost" size={text ? "sm" : "icon"}
    className={className} aria-label={label} title={copied ? "已复制" : label} disabled={busy || !value}
    onClick={async e => {
      e.stopPropagation();
      setBusy(true);
      try {
        if (await copy(value)) {
          setCopied(true); clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1800);
        }
      } finally { setBusy(false); }
    }}>{copied ? <Check size={14} /> : <Copy size={14} />}{text && (copied ? "已复制" : text)}</Button>;
}

export function inboxUrl(mailboxId: string) {
  return `${window.location.origin}/inbox?mailbox=${encodeURIComponent(mailboxId)}`;
}
