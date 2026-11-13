import { useEffect, useRef, useState } from "react"
import { Check, Copy, RotateCw, X, Minus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IN_TAURI } from "@/lib/platform"
import { cn } from "@/lib/utils"

/**
 * M0 WebGL check (UI_PLAN §10, RESEARCH §9 risk #1): decides sigma v4 (WebGL2)
 * vs sigma 3 fallback, and whether xterm's WebGL renderer is usable in this
 * webview (WebKitGTK on Linux is the worst case). Results are also logged to
 * stdout through tauri-plugin-log when running inside Tauri.
 */
type Result = { name: string; ok: boolean | null; detail: string }

async function basicChecks(): Promise<{ results: Result[]; info: Record<string, unknown> }> {
  const results: Result[] = []
  const info: Record<string, unknown> = { userAgent: navigator.userAgent, inTauri: IN_TAURI }
  const c = document.createElement("canvas")
  const gl1 = c.getContext("webgl")
  results.push({ name: "WebGL 1 context", ok: !!gl1, detail: gl1 ? "available" : "unavailable" })
  const c2 = document.createElement("canvas")
  const gl2 = c2.getContext("webgl2") as WebGL2RenderingContext | null
  results.push({ name: "WebGL 2 context (sigma v4 needs it)", ok: !!gl2, detail: gl2 ? "available" : "unavailable" })
  const gl = gl2 ?? gl1
  if (gl) {
    const dbg = gl.getExtension("WEBGL_debug_renderer_info")
    const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
    const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)
    info.renderer = renderer
    info.vendor = vendor
    info.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE)
    const software = /llvmpipe|swiftshader|software|softpipe/i.test(String(renderer))
    results.push({ name: "GPU renderer", ok: !software, detail: `${vendor} · ${renderer}${software ? " (software rendering)" : ""}` })
    results.push({ name: "Max texture size", ok: Number(info.maxTexture) >= 4096, detail: String(info.maxTexture) })
  }
  const c3 = document.createElement("canvas")
  const strict = c3.getContext("webgl2", { failIfMajorPerformanceCaveat: true })
  results.push({
    name: "No major performance caveat",
    ok: !!strict,
    detail: strict ? "hardware path" : "browser reports a slow/software path",
  })
  return { results, info }
}

