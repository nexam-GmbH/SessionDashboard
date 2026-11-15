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
  /** where the folder is: undefined = this computer, "cloud" = claude.ai, else an ssh host */
  machine?: string
  /** git as last read (Phase 2): branch, what is not committed or pushed, forgotten worktrees */
  git?: RepoGit
  /** a repo found in a workspace folder: shown even with no session running */
  inWorkspace?: boolean
  /** the workspace (Settings → Workspaces) this folder belongs to */
  workspace?: string
  /** "owner/name" as GitHub spells it ("acme/api"), when known */
  slug?: string
  /** a workspace's main folder (its sessions work across all the workspace's repos) */
  isHome?: boolean
  defaultBranch: string
  language: string
  worktrees: Worktree[]
  sharedRuleFiles: string[]
  pinned: boolean
  addedAt: string
}

export interface RepoGit {
  isRepo: boolean
  /** the main worktree of the repository this folder belongs to */
  root?: string
  /** who the repository is: its remote as "github.com/owner/name" (lowercase), whatever the folder */
  remote?: string
  /** the repository's name as its remote spells it ("api") */
  remoteName?: string
  /** "owner/name" as the remote spells it ("acme/api") */
  slug?: string
  hasRemote: boolean
  branch?: string
  changed: number
  untracked: number
  ahead: number
  behind: number
  /** commits on the checked-out branch that are on no remote */
  unpushed: number
  /** worktrees and branches with work that is not committed or not pushed */
  looseEnds: LooseEnd[]
  observedAt: string
  error?: string
}

export interface LooseEnd {
  kind: "worktree" | "branch"
  name: string
  path?: string
  changed: number
  unpushed: number
  /** upstream deleted (merged and cleaned up on the remote?) */
  gone?: boolean
  lastCommitMs: number
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
/** owned: the app runs it · observed: a terminal runs it · history: not running · cloud: claude.ai runs it */
export type ControlMode = "owned" | "pty" | "observed" | "history" | "cloud"

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
  /** where it runs: undefined = this computer, "cloud" = claude.ai, else an ssh host */
  machine?: string
  /** the folder it was started in (resume runs there); `cwd` is where it works now */
  startCwd?: string
  /** folders it worked in */
  cwds?: string[]
  /** claude.ai/code link (cloud sessions) */
  url?: string
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
  /** the last thing you asked and the last thing Claude said (hover preview) */
  lastPrompt?: string
  lastText?: string
  lastStopReason?: "end_turn" | "max_tokens" | "refusal" | "cancelled" | "error"
  errorMessage?: string
  model: string
  effort: Effort
  permissionMode: PermissionMode
  /** Claude Code fast mode (same model, faster output) */
  fastMode?: boolean
  /** Claude Code ultracode (multi-agent orchestration) */
  ultracode?: boolean
  /** output style ("default", "Explanatory", …) */
  outputStyle?: string
  usage: {
    contextPct: number
    inputTokens: number
    outputTokens: number
    costUsd: number
    /** what fills the context window, by category (sessions the app runs: get_context_usage) */
    context?: { used: number; max: number; categories: { name: string; tokens: number; kind: string; deferred?: boolean }[] }
  }
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
  /** how long the turn took, as Claude Code recorded it (system turn_duration) */
  durationMs?: number
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

/** A picture in a message or a tool result: a data: URL or a link. */
export interface Picture {
  src: string
  mediaType?: string
}

/** A file Claude handed you (SendUserFile): on this computer at `path`, or kept by claude.ai. */
export interface SharedFile {
  path: string
  name: string
  size?: number
  mediaType?: string
  /** claude.ai's id for it (cloud sessions) */
  fileUuid?: string
}

export interface ToolCall {
  id: string
  name: string
  /** pictures in its result (Read of an image, a screenshot) */
  images?: Picture[]
  /** files it handed you (SendUserFile), with the caption */
  files?: SharedFile[]
  caption?: string
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
  | { type: "user_message"; id: ID; turnId: ID; at: string; text: string; attachments?: string[]; images?: Picture[] }
  | { type: "agent_message"; id: ID; turnId: ID; at: string; text: string; streaming: boolean }
  | { type: "thought"; id: ID; turnId: ID; at: string; text: string; durationMs?: number }
  | { type: "tool_call"; id: ID; turnId: ID; at: string; call: ToolCall }
  | { type: "compaction"; id: ID; turnId: ID; at: string; trigger: "manual" | "auto"; preTokens: number }
  | { type: "notice"; id: ID; turnId: ID; at: string; severity: "info" | "warning" | "error"; text: string }

export interface Transcript {
  sessionId: ID
  /** the newest thing Claude produced is a thinking block (the live line says "thinking") */
  thinkingNow?: boolean
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
