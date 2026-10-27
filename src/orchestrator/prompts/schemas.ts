import type { ResponseSchemaSpec } from "../../llm/types.js";

export interface GrillRoundEvaluation {
  readonly frontier_resolved: boolean;
  readonly round_number: number;
  readonly follow_up_questions_markdown: string;
  readonly settled_decisions_summary_markdown?: string | undefined;
  readonly rationale: string;
}

export interface GeneratedAdrDocument {
  readonly path: string;
  readonly content: string;
  readonly filename: string;
  readonly title: string;
  readonly markdown: string;
}

export interface GeneratedTicketSpec {
  readonly index: number;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly summary: string;
  readonly acceptance_criteria: readonly string[];
  readonly blocked_by_indices: readonly number[];
  readonly files_to_create_or_update: readonly string[];
  readonly files_likely_touched: readonly string[];
}

export type PlannedTicketDefinition = GeneratedTicketSpec;

export interface GeneratedPlanningBundle {
  readonly plan_slug: string;
  readonly glossary_markdown: string;
  readonly adrs: readonly GeneratedAdrDocument[];
  readonly spec_path: string;
  readonly spec_markdown: string;
  readonly tickets: readonly GeneratedTicketSpec[];
}

export interface GeneratedFileChange {
  readonly path: string;
  readonly content: string;
}

export interface GeneratedFilePatchEdit {
  readonly old_string: string;
  readonly new_string: string;
  readonly search?: string | undefined;
  readonly replace?: string | undefined;
}

export type GeneratedTicketPatchEdit = GeneratedFilePatchEdit;

export interface GeneratedFilePatch {
  readonly path: string;
  readonly edits: readonly GeneratedFilePatchEdit[];
}

export type GeneratedTicketFilePatch = GeneratedFilePatch;

export interface GeneratedTicketImplementation {
  readonly commit_message: string;
  readonly test_summary: string;
  readonly files?: readonly GeneratedFileChange[] | undefined;
  readonly patches?: readonly GeneratedFilePatch[] | undefined;
  readonly deleted_files?: readonly string[] | undefined;
}

export interface ReviewerFindingPayloadItem {
  readonly severity?: string | undefined;
  readonly category?: string | undefined;
  readonly path?: string | undefined;
  readonly file?: string | undefined;
  readonly line?: number | undefined;
  readonly title?: string | undefined;
  readonly rationale?: string | undefined;
  readonly message?: string | undefined;
  readonly suggested_action?: string | undefined;
  readonly remediation?: string | undefined;
}

export type ReviewerLlmFindingItem = ReviewerFindingPayloadItem;

export interface ReviewerFindingsPayload {
  readonly reviewer?: string | undefined;
  readonly summary?: string | undefined;
  readonly findings: readonly ReviewerFindingPayloadItem[];
}

export interface UserAdvocatePersonaPayload {
  readonly id: string;
  readonly name: string;
  readonly roleDescription: string;
  readonly primaryGoals: readonly string[];
  readonly failureModesToWatch: readonly string[];
}

export interface UserAdvocateDesignGateFindingPayload {
  readonly persona: string;
  readonly journeyStep: string;
  readonly risk: string;
  readonly acceptanceCriterionToAdd: string;
}

export interface UserAdvocatePayload {
  readonly verdict?: "APPROVE" | "CONCERNS" | "BLOCK" | undefined;
  readonly concerns?: readonly string[] | undefined;
  readonly summary?: string | undefined;
  readonly personas?: readonly UserAdvocatePersonaPayload[] | undefined;
  readonly domain_invariants?: readonly string[] | undefined;
  readonly ux_acceptance_criteria?: readonly string[] | undefined;
  readonly findings?: readonly UserAdvocateDesignGateFindingPayload[] | undefined;
}

export type UserAdvocateLlmPayload = UserAdvocatePayload;

export interface SquashCommitPayload {
  readonly title?: string | undefined;
  readonly body?: string | undefined;
  readonly pr_title?: string | undefined;
  readonly commit_title?: string | undefined;
  readonly commit_body?: string | undefined;
  readonly bullets?: readonly string[] | undefined;
}