async function sigmaCheck(container: HTMLDivElement): Promise<Result> {
  try {
    const [{ default: Graph }, { Sigma }] = await Promise.all([import("graphology"), import("sigma")])
    const g = new Graph()
    const N = 5000
    for (let i = 0; i < N; i++) {
      const c = i % 24
      const a = (c / 24) * Math.PI * 2
      g.addNode(String(i), {
        x: Math.cos(a) * 10 + (Math.random() - 0.5) * 6,
        y: Math.sin(a) * 10 + (Math.random() - 0.5) * 6,
        size: 1.5 + Math.random() * 3,
        color: `hsl(${c * 15} 55% 60%)`,
        label: `node ${i}`,
      })
    }
    for (let i = 0; i < 15000; i++) {
      const a = Math.floor(Math.random() * N)
      const b = Math.random() < 0.85 ? (a + 1 + Math.floor(Math.random() * 40)) % N : Math.floor(Math.random() * N)
      if (a !== b && !g.hasEdge(String(a), String(b))) g.addEdge(String(a), String(b), { color: "#363a3f", size: 0.5 })
    }
    const renderer = new Sigma(g, container)
    const camera = renderer.getCamera()
    let frames = 0
    let running = true
    const start = performance.now()
    const loop = () => {
      if (!running) return
      frames++
      const t = (performance.now() - start) / 1000
      camera.setState({ ratio: 1 + Math.sin(t * 2) * 0.5, angle: t * 0.2 })
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
    await new Promise((r) => setTimeout(r, 3000))
    running = false
    const fps = Math.round(frames / ((performance.now() - start) / 1000))
    renderer.kill()
    return { name: "sigma v4: 5k nodes / 15k edges, animated camera", ok: fps >= 30, detail: `${fps} fps` }
  } catch (e) {
    return { name: "sigma v4: 5k nodes / 15k edges, animated camera", ok: false, detail: `failed: ${(e as Error).message}` }
  }
}

async function xtermCheck(container: HTMLDivElement): Promise<Result> {
  try {
    const [{ Terminal }, { WebglAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-webgl")])
    const term = new Terminal({ rows: 8, cols: 60 })
    term.open(container)
    let lost = false
    const addon = new WebglAddon()
    addon.onContextLoss(() => {
      lost = true
    })
    term.loadAddon(addon)
    term.write("\x1b[32m✔\x1b[0m xterm webgl renderer active\r\n")
    await new Promise((r) => setTimeout(r, 300))
    term.dispose()
    return { name: "xterm.js WebGL renderer", ok: !lost, detail: lost ? "context lost → DOM fallback" : "loaded" }
  } catch (e) {
    return { name: "xterm.js WebGL renderer", ok: false, detail: `failed → DOM fallback (${(e as Error).message})` }
  }
}

export default function WebglCheck() {
  const sigmaRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<HTMLDivElement>(null)
  const [results, setResults] = useState<Result[]>([])
  const [info, setInfo] = useState<Record<string, unknown>>({})
  const [running, setRunning] = useState(false)
  const [runId, setRunId] = useState(0)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setRunning(true)
      const base = await basicChecks()
      if (cancelled) return
      setInfo(base.info)
      setResults([...base.results, { name: "sigma v4 render", ok: null, detail: "running…" }, { name: "xterm.js WebGL renderer", ok: null, detail: "pending" }])
      const sig = sigmaRef.current ? await sigmaCheck(sigmaRef.current) : { name: "sigma", ok: false, detail: "no container" }
      const xt = xtermRef.current ? await xtermCheck(xtermRef.current) : { name: "xterm", ok: false, detail: "no container" }
      if (cancelled) return
      const all = [...base.results, sig, xt]
      setResults(all)
      setRunning(false)
      const verdict = all.find((r) => r.name.startsWith("sigma"))?.ok ? "sigma v4" : "sigma 3 fallback"
      const payload = JSON.stringify({ verdict, info: base.info, results: all })
      ;(window as unknown as { __webglCheck?: string }).__webglCheck = payload
      if (IN_TAURI) {
        try {
          const { info: log } = await import("@tauri-apps/plugin-log")
          await log(`[webgl-check] ${payload}`)
        } catch {
          /* log plugin unavailable */
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [runId])

  const sigmaOk = results.find((r) => r.name.startsWith("sigma"))?.ok
  return (
    <div className="@container flex h-full min-h-0 flex-col overflow-y-auto bg-canvas" data-ready={!running}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line-subtle px-4">
        <span className="text-sm font-medium" title="Decides sigma v4 vs sigma 3 and the xterm renderer">WebGL check</span>
        <div className="ml-auto flex gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(JSON.stringify({ info, results }, null, 2))}>
            <Copy /> Copy
          </Button>
          <Button size="sm" onClick={() => setRunId((n) => n + 1)} disabled={running}>
            <RotateCw /> Re-run
          </Button>
        </div>
      </div>
      <div className="grid gap-4 p-4 @min-[900px]:grid-cols-[minmax(0,1fr)_380px]">
        <div className="overflow-hidden rounded-md border border-line-subtle">
          <table className="w-full text-xs">
            <tbody>
              {results.map((r) => (
                <tr key={r.name} className="border-b border-line-subtle last:border-0">
                  <td className="w-8 py-2 pl-3">
                    {r.ok === null ? <Minus size={14} className="text-fg-faint" /> : r.ok ? <Check size={14} className="text-st-done" /> : <X size={14} className="text-st-error" />}
                  </td>
                  <td className="py-2 pr-3 text-fg">{r.name}</td>
                  <td className="py-2 pr-3 font-mono text-[11px] break-words text-fg-muted">{r.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border-t border-line-subtle px-3 py-2 text-xs">
            Verdict:{" "}
            <span className={cn("font-medium", sigmaOk === false ? "text-st-error-fg" : sigmaOk ? "text-fg" : "text-fg-faint")}>
              {sigmaOk === undefined || running ? "running…" : sigmaOk ? "use sigma v4 (WebGL2)" : "use sigma 3 + LightRAG port"}
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <div ref={sigmaRef} className="h-[260px] rounded-md border border-line-subtle bg-canvas" />
          <div ref={xtermRef} className="h-[120px] overflow-hidden rounded-md border border-line-subtle bg-canvas p-1" />
          <pre className="max-h-40 overflow-auto rounded-md border border-line-subtle p-2 font-mono text-[10.5px] text-fg-faint">
            {JSON.stringify(info, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  )
}
