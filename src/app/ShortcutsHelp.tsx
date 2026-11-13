import { useEffect, useState } from "react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Shortcut } from "@/components/common/bits"

/**
 * "?" opens a compact list of the shortcuts that matter (Linear/GitHub pattern). Calm UI: one
 * screen, short labels, no explanations. The full list lives in Settings → Keybindings.
 */
const GROUPS: { title: string; items: [string, string[]][] }[] = [
  {
    title: "Everywhere",
    items: [
      ["Search & commands", ["mod", "K"]],
      ["Next thing that needs you", ["N"]],
      ["Jump to Needs-you item", ["Alt", "1–9"]],
      ["New session", ["mod", "N"]],
      ["Cross-repo task", ["mod", "Shift", "N"]],
      ["Close tab", ["mod", "W"]],
    ],
  },
  {
    title: "Go to",
    items: [
      ["Map", ["G", "M"]],
      ["Sessions", ["G", "S"]],
      ["Code graph", ["G", "G"]],
      ["Sidebar", ["mod", "B"]],
      ["Bottom panel", ["mod", "J"]],
      ["Settings", ["mod", ","]],
    ],
  },
  {
    title: "In a session",
    items: [
      ["Approve (first option)", ["⏎"]],
      ["Send now", ["mod", "⏎"]],
      ["Interrupt", ["Esc"]],
      ["Edit last queued", ["↑"]],
    ],
  },
  {
    title: "On the map",
    items: [
      ["Move selection", ["←", "→", "↑", "↓"]],
      ["Open", ["⏎"]],
      ["Fit view", ["F"]],
      ["Repo links", ["L"]],
    ],
  },
]

export function ShortcutsHelp() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable || el.closest(".xterm"))) return
      e.preventDefault()
      setOpen((v) => !v)
    }
    const onOpen = () => setOpen(true)
    window.addEventListener("keydown", onKey)
    window.addEventListener("sd:shortcuts", onOpen)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("sd:shortcuts", onOpen)
    }
  }, [])
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-[640px] gap-0 border-line bg-elevated p-0 sm:max-w-[640px]">
        <div className="border-b border-line-subtle px-4 py-3">
          <DialogTitle className="text-sm font-medium">Keyboard shortcuts</DialogTitle>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 px-4 py-4">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <div className="section-label mb-1.5">{g.title}</div>
              {g.items.map(([label, keys]) => (
                <div key={label} className="flex h-7 items-center gap-3 text-xs">
                  <span className="text-fg-muted">{label}</span>
                  <Shortcut keys={keys} className="ml-auto" />
                </div>
              ))}
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function openShortcutsHelp() {
  window.dispatchEvent(new Event("sd:shortcuts"))
}
