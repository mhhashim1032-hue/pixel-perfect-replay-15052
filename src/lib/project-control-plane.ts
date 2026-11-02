/** Pure planning contracts for the customer-project control plane.
 * This module never performs provider I/O or resolves credentials.
 *
 * Sync is a saga across three independent customer-owned providers, not an atomic
 * transaction. A dry-run plan is deterministic; execution is a separate, authorized step.
 */
export const CONTROL_PLANE_PROVIDERS = ["github", "supabase", "vercel"] as const;
export type ControlPlaneProvider = (typeof CONTROL_PLANE_PROVIDERS)[number];
export type ResourceMode = "connect_existing" | "create_new";
export type SyncOperation =
  | "inspect_repository"
  | "verify_database_binding"
  | "verify_deployment_binding"
  | "sync_environment"
  | "sync_auth_redirects"
  | "inspect_migrations"
  | "apply_migrations"
  | "deploy_exact_commit"
  | "verify_runtime";

export type ProviderReadiness = Record<ControlPlaneProvider, {
  connected: boolean;
  accountPinned: boolean;
  resourceSelected: boolean;
}>;

export type SyncPlanInput = {
  mode?: ResourceMode;
  providers: ProviderReadiness;
  hasDatabase: boolean;
  hasDeployment: boolean;
  hasCommit: boolean;
  pendingMigrations: number;
  approvedOperations?: SyncOperation[];
  /** Explicit run-time capability; approval never substitutes for this capability. */
  allowProductionDeployment?: boolean;
  /** Must match the immutable plan/resource/commit approval the user accepted. */
  approvalBinding?: string | null;
  currentPlanBinding?: string | null;
};

export type PlannedSyncStep = {
  operation: SyncOperation;
  dependsOn: SyncOperation[];
  state: "ready" | "blocked" | "approval_required" | "not_applicable";
  reason: string;
  requiresApproval: boolean;
};

export type ProjectSyncPlan = {
  mode: "connect_existing" | "create_new";
  steps: PlannedSyncStep[];
  canStart: boolean;
  requiresApproval: SyncOperation[];
};

const PROVIDER_FOR: Partial<Record<SyncOperation, ControlPlaneProvider>> = {
  inspect_repository: "github",
  verify_database_binding: "supabase",
  verify_deployment_binding: "vercel",
  sync_environment: "vercel",
  sync_auth_redirects: "supabase",
  inspect_migrations: "github",
  apply_migrations: "supabase",
  deploy_exact_commit: "vercel",
  verify_runtime: "vercel",
};

const DEPENDENCIES: Record<SyncOperation, SyncOperation[]> = {
  inspect_repository: [],
  verify_database_binding: [],
  verify_deployment_binding: ["inspect_repository"],
  sync_environment: ["verify_database_binding", "verify_deployment_binding"],
  sync_auth_redirects: ["verify_database_binding", "verify_deployment_binding"],
  inspect_migrations: ["inspect_repository", "verify_database_binding"],
  apply_migrations: ["inspect_migrations"],
  deploy_exact_commit: ["inspect_repository", "verify_deployment_binding", "sync_environment"],
  verify_runtime: ["deploy_exact_commit"],
};

const APPROVAL_REQUIRED = new Set<SyncOperation>(["apply_migrations", "deploy_exact_commit"]);
const TOP_LEVEL_ORDER: SyncOperation[] = [
  "inspect_repository",
  "verify_database_binding",
  "verify_deployment_binding",
  "sync_environment",
  "sync_auth_redirects",
  "inspect_migrations",
  "apply_migrations",
  "deploy_exact_commit",
  "verify_runtime",
];

function readinessReason(input: SyncPlanInput, operation: SyncOperation): string | null {
  const provider = PROVIDER_FOR[operation];
  if (!provider) return null;
  const status = input.providers[provider];
  if (!status.connected) return `Connect the customer's ${provider} account.`;
  if (!status.accountPinned) return `Select and pin the customer's ${provider} account for this project.`;
  if (!status.resourceSelected) return `Select the customer's ${provider} resource for this project.`;
  return null;
}

function isOptional(input: SyncPlanInput, operation: SyncOperation): boolean {
  return operation === "verify_database_binding" && !input.hasDatabase
    || operation === "verify_deployment_binding" && !input.hasDeployment
    || ["sync_environment", "sync_auth_redirects", "inspect_migrations", "apply_migrations"].includes(operation) && !input.hasDatabase
    || ["sync_environment", "sync_auth_redirects", "deploy_exact_commit", "verify_runtime"].includes(operation) && !input.hasDeployment
    || operation === "deploy_exact_commit" && !input.hasCommit
    || operation === "apply_migrations" && input.pendingMigrations === 0;
}

/** Creates a deterministic dry-run plan. It never performs provider calls or external writes. */
export function buildProjectSyncPlan(input: SyncPlanInput): ProjectSyncPlan {
  const completed = new Set<SyncOperation>();
  const steps: PlannedSyncStep[] = [];
  const approved = new Set(input.approvedOperations ?? []);
  const bindingMatches = !!input.approvalBinding && input.approvalBinding === input.currentPlanBinding;

  for (const operation of TOP_LEVEL_ORDER) {
    if (isOptional(input, operation)) {
      steps.push({ operation, dependsOn: DEPENDENCIES[operation], state: "not_applicable", reason: "This resource or change is not part of the selected project sync.", requiresApproval: false });
      continue;
    }

    const missing = readinessReason(input, operation);
    if (missing) {
      steps.push({ operation, dependsOn: DEPENDENCIES[operation], state: "blocked", reason: missing, requiresApproval: false });
      continue;
    }

    const unmet = DEPENDENCIES[operation].filter((dep) => !completed.has(dep));
    if (unmet.length) {
      steps.push({ operation, dependsOn: DEPENDENCIES[operation], state: "blocked", reason: `Waiting for prerequisite: ${unmet.join(", ")}.`, requiresApproval: false });
      continue;
    }

    if (APPROVAL_REQUIRED.has(operation)) {
      if (!input.allowProductionDeployment && operation === "deploy_exact_commit") {
        steps.push({ operation, dependsOn: DEPENDENCIES[operation], state: "blocked", reason: "The task's current autonomy/permission policy does not permit production deployment.", requiresApproval: false });
        continue;
      }
      const requiresExactApproval = operation === "apply_migrations" || operation === "deploy_exact_commit";
      if (requiresExactApproval && (!approved.has(operation) || !bindingMatches)) {
        steps.push({
          operation, dependsOn: DEPENDENCIES[operation], state: "approval_required",
          reason: bindingMatches
            ? "Explicit approval for this exact operation is required."
            : "Approval must be bound to the current resource, commit and plan; review the current plan.",
          requiresApproval: true,
        });
        continue;
      }
    }

    steps.push({ operation, dependsOn: DEPENDENCIES[operation], state: "ready", reason: "All prerequisites, pinned customer resources and policy checks are satisfied.", requiresApproval: false });
    completed.add(operation);
  }

  const requiresApproval = steps.filter((step) => step.state === "approval_required").map((step) => step.operation);
  const hasBlocked = steps.some((step) => step.state === "blocked");
  const hasApproval = requiresApproval.length > 0;
  return {
    mode: input.mode ?? "connect_existing",
    steps,
    canStart: steps.some((step) => step.state === "ready") && !hasBlocked && !hasApproval,
    requiresApproval,
  };
}

/** Stable canonical JSON for hashing a dry-run plan before approval. */
export function stablePlanBinding(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, normalize(x)]));
    }
    return v;
  };
  return JSON.stringify(normalize(value));
}