export type SquashCommitLlmPayload = SquashCommitPayload;

function asRecord(value: unknown, schemaName: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${schemaName} expected a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "number" ? item : Number(item)))
    .filter((item) => Number.isFinite(item));
}

function deriveTicketSlug(title: string, fallbackIndex: number): string {
  const clean = title
    .toLowerCase()
    .replace(/^\[ticket\s*\d+\]\s*/i, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
    .replace(/-+$/g, "");
  return clean || `ticket-${fallbackIndex}`;
}

function extractTitleFromMarkdown(markdown: string, fallback: string): string {
  const match = /^#\s+(.+)$/m.exec(markdown);
  return match?.[1]?.trim() || fallback;
}

export const GRILL_ROUND_EVALUATION_SCHEMA: ResponseSchemaSpec<GrillRoundEvaluation> =
  {
    name: "grill_round_evaluation",
    description:
      "Evaluation of a /grill-with-docs decision tree round on a GitHub Issue.",
    schema: {
      type: "object",
      properties: {
        frontier_resolved: {
          type: "boolean",
          description:
            "True when all blocking architectural and domain questions are answered."
        },
        round_number: {
          type: "integer",
          description: "1-based index of the grilling round."
        },
        follow_up_questions_markdown: {
          type: "string",
          description:
            "Follow-up questions in Markdown when frontier_resolved is false; empty string otherwise."
        },
        settled_decisions_summary_markdown: {
          type: "string",
          description:
            "Markdown summary of settled decisions across all grill rounds when frontier_resolved is true; empty string otherwise."
        },
        rationale: {
          type: "string",
          description: "Concise explanation of the decision frontier state."
        }
      },
      required: [
        "frontier_resolved",
        "round_number",
        "follow_up_questions_markdown",
        "rationale"
      ]
    },
    validate(parsed: unknown): GrillRoundEvaluation {
      const obj = asRecord(parsed, "GrillRoundEvaluation");
      if (typeof obj.frontier_resolved !== "boolean") {
        throw new Error(
          "GrillRoundEvaluation.frontier_resolved must be a boolean."
        );
      }
      const roundNumber =
        typeof obj.round_number === "number" &&
        Number.isFinite(obj.round_number) &&
        obj.round_number >= 1
          ? Math.floor(obj.round_number)
          : 1;
      const followUp =
        typeof obj.follow_up_questions_markdown === "string"
          ? obj.follow_up_questions_markdown
          : "";
      const settledSummary =
        typeof obj.settled_decisions_summary_markdown === "string"
          ? obj.settled_decisions_summary_markdown
          : "";
      const rationale =
        typeof obj.rationale === "string" ? obj.rationale : "";
      return {
        frontier_resolved: obj.frontier_resolved,
        round_number: roundNumber,
        follow_up_questions_markdown: followUp,
        settled_decisions_summary_markdown: settledSummary,
        rationale
      };
    }
  };

export const GENERATED_PLANNING_BUNDLE_SCHEMA: ResponseSchemaSpec<GeneratedPlanningBundle> =
  {
    name: "generated_planning_bundle",
    description:
      "Complete EPURE planning bundle including GLOSSARY.md, ADRs, specification, and DAG tickets.",
    schema: {
      type: "object",
      properties: {
        plan_slug: { type: "string" },
        glossary_markdown: { type: "string" },
        adrs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
              filename: { type: "string" },
              title: { type: "string" },
              markdown: { type: "string" }
            },
            required: ["path", "content"]
          }
        },
        spec_path: { type: "string" },
        spec_markdown: { type: "string" },
        tickets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: { type: "integer" },
              slug: { type: "string" },
              title: { type: "string" },
              description: { type: "string" },
              summary: { type: "string" },
              acceptance_criteria: {
                type: "array",
                items: { type: "string" }
              },
              blocked_by_indices: {
                type: "array",
                items: { type: "integer" }
              },
              files_to_create_or_update: {
                type: "array",
                items: { type: "string" }
              },
              files_likely_touched: {
                type: "array",
                items: { type: "string" }
              }
            },
            required: [
              "title",
              "acceptance_criteria",
              "blocked_by_indices"
            ]
          }
        }
      },
      required: [
        "plan_slug",
        "glossary_markdown",
        "adrs",
        "spec_path",
        "spec_markdown",
        "tickets"
      ]
    },
    validate(parsed: unknown): GeneratedPlanningBundle {
      const obj = asRecord(parsed, "GeneratedPlanningBundle");
      if (!Array.isArray(obj.tickets)) {
        throw new Error("GeneratedPlanningBundle.tickets must be an array.");
      }

      const planSlug =
        typeof obj.plan_slug === "string" && obj.plan_slug.trim().length > 0
          ? obj.plan_slug.trim()
          : "feature";
      const glossaryMarkdown =
        typeof obj.glossary_markdown === "string" ? obj.glossary_markdown : "";
      const specPath =
        typeof obj.spec_path === "string" && obj.spec_path.trim().length > 0
          ? obj.spec_path.trim()
          : `docs/specs/${planSlug}.md`;
      const specMarkdown =
        typeof obj.spec_markdown === "string" ? obj.spec_markdown : "";

      const rawAdrs = Array.isArray(obj.adrs) ? obj.adrs : [];
      const adrs: GeneratedAdrDocument[] = rawAdrs.map((item, idx) => {
        const rec = asRecord(item, `GeneratedAdrDocument[${idx}]`);
        const rawPath =
          typeof rec.path === "string" ? rec.path.trim() : "";
        const rawFilename =
          typeof rec.filename === "string" && rec.filename.trim().length > 0
            ? rec.filename.trim()
            : rawPath
              ? (rawPath.split("/").pop() ?? rawPath)
              : `000${idx + 1}-adr.md`;
        const path =
          rawPath ||
          (rawFilename.startsWith("docs/adr/")
            ? rawFilename
            : `docs/adr/${rawFilename}`);
        const content =
          typeof rec.content === "string"
            ? rec.content
            : typeof rec.markdown === "string"
              ? rec.markdown
              : "";
        const title =
          typeof rec.title === "string" && rec.title.trim().length > 0
            ? rec.title.trim()
            : extractTitleFromMarkdown(content, rawFilename);

        return {
          path,
          content,
          filename: rawFilename,
          title,
          markdown: content
        };
      });

      const tickets: GeneratedTicketSpec[] = obj.tickets.map((item, idx) => {
        const rec = asRecord(item, `GeneratedTicketSpec[${idx}]`);
        const index =
          typeof rec.index === "number" && Number.isFinite(rec.index)
            ? Math.floor(rec.index)
            : idx + 1;
        const title =
          typeof rec.title === "string" && rec.title.trim().length > 0
            ? rec.title.trim()
            : `[Ticket ${index}] Implementation`;
        const slug =
          typeof rec.slug === "string" && rec.slug.trim().length > 0
            ? rec.slug.trim()
            : deriveTicketSlug(title, index);
        const description =
          typeof rec.description === "string" && rec.description.trim().length > 0
            ? rec.description
            : typeof rec.summary === "string"
              ? rec.summary
              : title;
        const summary =
          typeof rec.summary === "string" && rec.summary.trim().length > 0
            ? rec.summary
            : description;
        const acceptanceCriteria = asStringArray(rec.acceptance_criteria);
        const blockedByIndices = asNumberArray(rec.blocked_by_indices);
        const filesToCreateOrUpdate = asStringArray(
          rec.files_to_create_or_update ?? rec.files_likely_touched
        );

        return {
          index,
          slug,
          title,
          description,
          summary,
          acceptance_criteria: acceptanceCriteria,
          blocked_by_indices: blockedByIndices,
          files_to_create_or_update: filesToCreateOrUpdate,
          files_likely_touched: filesToCreateOrUpdate
        };
      });

      return {
        plan_slug: planSlug,
        glossary_markdown: glossaryMarkdown,
        adrs,
        spec_path: specPath,
        spec_markdown: specMarkdown,
        tickets
      };
    }
  };

