import type {
  EpureIssueState,
  PlanManifestRecord,
  SpecManifestRecord
} from "../state/git-ref-state.js";
import type { EpicGoalContract } from "./prompts/schemas.js";
import type {
  GitHubAppRef,
  IssueCommentRecord,
  IssueMetadata,
  TrackedTicketCommentMetadata
} from "./types.js";

/** GitHub Actions' App: it authors what EPURE writes with the fallback `GITHUB_TOKEN`. */
export const GITHUB_ACTIONS_APP_ID = 15368;

/** The GitHub App EPURE writes as: only its comments and issues are EPURE's. */
export interface EpureIdentity {
  readonly appId: number;
}

export function isEpureAuthored(
  item: { readonly performed_via_github_app?: GitHubAppRef | null | undefined },
  identity: EpureIdentity
): boolean {
  return item.performed_via_github_app?.id === identity.appId;
}

/** JSON for an HTML comment: `--` inside a string would end the comment early. */
export function embedManifestJson(manifest: unknown): string {
  return JSON.stringify(manifest).replace(/--/g, "-\\u002d");
}

function latestEpureManifests(
  comments: readonly IssueCommentRecord[],
  marker: "epure-plan-manifest" | "epure-spec-manifest",
  identity: EpureIdentity
): unknown[] {
  const pattern = new RegExp(`<!-- ${marker}:([\\s\\S]*?)-->`);
  const manifests: unknown[] = [];
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const comment = comments[i];
    const json = comment && isEpureAuthored(comment, identity)
      ? pattern.exec(comment.body)?.[1]?.trim()
      : undefined;
    if (json) {
      try {
        manifests.push(JSON.parse(json));
      } catch {
        // A truncated or edited manifest: try an older one.
      }
    }
  }
  return manifests;
}

/** States written before `plan_manifest` only have the manifest in an EPURE comment. */
export function parsePlanManifestFromComments(
  comments: readonly IssueCommentRecord[],
  identity: EpureIdentity
): PlanManifestRecord | null {
  for (const raw of latestEpureManifests(comments, "epure-plan-manifest", identity)) {
    const parsed = raw as {
      planBranch?: unknown;
      specPath?: unknown;
      epicGoalContract?: EpicGoalContract;
      tickets?: TrackedTicketCommentMetadata[];
    };
    if (Array.isArray(parsed.tickets) && parsed.tickets.length > 0) {
      return {
        planBranch: typeof parsed.planBranch === "string" ? parsed.planBranch : "",
        ...(typeof parsed.specPath === "string" ? { specPath: parsed.specPath } : {}),
        ...(parsed.epicGoalContract ? { epicGoalContract: parsed.epicGoalContract } : {}),
        tickets: parsed.tickets
      };
    }
  }
  return null;
}

/** States written before `spec_manifest` only have the manifest in an EPURE comment. */
export function parseSpecManifestFromComments(
  comments: readonly IssueCommentRecord[],
  identity: EpureIdentity
): SpecManifestRecord | null {
  for (const raw of latestEpureManifests(comments, "epure-spec-manifest", identity)) {
    const parsed = raw as Partial<Record<keyof SpecManifestRecord, unknown>>;
    if (
      typeof parsed.planBranch === "string" &&
      typeof parsed.specPath === "string" &&
      Array.isArray(parsed.adrPaths)
    ) {
      const strings = (values: unknown): string[] =>
        Array.isArray(values)
          ? values.filter((v): v is string => typeof v === "string")
          : [];
      return {
        planBranch: parsed.planBranch,
        specPath: parsed.specPath,
        adrPaths: strings(parsed.adrPaths),
        targetFilesHint: strings(parsed.targetFilesHint),
        ...(parsed.epicGoalContract
          ? { epicGoalContract: parsed.epicGoalContract as EpicGoalContract }
          : {})
      };
    }
  }
  return null;
}

export function resolveSpecManifest(
  state: EpureIssueState | null,
  comments: readonly IssueCommentRecord[],
  identity: EpureIdentity
): SpecManifestRecord | null {
  return state?.spec_manifest ?? parseSpecManifestFromComments(comments, identity);
}

export type PlanManifestResolution =
  | {
      readonly kind: "recorded";
      readonly manifest: PlanManifestRecord;
      // Read from a legacy EPURE comment: the next state write stores it.
      readonly fromLegacyComment: boolean;
    }
  | { readonly kind: "missing"; readonly reason: string }
  | { readonly kind: "none" };

const TICKETS_TASKLIST_MARKER = "<!-- epure-tickets-tasklist:start -->";

/**
 * Approve and continue implement the recorded manifest. The issue body stands in for it only
 * when no manifest was ever produced: a manifest that is recorded but unreadable is `missing`.
 */
export function resolvePlanManifest(params: {
  readonly state: EpureIssueState | null;
  readonly comments: readonly IssueCommentRecord[];
  readonly identity: EpureIdentity;
  readonly epicBody: string;
}): PlanManifestResolution {
  const recorded = params.state?.plan_manifest;
  if (recorded) {
    return recorded.superseded
      ? {
          kind: "missing",
          reason:
            "the last `/epure to-tickets` stopped while it regenerated the ticket graph: the recorded tickets are superseded"
        }
      : { kind: "recorded", manifest: recorded, fromLegacyComment: false };
  }
  const legacy = parsePlanManifestFromComments(params.comments, params.identity);
  if (legacy) {
    return { kind: "recorded", manifest: legacy, fromLegacyComment: true };
  }
  return params.state?.phase === "tickets" ||
    params.epicBody.includes(TICKETS_TASKLIST_MARKER)
    ? {
        kind: "missing",
        reason:
          "a ticket graph was generated for this plan, but no manifest written by EPURE's GitHub App was found in the state ref or the issue comments"
      }
    : { kind: "none" };
}

/** `/epure to-tickets` closes only open issues EPURE created as tickets of this plan. */
export function isSupersedableTicket(
  ticket: IssueMetadata,
  parentIssueNumber: number,
  identity: EpureIdentity
): boolean {
  return (
    ticket.is_pull_request !== true &&
    ticket.state === "open" &&
    isEpureAuthored(ticket, identity) &&
    ticket.body.split("\n", 1)[0]?.trim() === `Parent Plan: #${parentIssueNumber}`
  );
}
