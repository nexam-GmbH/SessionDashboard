// nodeTypes / edgeTypes at module scope (React Flow re-mounts every node if these objects change).
import type { EdgeTypes, NodeTypes } from "@xyflow/react"
import { MainAgentNode } from "./nodes/MainAgentNode"
import { RepoGroupNode } from "./nodes/RepoGroupNode"
import { SessionNode } from "./nodes/SessionNode"
import { StackNode } from "./nodes/StackNode"
import { SubagentNode } from "./nodes/SubagentNode"
import { OrthoEdge } from "./edges/OrthoEdge"
import { LinkEdge } from "./edges/LinkEdge"

export const nodeTypes: NodeTypes = {
  main: MainAgentNode,
  repo: RepoGroupNode,
  session: SessionNode,
  subagent: SubagentNode,
  stack: StackNode,
}

export const edgeTypes: EdgeTypes = {
  ortho: OrthoEdge,
  link: LinkEdge,
}