export const GENERATED_TICKET_IMPLEMENTATION_SCHEMA: ResponseSchemaSpec<GeneratedTicketImplementation> =
  {
    name: "generated_ticket_implementation",
    description:
      "Structured TDD code implementation or remediation payload for a ticket.",
    schema: {
      type: "object",
      properties: {
        commit_message: { type: "string" },
        test_summary: { type: "string" },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" }
            },
            required: ["path", "content"]
          }
        },
        patches: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              edits: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    old_string: { type: "string" },
                    new_string: { type: "string" },
                    search: { type: "string" },
                    replace: { type: "string" }
                  },
                  required: ["old_string", "new_string"]
                }
              }
            },
            required: ["path", "edits"]
          }
        },
        deleted_files: {
          type: "array",
          items: { type: "string" }
        }
      },
      required: ["commit_message", "test_summary"]
    },
    validate(parsed: unknown): GeneratedTicketImplementation {
      const obj = asRecord(parsed, "GeneratedTicketImplementation");
      if (
        typeof obj.commit_message !== "string" ||
        obj.commit_message.trim().length === 0
      ) {
        throw new Error(
          "GeneratedTicketImplementation.commit_message must be a non-empty string."
        );
      }
      const commitMessage = obj.commit_message.trim();
      const testSummary =
        typeof obj.test_summary === "string" ? obj.test_summary : "";

      const files: GeneratedFileChange[] | undefined = Array.isArray(obj.files)
        ? obj.files.map((item, idx) => {
            const rec = asRecord(item, `GeneratedFileChange[${idx}]`);
            if (typeof rec.path !== "string" || rec.path.trim().length === 0) {
              throw new Error(
                `GeneratedFileChange[${idx}].path must be a non-empty string.`
              );
            }
            return {
              path: rec.path.trim(),
              content: typeof rec.content === "string" ? rec.content : ""
            };
          })
        : undefined;

      const patches: GeneratedFilePatch[] | undefined = Array.isArray(
        obj.patches
      )
        ? obj.patches.map((item, idx) => {
            const rec = asRecord(item, `GeneratedFilePatch[${idx}]`);
            if (typeof rec.path !== "string" || rec.path.trim().length === 0) {
              throw new Error(
                `GeneratedFilePatch[${idx}].path must be a non-empty string.`
              );
            }
            const rawEdits = Array.isArray(rec.edits) ? rec.edits : [];
            const edits: GeneratedFilePatchEdit[] = rawEdits.map(
              (editItem, editIdx) => {
                const editRec = asRecord(
                  editItem,
                  `GeneratedFilePatchEdit[${idx}][${editIdx}]`
                );
                const oldStr =
                  typeof editRec.old_string === "string"
                    ? editRec.old_string
                    : typeof editRec.search === "string"
                      ? editRec.search
                      : "";
                const newStr =
                  typeof editRec.new_string === "string"
                    ? editRec.new_string
                    : typeof editRec.replace === "string"
                      ? editRec.replace
                      : "";
                return {
                  old_string: oldStr,
                  new_string: newStr,
                  search: oldStr,
                  replace: newStr
                };
              }
            );
            return {
              path: rec.path.trim(),
              edits
            };
          })
        : undefined;

      const deletedFiles: string[] | undefined = Array.isArray(
        obj.deleted_files
      )
        ? asStringArray(obj.deleted_files)
        : undefined;

      return {
        commit_message: commitMessage,
        test_summary: testSummary,
        ...(files !== undefined ? { files } : {}),
        ...(patches !== undefined ? { patches } : {}),
        ...(deletedFiles !== undefined ? { deleted_files: deletedFiles } : {})
      };
    }
  };

