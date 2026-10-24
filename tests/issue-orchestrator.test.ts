import { generateKeyPairSync, createVerify } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createGitHubAppJwt } from "../src/auth/github-app-jwt.js";
import {
  evaluateIssueCommandGate,
  parseEpureCommand
} from "../src/auth/issue-command-gate.js";
import { extractJsonObject } from "../src/orchestrator/gemini-client.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLED_ORCHESTRATE_ACTION_PATH = join(
  ROOT_DIR,
  "dist",
  "actions",
  "orchestrate-issue",
  "index.mjs"
);
const ORCHESTRATE_ACTION_MANIFEST_PATH = join(
  ROOT_DIR,
  "actions",
  "orchestrate-issue",
  "action.yml"
);

describe("EPURE v1.1.0 — Real Orchestration Wiring (Q84–Q90, ADR-0026)", () => {
  describe("1. RS256 GitHub App JWT Signing (createGitHubAppJwt)", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });

    it.each([
      {
        id: "signs-valid-rs256-jwt-with-clock-skew-and-9min-expiry",
        appId: "123456",
        nowEpoch: 1700000000,
        expectedIat: 1699999940,
        expectedExp: 1700000540
      },
      {
        id: "normalizes-escaped-newlines-in-pem-private-key",
        appId: "789012",
        nowEpoch: 1800000000,
        expectedIat: 1799999940,
        expectedExp: 1800000540
      }
    ])("$id", ({ appId, nowEpoch, expectedIat, expectedExp }) => {
      const pemInput =
        appId === "789012" ? privateKey.replace(/\n/g, "\\n") : privateKey;
      const token = createGitHubAppJwt(
        { appId, privateKeyPem: pemInput },
        nowEpoch
      );
      const segments = token.split(".");
      expect(segments).toHaveLength(3);

      const header = JSON.parse(
        Buffer.from(segments[0]!, "base64url").toString("utf8")
      ) as { alg: string; typ: string };
      const payload = JSON.parse(
        Buffer.from(segments[1]!, "base64url").toString("utf8")
      ) as { iat: number; exp: number; iss: string };

      expect(header).toEqual({ alg: "RS256", typ: "JWT" });
      expect(payload).toEqual({
        iat: expectedIat,
        exp: expectedExp,
        iss: appId
      });

      const verifier = createVerify("RSA-SHA256");
      verifier.update(`${segments[0]}.${segments[1]}`);
      verifier.end();
      const signatureValid = verifier.verify(
        publicKey,
        Buffer.from(segments[2]!, "base64url")
      );
      expect(signatureValid).toBe(true);
    });
  });

  describe("2. Implicit Grill Reply & Extended Slash Commands (Q84, Q85)", () => {
    it.each([
      {
        id: "parses-explicit-to-spec-slash-command",
        body: "/epure to-spec",
        expected: {
          command: "to-spec",
          args: ""
        }
      },
      {
        id: "parses-explicit-to-tickets-slash-command",
        body: "/epure to-tickets",
        expected: {
          command: "to-tickets",
          args: ""
        }
      },
      {
        id: "returns-null-on-natural-human-comment-in-direct-parser",
        body: "Simple commentaire sans slash command",
        expected: null
      }
    ])("$id", ({ body, expected }) => {
      const parsed = parseEpureCommand(body);
      expect(parsed).toEqual(expected);
    });

    it("authorizes implicit planning reply only for write/admin human users when allowImplicitPlanningReply is true", async () => {
      const authorized = await evaluateIssueCommandGate({
        repository: "Hartorn-Inc/enclume-astrale",
        issueNumber: 1,
        commentBody: "Voici mes réponses au grill : tout en mémoire.",
        actor: { login: "Hartorn", type: "User" },
        effectivePermission: { permission: "admin", role_name: "admin" },
        allowImplicitPlanningReply: true
      });
      expect(authorized.authorized).toBe(true);
      expect(authorized.command).toBe("reply");
      expect(authorized.llm_call_allowed).toBe(true);

      const deniedRead = await evaluateIssueCommandGate({
        repository: "Hartorn-Inc/enclume-astrale",
        issueNumber: 1,
        commentBody: "Voici mes réponses au grill : tout en mémoire.",
        actor: { login: "outsider", type: "User" },
        effectivePermission: { permission: "read", role_name: "read" },
        allowImplicitPlanningReply: true
      });
      expect(deniedRead.authorized).toBe(false);
      expect(deniedRead.error_code).toBe("INSUFFICIENT_EFFECTIVE_PERMISSION");
    });
  });

  describe("3. Gemini JSON Extraction & Pre-bundled Orchestrate Action", () => {
    it.each([
      {
        id: "extracts-direct-json-object",
        raw: '{"questions":["Q1","Q2"],"context_summary":"ok"}',
        expected: { questions: ["Q1", "Q2"], context_summary: "ok" }
      },
      {
        id: "extracts-json-from-markdown-code-fence",
        raw: 'Here is the plan:\n```json\n{"passed":true,"rationale":"clean"}\n```',
        expected: { passed: true, rationale: "clean" }
      }
    ])("$id", ({ raw, expected }) => {
      expect(extractJsonObject(raw)).toEqual(expected);
    });

    it("ships the pre-bundled orchestrate-issue custom action", () => {
      expect(existsSync(ORCHESTRATE_ACTION_MANIFEST_PATH)).toBe(true);
      expect(existsSync(BUNDLED_ORCHESTRATE_ACTION_PATH)).toBe(true);
    });
  });
});
