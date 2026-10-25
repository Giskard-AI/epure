<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useData, withBase } from "vitepress";

const props = withDefaults(
  defineProps<{
    slug:
      | "epure-issue-flow"
      | "epure-state-machine"
      | "epure-security-architecture"
      | "epure-review-pipeline";
    locale?: "en" | "fr";
    title: string;
    caption?: string;
    height?: string;
  }>(),
  {
    locale: "en",
    caption: "",
    height: "520px"
  }
);

type DiagramState = "loading" | "ready" | "error";
type ReaderMode = "embed" | "interactive";

const { isDark } = useData();
const status = ref<DiagramState>("loading");
const readerMode = ref<ReaderMode>("embed");
const isFullscreen = ref(false);
const reloadKey = ref(0);
const computedStageHeight = ref<string>(props.height);
const iframeRef = ref<HTMLIFrameElement | null>(null);
const fullscreenBtnRef = ref<HTMLButtonElement | null>(null);

const activeTheme = computed(() => (isDark.value ? "dark" : "light"));
const figureId = computed(() => `archify-fig-${props.locale}-${props.slug}`);

const diagramUrl = computed(() => {
  const modeParam =
    readerMode.value === "embed" && !isFullscreen.value
      ? "embed=1"
      : "present=1";
  return withBase(
    `/diagrams/${props.locale}/${props.slug}.html?${modeParam}&theme=${activeTheme.value}&v=${reloadKey.value}`
  );
});

const standaloneUrl = computed(() =>
  withBase(
    `/diagrams/${props.locale}/${props.slug}.html?theme=${activeTheme.value}`
  )
);

const i18n = computed(() =>
  props.locale === "fr"
    ? {
        loading: "Chargement de l'épure interactive Archify…",
        error:
          "Le chargement du schéma interactif a échoué. Vous pouvez réessayer ou ouvrir le schéma autonome dans un nouvel onglet.",
        retry: "Réessayer le chargement",
        retryAria: `Réessayer de charger le schéma ${props.title}`,
        modeEmbed: "Vue Épure",
        modeInteractive: "Explorer & Animer",
        modeAria: `Basculer entre la vue épure épurée et l'explorateur interactif pour ${props.title}`,
        fullscreenEnter: "Plein écran",
        fullscreenExit: "Quitter le plein écran",
        fullscreenAriaEnter: `Afficher le schéma ${props.title} en plein écran`,
        fullscreenAriaExit: `Quitter le mode plein écran pour le schéma ${props.title}`,
        openNewTab: "Pleine page ↗",
        openNewTabAria: `Ouvrir le schéma interactif ${props.title} dans un nouvel onglet`,
        badge: "Épure Interactive Archify"
      }
    : {
        loading: "Loading interactive Archify blueprint…",
        error:
          "Failed to load the interactive diagram. You can retry or open the standalone diagram in a new tab.",
        retry: "Retry loading",
        retryAria: `Retry loading diagram ${props.title}`,
        modeEmbed: "Clean Canvas",
        modeInteractive: "Explore & Animate",
        modeAria: `Toggle between clean canvas view and interactive explorer for ${props.title}`,
        fullscreenEnter: "Fullscreen",
        fullscreenExit: "Exit Fullscreen",
        fullscreenAriaEnter: `Open diagram ${props.title} in fullscreen mode`,
        fullscreenAriaExit: `Exit fullscreen mode for diagram ${props.title}`,
        openNewTab: "Standalone ↗",
        openNewTabAria: `Open interactive diagram ${props.title} in a new tab`,
        badge: "Archify Interactive Blueprint"
      }
);

function syncIframeThemeAndMeasure(): void {
  const frame = iframeRef.value;
  if (!frame) return;
  try {
    const doc = frame.contentDocument;
    if (!doc) return;
    doc.documentElement.setAttribute("data-theme", activeTheme.value);
    doc.documentElement.setAttribute("lang", props.locale);

    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

    // In embed mode, turn on live signal comet motion and auto-fit stage height to SVG aspect ratio so there is zero scrollbar
    if (readerMode.value === "embed" && !isFullscreen.value) {
      if (!prefersReducedMotion) {
        doc.documentElement.setAttribute("data-motion", "live");
        doc.documentElement.setAttribute("data-ambient-motion", "running");
      }
      const svg = doc.querySelector<SVGSVGElement>(".diagram-container svg");
      if (svg) {
        const vb = svg.viewBox?.baseVal;
        const containerWidth = frame.clientWidth || 880;
        if (vb && vb.width > 0 && vb.height > 0) {
          const idealHeight = Math.round(
            (containerWidth * vb.height) / vb.width + 28
          );
          const clamped = Math.max(380, Math.min(680, idealHeight));
          computedStageHeight.value = `${clamped}px`;
        }
      }
    } else {
      // In interactive/fullscreen mode, enable Live comet flow by default
      const win = frame.contentWindow as
        | (Window & {
            Archify?: {
              motion?: { setPaused?: (paused: boolean) => void };
            };
          })
        | null;
      win?.Archify?.motion?.setPaused?.(false);
      computedStageHeight.value = "660px";
    }
  } catch {
    // Same-origin guard fallback
  }
}

