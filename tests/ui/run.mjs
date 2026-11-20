// `bun run test:ui`: starts Vite on a fixed port (UI_PORT, default 5191), runs tests/ui/smoke.mjs
// against it, and always stops Vite again (it runs inside this process, so nothing is left behind).
// Arguments are passed on to smoke.mjs (test name filters).
import { spawn } from "node:child_process"
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { createServer, searchForWorkspaceRoot } from "vite"

const root = resolve(import.meta.dirname, "../..")
const port = Number(process.env.UI_PORT ?? 5191)

const server = await createServer({
  root,
  configFile: resolve(root, "vite.config.ts"),
  // its own dependency cache: a dev server running from the same checkout is not disturbed
  cacheDir: resolve(root, "node_modules/.vite-ui-test"),
  logLevel: "warn",
  clearScreen: false,
  server: {
    // one address, so a server already on this port is an error here, not the server under test
    host: "127.0.0.1",
    port,
    strictPort: true,
    watch: null,
    // node_modules may be a symlink (a git worktree sharing the main checkout's): fonts are served from its real path
    fs: { allow: [searchForWorkspaceRoot(root), realpathSync(resolve(root, "node_modules"))] },
  },
})

let code = 1
let child
const stop = async () => {
  child?.kill()
  await server.close()
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => void stop().finally(() => process.exit(130)))
}

try {
  await server.listen()
  const base = `http://127.0.0.1:${port}/`
  child = spawn(process.execPath, [resolve(import.meta.dirname, "smoke.mjs"), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, UI_BASE: base },
  })
  code = await new Promise((done) => child.on("exit", (c) => done(c ?? 1)))
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
} finally {
  await stop()
}
process.exit(code)
