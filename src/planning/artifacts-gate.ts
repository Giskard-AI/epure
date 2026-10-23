export type ArtifactsGateErrorCode =
  | "NONE"
  | "GLOSSARY_MISSING_FOR_DOMAIN_TERMS"
  | "ADR_MISSING_OR_INCOMPLETE"
  | "SPEC_MISSING_OR_INCOMPLETE"
  | "TICKET_GRAPH_EMPTY"
  | "TICKET_GRAPH_CYCLE_DETECTED";

export interface AdrFileEntry {
  readonly path: string;
  readonly content: string;
}

export interface TicketGraphNode {
  readonly id: number;
  readonly issueNumber: number;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly blockedBy: readonly number[];
}

export interface PlanningArtifactsBundle {
  readonly introducesDomainTerms: boolean;
  readonly glossaryContent: string;
  readonly adrFiles: readonly AdrFileEntry[];
  readonly specPath: string;
  readonly specContent: string;
  readonly tickets: readonly TicketGraphNode[];
}

export interface ValidatePlanningArtifactsResult {
  readonly valid: boolean;
  readonly error_code: ArtifactsGateErrorCode;
  readonly error_message: string;
  readonly ready_ticket_ids: readonly number[];
  readonly blocked_ticket_ids: readonly number[];
}

const ADR_PATH_PATTERN = /^docs\/adr\/\d{4}-[a-z0-9-]+\.md$/;

function hasDependencyCycle(tickets: readonly TicketGraphNode[]): boolean {
  const byId = new Map<number, TicketGraphNode>();
  for (const t of tickets) {
    byId.set(t.id, t);
  }

  const visiting = new Set<number>();
  const visited = new Set<number>();

  function dfs(id: number): boolean {
    if (visiting.has(id)) {
      return true;
    }
    if (visited.has(id)) {
      return false;
    }
    visiting.add(id);
    const node = byId.get(id);
    if (node) {
      for (const blockerId of node.blockedBy) {
        if (dfs(blockerId)) {
          return true;
        }
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }

  for (const t of tickets) {
    if (dfs(t.id)) {
      return true;
    }
  }
  return false;
}

export function validatePlanningArtifactsAndGraph(
  bundle: PlanningArtifactsBundle
): ValidatePlanningArtifactsResult {
  if (
    bundle.introducesDomainTerms &&
    bundle.glossaryContent.trim().length === 0
  ) {
    return {
      valid: false,
      error_code: "GLOSSARY_MISSING_FOR_DOMAIN_TERMS",
      error_message:
        "GLOSSARY.md is required when domain terms are introduced or refined (ADR-0007).",
      ready_ticket_ids: [],
      blocked_ticket_ids: []
    };
  }

  if (bundle.adrFiles.length === 0) {
    return {
      valid: false,
      error_code: "ADR_MISSING_OR_INCOMPLETE",
      error_message:
        "At least one numbered ADR under docs/adr/NNNN-*.md is required before implementation (ADR-0007).",
      ready_ticket_ids: [],
      blocked_ticket_ids: []
    };
  }

  for (const adr of bundle.adrFiles) {
    if (
      !ADR_PATH_PATTERN.test(adr.path.trim()) ||
      adr.content.trim().length === 0
    ) {
      return {
        valid: false,
        error_code: "ADR_MISSING_OR_INCOMPLETE",
        error_message: `Invalid or empty ADR file '${adr.path}'.`,
        ready_ticket_ids: [],
        blocked_ticket_ids: []
      };
    }
  }

  if (
    !bundle.specPath.trim().startsWith("docs/specs/") ||
    bundle.specContent.trim().length === 0
  ) {
    return {
      valid: false,
      error_code: "SPEC_MISSING_OR_INCOMPLETE",
      error_message:
        "Approved specification under docs/specs/<slug>.md is missing or empty (ADR-0002, ADR-0007).",
      ready_ticket_ids: [],
      blocked_ticket_ids: []
    };
  }

  if (bundle.tickets.length === 0) {
    return {
      valid: false,
      error_code: "TICKET_GRAPH_EMPTY",
      error_message: "Ticket breakdown graph cannot be empty.",
      ready_ticket_ids: [],
      blocked_ticket_ids: []
    };
  }

  if (hasDependencyCycle(bundle.tickets)) {
    return {
      valid: false,
      error_code: "TICKET_GRAPH_CYCLE_DETECTED",
      error_message:
        "Ticket dependency graph contains a cycle; blocked_by edges must form a strict DAG (ADR-0003).",
      ready_ticket_ids: [],
      blocked_ticket_ids: []
    };
  }

  const stateById = new Map<number, "open" | "closed">();
  for (const t of bundle.tickets) {
    stateById.set(t.id, t.state);
  }

  const readyTicketIds: number[] = [];
  const blockedTicketIds: number[] = [];

  for (const t of bundle.tickets) {
    if (t.state === "closed") {
      continue;
    }
    const hasOpenBlocker = t.blockedBy.some(
      (blockerId) => stateById.get(blockerId) !== "closed"
    );
    if (hasOpenBlocker) {
      blockedTicketIds.push(t.id);
    } else {
      readyTicketIds.push(t.id);
    }
  }

  return {
    valid: true,
    error_code: "NONE",
    error_message: "",
    ready_ticket_ids: readyTicketIds,
    blocked_ticket_ids: blockedTicketIds
  };
}
