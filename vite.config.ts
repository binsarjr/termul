import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig, type Plugin } from "vite";

const host = process.env.TAURI_DEV_HOST;

// Desktop webviews always pick woff2, so KaTeX's ttf/woff fallbacks are dead
// weight — drop the files and strip their url() entries from emitted CSS.
function dropLegacyKatexFonts(): Plugin {
  return {
    name: "drop-legacy-katex-fonts",
    generateBundle(_options, bundle) {
      for (const [name, asset] of Object.entries(bundle)) {
        if (/KaTeX_.*\.(ttf|woff)$/.test(name)) {
          delete bundle[name];
        } else if (
          asset.type === "asset" &&
          name.endsWith(".css") &&
          typeof asset.source === "string"
        ) {
          asset.source = asset.source.replace(
            /,url\([^)]*KaTeX_[^)]*\.(?:ttf|woff)\)\s*format\(["']?(?:truetype|woff)["']?\)/g,
            "",
          );
        }
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => ({
  plugins: [react(), tailwindcss(), dropLegacyKatexFonts()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  esbuild: {
    drop: mode === "production" ? (["debugger"] as ["debugger"]) : [],
    pure:
      mode === "production"
        ? ["console.debug", "console.info", "console.trace"]
        : [],
  },
  build: {
    target:
      process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome120" : "es2022",
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
      },
      output: {
        manualChunks(id: string) {
          // The preload helper is shared by every dynamic import; left to
          // Rollup it gets colored into a lazy chunk (streamdown), which
          // pins that chunk into the eager preload graph.
          if (id.includes("vite/preload-helper")) return "utils";
          if (!id.includes("node_modules")) return;

          // Each AI provider SDK in its own chunk so unused providers
          // don't bloat the initial load (lazy-imported in agent.ts).
          if (id.includes("@ai-sdk/anthropic")) return "ai-anthropic";
          if (id.includes("@ai-sdk/google")) return "ai-google";
          if (id.includes("@ai-sdk/openai-compatible"))
            return "ai-openai-compat";
          if (id.includes("@ai-sdk/openai")) return "ai-openai";
          if (id.includes("@ai-sdk/cerebras")) return "ai-cerebras";
          if (id.includes("@ai-sdk/groq")) return "ai-groq";
          if (id.includes("@ai-sdk/xai")) return "ai-xai";
          if (id.includes("@ai-sdk/")) return "ai-sdk-shared";

          if (id.includes("/xterm/") || id.includes("@xterm/")) return "xterm";
          if (
            id.includes("@codemirror/") ||
            id.includes("@uiw/codemirror") ||
            id.includes("@replit/codemirror")
          )
            return "codemirror";
          if (id.includes("/streamdown/") || id.includes("@streamdown/"))
            return "streamdown";
          // Keep tiny shared style utils out of the streamdown chunk —
          // colored in there, they'd give eager code a static edge into it.
          if (
            id.includes("/clsx/") ||
            id.includes("/tailwind-merge/") ||
            id.includes("/class-variance-authority/")
          )
            return "utils";
          if (id.includes("/pdfjs-dist/")) return "pdfjs";
          if (
            id.includes("/mermaid/") ||
            id.includes("@mermaid-js/") ||
            id.includes("/dagre-d3-es/")
          )
            return "mermaid";
          if (id.includes("/katex/")) return "katex";
          if (id.includes("/motion/") || id.includes("framer-motion"))
            return "motion";
          if (
            id.includes("/react-dom/") ||
            id.includes("/react/") ||
            id.includes("/scheduler/")
          )
            return "react";
          if (id.includes("@radix-ui/") || id.includes("/radix-ui/"))
            return "radix";
        },
      },
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
