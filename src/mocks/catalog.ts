/**
 * Curated, realistic content for mock data. Names, paths and tasks read like a
 * real multi-repo product so screenshots are representative (no lorem ipsum).
 */
export interface RepoSpec {
  name: string
  language: "TypeScript" | "Go" | "Python" | "Markdown" | "HCL"
  files: string[]
  tasks: string[]
  symbols: string[]
}

export const REPO_CATALOG: RepoSpec[] = [
  {
    name: "api-gateway",
    language: "TypeScript",
    files: [
      "src/auth/retry.ts",
      "src/auth/client.ts",
      "src/routes/v2/completions.ts",
      "src/middleware/rate-limit.ts",
      "src/config/upstreams.ts",
      "src/lib/metrics.ts",
      "src/routes/v2/tickets.ts",
      "test/retry.test.ts",
      "test/rate-limit.test.ts",
    ],
    tasks: [
      "Fix auth retry double-counting attempts",
      "Add rate limiter to /v2/completions",
      "Expose Prometheus metrics endpoint",
      "Accept ticket v3 payloads on /v2/tickets",
      "Investigate 502s from billing upstream",
      "Add request tracing headers",
      "Migrate upstream config to YAML",
    ],
    symbols: ["withRetry", "AuthClient", "rateLimit", "UpstreamPool", "metricsHandler", "TicketRoute"],
  },
  {
    name: "web-app",
    language: "TypeScript",
    files: [
      "app/(dashboard)/tickets/page.tsx",
      "components/TicketTable.tsx",
      "lib/api/tickets.ts",
      "app/pricing/page.tsx",
      "components/ui/select.tsx",
      "lib/i18n/en.json",
      "app/(dashboard)/triage/page.tsx",
    ],
    tasks: [
      "Ticket schema v3 in the dashboard",
      "Rewrite pricing page copy",
      "Fix hydration warning on tickets page",
      "Virtualize the ticket table",
      "Keyboard shortcuts for the triage view",
    ],
    symbols: ["TicketTable", "useTickets", "PricingPage", "TriageView", "fetchTickets"],
  },
  {
    name: "billing-service",
    language: "Go",
    files: [
      "internal/invoice/rounding.go",
      "internal/invoice/rounding_test.go",
      "internal/stripe/webhook.go",
      "cmd/billing/main.go",
      "internal/ledger/entries.go",
    ],
    tasks: [
      "Fix invoice rounding for zero-decimal currencies",
      "Idempotent Stripe webhook handling",
      "Backfill ledger entries for March",
      "Dunning email schedule",
    ],
    symbols: ["RoundMinor", "HandleWebhook", "LedgerEntry", "InvoiceService"],
  },
  {
    name: "ticketing",
    language: "TypeScript",
    files: [
      "packages/schema/src/ticket.ts",
      "packages/schema/src/v3/migrate.ts",
      "packages/api/src/routes/tickets.ts",
      "packages/worker/src/sla.ts",
      "packages/schema/test/migrate.test.ts",
      "packages/api/src/routes/fields.ts",
    ],
    tasks: [
      "Roll out ticket-schema v3",
      "SLA breach notifications",
      "Merge duplicate tickets by email thread",
      "Custom fields API",
    ],
    symbols: ["TicketV3", "migrateV2toV3", "slaWorker", "CustomField", "ticketsRouter"],
  },
  {
    name: "llm-router",
    language: "Python",
    files: [
      "router/mapping.py",
      "router/providers/anthropic.py",
      "router/providers/openai_compat.py",
      "router/fallbacks.py",
      "tests/test_mapping.py",
      "config/models.yaml",
    ],
    tasks: [
      "Update model mapping for opus-5.5",
      "Fallback chain per tenant",
      "Token budget per route",
      "Cache provider capabilities",
    ],
    symbols: ["resolve_model", "AnthropicProvider", "FallbackChain", "TokenBudget"],
  },
  {
    name: "shared-rules",
    language: "Markdown",
    files: [
      "rules/CLAUDE.base.md",
      "rules/typescript.md",
      "rules/go.md",
      "rules/python.md",
      "rules/security.md",
      "scripts/sync.sh",
    ],
    tasks: ["Tighten security rules for secrets", "Sync rules into all repos", "Python typing rules"],
    symbols: ["base rules", "security rules", "sync.sh"],
  },
  {
    name: "auth-service",
    language: "Go",
    files: [
      "internal/oidc/provider.go",
      "internal/session/store.go",
      "internal/mfa/totp.go",
      "api/openapi.yaml",
    ],
    tasks: ["Rotate signing keys without downtime", "TOTP recovery codes", "OIDC discovery cache"],
    symbols: ["Provider", "SessionStore", "VerifyTOTP", "KeyRing"],
  },
  {
    name: "mobile-app",
    language: "TypeScript",
    files: [
      "src/screens/TicketDetail.tsx",
      "src/api/client.ts",
      "src/navigation/index.tsx",
      "src/store/tickets.ts",
    ],
    tasks: ["Ticket schema v3 in mobile", "Offline queue for replies", "Fix Android back navigation"],
    symbols: ["TicketDetail", "ApiClient", "RootNavigator", "ticketsSlice"],
  },
  {
    name: "infra",
    language: "HCL",
    files: [
      "modules/postgres/main.tf",
      "envs/staging/main.tf",
      "envs/prod/main.tf",
      "k8s/api-gateway/deployment.yaml",
    ],
    tasks: ["Bump Postgres to 17 in staging", "PodDisruptionBudget for the gateway", "Terraform drift in prod"],
    symbols: ["module.postgres", "aws_db_instance", "Deployment/api-gateway"],
  },
  {
    name: "analytics-pipeline",
    language: "Python",
    files: [
      "pipelines/events/transform.py",
      "dbt/models/tickets_daily.sql",
      "pipelines/llm/costs.py",
    ],
    tasks: ["Daily LLM cost rollup", "Fix late-arriving events", "dbt model for ticket SLA"],
    symbols: ["transform_events", "tickets_daily", "llm_costs"],
  },
  {
    name: "notifications",
    language: "TypeScript",
    files: [
      "src/channels/email.ts",
      "src/channels/slack.ts",
      "src/templates/sla-breach.mjml",
      "src/queue/consumer.ts",
    ],
    tasks: ["Slack routing per team", "SLA breach email template", "Retry poison messages"],
    symbols: ["EmailChannel", "SlackChannel", "QueueConsumer"],
  },
  {
    name: "design-system",
    language: "TypeScript",
    files: [
      "src/components/Button.tsx",
      "src/tokens/colors.ts",
      "src/components/DataTable.tsx",
      "stories/Button.stories.tsx",
    ],
    tasks: ["Dense variant for DataTable", "Token export for mobile", "Fix focus ring contrast"],
    symbols: ["Button", "DataTable", "colors"],
  },
]

