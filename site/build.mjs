// PatchDeck Website — static build (Tailwind CLI + asset copy)
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const ROOT = import.meta.dirname;
const DIST = path.join(ROOT, "dist");
const PUBLIC = path.join(ROOT, "public");
const watch = process.argv.includes("--watch");

const tailwindBin = path.join(
  ROOT,
  "node_modules/.bin",
  process.platform === "win32" ? "tailwindcss.cmd" : "tailwindcss",
);

/** Recursively copy a directory into dist, preserving structure. */
function copyDir(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

function copyStatic() {
  fs.mkdirSync(DIST, { recursive: true });
  fs.copyFileSync(path.join(ROOT, "index.html"), path.join(DIST, "index.html"));
  copyDir(PUBLIC, DIST);
}

const cssArgs = [
  "-c",
  path.join(ROOT, "tailwind.config.cjs"),
  "-i",
  path.join(ROOT, "src/input.css"),
  "-o",
  path.join(DIST, "styles.css"),
];

fs.rmSync(DIST, { recursive: true, force: true });
copyStatic();

if (watch) {
  // Build the stylesheet once up front. dist/ was just cleared, and the watcher
  // below may take a moment (or fail) to produce it — without this the page
  // serves with a 404 on styles.css.
  const initial = spawnSync(tailwindBin, cssArgs, { stdio: "inherit" });
  if (initial.status !== 0) process.exit(initial.status ?? 1);

  fs.watch(path.join(ROOT, "index.html"), () => copyStatic());
  fs.watch(PUBLIC, { recursive: true }, () => copyStatic());

  // stdin must be an open pipe we never write to or close. The Tailwind CLI
  // watcher shuts down the moment stdin reaches EOF, which is what both
  // "inherit" (when detached) and "ignore" (/dev/null) hand it immediately.
  const watcher = spawn(tailwindBin, [...cssArgs, "--watch"], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  watcher.on("exit", (code) => {
    console.error(`tailwind --watch exited (${code}); css is no longer rebuilding`);
  });

  console.log("watching — dist/ is live on the files it has built");
} else {
  const result = spawnSync(tailwindBin, [...cssArgs, "--minify"], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);

  const size = (file) => (fs.statSync(path.join(DIST, file)).size / 1024).toFixed(1);
  console.log(`\nbuilt dist/ — index.html ${size("index.html")} KB, styles.css ${size("styles.css")} KB`);
}
