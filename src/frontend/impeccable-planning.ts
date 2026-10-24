export interface ImpeccableDesignSessionInput {
  readonly issueNumber: number;
  readonly surfaceSlug: string;
  readonly touchesFrontendUi: boolean;
  readonly alreadyAnsweredTopics: readonly string[];
  readonly candidateDesignTopics: readonly string[];
}

export interface ImpeccableDesignSessionResult {
  readonly impeccable_invoked: boolean;
  readonly open_design_questions: readonly string[];
  readonly versioned_artifact_paths: readonly string[];
}

export function planImpeccableDesignSession(
  input: ImpeccableDesignSessionInput
): ImpeccableDesignSessionResult {
  if (!input.touchesFrontendUi) {
    return {
      impeccable_invoked: false,
      open_design_questions: [],
      versioned_artifact_paths: []
    };
  }

  const answeredSet = new Set(
    input.alreadyAnsweredTopics.map((t) => t.trim().toLowerCase())
  );
  const openQuestions = input.candidateDesignTopics.filter(
    (topic) => !answeredSet.has(topic.trim().toLowerCase())
  );

  const cleanSlug = input.surfaceSlug.trim().replace(/^\/+|\/+$/g, "");

  return {
    impeccable_invoked: true,
    open_design_questions: openQuestions,
    versioned_artifact_paths: [
      ".impeccable.md",
      "DESIGN.md",
      `.impeccable/surfaces/${cleanSlug}.md`
    ]
  };
}
