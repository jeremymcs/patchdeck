import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { getCodeFactoryPaths } from "./paths";

test("getCodeFactoryPaths prefers PATCHDECK_HOME, then legacy homes, then ~/.patchdeck", () => {
  const previousPatchdeckHome = process.env.PATCHDECK_HOME;
  const previousOhMyPrHome = process.env.OH_MY_PR_HOME;
  const previousCodeFactoryHome = process.env.CODEFACTORY_HOME;

  try {
    process.env.PATCHDECK_HOME = "/tmp/patchdeck-test";
    process.env.OH_MY_PR_HOME = "/tmp/oh-my-pr-test";
    process.env.CODEFACTORY_HOME = "/tmp/codefactory-test";

    const preferred = getCodeFactoryPaths();
    assert.equal(preferred.rootDir, "/tmp/patchdeck-test");
    assert.equal(preferred.repoRootDir, "/tmp/patchdeck-test/repos");
    assert.equal(preferred.worktreeRootDir, "/tmp/patchdeck-test/worktrees");

    delete process.env.PATCHDECK_HOME;

    const renamedLegacy = getCodeFactoryPaths();
    assert.equal(renamedLegacy.rootDir, "/tmp/oh-my-pr-test");
    assert.equal(renamedLegacy.repoRootDir, "/tmp/oh-my-pr-test/repos");
    assert.equal(renamedLegacy.worktreeRootDir, "/tmp/oh-my-pr-test/worktrees");

    delete process.env.OH_MY_PR_HOME;

    const legacy = getCodeFactoryPaths();
    assert.equal(legacy.rootDir, "/tmp/codefactory-test");
    assert.equal(legacy.repoRootDir, "/tmp/codefactory-test/repos");
    assert.equal(legacy.worktreeRootDir, "/tmp/codefactory-test/worktrees");

    delete process.env.CODEFACTORY_HOME;

    const newDefaultRoot = path.join(os.homedir(), ".patchdeck");
    const legacyDefaultRoot = path.join(os.homedir(), ".oh-my-pr");
    const expectedDefaultRoot = fs.existsSync(legacyDefaultRoot) && !fs.existsSync(newDefaultRoot)
      ? legacyDefaultRoot
      : newDefaultRoot;
    const fallback = getCodeFactoryPaths();
    assert.equal(fallback.rootDir, expectedDefaultRoot);
    assert.equal(fallback.repoRootDir, path.join(expectedDefaultRoot, "repos"));
    assert.equal(fallback.worktreeRootDir, path.join(expectedDefaultRoot, "worktrees"));
  } finally {
    if (previousPatchdeckHome === undefined) {
      delete process.env.PATCHDECK_HOME;
    } else {
      process.env.PATCHDECK_HOME = previousPatchdeckHome;
    }

    if (previousOhMyPrHome === undefined) {
      delete process.env.OH_MY_PR_HOME;
    } else {
      process.env.OH_MY_PR_HOME = previousOhMyPrHome;
    }

    if (previousCodeFactoryHome === undefined) {
      delete process.env.CODEFACTORY_HOME;
    } else {
      process.env.CODEFACTORY_HOME = previousCodeFactoryHome;
    }
  }
});
