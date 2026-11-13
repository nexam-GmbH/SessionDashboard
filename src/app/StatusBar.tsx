// Status bar — UI_PLAN §4.6 + Calm UI rules (§2.5): glyph + count only, attention counts only when
// non-zero, no labels (tooltips instead). After Orca status-bar/StatusBar.tsx (MIT); 22px like VS Code.
import { memo } from "react"
import { Keyboard, Radio } from "lucide-react"
import { openShortcutsHelp } from "./ShortcutsHelp"
import { useApp } from "@/store/app"
import { useStatusCounts } from "@/store/selectors"
import { navigate } from "./nav"
import { setEngine } from "@/store/actions"
import { StatusGlyph } from "@/components/common/StatusGlyph"
import type { SessionStatus } from "@/lib/model"
import { STATUS_LABEL } from "@/lib/status"
import { setSessionsFilter } from "@/features/sessions/sessionsUi"
import { cn } from "@/lib/utils"

const ORDER: SessionStatus[] = ["waiting_permission", "waiting_input", "error", "done_unseen", "working"]

export const StatusBar = memo(function StatusBar() {
  const counts = useStatusCounts()
  const engine = useApp((s) => s.engine)
  const fixture = useApp((s) => s.fixture)
  const item = "flex h-full items-center gap-1 px-1.5 hover:bg-hover hover:text-fg-muted"
  return (
    <footer className="flex h-[var(--statusbar-h)] shrink-0 items-stretch border-t border-line-subtle bg-chrome px-1 text-[11px] text-fg-faint">
      {ORDER.map((st) =>
        counts[st] || st === "working" ? (
          <button
            key={st}
            className={item}
            onClick={() => {
              setSessionsFilter({ view: "active", status: [st] })
              navigate("/sessions")
            }}
            title={`${counts[st]} ${STATUS_LABEL[st].toLowerCase()}`}
          >
            <StatusGlyph status={st} size="xs" animate={false} title={null} />
            <span className={cn("tabular", (st === "waiting_permission" || st === "waiting_input" || st === "error") && "text-fg-muted")}>{counts[st]}</span>
          </button>
        ) : null,
      )}
      <div className="ml-auto flex items-stretch">
        <button className={item} onClick={openShortcutsHelp} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
          <Keyboard size={12} />
        </button>
        <button
          className={item}
          onClick={() => setEngine({ running: !engine.running })}
          title={`Mock data${fixture === "stress" ? " (stress fixture)" : ""}: ${engine.running ? "live, click to pause" : "paused, click to resume"}`}
        >
          <Radio size={11} className={engine.running ? "text-st-done" : undefined} />
          mock
        </button>
      </div>
    </footer>
  )
})
