import { useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { getApp, useApp } from "@/store/app"
import { setEngine } from "@/store/actions"
import { engineStats } from "@/mocks/engine"
import { PropertyTable, Prop } from "@/components/common/bits"

/**
 * Perf harness (UI_PLAN §8): FPS meter, long-task observer, engine rate, fixture
 * switch. Budgets are checked against the `stress` fixture on WebKitGTK.
 */
export default function PerfHarness() {
  const engine = useApp((s) => s.engine)
  const fixture = useApp((s) => s.fixture)
  // counts only change structurally; don't rescan 5k records on every store update
  const structVersion = useApp((s) => s.structVersion)
  const counts = useMemo(() => {
    const s = getApp()
    return { sessions: Object.keys(s.sessions).length, subagents: Object.keys(s.subagents).length, repos: s.repoOrder.length }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structVersion])
  const [fps, setFps] = useState(0)
  const [longTasks, setLongTasks] = useState({ count: 0, max: 0 })
  const [stats, setStats] = useState({ ...engineStats })
  const frames = useRef(0)

  useEffect(() => {
    let raf = 0
    const loop = () => {
      frames.current++
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    const id = setInterval(() => {
      setFps(frames.current)
      frames.current = 0
      setStats({ ...engineStats })
    }, 1000)
    let po: PerformanceObserver | null = null
    try {
      po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          setLongTasks((lt) => ({ count: lt.count + 1, max: Math.max(lt.max, Math.round(e.duration)) }))
        }
      })
      po.observe({ type: "longtask", buffered: true })
    } catch {
      /* longtask unsupported in this webview */
    }
    return () => {
      cancelAnimationFrame(raf)
      clearInterval(id)
      po?.disconnect()
    }
  }, [])

  const setFixture = (f: string) => {
    try {
      localStorage.setItem("sd.fixture", f)
    } catch {
      /* ignore */
    }
    location.reload()
  }

  return (
    <div className="@container h-full overflow-y-auto bg-canvas p-4">
      <div className="mb-3 text-sm font-medium">Performance harness</div>
      <div className="grid max-w-3xl gap-4 @min-[640px]:grid-cols-2">
        <section className="rounded-md border border-line-subtle p-3">
          <div className="section-label mb-2">Live</div>
          <PropertyTable>
            <Prop label="FPS">
              <span className="tabular">{fps}</span>
            </Prop>
            <Prop label="Long tasks">
              <span className="tabular">{longTasks.count} (max {longTasks.max} ms)</span>
            </Prop>
            <Prop label="Events applied">
              <span className="tabular">{stats.applied} in {stats.batches} frames</span>
            </Prop>
            <Prop label="Last batch">
              <span className="tabular">{stats.lastBatch}</span>
            </Prop>
          </PropertyTable>
        </section>
        <section className="rounded-md border border-line-subtle p-3">
          <div className="section-label mb-2">Data</div>
          <PropertyTable>
            <Prop label="Fixture">{fixture}</Prop>
            <Prop label="Repos">{counts.repos}</Prop>
            <Prop label="Sessions">{counts.sessions}</Prop>
            <Prop label="Subagents">{counts.subagents}</Prop>
          </PropertyTable>
          <div className="mt-3 flex gap-1.5">
            <Button size="sm" variant={fixture === "normal" ? "default" : "secondary"} onClick={() => setFixture("normal")}>normal</Button>
            <Button size="sm" variant={fixture === "stress" ? "default" : "secondary"} onClick={() => setFixture("stress")}>stress</Button>
          </div>
        </section>
        <section className="rounded-md border border-line-subtle p-3 @min-[640px]:col-span-2">
          <div className="section-label mb-2">Mock engine</div>
          <div className="flex items-center gap-2 text-xs">
            <Button size="sm" onClick={() => setEngine({ running: !engine.running })}>{engine.running ? "Pause" : "Resume"}</Button>
            <span className="text-fg-faint">rate</span>
            {[2, 6, 25, 100, 250].map((r) => (
              <Button key={r} size="xs" variant={engine.rate === r ? "default" : "ghost"} onClick={() => setEngine({ rate: r })}>
                {r}/s
              </Button>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
