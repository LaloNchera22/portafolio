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

const pages = Object.fromEntries(
  readdirSync(srcDir)
    .filter((file) => file.endsWith(".html"))
    .map((file) => [file.replace(/\.html$/, ""), resolve(srcDir, file)]),
);

const isTruthy = (value) => /^(1|true|yes|on)$/i.test(String(value || ""));

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
    envDir: rootDir,
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
      },
    },
    server: {
      port: 5173,
    },
  };
});
