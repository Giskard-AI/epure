import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentEngineError,
  type FileMode,
  type SkippedPathReason,
  type WorktreeDiff
} from "./engine.js";

export interface WorktreeDiffLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export const DEFAULT_WORKTREE_DIFF_LIMITS: WorktreeDiffLimits = {
  maxFiles: 500,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 10 * 1024 * 1024
};

// Untracked dependency and build output is never committed, even without a .gitignore; it stays in the worktree as a cache.
export const DEFAULT_UNTRACKED_EXCLUDES: readonly string[] = [
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  ".venv/",
  "__pycache__/",
  "target/",
  "*.tsbuildinfo"
];
const CACHE_DIR_NAMES = new Set(DEFAULT_UNTRACKED_EXCLUDES.filter((p) => p.endsWith("/")).map((p) => p.slice(0, -1)));

export interface SnapshotWorktreeOptions {
  // Paths the checkout's repository tracks: kept in the diff even when a .gitignore matches them.
  readonly trackedPaths?: readonly string[] | undefined;
  readonly isProtectedPath?: ((path: string) => boolean) | undefined;
  readonly limits?: WorktreeDiffLimits | undefined;
}

export interface WorktreeSnapshot {
  // Changes since the snapshot. Skipped paths are put back to their snapshot state and new ignored files
  // outside the default excludes are removed, so the worktree then holds the snapshot plus the diff.
  collect(): Promise<WorktreeDiff>;
  dispose(): void;
}

const GIT_TIMEOUT_MS = 120_000;
const MAX_GIT_OUTPUT_BYTES = 256 * 1024 * 1024;
const GIT_STDERR_TAIL_CHARS = 2000;

// The agent can write the worktree's own .git (hooks, fsmonitor, filters), so it is never used:
// snapshots live in a private git dir, with no system, global or repository config read.
function gitRunner(gitDir: string, worktree: string, extraEnv: Readonly<Record<string, string>> = {}) {
  return (args: readonly string[], input = ""): Promise<Buffer> =>
    new Promise((resolvePromise, reject) => {
      const fail = (why: string): void =>
        reject(new AgentEngineError("AGENT_SNAPSHOT_FAILED", `Worktree snapshot: git ${args[0] ?? ""} ${why}`));
      const child = spawn(
        "git",
        [
          "-c", "core.hooksPath=/dev/null",
          "-c", "core.fsmonitor=false",
          "-c", "core.autocrlf=false",
          "-c", "core.symlinks=true",
          `--git-dir=${gitDir}`,
          `--work-tree=${worktree}`,
          ...args
        ],
        {
          cwd: worktree,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: gitDir,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_LITERAL_PATHSPECS: "1",
            ...extraEnv
          },
          stdio: ["pipe", "pipe", "pipe"]
        }
      );
      const out: Buffer[] = [];
      let outBytes = 0;
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        fail(`timed out after ${GIT_TIMEOUT_MS} ms`);
      }, GIT_TIMEOUT_MS);
      child.stdout.on("data", (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes > MAX_GIT_OUTPUT_BYTES) {
          child.kill("SIGKILL");
          fail("output exceeded its cap");
          return;
        }
        out.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-GIT_STDERR_TAIL_CHARS);
      });
      child.stdin.on("error", () => {
        // git exited before reading its input; its exit code reports why
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        fail(`could not run: ${err.message}`);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolvePromise(Buffer.concat(out));
        } else {
          fail(`exited with code ${code ?? "?"}: ${stderr.trim()}`);
        }
      });
      child.stdin.end(input);
    });
}

// Reads the checkout's index as data (no repository config): call it before any session writes the worktree.
export async function listTrackedPaths(worktree: string): Promise<string[]> {
  const index = join(worktree, ".git", "index");
  if (!existsSync(index)) {
    return [];
  }
  const gitDir = mkdtempSync(join(tmpdir(), "epure-tracked-"));
  try {
    const git = gitRunner(gitDir, worktree, { GIT_INDEX_FILE: index });
    await git(["init", "--quiet"]);
    return splitNul(await git(["ls-files", "-z"]));
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
  }
}

