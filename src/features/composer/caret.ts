/**
 * Caret coordinates inside a textarea via a hidden mirror element that copies the
 * textarea's box and text metrics (the well-known mirror-div technique).
 * Returns the caret's offset relative to the textarea's border box.
 */
const COPIED = [
  "boxSizing",
  "width",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "lineHeight",
  "textTransform",
  "wordSpacing",
  "tabSize",
  "fontFeatureSettings",
] as const

export function caretCoordinates(el: HTMLTextAreaElement, position: number): { left: number; top: number; height: number } {
  const mirror = document.createElement("div")
  const style = getComputedStyle(el)
  const s = mirror.style
  s.position = "absolute"
  s.visibility = "hidden"
  s.whiteSpace = "pre-wrap"
  s.overflowWrap = "break-word"
  s.top = "0"
  s.left = "-9999px"
  for (const prop of COPIED) s[prop] = style[prop]
  s.overflow = "hidden"
  mirror.textContent = el.value.slice(0, position)
  const marker = document.createElement("span")
  marker.textContent = el.value.slice(position) || "."
  mirror.appendChild(marker)
  document.body.appendChild(mirror)
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4
  const out = { left: marker.offsetLeft, top: marker.offsetTop - el.scrollTop, height: lineHeight }
  document.body.removeChild(mirror)
  return out
}
