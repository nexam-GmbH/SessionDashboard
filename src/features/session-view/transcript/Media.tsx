// Pictures and files in a chat: the photos you sent, pictures a tool read, and the files Claude
// handed you (SendUserFile: a video clip, a PDF). Files on this computer play and open in place;
// a cloud session's files stay with claude.ai, so its card links there.
import { useState } from "react"
import { convertFileSrc } from "@tauri-apps/api/core"
import { Download, ExternalLink, FileText, Film, Image as ImageIcon } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { IN_TAURI } from "@/lib/platform"
import { useApp } from "@/store/app"
import { cn } from "@/lib/utils"
import type { ID, Picture, SharedFile } from "@/lib/model"

/** Thumbnails; a click shows the picture full size. */
export function Pictures({ pictures, className }: { pictures: Picture[]; className?: string }) {
  const [open, setOpen] = useState<Picture | null>(null)
  return (
    <>
      <div className={cn("flex flex-wrap gap-2", className)}>
        {pictures.slice(0, 24).map((p, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setOpen(p)}
            className="relative max-w-[min(100%,480px)] overflow-hidden rounded-xl outline-none after:pointer-events-none after:absolute after:inset-0 after:rounded-xl after:ring-1 after:ring-cc-wash-2 after:ring-inset focus-visible:ring-1 focus-visible:ring-cc-accent"
            aria-label={pictures.length === 1 ? "View image" : `View image ${i + 1} of ${pictures.length}`}
          >
            {/* one picture at its own shape (up to 480 × 320); several as 120 px tiles (Claude Code desktop) */}
            <img
              src={p.src}
              alt=""
              loading="lazy"
              decoding="async"
              className={cn("block", pictures.length === 1 ? "max-h-80 min-h-30 w-auto max-w-full min-w-30 object-contain" : "h-30 w-auto max-w-72 min-w-20 object-cover")}
            />
          </button>
        ))}
        {pictures.length > 24 && <span className="self-center text-[13px] text-cc-fg3">{pictures.length - 24} more images</span>}
      </div>
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="max-h-[92vh] w-fit max-w-[92vw] place-items-center border-0 bg-transparent p-0 shadow-none ring-0 sm:max-w-[92vw]">
          <DialogTitle className="sr-only">Picture</DialogTitle>
          {open && <img src={open.src} alt="" className="max-h-[90vh] max-w-[90vw] rounded-md object-contain" />}
        </DialogContent>
      </Dialog>
    </>
  )
}

const mb = (n?: number) => (n === undefined ? undefined : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`)
const kindOf = (f: SharedFile) => {
  const t = f.mediaType ?? ""
  if (t.startsWith("video/") || /\.(mp4|mov|webm|mkv)$/i.test(f.name)) return "video"
  if (t.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(f.name)) return "image"
  return "file"
}

/** Files Claude handed you, with its caption. */
export function SharedFiles({ sessionId, files, caption }: { sessionId: ID; files: SharedFile[]; caption?: string }) {
  const machine = useApp((s) => s.sessions[sessionId]?.machine)
  const url = useApp((s) => s.sessions[sessionId]?.url)
  const local = !machine && IN_TAURI
  return (
    <div className="flex flex-col gap-2">
      {caption && <p className="pl-1 text-[15px] leading-[21px] text-foreground">{caption}</p>}
      {files.map((f) => {
        const kind = kindOf(f)
        const Icon = kind === "video" ? Film : kind === "image" ? ImageIcon : FileText
        const src = local ? convertFileSrc(f.path) : undefined
        return (
          <div key={`${f.path}:${f.fileUuid ?? ""}`} className="overflow-hidden rounded-xl bg-cc-card ring-1 ring-cc-wash ring-inset">
            {src && kind === "video" && <video src={src} controls preload="metadata" className="block max-h-[420px] w-full bg-black" />}
            {src && kind === "image" && <img src={src} alt={f.name} className="block max-h-[420px] w-full bg-black object-contain" />}
            <div className="flex min-w-0 items-center gap-2.5 px-3 py-2">
              <Icon size={16} className="shrink-0 text-cc-fg3" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">{f.name}</span>
                <span className="block text-[13px] text-cc-fg3">{[mb(f.size), f.mediaType].filter(Boolean).join(" · ") || "file"}</span>
              </span>
              {local ? (
                <Button size="xs" variant="ghost" onClick={() => void import("@tauri-apps/plugin-opener").then((o) => o.openPath(f.path)).catch(() => undefined)}>
                  <Download /> Open
                </Button>
              ) : (
                url && (
                  <Button size="xs" variant="outline" asChild>
                    <a href={url} target="_blank" rel="noreferrer" title="The file is kept by claude.ai: open the session there to play or download it">
                      <ExternalLink /> Open on claude.ai
                    </a>
                  </Button>
                )
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
