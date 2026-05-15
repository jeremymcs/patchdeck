import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5001";
const OUT_DIR = resolve(process.cwd(), "docs/assets");

const PAGES = [
  { route: "/", file: "PatchDeck-Dashboard.png", waitFor: "body" },
  { route: "/prs", file: "PatchDeck-PRs.png", waitFor: "body" },
  { route: "/issues", file: "PatchDeck-Issues.png", waitFor: "body" },
  { route: "/releases", file: "PatchDeck-Releases.png", waitFor: "body" },
  { route: "/logs", file: "PatchDeck-Logs.png", waitFor: "body" },
  { route: "/settings", file: "PatchDeck-Settings.png", waitFor: "body" },
];

await mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});

// Seed localStorage so next-themes picks dark on first paint and avoids a flash.
await context.addInitScript(() => {
  try {
    localStorage.setItem("theme", "dark");
  } catch {}
});

const page = await context.newPage();

for (const { route, file, waitFor } of PAGES) {
  const url = `${BASE}/#${route}`;
  process.stdout.write(`→ ${url}\n`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForSelector(waitFor, { timeout: 10_000 });
  // Allow dashboard polls and activity-driven UI to settle before capture.
  await page.waitForTimeout(10000);
  const out = resolve(OUT_DIR, file);
  await page.screenshot({ path: out, fullPage: false });
  await mkdir(dirname(out), { recursive: true });
  process.stdout.write(`  ✓ ${out}\n`);
}

await browser.close();
process.stdout.write("done\n");