watch(isDark, () => {
  syncIframeThemeAndMeasure();
});

function handleLoad(): void {
  status.value = "ready";
  syncIframeThemeAndMeasure();
}

function handleError(): void {
  status.value = "error";
}

function retryLoad(): void {
  status.value = "loading";
  reloadKey.value += 1;
}

function toggleReaderMode(): void {
  status.value = "loading";
  readerMode.value = readerMode.value === "embed" ? "interactive" : "embed";
}

function toggleFullscreen(): void {
  isFullscreen.value = !isFullscreen.value;
  setTimeout(() => syncIframeThemeAndMeasure(), 60);
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && isFullscreen.value) {
    isFullscreen.value = false;
    fullscreenBtnRef.value?.focus();
  }
}

onMounted(() => {
  window.addEventListener("keydown", handleKeydown);
  window.addEventListener("resize", syncIframeThemeAndMeasure);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleKeydown);
  window.removeEventListener("resize", syncIframeThemeAndMeasure);
});
</script>

<template>
  <figure
    class="epure-archify-figure"
    :class="{ 'epure-archify-figure--fullscreen': isFullscreen }"
    role="group"
    :aria-labelledby="figureId"
  >
    <div class="epure-archify-toolbar">
      <div class="epure-archify-title-group">
        <span class="epure-archify-badge">
          <span class="epure-archify-pulse" aria-hidden="true" />
          {{ i18n.badge }}
        </span>
        <strong :id="figureId" class="epure-archify-title">{{ title }}</strong>
      </div>
      <div class="epure-archify-actions">
        <button
          type="button"
          class="epure-archify-btn"
          :class="{ 'epure-archify-btn--active': readerMode === 'interactive' }"
          :aria-label="i18n.modeAria"
          :aria-pressed="readerMode === 'interactive'"
          @click="toggleReaderMode"
        >
          {{
            readerMode === "embed" ? i18n.modeInteractive : i18n.modeEmbed
          }}
        </button>
        <button
          ref="fullscreenBtnRef"
          type="button"
          class="epure-archify-btn"
          :aria-label="
            isFullscreen ? i18n.fullscreenAriaExit : i18n.fullscreenAriaEnter
          "
          :aria-expanded="isFullscreen"
          @click="toggleFullscreen"
        >
          {{ isFullscreen ? i18n.fullscreenExit : i18n.fullscreenEnter }}
        </button>
        <a
          :href="standaloneUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="epure-archify-link"
          :aria-label="i18n.openNewTabAria"
        >
          {{ i18n.openNewTab }}
        </a>
      </div>
    </div>

    <div
      class="epure-archify-stage"
      :style="{ '--archify-height': computedStageHeight }"
    >
      <div
        v-if="status === 'loading'"
        class="epure-archify-status epure-archify-status--loading"
        role="status"
        aria-live="polite"
      >
        <span class="epure-archify-spinner" aria-hidden="true" />
        <span>{{ i18n.loading }}</span>
      </div>

      <div
        v-if="status === 'error'"
        class="epure-archify-status epure-archify-status--error"
        role="alert"
      >
        <p>{{ i18n.error }}</p>
        <button
          type="button"
          class="epure-archify-btn"
          :aria-label="i18n.retryAria"
          @click="retryLoad"
        >
          {{ i18n.retry }}
        </button>
      </div>

      <iframe
        ref="iframeRef"
        :key="`${readerMode}-${isFullscreen}-${reloadKey}`"
        class="epure-archify-iframe"
        :src="diagramUrl"
        :title="title"
        scrolling="no"
        loading="lazy"
        @load="handleLoad"
        @error="handleError"
      />
    </div>

    <figcaption v-if="caption" class="epure-archify-caption">
      {{ caption }}
    </figcaption>
  </figure>
