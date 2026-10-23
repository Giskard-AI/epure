import {
  createInitialIssueState,
  updateIssueStateWithCas,
  type EpureIssueState,
  type GitRefStateStore,
  type IssueOrchestrationPhase,
  type IssueOrchestrationStatus
} from "../state/git-ref-state.js";

export type PlanningSkillName =
  | "grilling"
  | "grilling+domain-modeling"
  | "to-spec"
  | "to-tickets"
  | "unknown";

export type PlanningRouterErrorCode =
  | "NONE"
  | "UNRECOGNIZED_PLANNING_COMMAND"
  | "SPEC_NOT_APPROVED_BY_HUMAN"
  | "CODE_GENERATION_FORBIDDEN_DURING_PLANNING";

export interface PlanningCommandInput {
  readonly issueNumber: number;
  readonly planSlug: string;
  readonly commandText: string;
  readonly specApprovedByHuman: boolean;
  readonly proposedFilesToWrite: readonly string[];
  readonly store: GitRefStateStore;
}

export interface PlanningCommandResult {
  readonly routed: boolean;
  readonly error_code: PlanningRouterErrorCode;
  readonly error_message: string;
  readonly skill: PlanningSkillName;
  readonly plan_branch: string;
  readonly application_code_generated: false;
  readonly state: EpureIssueState;
  readonly issue_mirror_markdown: string;
}

const ALLOWED_PLANNING_PATH_PATTERN =
  /^(?:GLOSSARY\.md|docs\/(?:DECISIONS\.md|adr\/.*\.md|specs\/.*\.md|agents\/.*\.md)|planning\/.*\.(?:md|json))$/;

function parsePlanningSkill(commandText: string): PlanningSkillName {
  const trimmed = commandText.trim();
  if (/^(?:\/epure\s+)?\/?grill-with-docs(?:\s|$)/i.test(trimmed)) {
    return "grilling+domain-modeling";
  }
  if (/^(?:\/epure\s+)?\/?grill-me(?:\s|$)/i.test(trimmed)) {
    return "grilling";
  }
  if (/^(?:\/epure\s+)?\/?to-spec(?:\s|$)/i.test(trimmed)) {
    return "to-spec";
  }
  if (/^(?:\/epure\s+)?\/?to-tickets(?:\s|$)/i.test(trimmed)) {
    return "to-tickets";
  }
  return "unknown";
}

function hasForbiddenApplicationCodePaths(paths: readonly string[]): boolean {
  for (const rawPath of paths) {
    const normalized = rawPath.trim().replace(/^\/+/, "");
    if (!ALLOWED_PLANNING_PATH_PATTERN.test(normalized)) {
      return true;
    }
  }
  return false;
}

export async function routePlanningCommand(
  input: PlanningCommandInput
): Promise<PlanningCommandResult> {
  const planBranch = `plan/${input.issueNumber}-${input.planSlug
    .trim()
    .replace(/^\/+|\/+$/g, "")}`;
  const skill = parsePlanningSkill(input.commandText);
  const initialState = createInitialIssueState(input.issueNumber);

  if (skill === "unknown") {
    return {
      routed: false,
      error_code: "UNRECOGNIZED_PLANNING_COMMAND",
      error_message: `Unrecognized planning command '${input.commandText}'. Expected /grill-me, /grill-with-docs, /to-spec, or /to-tickets.`,
      skill: "unknown",
      plan_branch: planBranch,
      application_code_generated: false,
      state: initialState,
      issue_mirror_markdown: ""
    };
  }

  if (hasForbiddenApplicationCodePaths(input.proposedFilesToWrite)) {
    return {
      routed: false,
      error_code: "CODE_GENERATION_FORBIDDEN_DURING_PLANNING",
      error_message:
        "Application code generation is strictly forbidden during planning phases (/grill-me, /to-spec, /to-tickets) (ADR-0002, ADR-0006).",
      skill,
      plan_branch: planBranch,
      application_code_generated: false,
      state: initialState,
      issue_mirror_markdown: ""
    };
  }

  if (skill === "to-tickets" && !input.specApprovedByHuman) {
    return {
      routed: false,
      error_code: "SPEC_NOT_APPROVED_BY_HUMAN",
      error_message:
        "Cannot transition to /to-tickets before the specification has been explicitly approved by an authorized human (ADR-0002).",
      skill,
      plan_branch: planBranch,
      application_code_generated: false,
      state: initialState,
      issue_mirror_markdown: ""
    };
  }

  let nextPhase: IssueOrchestrationPhase = "grilling";
  let nextStatus: IssueOrchestrationStatus = "active";

  if (skill === "to-spec") {
    nextPhase = "spec";
    nextStatus = "awaiting_human_approval";
  } else if (skill === "to-tickets") {
    nextPhase = "tickets";
    nextStatus = "awaiting_human_approval";
  }

  const casUpdate = await updateIssueStateWithCas({
    issueNumber: input.issueNumber,
    store: input.store,
    mutator: (prev) => ({
      ...prev,
      phase: nextPhase,
      status: nextStatus,
      active_branch: planBranch
    })
  });

  return {
    routed: true,
    error_code: "NONE",
    error_message: "",
    skill,
    plan_branch: planBranch,
    application_code_generated: false,
    state: casUpdate.state,
    issue_mirror_markdown: casUpdate.issue_mirror_markdown
  };
}