export const REVIEWER_FINDINGS_SCHEMA: ResponseSchemaSpec<ReviewerFindingsPayload> =
  {
    name: "reviewer_findings_payload",
    description:
      "Structured output from a single EPURE multi-agent PR reviewer pass.",
    schema: {
      type: "object",
      properties: {
        reviewer: { type: "string" },
        summary: { type: "string" },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              category: { type: "string" },
              severity: { type: "string" },
              path: { type: "string" },
              file: { type: "string" },
              line: { type: "integer" },
              title: { type: "string" },
              rationale: { type: "string" },
              message: { type: "string" },
              suggested_action: { type: "string" },
              remediation: { type: "string" }
            }
          }
        }
      },
      required: ["findings"]
    },
    validate(parsed: unknown): ReviewerFindingsPayload {
      const obj = asRecord(parsed, "ReviewerFindingsPayload");
      if (obj.findings !== undefined && !Array.isArray(obj.findings)) {
        throw new Error("ReviewerFindingsPayload.findings must be an array.");
      }
      const rawFindings = Array.isArray(obj.findings) ? obj.findings : [];
      const findings: ReviewerFindingPayloadItem[] = rawFindings.map(
        (item, idx) => {
          const rec = asRecord(item, `ReviewerFindingPayloadItem[${idx}]`);
          const pathVal =
            typeof rec.path === "string"
              ? rec.path
              : typeof rec.file === "string"
                ? rec.file
                : undefined;
          const rationaleVal =
            typeof rec.rationale === "string"
              ? rec.rationale
              : typeof rec.message === "string"
                ? rec.message
                : undefined;
          const actionVal =
            typeof rec.suggested_action === "string"
              ? rec.suggested_action
              : typeof rec.remediation === "string"
                ? rec.remediation
                : undefined;
          const lineVal =
            typeof rec.line === "number" && Number.isFinite(rec.line)
              ? Math.floor(rec.line)
              : undefined;

          return {
            ...(typeof rec.severity === "string"
              ? { severity: rec.severity }
              : {}),
            ...(typeof rec.category === "string"
              ? { category: rec.category }
              : {}),
            ...(pathVal !== undefined ? { path: pathVal, file: pathVal } : {}),
            ...(lineVal !== undefined ? { line: lineVal } : {}),
            ...(typeof rec.title === "string" ? { title: rec.title } : {}),
            ...(rationaleVal !== undefined
              ? { rationale: rationaleVal, message: rationaleVal }
              : {}),
            ...(actionVal !== undefined
              ? { suggested_action: actionVal, remediation: actionVal }
              : {})
          };
        }
      );

      return {
        ...(typeof obj.reviewer === "string" ? { reviewer: obj.reviewer } : {}),
        ...(typeof obj.summary === "string" ? { summary: obj.summary } : {}),
        findings
      };
    }
  };

