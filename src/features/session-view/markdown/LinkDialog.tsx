// Clicking a link in Claude's answer: where it goes, then Open (your browser) or Copy. Our own dialog
// instead of streamdown's: that one's box swallows every key, so Esc never closed it, and its blur
// of the whole window repaints on WebKitGTK. Esc, a click outside and the X close this one.
import { useState } from "react"
import { Check, Copy, ExternalLink } from "lucide-react"
import type { LinkSafetyModalProps } from "streamdown"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"

export function openLink(url: string) {
  void import("@tauri-apps/plugin-opener")
    .then((o) => o.openUrl(url))
    .catch(() => window.open(url, "_blank", "noreferrer"))
}

export function LinkDialog({ url, isOpen, onClose }: LinkSafetyModalProps) {
  const [copied, setCopied] = useState(false)
  return (
    <Dialog open={isOpen} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ExternalLink size={16} /> Open link?
          </DialogTitle>
          <DialogDescription>It opens in your browser.</DialogDescription>
        </DialogHeader>
        <div className="rounded-md bg-cc-secondary px-3 py-2 font-mono text-[13px] break-all select-text">{url}</div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => {
              void navigator.clipboard?.writeText(url).catch(() => undefined)
              setCopied(true)
              setTimeout(onClose, 500)
            }}
          >
            {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy link"}
          </Button>
          <Button
            autoFocus
            className="flex-1"
            onClick={() => {
              openLink(url)
              onClose()
            }}
          >
            <ExternalLink /> Open link
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