export const EXTRA_REPO_WORDS = [
  "search",
  "payments",
  "catalog",
  "inventory",
  "scheduler",
  "reports",
  "exports",
  "webhooks",
  "identity",
  "audit",
  "pricing",
  "ingest",
  "realtime",
  "media",
  "docs",
  "support",
  "crm",
  "ml-features",
  "feature-flags",
  "status-page",
]

export const HISTORY_TASKS = [
  "Bump dependencies",
  "Fix flaky test in CI",
  "Investigate memory spike",
  "Add OpenAPI examples",
  "Refactor config loading",
  "Remove dead feature flag",
  "Write migration guide",
  "Profile slow endpoint",
  "Add missing indexes",
  "Clean up logging",
  "Fix lint errors after upgrade",
  "Add e2e test for login",
  "Document env variables",
  "Split large module",
  "Fix timezone bug in reports",
  "Rename package",
  "Speed up Docker build",
  "Add health check endpoint",
]

export const CITY_HANDLES = [
  "warsaw",
  "lisbon",
  "osaka",
  "quito",
  "tunis",
  "riga",
  "hanoi",
  "perth",
  "cusco",
  "bergen",
  "dakar",
  "lyon",
  "malmo",
  "porto",
  "split",
  "turin",
  "accra",
  "bonn",
  "cork",
  "delft",
  "gent",
  "kobe",
  "lille",
  "nice",
  "oslo",
  "pune",
  "sofia",
  "tartu",
  "utrecht",
  "vigo",
  "york",
  "zadar",
]

export const SUBAGENT_TYPES = [
  { type: "Explore", tasks: ["Find other callers of withRetry", "Map where tickets are serialized", "Locate SLA config usage", "Find all v2 payload consumers"] },
  { type: "general-purpose", tasks: ["Draft migration for ticket fields", "Update fixtures to v3", "Summarize failing tests"] },
  { type: "code-reviewer", tasks: ["Review retry changes", "Review schema migration", "Review webhook idempotency"] },
  { type: "test-runner", tasks: ["Run package tests", "Run integration suite", "Reproduce flaky test"] },
]

export const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const

export const FOLLOW_UPS = [
  "Also update the changelog.",
  "Run the full test suite before you finish.",
  "Keep the public API unchanged.",
  "Can you add a regression test for this?",
  "Looks good. Push the branch and open a draft PR.",
  "Use the existing helper instead of a new util.",
]
