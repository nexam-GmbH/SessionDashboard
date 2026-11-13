// Agent Map (home) — UI_PLAN §5.1. React Flow 12 (MIT) canvas with structure-only nodes that read
// live data from the store by id (Headlamp resource-map architecture, Apache-2.0), a stable
// deterministic layout cached by structure hash, three LOD tiers via boolean zoom selectors, and
// keyboard-first interactions.
import { ReactFlowProvider } from "@xyflow/react"
import "./map.css"
import { MapCanvas } from "./MapCanvas"

export default function MapView() {
  return (
    <ReactFlowProvider>
      <MapCanvas />
    </ReactFlowProvider>
  )
}
