import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The brand is "PatchDeck" (display) but the package/identifier slug is
// "patchdeck" (lowercase). Files should contain at least one of the two.
const APP_BRAND_PATTERN = /patchdeck|PatchDeck/;
const APP_DISPLAY_NAME = "PatchDeck";
const APP_PACKAGE_NAME = "patchdeck";

async function readProjectFile(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("live app branding uses PatchDeck instead of Code Factory", async () => {
  const files = [
    "client/index.html",
    "client/src/components/AppHeader.tsx",
    "src-tauri/tauri.conf.json",
    "src-tauri/src/lib.rs",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "docs/public/_site/configuration.html",
    "server/localOnly.ts",
    "server/sqliteStorage.ts",
    "server/prQuestionAgent.ts",
    "server/mcp.ts",
  ];

  const contents = await Promise.all(files.map(async (file) => [file, await readProjectFile(file)] as const));
  for (const [file, content] of contents) {
    assert.doesNotMatch(content, /Code Factory|code factory|code-factory|PR Feedback Agent/, file);
    assert.match(content, APP_BRAND_PATTERN, file);
  }
});

test("standalone metadata names the app PatchDeck (display) and patchdeck (package)", async () => {
  const tauriConfig = JSON.parse(await readProjectFile("src-tauri/tauri.conf.json"));
  const cargoToml = await readProjectFile("src-tauri/Cargo.toml");

  assert.equal(tauriConfig.productName, APP_DISPLAY_NAME);
  assert.equal(tauriConfig.identifier, "com.fluxlabs.patchdeck");
  assert.equal(tauriConfig.app.windows[0].title, APP_DISPLAY_NAME);
  assert.match(cargoToml, new RegExp(`^name = "${APP_PACKAGE_NAME}"$`, "m"));
});

test("release metadata keeps Tauri package versions in sync", async () => {
  const packageJson = JSON.parse(await readProjectFile("package.json"));
  const tauriConfig = JSON.parse(await readProjectFile("src-tauri/tauri.conf.json"));
  const cargoToml = await readProjectFile("src-tauri/Cargo.toml");
  const releasePleaseConfig = JSON.parse(await readProjectFile("release-please-config.json"));
  const version = packageJson.version;

  assert.equal(tauriConfig.version, version);
  assert.match(cargoToml, new RegExp(`^version = "${version}"$`, "m"));

  const extraFilePaths = releasePleaseConfig.packages["."]["extra-files"].map((file: { path: string }) => file.path);
  assert.deepEqual(extraFilePaths, [
    "src-tauri/tauri.conf.json",
    "src-tauri/Cargo.toml",
  ]);
});
