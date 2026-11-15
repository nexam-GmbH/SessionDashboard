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
    const name = f.name && f.name !== "image.png" ? f.name : `screenshot-${++seq}.${ext}`
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
