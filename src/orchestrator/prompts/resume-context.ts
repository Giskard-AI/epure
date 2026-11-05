import { wrapUntrustedContent } from "../../security/prompt-injection-guard.js";

export function formatResumeContextPromptLines(
  resumeContextMarkdown: string | undefined
): string[] {
  return resumeContextMarkdown
    ? [
        "Consignes humaines publiées depuis l'escalade (à prendre en compte pour cette reprise) :",
        wrapUntrustedContent("untrusted_issue_content", resumeContextMarkdown),
        ""
      ]
    : [];
}
