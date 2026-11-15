// Pictures pasted or dropped into a prompt box, kept as data: URLs by the name shown on their chip,
// until the message is sent: then they go to Claude as image blocks and into the chat as pictures.
const store = new Map<string, string>()
let seq = 0

/** Read image files; resolves to the chip names they were stored under. */
export async function addImages(files: File[]): Promise<string[]> {
  const names: string[] = []
  for (const f of files) {
    const url = await new Promise<string>((ok, no) => {
      const r = new FileReader()
      r.onload = () => ok(String(r.result))
      r.onerror = () => no(r.error)
      r.readAsDataURL(f)
    }).catch(() => "")
    if (!url) continue
    const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg")
    let name = f.name && f.name !== "image.png" ? f.name : `screenshot-${++seq}.${ext}`
    // two pictures with the same name keep both
    for (let i = 2; store.has(name); i++) name = name.replace(/(\.[^.]*)?$/, ` (${i})$1`)
    store.set(name, url)
    names.push(name)
  }
  return names
}

/** The pictures among these attachment names (taken out of the store), and the other names. */
export function takeImages(names: string[] | undefined): { images: string[]; rest: string[] } {
  const images: string[] = []
  const rest: string[] = []
  for (const n of names ?? []) {
    const u = store.get(n)
    if (u) {
      images.push(u)
      store.delete(n)
    } else rest.push(n)
  }
  return { images, rest }
}

/** The picture behind a chip name (for its thumbnail), while it waits to be sent. */
export const imageUrl = (name: string): string | undefined => store.get(name)

// Other files (a PDF, a log, a CSV): in the app they are saved where the session may read them and
// go to Claude by their full path; in the browser preview only their name goes.
const paths = new Map<string, string>()

/** Keep dropped or picked files; resolves to the chip names they were stored under. */
export async function addFiles(files: File[]): Promise<string[]> {
  const { REAL } = await import("@/backend/mode")
  const names: string[] = []
  for (const f of files) {
    let name = f.name || "file"
    // the same name twice: the second one gets a number
    for (let i = 2; paths.has(name) || store.has(name); i++) name = f.name.replace(/(\.[^.]*)?$/, ` (${i})$1`)
    if (REAL) {
      const data = await new Promise<string>((ok) => {
        const r = new FileReader()
        r.onload = () => ok(String(r.result).split(",")[1] ?? "")
        r.onerror = () => ok("")
        r.readAsDataURL(f)
      })
      try {
        const { invoke } = await import("@tauri-apps/api/core")
        paths.set(name, await invoke<string>("save_attachment", { name, data }))
      } catch (e) {
        console.warn("save_attachment", e)
      }
    }
    names.push(name)
  }
  return names
}

/**
 * The text that tells Claude about attached files: their full paths (it reads them itself); names
 * that have no file behind them stay as a note.
 */
export function attachmentsText(names: string[]): string {
  if (!names.length) return ""
  const lines = names.map((n) => {
    const p = paths.get(n)
    return p ? `- ${p}` : `- ${n} (attached by name only)`
  })
  return `\n\nAttached files (read them):\n${lines.join("\n")}`
}
