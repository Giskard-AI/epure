// Must stay import-free: setup-repo reads it at module load, inside an import cycle.
export const DEFAULT_REVIEWERS_DIR = ".agents/reviewers";
