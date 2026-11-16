// Settings → Reduce motion for every spinner: a data attribute on <html> that index.css reads
// (the spinners themselves turn with a smooth CSS animation).
import { getApp, useApp } from "@/store/app"

function sync() {
  if (getApp().settings.reduceMotion) document.documentElement.dataset.reduceMotion = ""
  else delete document.documentElement.dataset.reduceMotion
}

export function installSpinClock() {
  sync()
  useApp.subscribe((st) => st.settings.reduceMotion, sync)
}