</template>

<style scoped>
.epure-archify-figure {
  margin: 1.75rem 0;
  border: 1px solid var(--epure-border-subtle);
  border-radius: 12px;
  background-color: var(--epure-surface-card);
  box-shadow: var(--epure-card-shadow);
  overflow: hidden;
  max-width: 100%;
  transition: transform 0.22s ease, box-shadow 0.22s ease, border-color 0.22s ease;
}

.epure-archify-figure:hover {
  border-color: var(--epure-brand-1);
  box-shadow: var(--epure-card-shadow-hover);
}

.epure-archify-figure--fullscreen {
  position: fixed;
  inset: 1rem;
  z-index: 9999;
  margin: 0;
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
}

.epure-archify-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.7rem 1.1rem;
  border-bottom: 1px solid var(--epure-border-subtle);
  background: var(--epure-toolbar-gradient);
  backdrop-filter: blur(10px);
}

.epure-archify-title-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem;
}

.epure-archify-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-family: var(--vp-font-family-mono);
  font-size: 0.72rem;
  font-weight: 600;
  padding: 0.16rem 0.55rem;
  border-radius: 9999px;
  background-color: var(--epure-step-auto-bg);
  color: var(--epure-step-auto-fg);
  border: 1px solid var(--epure-step-auto-border);
}

.epure-archify-pulse {
  width: 7px;
  height: 7px;
  border-radius: 9999px;
  background-color: var(--epure-brand-1);
  animation: epure-pulse-dot 2.2s infinite ease-in-out;
}

.epure-archify-title {
  font-size: 0.92rem;
  color: var(--epure-text-primary);
}

.epure-archify-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.45rem;
}

.epure-archify-btn,
.epure-archify-link {
  font-size: 0.78rem;
  font-weight: 600;
  padding: 0.32rem 0.7rem;
  border-radius: 7px;
  border: 1px solid var(--epure-border-strong);
  background-color: var(--epure-surface-elevated);
  color: var(--epure-text-primary);
  text-decoration: none;
  cursor: pointer;
  transition: all 0.18s ease;
}

.epure-archify-btn--active {
  background-color: var(--epure-brand-soft);
  border-color: var(--epure-brand-1);
  color: var(--epure-brand-1);
}

.epure-archify-btn:hover,
.epure-archify-link:hover {
  background-color: var(--epure-brand-soft);
  border-color: var(--epure-brand-1);
  color: var(--epure-brand-1);
  transform: translateY(-1px);
}

.epure-archify-btn:focus-visible,
.epure-archify-link:focus-visible {
  outline: 2px solid var(--epure-brand-1);
  outline-offset: 2px;
}

.epure-archify-stage {
  position: relative;
  width: 100%;
  height: var(--archify-height, 520px);
  min-height: 380px;
  overflow: hidden;
  transition: height 0.25s ease;
}

.epure-archify-figure--fullscreen .epure-archify-stage {
  flex: 1;
  height: auto;
}

.epure-archify-iframe {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
  overflow: hidden;
}

.epure-archify-status {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding: 1rem;
  text-align: center;
  font-size: 0.9rem;
  background-color: var(--epure-surface-card);
  color: var(--epure-text-secondary);
  z-index: 2;
}

.epure-archify-spinner {
  width: 24px;
  height: 24px;
  border-radius: 9999px;
  border: 2.5px solid var(--epure-border-subtle);
  border-top-color: var(--epure-brand-1);
  animation: epure-spin 0.85s linear infinite;
}

.epure-archify-status--error {
  background-color: var(--epure-danger-bg);
  color: var(--epure-danger-fg);
  border: 1px solid var(--epure-danger-border);
}

.epure-archify-caption {
  padding: 0.6rem 1.1rem;
  font-size: 0.82rem;
  color: var(--epure-text-secondary);
  border-top: 1px solid var(--epure-border-subtle);
  background-color: var(--epure-surface-card);
}

@keyframes epure-pulse-dot {
  0%,
  100% {
    opacity: 0.45;
    transform: scale(0.92);
  }
  50% {
    opacity: 1;
    transform: scale(1.18);
  }
}

@keyframes epure-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 640px) {
  .epure-archify-stage {
    height: 420px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .epure-archify-pulse,
  .epure-archify-spinner {
    animation: none;
  }
  .epure-archify-figure,
  .epure-archify-btn,
  .epure-archify-link,
  .epure-archify-stage {
    transition: none;
  }
}
</style>