export async function snapshotWorktree(
  worktree: string,
  options: SnapshotWorktreeOptions = {}
): Promise<WorktreeSnapshot> {
  const gitDir = mkdtempSync(join(tmpdir(), "epure-snapshot-"));
  const git = gitRunner(gitDir, worktree);
  const limits = options.limits ?? DEFAULT_WORKTREE_DIFF_LIMITS;
  const isProtected = options.isProtectedPath ?? (() => false);
  const listIgnored = async (): Promise<Set<string>> =>
    new Set(splitNul(await git(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"])));

  let before = "";
  let ignoredBefore = new Set<string>();
  try {
    await git(["init", "--quiet"]);
    mkdirSync(join(gitDir, "info"), { recursive: true });
    writeFileSync(join(gitDir, "info", "exclude"), `${DEFAULT_UNTRACKED_EXCLUDES.join("\n")}\n`);
    await git(["add", "--all"]);
    const tracked = (options.trackedPaths ?? []).filter((p) => isFileOrSymlink(join(worktree, p)));
    if (tracked.length > 0) {
      await git(["add", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"], tracked.join("\0"));
    }
    before = (await git(["write-tree"])).toString("utf8").trim();
    ignoredBefore = await listIgnored();
  } catch (err) {
    rmSync(gitDir, { recursive: true, force: true });
    throw err;
  }

  return {
    async collect(): Promise<WorktreeDiff> {
      // Paths already in the private index stay tracked by `add --all`, ignored or not.
      await git(["add", "--all"]);
      const after = (await git(["write-tree"])).toString("utf8").trim();
      const entries = parseDiffTree(await git(["diff-tree", "-r", "-z", "--no-renames", before, after]));

      const skipped: Array<{ path: string; reason: SkippedPathReason; existedBefore: boolean }> = [];
      const deleted: string[] = [];
      const candidates: DiffTreeEntry[] = [];
      for (const entry of entries) {
        const existedBefore = entry.status !== "A";
        if (isProtected(entry.path)) {
          skipped.push({ path: entry.path, reason: "protected", existedBefore });
        } else if (entry.status === "D") {
          deleted.push(entry.path);
        } else if (entry.newMode === "120000") {
          skipped.push({ path: entry.path, reason: "symlink", existedBefore });
        } else if (entry.newMode === "160000") {
          skipped.push({ path: entry.path, reason: "submodule", existedBefore });
        } else {
          candidates.push(entry);
        }
      }

      if (candidates.length + deleted.length > limits.maxFiles) {
        throw new AgentEngineError(
          "AGENT_DIFF_TOO_LARGE",
          `The session changed ${candidates.length + deleted.length} files; at most ${limits.maxFiles} are accepted.`
        );
      }
      const sizes = await blobSizes(git, candidates.map((c) => c.newSha));
      let totalBytes = 0;
      for (const [i, entry] of candidates.entries()) {
        const size = sizes[i] ?? 0;
        if (size > limits.maxFileBytes) {
          throw new AgentEngineError(
            "AGENT_DIFF_TOO_LARGE",
            `The session left ${entry.path} at ${size} bytes; at most ${limits.maxFileBytes} bytes per file are accepted.`
          );
        }
        totalBytes += size;
      }
      if (totalBytes > limits.maxTotalBytes) {
        throw new AgentEngineError(
          "AGENT_DIFF_TOO_LARGE",
          `The session changed ${totalBytes} bytes; at most ${limits.maxTotalBytes} bytes are accepted.`
        );
      }

      const files: Array<{ path: string; content: string; mode: FileMode }> = [];
      const blobs = await blobContents(git, candidates.map((c) => c.newSha));
      for (const [i, entry] of candidates.entries()) {
        const text = decodeText(blobs[i] ?? Buffer.alloc(0));
        if (text === undefined) {
          skipped.push({ path: entry.path, reason: "binary", existedBefore: entry.status !== "A" });
        } else {
          files.push({ path: entry.path, content: text, mode: entry.newMode === "100755" ? "100755" : "100644" });
        }
      }

      for (const path of await listIgnored()) {
        if (!ignoredBefore.has(path) && !isDefaultExcluded(path)) {
          skipped.push({ path: path.replace(/\/$/, ""), reason: "ignored", existedBefore: false });
        }
      }

      for (const s of skipped) {
        removeInsideWorktree(worktree, s.path);
      }
      const restore = skipped.filter((s) => s.existedBefore).map((s) => s.path);
      if (restore.length > 0) {
        await git(["checkout", before, "--pathspec-from-file=-", "--pathspec-file-nul"], restore.join("\0"));
      }

      return {
        files,
        deleted_files: deleted,
        skipped: skipped.map(({ path, reason }) => ({ path, reason }))
      };
    },
    dispose(): void {
      rmSync(gitDir, { recursive: true, force: true });
    }
  };
}

interface DiffTreeEntry {
  readonly newMode: string;
  readonly newSha: string;
  readonly status: string;
  readonly path: string;
}

function parseDiffTree(raw: Buffer): DiffTreeEntry[] {
  const fields = splitNul(raw);
  const entries: DiffTreeEntry[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, newMode = "", , newSha = "", status = ""] = (fields[i] ?? "").split(" ");
    entries.push({ newMode, newSha, status, path: fields[i + 1] ?? "" });
  }
  return entries;
}

async function blobSizes(git: ReturnType<typeof gitRunner>, shas: readonly string[]): Promise<number[]> {
  if (shas.length === 0) {
    return [];
  }
  const out = (await git(["cat-file", "--batch-check=%(objectsize)"], `${shas.join("\n")}\n`)).toString("utf8");
  return out.split("\n").slice(0, shas.length).map((line) => Number.parseInt(line, 10));
}

// `cat-file --batch` prints "<sha> <type> <size>\n<content>\n" per object.
async function blobContents(git: ReturnType<typeof gitRunner>, shas: readonly string[]): Promise<Buffer[]> {
  if (shas.length === 0) {
    return [];
  }
  const out = await git(["cat-file", "--batch"], `${shas.join("\n")}\n`);
  const blobs: Buffer[] = [];
  let offset = 0;
  for (let i = 0; i < shas.length; i += 1) {
    const headerEnd = out.indexOf(10, offset);
    const size = Number.parseInt(out.subarray(offset, headerEnd).toString("utf8").split(" ")[2] ?? "0", 10);
    blobs.push(out.subarray(headerEnd + 1, headerEnd + 1 + size));
    offset = headerEnd + 1 + size + 1;
  }
  return blobs;
}

function decodeText(blob: Buffer): string | undefined {
  if (blob.includes(0)) {
    return undefined;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(blob);
  } catch {
    return undefined;
  }
}

function splitNul(raw: Buffer): string[] {
  return raw.toString("utf8").split("\0").filter((field) => field.length > 0);
}

function isFileOrSymlink(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isDefaultExcluded(path: string): boolean {
  const isDir = path.endsWith("/");
  const segments = path.replace(/\/$/, "").split("/");
  const dirs = isDir ? segments : segments.slice(0, -1);
  return dirs.some((s) => CACHE_DIR_NAMES.has(s)) || (!isDir && path.endsWith(".tsbuildinfo"));
}

// Never follows a symlinked parent out of the worktree.
function removeInsideWorktree(worktree: string, relPath: string): void {
  const segments = relPath.split("/");
  let current = worktree;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        return;
      }
    } catch {
      return;
    }
  }
  rmSync(join(worktree, relPath), { recursive: true, force: true });
}
