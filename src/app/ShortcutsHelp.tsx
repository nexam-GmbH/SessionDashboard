import { useEffect, useState } from "react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Shortcut } from "@/components/common/bits"

/** "?" opens the few shortcuts that matter (Linear/GitHub pattern): one screen, short labels. */
const GROUPS: { title: string; items: [string, string[]][] }[] = [
  {
    title: "Switch",
    items: [
      ["Previous session", ["mod", "Tab"]],
      ["Next that needs you", ["mod", "J"]],
      ["Session 1–9 in the list", ["mod", "1–9"]],
      ["Overview", ["mod", "0"]],
      ["Up / down the list", ["Alt", "↑↓"]],
      ["Search sessions and what was said", ["mod", "K"]],
      ["History: every past session", ["mod", "Shift", "H"]],
    ],
  },
  {
    title: "In a session",
    items: [
      ["Send (read after the current step)", ["⏎"]],
      ["Interrupt and send", ["mod", "⏎"]],
      ["Send in a forked session", ["mod", "Alt", "⏎"]],
      ["Earlier prompts", ["↑", "↓"]],
      ["Allow once / always", ["mod", "⏎ · ⇧"]],
      ["Stop", ["Esc"]],
      ["Find in chat", ["mod", "F"]],
      ["Transcript view: Normal, Thinking, Verbose", ["mod", "O"]],
      ["Rewind", ["Esc", "Esc"]],
      ["New session", ["mod", "N"]],
    ],
  },
  {
    title: "Window",
    items: [
      ["Workspace 1–9", ["Alt", "1–9"]],
      ["Hide / show the session list", ["mod", "B"]],
      ["Terminal", ["mod", "`"]],
      ["Larger / smaller", ["mod", "= −"]],
      ["Settings", ["mod", ","]],
    ],
  },
]

export function ShortcutsHelp() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return
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
      <DialogContent className="max-w-[640px] gap-0 border-border bg-muted p-0 sm:max-w-[640px]">
        <div className="border-b border-border px-4 py-3">
          <DialogTitle className="text-sm font-medium">Keyboard shortcuts</DialogTitle>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 px-4 py-4">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3 className="mb-1.5 text-xs font-medium text-muted-foreground/70">{g.title}</h3>
              {g.items.map(([label, keys]) => (
                <div key={label} className="flex h-7 items-center gap-3 text-xs">
                  <span className="text-muted-foreground">{label}</span>
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
