/**
 * Domain model — UI_PLAN.md §3. Mirrors how Claude Code really works
 * (RESEARCH.md §1) and the data-model lessons in RESEARCH.md §4. Phase 2 keeps
 * these types; only the data source changes.
 */
export type ID = string

// ---------- repos & git ----------
export interface Repo {
  id: ID
  name: string
  rootPath: string
  defaultBranch: string
  language: string
  worktrees: Worktree[]
  graphify?: {
    state: "none" | "building" | "fresh" | "stale"
    builtAtCommit?: string
    builtAt?: string
    nodes?: number
    edges?: number
    communities?: number
  }
  sharedRuleFiles: string[]
  pinned: boolean
  addedAt: string
}

/** id = `${repoId}::${path}` (Orca) */
export interface Worktree {
  id: ID
  repoId: ID
  path: string
  branch: string
  isMain: boolean
  git: GitSnapshot
}

/** Crystal GitStatus + Jean cached_* + Emdash observedGit */
export interface GitSnapshot {
  state: "clean" | "modified" | "ahead" | "behind" | "diverged" | "conflict"
  filesChanged: number
  linesAdded: number
  linesRemoved: number
  untracked: number
  ahead: number
  behind: number
  unpushed: number
  pr?: {
    number: number
    state: "open" | "draft" | "merged" | "closed"
    checks: "pending" | "passing" | "failing" | "none"
  }
  observedAt: string
}

/** Map cross-links: Graphify global graph (calls) or shared rules/code. */
export interface RepoLink {
  id: ID
  from: ID
  to: ID
  kind: "shared-code" | "shared-rules" | "calls" | "manual"
  label: string
  weight?: number
}

// ---------- sessions ----------
export type SessionStatus =
  | "starting"
  | "working"
  | "waiting_permission"
  | "waiting_input"
  | "idle"
  | "done_unseen"
  | "error"
  | "stopped"

/** RESEARCH §1.4 */
export type ControlMode = "owned" | "pty" | "observed" | "history"

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "auto"
  | "dontAsk"
  | "bypassPermissions"

export type Effort = "low" | "medium" | "high" | "xhigh" | "max"

export interface Session {
  /** ours, stable forever */
  id: ID
  provider: "claude-code"
  /** chain, newest last: resume/compaction can change Claude's id */
  providerSessionIds: string[]
  role: "main" | "standard"
  title: string
  titleSource: "custom" | "ai" | "first-prompt"
  titleLocked: boolean
  firstPrompt: string
  repoId: ID | null
  worktreeId: ID | null
  /** frozen; --resume depends on it */
  cwd: string
  /** --add-dir: multi-repo scope */
  additionalDirs: string[]
  control: ControlMode
  kind: "interactive" | "background" | "sdk"
  status: SessionStatus
  statusObservedAt: string
  waitingFor?: {
    kind: "permission" | "question" | "plan" | "input"
    summary: string
    requestId?: ID
  }
  /** one line: "Editing src/auth/retry.ts" (Xum status_update, Jean set_status) */
  activity?: string
  lastStopReason?: "end_turn" | "max_tokens" | "refusal" | "cancelled" | "error"
  errorMessage?: string
  model: string
  effort: Effort
  permissionMode: PermissionMode
  usage: { contextPct: number; inputTokens: number; outputTokens: number; costUsd: number }
  /** files changed by this session (its worktree diff) */
  diff: { filesChanged: number; linesAdded: number; linesRemoved: number; unpushed: number }
  backgroundTasks: number
  todo?: { done: number; total: number }
  parent?: {
    sessionId: ID
    kind: "delegated" | "forked" | "teammate"
    viaToolCallId?: string
    atMessageId?: string
  }
  /** stable short handle shown in places where titles are too long */
  handle: string
  createdAt: string
  updatedAt: string
  lastViewedAt?: string
  pinned: boolean
  archived: boolean
  archivedAt?: string
  snoozedUntil?: string
}

