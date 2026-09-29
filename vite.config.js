// Runinback — Vite multi-page build.
//
// Every src/*.html file is a page entry. Public, unhashed assets (icons, logos,
// media, robots.txt, sitemap.xml) live in /public and are served from the site
// root. Scripts and styles are bundled, minified and content-hashed into
// dist/assets so they can be cached immutably.
//
// Public runtime config is injected at build time from the same environment
// variables Vercel already has (SUPABASE_URL, SUPABASE_ANON_KEY, STRIPE_ENABLED,
// CRYPTO_ENABLED). Only public values belong here — never a service-role key.
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";

const rootDir = import.meta.dirname;
const srcDir = resolve(rootDir, "src");
// Pure game rules shared with the game-move Edge Function (Deno).
const gameRulesDir = resolve(rootDir, "supabase/functions/_shared/game-rules");

const pages = Object.fromEntries(
  readdirSync(srcDir)
    .filter((file) => file.endsWith(".html"))
    .map((file) => [file.replace(/\.html$/, ""), resolve(srcDir, file)]),
);

const isTruthy = (value) => /^(1|true|yes|on)$/i.test(String(value || ""));

// Fonts are hashed by the bundler, so their <link rel="preload"> tags can
// only be written after the build: preload the display (600) and body (400)
// faces so first paint doesn't swap fonts under the hero headline.
const PRELOADED_FONTS = /inter-tight-latin-(400|600)-normal-[^/]*\.woff2$/;
function preloadFonts() {
  return {
    name: "runinback:preload-fonts",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        if (!ctx.bundle) return [];
        return Object.keys(ctx.bundle)
          .filter((file) => PRELOADED_FONTS.test(file))
          .map((file) => ({
            tag: "link",
            attrs: { rel: "preload", as: "font", type: "font/woff2", crossorigin: "", href: "/" + file },
            injectTo: "head-prepend",
          }));
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, rootDir, "");
  const publicConfig = {
    supabaseUrl: env.SUPABASE_URL || "",
    supabaseAnonKey: env.SUPABASE_ANON_KEY || "",
    stripeEnabled: isTruthy(env.STRIPE_ENABLED),
    cryptoEnabled: isTruthy(env.CRYPTO_ENABLED),
  };

  return {
    root: srcDir,
    publicDir: resolve(rootDir, "public"),
    appType: "mpa",
    plugins: [preloadFonts()],
    envDir: rootDir,
    resolve: {
      alias: { "@game-rules": gameRulesDir },
    },
    define: {
      __RUNINBACK_CONFIG__: JSON.stringify(publicConfig),
    },
    build: {
      outDir: resolve(rootDir, "dist"),
      emptyOutDir: true,
      target: "es2020",
      // Emitted for error tracking uploads, but not referenced from the bundles.
      sourcemap: "hidden",
      rolldownOptions: {
        input: pages,
        output: {
          manualChunks: (id) => {
            if (id.includes('node_modules/@supabase/supabase-js')) {
              return 'supabase';
            } else if (id.includes('node_modules')) {
              return 'vendor';
            }
          },
        },
      },
    },
    server: {
      port: 5173,
      fs: { allow: [srcDir, gameRulesDir] },
    },
  };
});
