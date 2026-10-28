import {
  discoverVerificationProfile,
  type VerificationProfile
} from "../../bootstrap/ci-and-renovate.js";
import type {
  SandboxExecutionInput,
  SandboxExecutionResult
} from "../../sandbox/llm-sandbox.js";
import {
  isSensitiveTaskBranchPath,
  runPolyglotStage1Verification
} from "../../sandbox/polyglot-workspace-runner.js";
import { wrapUntrustedContent } from "../../security/prompt-injection-guard.js";
import type {
  GeminiFunctionDeclaration,
  GeminiToolHandler
} from "../gemini-client.js";
import type {
  GeneratedTicketImplementation,
  GitHubRestHelper,
  IssueCommentRecord,
  TrackedTicketCommentMetadata
} from "../types.js";

export async function applyTicketImplementationPayload(params: {
  readonly parsed: GeneratedTicketImplementation;
  readonly accumulatedFiles: Map<string, string>;
  readonly featureChangedFilesMap: Map<string, string>;
  readonly ticketChangedFilesMap: Map<string, string>;
  readonly featureDeletedFilesSet?: Set<string> | undefined;
  readonly ticketDeletedFilesSet?: Set<string> | undefined;
  readonly gh: GitHubRestHelper;
  readonly branch: string;
}): Promise<Array<{ path: string; content: string }>> {
  for (const f of params.parsed.files ?? []) {
    const cleanPath = f.path.replace(/^\/+/, "");
    params.accumulatedFiles.set(cleanPath, f.content);
    params.featureChangedFilesMap.set(cleanPath, f.content);
    params.ticketChangedFilesMap.set(cleanPath, f.content);
    params.featureDeletedFilesSet?.delete(cleanPath);
    params.ticketDeletedFilesSet?.delete(cleanPath);
  }

  for (const del of params.parsed.deleted_files ?? []) {
    const cleanPath = del.replace(/^\/+/, "");
    params.accumulatedFiles.delete(cleanPath);
    params.featureChangedFilesMap.delete(cleanPath);
    params.ticketChangedFilesMap.delete(cleanPath);
    params.featureDeletedFilesSet?.add(cleanPath);
    params.ticketDeletedFilesSet?.add(cleanPath);
  }

  for (const patch of params.parsed.patches ?? []) {
    const cleanPath = patch.path.replace(/^\/+/, "");
    let baseContent = params.accumulatedFiles.get(cleanPath) ?? null;
    if (baseContent === null) {
      baseContent = await params.gh.readSingleBranchFile(
        params.branch,
        cleanPath
      );
    }
    if (baseContent === null) {
      continue;
    }
    let updatedContent = baseContent;
    let appliedAny = false;
    for (const edit of patch.edits ?? []) {
      const oldStr = edit.old_string || edit.search || "";
      const newStr = edit.new_string ?? edit.replace ?? "";
      if (!oldStr) {
        continue;
      }
      if (updatedContent.includes(oldStr)) {
        updatedContent = updatedContent.replace(oldStr, newStr);
        appliedAny = true;
        continue;
      }
      const normalizedOld = oldStr.replace(/\r\n/g, "\n").trim();
      const normalizedDoc = updatedContent.replace(/\r\n/g, "\n");
      if (normalizedOld && normalizedDoc.includes(normalizedOld)) {
        updatedContent = normalizedDoc.replace(
          normalizedOld,
          newStr.replace(/\r\n/g, "\n").trim()
        );
        appliedAny = true;
      } else if (process.env.GITHUB_ACTIONS === "true") {
        process.stdout.write(
          `[EPURE][Patch] Warning: edit old_string (${oldStr.length} chars) did not match in ${cleanPath}\n`
        );
      }
    }
    if (!appliedAny && (patch.edits?.length ?? 0) > 0) {
      continue;
    }
    params.accumulatedFiles.set(cleanPath, updatedContent);
    params.featureChangedFilesMap.set(cleanPath, updatedContent);
    params.ticketChangedFilesMap.set(cleanPath, updatedContent);
    params.featureDeletedFilesSet?.delete(cleanPath);
    params.ticketDeletedFilesSet?.delete(cleanPath);
  }

  return Array.from(params.ticketChangedFilesMap.entries()).map(
    ([path, content]) => ({ path, content })
  );
}

export function parseTrackedTicketsFromComments(
  comments: readonly IssueCommentRecord[]
): TrackedTicketCommentMetadata[] {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const body = comments[i]?.body ?? "";
    const match = /<!-- epure-plan-manifest:([\s\S]*?)-->/.exec(body);
    if (match?.[1]) {
      try {
        const parsed = JSON.parse(match[1].trim()) as {
          tickets?: TrackedTicketCommentMetadata[];
        };
        if (Array.isArray(parsed.tickets) && parsed.tickets.length > 0) {
          return parsed.tickets;
        }
      } catch {
        // continue
      }
    }
  }
  return [];
}

