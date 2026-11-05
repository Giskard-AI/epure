import { isBotActor } from "../auth/issue-command-gate.js";
import {
  toTerminalState,
  updateIssueStateWithCas,
  type EpureIssueState,
  type GitRefStateStore
} from "./git-ref-state.js";

export interface IncomingIssueComment {
  readonly id: number;
  readonly authorLogin: string;
  readonly authorType: "User" | "Bot" | string;
  readonly effectivePermission: "admin" | "maintain" | "write" | "triage" | "read" | "none";
  readonly body: string;
}

export interface ProcessPendingIssueCommentsInput {
  readonly issueNumber: number;
  readonly store: GitRefStateStore;
  readonly initialCursor?: number | undefined;
  readonly fetchCommentsSinceCursor: (
    cursor: number
  ) => Promise<readonly IncomingIssueComment[]>;
}

export interface ProcessPendingIssueCommentsResult {
  readonly processed_comment_ids: readonly number[];
  readonly processed_bodies: readonly string[];
  readonly last_processed_comment_id: number;
  readonly cancelled: boolean;
  readonly state: EpureIssueState;
}

const CANCEL_OR_STOP_PATTERN =
  /(?:^|\s)\/epure\s+(?:cancel|stop)(?:\s|$)/i;

function isAuthorizedHumanComment(comment: IncomingIssueComment): boolean {
  if (isBotActor({ login: comment.authorLogin, type: comment.authorType })) {
    return false;
  }
  return (
    comment.effectivePermission === "admin" ||
    comment.effectivePermission === "maintain" ||
    comment.effectivePermission === "write"
  );
}

export const RESUME_CONTEXT_MAX_COMMENTS = 10;
export const RESUME_CONTEXT_MAX_CHARS = 8000;
const EPURE_COMMAND_PATTERN = /^\s*\/epure\b/i;

export interface ResumeContextCandidate {
  readonly id: number;
  readonly authorLogin: string;
  readonly authorType: string;
  readonly body: string;
}

/**
 * Selects the human guidance injected into a resumed implementation session: comments posted
 * after `afterCommentId` and before the resume command, by authors with `write` or higher,
 * excluding `/epure` commands and bots. Keeps the most recent ones within both caps, oldest first.
 */
export async function selectResumeContextComments(input: {
  readonly comments: readonly ResumeContextCandidate[];
  readonly afterCommentId: number;
  readonly resumeCommentId: number;
  readonly resolvePermission: (
    login: string
  ) => Promise<IncomingIssueComment["effectivePermission"]>;
}): Promise<readonly IncomingIssueComment[]> {
  const candidates = input.comments
    .filter(
      (c) =>
        c.id > input.afterCommentId &&
        c.id < input.resumeCommentId &&
        !EPURE_COMMAND_PATTERN.test(c.body) &&
        !isBotActor({ login: c.authorLogin, type: c.authorType })
    )
    .sort((a, b) => b.id - a.id);

  const permissions = new Map<string, IncomingIssueComment["effectivePermission"]>();
  const selected: IncomingIssueComment[] = [];
  let remainingChars = RESUME_CONTEXT_MAX_CHARS;
  for (const candidate of candidates) {
    if (selected.length === RESUME_CONTEXT_MAX_COMMENTS || remainingChars <= 0) {
      break;
    }
    if (!permissions.has(candidate.authorLogin)) {
      permissions.set(
        candidate.authorLogin,
        await input.resolvePermission(candidate.authorLogin)
      );
    }
    const comment: IncomingIssueComment = {
      ...candidate,
      effectivePermission: permissions.get(candidate.authorLogin)!,
      body: candidate.body.trim().slice(0, remainingChars)
    };
    if (isAuthorizedHumanComment(comment)) {
      selected.push(comment);
      remainingChars -= comment.body.length;
    }
  }
  return selected.reverse();
}

export function formatResumeContextMarkdown(
  comments: readonly IncomingIssueComment[]
): string {
  return comments
    .map((c) => `@${c.authorLogin} (commentaire ${c.id}) :\n${c.body}`)
    .join("\n\n");
}

export async function processPendingIssueCommentsBatch(
  input: ProcessPendingIssueCommentsInput
): Promise<ProcessPendingIssueCommentsResult> {
  if (typeof input.initialCursor === "number" && input.initialCursor > 0) {
    await updateIssueStateWithCas({
      issueNumber: input.issueNumber,
      store: input.store,
      mutator: (prev) => ({
        ...prev,
        last_processed_comment_id: Math.max(
          prev.last_processed_comment_id,
          input.initialCursor ?? 0
        )
      })
    });
  }

  const processedIds: number[] = [];
  const processedBodies: string[] = [];
  let cursor = input.initialCursor ?? 0;
  let cancelled = false;
  let latestStateResult = await updateIssueStateWithCas({
    issueNumber: input.issueNumber,
    store: input.store,
    mutator: (prev) => prev
  });

  // Up to 3 passes to cover initial batch + final race check before exiting the run
  for (let pass = 0; pass < 3; pass += 1) {
    const rawComments = await input.fetchCommentsSinceCursor(cursor);
    const unseen = rawComments
      .filter((c) => c.id > cursor)
      .sort((a, b) => a.id - b.id);

    if (unseen.length === 0) {
      break;
    }

    const maxSeenId = unseen[unseen.length - 1]?.id ?? cursor;
    const authorized = unseen.filter(isAuthorizedHumanComment);

    const cancelComment = authorized.find((c) =>
      CANCEL_OR_STOP_PATTERN.test(c.body)
    );

    if (cancelComment) {
      processedIds.push(cancelComment.id);
      processedBodies.push(cancelComment.body);
      cursor = maxSeenId;
      cancelled = true;

      latestStateResult = await updateIssueStateWithCas({
        issueNumber: input.issueNumber,
        store: input.store,
        mutator: (prev) =>
          toTerminalState(prev, {
            status: "cancelled",
            last_processed_comment_id: cursor
          })
      });
      break;
    }

    for (const comment of authorized) {
      processedIds.push(comment.id);
      processedBodies.push(comment.body);
    }

    cursor = maxSeenId;
    latestStateResult = await updateIssueStateWithCas({
      issueNumber: input.issueNumber,
      store: input.store,
      mutator: (prev) => ({
        ...prev,
        status: "active",
        last_processed_comment_id: cursor
      })
    });
  }

  return {
    processed_comment_ids: processedIds,
    processed_bodies: processedBodies,
    last_processed_comment_id: cursor,
    cancelled,
    state: latestStateResult.state
  };
}
