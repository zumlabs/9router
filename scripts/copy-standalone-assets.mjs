import { cpSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Appwrite Sites injects APPWRITE_*-prefixed variables (e.g. APPWRITE_SITE_PROJECT_ID)
// into every site deployment, readable at build and runtime. They are never part of
// local/Docker/VPS builds (this repo references no APPWRITE_* keys itself), so their
// presence reliably signals an Appwrite build. SKIP_STANDALONE_PUBLIC_COPY=1 is an
// explicit manual override for the same behavior.
const isAppwriteBuild =
  process.env.SKIP_STANDALONE_PUBLIC_COPY === "1" ||
  Object.keys(process.env).some((key) => key.startsWith("APPWRITE_"));

export function copyStandaloneAssets({ projectRoot = process.cwd(), distDir = process.env.NEXT_DIST_DIR || ".next" } = {}) {
  if (process.env.NEXT_TRACING_ROOT_MODE === "workspace") {
    console.log("[standalone-assets] Skipping workspace-traced CLI build; CLI packaging handles assets");
    return;
  }

  const buildDir = resolve(projectRoot, distDir);
  const standaloneDir = resolve(buildDir, "standalone");

  if (!existsSync(standaloneDir)) {
    console.log(`[standalone-assets] No standalone build found at ${standaloneDir}`);
    return;
  }

  const staticSource = resolve(buildDir, "static");
  const staticDestination = resolve(standaloneDir, distDir, "static");
  if (existsSync(staticSource)) {
    cpSync(staticSource, staticDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied static assets to ${staticDestination}`);
  }

  const publicSource = resolve(projectRoot, "public");
  const publicDestination = resolve(standaloneDir, "public");
  if (isAppwriteBuild) {
    // Appwrite Sites' internal SSR bundler moves the repo public/ into the
    // standalone output itself during "Bundling for SSR". A pre-existing
    // non-empty standalone/public/<dir> makes that rename fail with
    // "mv: can't rename '.../public/<dir>': Directory not empty", so the
    // copy must be skipped here and left for the platform to perform.
    rmSync(publicDestination, { recursive: true, force: true });
    console.log("[standalone-assets] Appwrite build detected; skipping public/ copy (platform SSR bundler moves public/ itself)");
  } else if (existsSync(publicSource)) {
    cpSync(publicSource, publicDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied public assets to ${publicDestination}`);
  }

  // Without it beside server.js the standalone build serves requests unsanitized.
  const serverWrapperSource = resolve(projectRoot, "custom-server.js");
  const serverWrapperDestination = resolve(standaloneDir, "custom-server.js");
  if (existsSync(serverWrapperSource)) {
    cpSync(serverWrapperSource, serverWrapperDestination, { force: true });
    console.log(`[standalone-assets] Copied custom-server.js to ${serverWrapperDestination}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(dirname(fileURLToPath(import.meta.url)), "copy-standalone-assets.mjs")) {
  copyStandaloneAssets();
}
