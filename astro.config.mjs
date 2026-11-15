import { unified } from "@astrojs/markdown-remark";
import starlight from "@astrojs/starlight";
import svelte from "@astrojs/svelte";
import rehypeAstroRelativeMarkdownLinks from "astro-rehype-relative-markdown-links";
import { defineConfig } from "astro/config";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sirv from "sirv";

// In dev, serve the local catalog/ at /catalog when it has been built; DATA_BASE reads it.
/** @returns {import("vite").Plugin} */
function localCatalog() {
  const local = existsSync("catalog/catalog.json");
  return {
    name: "local-catalog",
    apply: "serve",
    config: () => ({ define: { "import.meta.env.LOCAL_CATALOG": JSON.stringify(local) } }),
    configureServer(server) {
      console.log(`data: ${local ? "local catalog/" : "source.coop"}`);
      if (!local) return;
      const serve = sirv("catalog", { dev: true });
      // Hidden files stay unserved, as the push leaves them out.
      server.middlewares.use("/catalog", (req, res, next) => {
        if (!/\/\./.test(req.url ?? "")) return serve(req, res, next);
        res.statusCode = 404;
        res.end();
      });
    },
  };
}

export default defineConfig({
  site: "https://cod.unocha.org",
  integrations: [
    starlight({
      title: "Tools",
      disable404Route: true,
      favicon: "/icons/favicon.svg",
      customCss: ["./src/styles/brand.css", "./src/styles/site-tokens.css", "./src/styles/starlight-ocha.css"],
      components: {
        Head: "./src/lib/components/starlight/Head.astro",
        Header: "./src/lib/components/starlight/Header.astro",
        Sidebar: "./src/lib/components/starlight/Sidebar.astro",
        ThemeProvider: "./src/lib/components/starlight/ThemeProvider.astro",
        ThemeSelect: "./src/lib/components/starlight/ThemeSelect.astro",
      },
      sidebar: [
        { label: "Overview", link: "/tools/docs/" },
        { label: "Agents", items: [{ autogenerate: { directory: "tools/docs/agents" } }] },
        { label: "1. Schema", items: [{ autogenerate: { directory: "tools/docs/1-schema" } }] },
        { label: "2. Topology", items: [{ autogenerate: { directory: "tools/docs/2-topology" } }] },
        { label: "3. Edge matching", items: [{ autogenerate: { directory: "tools/docs/3-edge" } }] },
        { label: "4. Codes", items: [{ autogenerate: { directory: "tools/docs/4-codes" } }] },
        { label: "5. Names", items: [{ autogenerate: { directory: "tools/docs/5-names" } }] },
        { label: "6. Packaging", items: [{ autogenerate: { directory: "tools/docs/6-packaging" } }] },
      ],
    }),
    svelte(),
  ],
  markdown: {
    processor: unified({
      rehypePlugins: [
        [
          rehypeAstroRelativeMarkdownLinks,
          { collectionBase: false, trailingSlash: "always" },
        ],
      ],
    }),
  },
  vite: {
    plugins: [localCatalog()],
    resolve: {
      // Resolve MDX imports in the symlinked py docs from this project's node_modules.
      preserveSymlinks: true,
      alias: {
        $lib: fileURLToPath(new URL("./src/lib", import.meta.url)),
      },
    },
    optimizeDeps: {
      exclude: ["@duckdb/duckdb-wasm"],
    },
    build: {
      // Astro's static SSR prunes scoped CSS for components that don't render
      // at SSR time (e.g. {#if} branches). Disabling code-split keeps every
      // component's styles in the client bundle.
      cssCodeSplit: false,
    },
  },
});