export async function runTestsInIsolatedWorkspace(params: {
  readonly files: ReadonlyArray<{ path: string; content: string }>;
  readonly deleted_files?: readonly string[] | undefined;
  readonly changedPaths?: readonly string[] | undefined;
  readonly isTaskBranch?: boolean | undefined;
  readonly verificationProfile?: VerificationProfile | undefined;
  readonly workDir?: string | undefined;
  readonly bootstrappedTargets?: Set<string> | undefined;
  readonly sandboxRunner?:
    | ((input: SandboxExecutionInput) => Promise<SandboxExecutionResult>)
    | undefined;
  readonly llmApiKey: string;
  readonly label?: string | undefined;
}): Promise<{
  readonly passed: boolean;
  readonly output: string;
  readonly blocked_by_security_gate?: boolean;
  readonly sensitive_paths?: readonly string[];
  readonly traversal_paths?: readonly string[];
}> {
  const isGha = process.env.GITHUB_ACTIONS === "true";
  const groupTitle = params.label
    ? `[EPURE][Sandbox] ${params.label}`
    : "[EPURE][Sandbox] Verify Polyglot Stage 1 Suite";
  if (isGha) {
    process.stdout.write(`::group::${groupTitle}\n`);
  }
  try {
    const profile =
      params.verificationProfile ??
      discoverVerificationProfile({
        targetFilesHint: params.files.map((f) => f.path)
      });

    const stage1Result = await runPolyglotStage1Verification({
      workDir: params.workDir,
      profile,
      files: params.files,
      deleted_files: params.deleted_files,
      changedPaths: params.changedPaths,
      isTaskBranch: params.isTaskBranch,
      llmApiKey: params.llmApiKey,
      bootstrappedTargets: params.bootstrappedTargets,
      sandboxRunner: params.sandboxRunner,
      label: params.label
    });

    if (isGha) {
      process.stdout.write(
        `[EPURE][Sandbox] Stage 1 -> ${stage1Result.passed ? "PASSED" : "FAILED"}\n${stage1Result.output.slice(-4000)}\n`
      );
    }

    return {
      passed: stage1Result.passed,
      output: stage1Result.output,
      blocked_by_security_gate: stage1Result.blocked_by_security_gate,
      sensitive_paths: stage1Result.sensitive_paths,
      traversal_paths: stage1Result.traversal_paths
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isGha) {
      process.stdout.write(`[EPURE][Sandbox] ERROR: ${msg}\n`);
    }
    return { passed: false, output: msg };
  } finally {
    if (isGha) {
      process.stdout.write("::endgroup::\n");
    }
  }
}

export function checkIsBrownfieldSubpackageRepo(
  accumulatedFiles: ReadonlyMap<string, string>,
  devBranchPaths: readonly string[]
): boolean {
  return (
    (accumulatedFiles.size > 0 &&
      !accumulatedFiles.has("package.json") &&
      Array.from(accumulatedFiles.keys()).some(
        (k) => k.startsWith("backend/") || k.startsWith("frontend/")
      )) ||
    (!devBranchPaths.includes("package.json") &&
      devBranchPaths.some(
        (k) => k.startsWith("backend/") || k.startsWith("frontend/")
      ))
  );
}

