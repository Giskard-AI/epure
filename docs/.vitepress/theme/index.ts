import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import ArchifyDiagram from "./components/ArchifyDiagram.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("ArchifyDiagram", ArchifyDiagram);
  }
} satisfies Theme;