export const USER_ADVOCATE_SCHEMA: ResponseSchemaSpec<UserAdvocatePayload> = {
  name: "user_advocate_payload",
  description:
    "Structured output for user-advocate persona review and design-gate evaluation.",
  schema: {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        enum: ["APPROVE", "CONCERNS", "BLOCK"]
      },
      concerns: {
        type: "array",
        items: { type: "string" }
      },
      summary: { type: "string" },
      personas: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            roleDescription: { type: "string" },
            primaryGoals: {
              type: "array",
              items: { type: "string" }
            },
            failureModesToWatch: {
              type: "array",
              items: { type: "string" }
            }
          },
          required: ["id", "name", "roleDescription"]
        }
      },
      domain_invariants: {
        type: "array",
        items: { type: "string" }
      },
      ux_acceptance_criteria: {
        type: "array",
        items: { type: "string" }
      },
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            persona: { type: "string" },
            journeyStep: { type: "string" },
            risk: { type: "string" },
            acceptanceCriterionToAdd: { type: "string" }
          }
        }
      }
    }
  },
  validate(parsed: unknown): UserAdvocatePayload {
    const obj = asRecord(parsed, "UserAdvocatePayload");
    const rawVerdict =
      typeof obj.verdict === "string"
        ? obj.verdict.trim().toUpperCase()
        : undefined;
    const verdict: "APPROVE" | "CONCERNS" | "BLOCK" | undefined =
      rawVerdict === "APPROVE" ||
      rawVerdict === "CONCERNS" ||
      rawVerdict === "BLOCK"
        ? rawVerdict
        : undefined;

    const concerns = Array.isArray(obj.concerns)
      ? asStringArray(obj.concerns)
      : undefined;
    const summary = typeof obj.summary === "string" ? obj.summary : undefined;
    const domainInvariants = Array.isArray(obj.domain_invariants)
      ? asStringArray(obj.domain_invariants)
      : undefined;
    const uxAcceptanceCriteria = Array.isArray(obj.ux_acceptance_criteria)
      ? asStringArray(obj.ux_acceptance_criteria)
      : undefined;

    const personas: UserAdvocatePersonaPayload[] | undefined = Array.isArray(
      obj.personas
    )
      ? obj.personas.map((p, idx) => {
          const rec = asRecord(p, `UserAdvocatePersonaPayload[${idx}]`);
          return {
            id:
              typeof rec.id === "string" && rec.id.trim()
                ? rec.id.trim()
                : `persona-${idx + 1}`,
            name:
              typeof rec.name === "string" && rec.name.trim()
                ? rec.name.trim()
                : `Persona ${idx + 1}`,
            roleDescription:
              typeof rec.roleDescription === "string"
                ? rec.roleDescription
                : "",
            primaryGoals: asStringArray(rec.primaryGoals),
            failureModesToWatch: asStringArray(rec.failureModesToWatch)
          };
        })
      : undefined;

    const findings: UserAdvocateDesignGateFindingPayload[] | undefined =
      Array.isArray(obj.findings)
        ? obj.findings.map((f, idx) => {
            const rec = asRecord(
              f,
              `UserAdvocateDesignGateFindingPayload[${idx}]`
            );
            return {
              persona: typeof rec.persona === "string" ? rec.persona : "",
              journeyStep:
                typeof rec.journeyStep === "string" ? rec.journeyStep : "",
              risk: typeof rec.risk === "string" ? rec.risk : "",
              acceptanceCriterionToAdd:
                typeof rec.acceptanceCriterionToAdd === "string"
                  ? rec.acceptanceCriterionToAdd
                  : ""
            };
          })
        : undefined;

    return {
      ...(verdict !== undefined ? { verdict } : {}),
      ...(concerns !== undefined ? { concerns } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(personas !== undefined ? { personas } : {}),
      ...(domainInvariants !== undefined
        ? { domain_invariants: domainInvariants }
        : {}),
      ...(uxAcceptanceCriteria !== undefined
        ? { ux_acceptance_criteria: uxAcceptanceCriteria }
        : {}),
      ...(findings !== undefined ? { findings } : {})
    };
  }
};

