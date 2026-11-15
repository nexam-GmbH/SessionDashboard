// The app's own tooltip for every `title` attribute. WebKitGTK shows `title` as a native GTK tooltip:
// it fades out when the pointer leaves, blinks again whenever the page repaints under it (a clock
// ticking every second is enough) and lingers. This one appears after a short rest, follows no
// animation, and is gone the moment the pointer leaves, scrolls, clicks or types.
// `title` moves to `data-sd-title` on hover so the native one never shows; an icon button whose
// only name was its title keeps it as `aria-label`.

const SHOW_MS = 450
let tip: HTMLDivElement | null = null
let timer = 0
let current: Element | null = null

function box(): HTMLDivElement {
  if (tip) return tip
  tip = document.createElement("div")
  tip.setAttribute("role", "tooltip")
  tip.className =
    "pointer-events-none fixed z-[1000] max-w-[min(420px,80vw)] rounded-md bg-foreground px-2.5 py-1.5 text-xs leading-[1.35] whitespace-pre-line text-background shadow-md"
  tip.style.display = "none"
  document.body.appendChild(tip)
  return tip
}

function hide() {
  window.clearTimeout(timer)
  timer = 0
  current = null
  if (tip) tip.style.display = "none"
}

function textOf(el: Element): string {
  const t = el.getAttribute("title")
  if (t !== null) {
    el.removeAttribute("title")
    if (t) {
      el.setAttribute("data-sd-title", t)
      // the title was its only name (an icon button): screen readers keep it
      if (!el.getAttribute("aria-label") && !el.textContent?.trim()) el.setAttribute("aria-label", t)
    }
    return t
  }
  return el.getAttribute("data-sd-title") ?? ""
}

function show(el: Element, x: number, y: number) {
  const text = textOf(el)
  if (!text || !el.isConnected) return
  const t = box()
  t.textContent = text
  t.style.display = "block"
  t.style.left = "0px"
  t.style.top = "0px"
  const r = t.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  // under the pointer, kept inside the window (above it near the bottom edge)
  let left = Math.min(Math.max(8, x - r.width / 2), vw - r.width - 8)
  let top = y + 18
  if (top + r.height > vh - 8) top = y - r.height - 12
  left = Math.max(8, left)
  t.style.left = `${Math.round(left)}px`
  t.style.top = `${Math.round(Math.max(8, top))}px`
}

export function installTitleTooltips() {
  let lastX = 0
  let lastY = 0
  document.addEventListener(
    "pointerover",
    (e) => {
      const el = (e.target as Element | null)?.closest?.("[title], [data-sd-title]")
      if (el === current) return
      hide()
      if (!el) return
      // take the title away at once: the native tooltip must never get its turn
      textOf(el)
      current = el
      lastX = e.clientX
      lastY = e.clientY
      timer = window.setTimeout(() => current === el && show(el, lastX, lastY), SHOW_MS)
    },
    true,
  )
  document.addEventListener(
    "pointermove",
    (e) => {
      lastX = e.clientX
      lastY = e.clientY
    },
    { capture: true, passive: true },
  )
  document.addEventListener(
    "pointerout",
    (e) => {
      if (!current) return
      const to = e.relatedTarget as Node | null
      if (to && current.contains(to)) return
      hide()
    },
    true,
  )
  for (const ev of ["pointerdown", "keydown", "wheel", "scroll", "blur"] as const) window.addEventListener(ev, hide, { capture: true, passive: true })
}