export function buildRepoExplorationToolsAndHandlers(params: {
  readonly branch: string;
  readonly featureBranch: string;
  readonly accumulatedFiles: Map<string, string>;
  readonly devBranchPaths: readonly string[];
  readonly gh: GitHubRestHelper;
}): {
  readonly tools?: readonly GeminiFunctionDeclaration[];
  readonly toolHandlers?: Readonly<Record<string, GeminiToolHandler>>;
} {
  if (
    !checkIsBrownfieldSubpackageRepo(
      params.accumulatedFiles,
      params.devBranchPaths
    ) &&
    process.env.GITHUB_ACTIONS !== "true"
  ) {
    return {};
  }

  return {
    tools: [
      {
        name: "list_repo_files",
        description:
          "Search file paths in the repository matching a substring or keyword (e.g. 'toast', 'fog', 'CampaignContext', 'sessionStore').",
        parameters: {
          type: "OBJECT" as const,
          properties: {
            query: {
              type: "STRING" as const,
              description: "Case-insensitive path substring to match"
            }
          },
          required: ["query"]
        }
      },
      {
        name: "search_in_repo_file",
        description:
          "Search for a substring inside a repository file and return matching line numbers with surrounding lines.",
        parameters: {
          type: "OBJECT" as const,
          properties: {
            path: {
              type: "STRING" as const,
              description: "Repository-relative file path"
            },
            query: {
              type: "STRING" as const,
              description: "Substring or identifier to search for"
            }
          },
          required: ["path", "query"]
        }
      },
      {
        name: "read_repo_file",
        description:
          "Read a file (or line range start_line..end_line) from the repository branch.",
        parameters: {
          type: "OBJECT" as const,
          properties: {
            path: {
              type: "STRING" as const,
              description: "Repository-relative file path"
            },
            start_line: {
              type: "INTEGER" as const,
              description: "Optional 1-based start line"
            },
            end_line: {
              type: "INTEGER" as const,
              description: "Optional 1-based end line"
            }
          },
          required: ["path"]
        }
      }
    ],
    toolHandlers: {
      list_repo_files: async (args: Readonly<Record<string, unknown>>) => {
        const rawQuery = String(args.query ?? "")
          .trim()
          .toLowerCase();
        const q =
          rawQuery === "*" ||
          rawQuery === "**" ||
          rawQuery === "." ||
          rawQuery === "./"
            ? ""
            : rawQuery;
        const queryTokens = q.split("*").filter(Boolean);
        let allPaths = await params.gh.listBranchPaths(params.branch);
        if (allPaths.length === 0 && params.branch !== params.featureBranch) {
          allPaths = await params.gh.listBranchPaths(params.featureBranch);
        }
        const matches = allPaths
          .filter((p) => {
            const lower = p.toLowerCase();
            return queryTokens.length === 0
              ? true
              : queryTokens.every((token) => lower.includes(token));
          })
          .slice(0, 60);
        return { matches };
      },
      search_in_repo_file: async (args: Readonly<Record<string, unknown>>) => {
        const p = String(args.path ?? "")
          .trim()
          .replace(/^\/+/, "");
        if (!p || p.includes("..") || isSensitiveTaskBranchPath(p)) {
          return { error: `Access denied or invalid path: ${p}` };
        }
        const q = String(args.query ?? "").trim();
        let content = params.accumulatedFiles.get(p) ?? null;
        if (content === null) {
          content =
            (await params.gh.readSingleBranchFile(params.branch, p)) ??
            (params.branch !== params.featureBranch
              ? await params.gh.readSingleBranchFile(params.featureBranch, p)
              : null);
          if (content !== null) {
            params.accumulatedFiles.set(p, content);
          }
        }
        if (content === null) {
          return { error: `File not found: ${p}` };
        }
        const lines = content.split("\n");
        const snippets: string[] = [];
        for (let i = 0; i < lines.length; i += 1) {
          if (lines[i]!.toLowerCase().includes(q.toLowerCase())) {
            const start = Math.max(0, i - 15);
            const end = Math.min(lines.length, i + 20);
            snippets.push(
              wrapUntrustedContent(
                "untrusted_workspace_files",
                `Lines ${start + 1}-${end}:\n` +
                  lines
                    .slice(start, end)
                    .map((l, idx) => `${start + idx + 1}| ${l}`)
                    .join("\n")
              )
            );
            i = end - 1;
            if (snippets.length >= 8) {
              break;
            }
          }
        }
        return {
          path: p,
          total_lines: lines.length,
          matches: snippets
        };
      },
      read_repo_file: async (args: Readonly<Record<string, unknown>>) => {
        const p = String(args.path ?? "")
          .trim()
          .replace(/^\/+/, "");
        if (!p || p.includes("..") || isSensitiveTaskBranchPath(p)) {
          return { error: `Access denied or invalid path: ${p}` };
        }
        let content = params.accumulatedFiles.get(p) ?? null;
        if (content === null) {
          content =
            (await params.gh.readSingleBranchFile(params.branch, p)) ??
            (params.branch !== params.featureBranch
              ? await params.gh.readSingleBranchFile(params.featureBranch, p)
              : null);
          if (content !== null) {
            params.accumulatedFiles.set(p, content);
          }
        }
        if (content === null) {
          return { error: `File not found: ${p}` };
        }
        const lines = content.split("\n");
        const startLine = Math.max(1, Number(args.start_line ?? 1) || 1);
        const endLine = Math.min(
          lines.length,
          Number(
            args.end_line ?? Math.min(lines.length, startLine + 250)
          ) || lines.length
        );
        return {
          path: p,
          total_lines: lines.length,
          start_line: startLine,
          end_line: endLine,
          content: wrapUntrustedContent(
            "untrusted_workspace_files",
            lines.slice(startLine - 1, endLine).join("\n")
          )
        };
      }
    }
  };
}
