import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface WorktreeDiff {
  readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>;
  readonly deleted_files: readonly string[];
}

export interface WorktreeSnapshot {
  // Changes since the snapshot, honouring .gitignore; symlinks, submodules and binary files are left out.
  diff(): WorktreeDiff;
  dispose(): void;
}

const MAX_GIT_OUTPUT_BYTES = 256 * 1024 * 1024;

// The agent can write the worktree's own .git (hooks, fsmonitor, filters), so it is never used:
// snapshots live in a private git dir, with no system, global or repository config read.
export function snapshotWorktree(worktree: string): WorktreeSnapshot {
  const gitDir = mkdtempSync(join(tmpdir(), "epure-snapshot-"));
  const git = (args: readonly string[]): Buffer =>
    execFileSync(
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
          GIT_CONFIG_GLOBAL: "/dev/null"
        },
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: MAX_GIT_OUTPUT_BYTES
      }
    );
  const writeTree = (): string => {
    git(["add", "--all"]);
    return git(["write-tree"]).toString("utf8").trim();
  };

  git(["init", "--quiet"]);
  const before = writeTree();

  return {
    diff(): WorktreeDiff {
      const after = writeTree();
      const raw = git(["diff-tree", "-r", "-z", "--no-renames", before, after]).toString("utf8");
      const files: Array<{ path: string; content: string }> = [];
      const deleted: string[] = [];
      const fields = raw.split("\0").filter((field) => field.length > 0);
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const [, newMode = "", , newSha = "", status = ""] = (fields[i] ?? "").split(" ");
        const path = fields[i + 1] ?? "";
        if (status === "D") {
          deleted.push(path);
          continue;
        }
        if (newMode !== "100644" && newMode !== "100755") {
          continue;
        }
        const blob = git(["cat-file", "blob", newSha]);
        if (blob.includes(0)) {
          continue;
        }
        files.push({ path, content: blob.toString("utf8") });
      }
      return { files, deleted_files: deleted };
    },
    dispose(): void {
      rmSync(gitDir, { recursive: true, force: true });
    }
  };
}