/** From <session>/subagents/agent-<id>.meta.json + SubagentStart/Stop hooks */
export interface Subagent {
  id: ID
  sessionId: ID
  parentToolUseId: string
  parentSubagentId?: ID
  agentType: string
  description: string
  status: "running" | "waiting_permission" | "completed" | "failed" | "stopped"
  background: boolean
  spawnDepth: number
  worktreeBranch?: string
  lastTool?: string
  toolCount: number
  startedAt: string
  finishedAt?: string
  summary?: string
}

// ---------- transcript (shaped after ACP; Claude specifics on top) ----------
export interface Turn {
  id: ID
  sessionId: ID
  status: "in_progress" | "completed" | "interrupted" | "failed"
  startedAt: string
  completedAt?: string
  itemIds: ID[]
  receipt?: { durationMs: number; tokens: number; costUsd: number; filesChanged: number }
}

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other"

export interface FileChange {
  path: string
  oldPath?: string
  op: "add" | "modify" | "delete" | "move"
  oldText: string
  newText: string
  added: number
  removed: number
  review?: "unreviewed" | "kept" | "rejected"
}

export interface ToolCall {
  id: string
  name: string
  kind: ToolKind
  title: string
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled"
  display: "awaiting_permission" | "running" | "done" | "failed" | "rejected" | "cancelled"
  input: Record<string, unknown>
  output?: string
  locations?: { path: string; line?: number }[]
  diff?: FileChange[]
  terminal?: { command: string; exitCode?: number }
  subagentId?: ID
  startedAt: string
  completedAt?: string
}

export type Item =
  | { type: "user_message"; id: ID; turnId: ID; at: string; text: string; attachments?: string[] }
  | { type: "agent_message"; id: ID; turnId: ID; at: string; text: string; streaming: boolean }
  | { type: "thought"; id: ID; turnId: ID; at: string; text: string; durationMs?: number }
  | { type: "tool_call"; id: ID; turnId: ID; at: string; call: ToolCall }
  | { type: "compaction"; id: ID; turnId: ID; at: string; trigger: "manual" | "auto"; preTokens: number }
  | { type: "notice"; id: ID; turnId: ID; at: string; severity: "info" | "warning" | "error"; text: string }

export interface Transcript {
  sessionId: ID
  turns: Turn[]
  order: ID[]
  items: Record<ID, Item>
  liveItemId?: ID
  queued: { id: ID; text: string; attachments?: string[] }[]
  todos: { content: string; status: "pending" | "in_progress" | "completed" }[]
}

// ---------- things that need the user ----------
export interface PermissionOption {
  id: string
  name: string
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always"
}

export interface PermissionRequest {
  type: "permission"
  id: ID
  sessionId: ID
  subagentId?: ID
  toolCallId?: string
  toolName: string
  title: string
  description?: string
  subject?: { type: "tool_call"; path?: string } | { type: "command"; command: string; cwd: string }
  options: PermissionOption[]
  state: "pending" | "selected" | "cancelled"
  selectedOptionId?: string
  requestedAt: string
  resolvedAt?: string
}

export interface QuestionRequest {
  type: "question"
  id: ID
  sessionId: ID
  state: "pending" | "answered" | "cancelled"
  requestedAt: string
  questions: {
    question: string
    header: string
    multiSelect: boolean
    options: { label: string; description?: string; preview?: string }[]
  }[]
}

export interface PlanApproval {
  type: "plan"
  id: ID
  sessionId: ID
  state: "pending" | "selected" | "cancelled"
  requestedAt: string
  planMarkdown: string
  /** several allow_always options, one per target mode */
  options: PermissionOption[]
}

export type PendingRequest = PermissionRequest | QuestionRequest | PlanApproval

export interface AppNotification {
  id: ID
  sessionId: ID
  kind: "permission" | "question" | "finished" | "error"
  groupKey: string
  count: number
  title: string
  body: string
  createdAt: string
  readAt?: string
}

export type Selection =
  | { kind: "session"; id: ID }
  | { kind: "repo"; id: ID }
  | { kind: "subagent"; id: ID }
  | null
