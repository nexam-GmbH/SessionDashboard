import { IN_TAURI } from "@/lib/platform"

/**
 * Dev-only: inside Tauri, run the M0 WebGL check off-screen once at startup and
 * print the JSON to stdout via tauri-plugin-log, so the real webview's result
 * (WebKitGTK on Linux) is visible in the terminal without navigating.
 */
export function scheduleBootDiagnostics() {
  if (!IN_TAURI || !import.meta.env.DEV) return
  setTimeout(async () => {
    const host = document.createElement("div")
    host.style.cssText = "position:fixed;left:-10000px;top:0;width:800px;height:600px;"
    document.body.appendChild(host)
    const result: Record<string, unknown> = { userAgent: navigator.userAgent }
    try {
      const c2 = document.createElement("canvas").getContext("webgl2") as WebGL2RenderingContext | null
      result.webgl2 = !!c2
      if (c2) {
        const dbg = c2.getExtension("WEBGL_debug_renderer_info")
        result.renderer = dbg ? c2.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : c2.getParameter(c2.RENDERER)
        result.vendor = dbg ? c2.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : c2.getParameter(c2.VENDOR)
      }
      result.noPerfCaveat = !!document.createElement("canvas").getContext("webgl2", { failIfMajorPerformanceCaveat: true })
      const [{ default: Graph }, { Sigma }] = await Promise.all([import("graphology"), import("sigma")])
      const g = new Graph()
      for (let i = 0; i < 5000; i++) g.addNode(String(i), { x: Math.random() * 100, y: Math.random() * 100, size: 2, color: "#70b8ff" })
      for (let i = 0; i < 15000; i++) {
        const a = String(Math.floor(Math.random() * 5000))
        const b = String(Math.floor(Math.random() * 5000))
        if (a !== b && !g.hasEdge(a, b)) g.addEdge(a, b, { color: "#363a3f", size: 0.5 })
      }
      const r = new Sigma(g, host)
      let frames = 0
      const t0 = performance.now()
      await new Promise<void>((done) => {
        const loop = () => {
          frames++
          r.getCamera().setState({ ratio: 1 + Math.sin(frames / 20) * 0.5 })
          if (performance.now() - t0 < 3000) requestAnimationFrame(loop)
          else done()
        }
        requestAnimationFrame(loop)
      })
      result.sigmaFps = Math.round(frames / ((performance.now() - t0) / 1000))
      r.kill()
    } catch (e) {
      result.error = String(e)
    }
    host.remove()
    try {
      const { info } = await import("@tauri-apps/plugin-log")
      await info(`[webgl-check] ${JSON.stringify(result)}`)
    } catch {
      console.info("[webgl-check]", result)
    }
  }, 2500)
}