export const SQUASH_COMMIT_SCHEMA: ResponseSchemaSpec<SquashCommitPayload> = {
  name: "squash_commit_payload",
  description:
    "Structured Conventional Commit squash title and bullet summary for a Pull Request.",
  schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      body: { type: "string" },
      pr_title: { type: "string" },
      commit_title: { type: "string" },
      commit_body: { type: "string" },
      bullets: {
        type: "array",
        items: { type: "string" }
      }
    }
  },
  validate(parsed: unknown): SquashCommitPayload {
    const obj = asRecord(parsed, "SquashCommitPayload");
    const prTitle =
      typeof obj.pr_title === "string"
        ? obj.pr_title
        : typeof obj.title === "string"
          ? obj.title
          : typeof obj.commit_title === "string"
            ? obj.commit_title
            : undefined;
    const title =
      typeof obj.title === "string" ? obj.title : prTitle;
    const commitTitle =
      typeof obj.commit_title === "string" ? obj.commit_title : prTitle;

    const bullets = Array.isArray(obj.bullets)
      ? asStringArray(obj.bullets)
      : undefined;
    const body =
      typeof obj.body === "string"
        ? obj.body
        : typeof obj.commit_body === "string"
          ? obj.commit_body
          : bullets && bullets.length > 0
            ? bullets.join("\n")
            : undefined;
    const commitBody =
      typeof obj.commit_body === "string" ? obj.commit_body : body;

    return {
      ...(title !== undefined ? { title } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(prTitle !== undefined ? { pr_title: prTitle } : {}),
      ...(commitTitle !== undefined ? { commit_title: commitTitle } : {}),
      ...(commitBody !== undefined ? { commit_body: commitBody } : {}),
      ...(bullets !== undefined ? { bullets } : {})
    };
  }
};
