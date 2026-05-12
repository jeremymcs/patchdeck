import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { migrateLegacyHomeIfNeeded } from "./migrateLegacyHome";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `migrate-home-${prefix}-`));
}

function seed(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "state.sqlite"), "deadbeef");
  fs.mkdirSync(path.join(dir, "log", "2026-05-12"), { recursive: true });
  fs.writeFileSync(path.join(dir, "log", "2026-05-12", "x.log"), "line\n");
}

test("migrateLegacyHomeIfNeeded skips when env override is set", () => {
  const root = tmpDir("env");
  const legacy = path.join(root, "legacy");
  const preferred = path.join(root, "preferred");
  seed(legacy);

  const result = migrateLegacyHomeIfNeeded({
    legacy,
    preferred,
    env: { PATCHDECK_HOME: "/somewhere/else" },
  });

  assert.equal(result.migrated, false);
  assert.equal(fs.existsSync(legacy), true);
  assert.equal(fs.existsSync(preferred), false);
});

test("migrateLegacyHomeIfNeeded skips when preferred already exists", () => {
  const root = tmpDir("both");
  const legacy = path.join(root, "legacy");
  const preferred = path.join(root, "preferred");
  seed(legacy);
  fs.mkdirSync(preferred);

  const result = migrateLegacyHomeIfNeeded({ legacy, preferred, env: {} });

  assert.equal(result.migrated, false);
  assert.equal(fs.existsSync(legacy), true);
  assert.equal(fs.existsSync(preferred), true);
});

test("migrateLegacyHomeIfNeeded skips when legacy does not exist", () => {
  const root = tmpDir("none");
  const legacy = path.join(root, "legacy");
  const preferred = path.join(root, "preferred");

  const result = migrateLegacyHomeIfNeeded({ legacy, preferred, env: {} });

  assert.equal(result.migrated, false);
  assert.equal(fs.existsSync(preferred), false);
});

test("migrateLegacyHomeIfNeeded renames legacy to preferred and preserves contents", () => {
  const root = tmpDir("happy");
  const legacy = path.join(root, "legacy");
  const preferred = path.join(root, "preferred");
  seed(legacy);

  const result = migrateLegacyHomeIfNeeded({ legacy, preferred, env: {} });

  assert.equal(result.migrated, true);
  if (result.migrated) {
    assert.equal(result.from, legacy);
    assert.equal(result.to, preferred);
  }
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(fs.existsSync(preferred), true);
  assert.equal(fs.readFileSync(path.join(preferred, "state.sqlite"), "utf8"), "deadbeef");
  assert.equal(fs.readFileSync(path.join(preferred, "log", "2026-05-12", "x.log"), "utf8"), "line\n");
});

test("migrateLegacyHomeIfNeeded is idempotent on a second run", () => {
  const root = tmpDir("idem");
  const legacy = path.join(root, "legacy");
  const preferred = path.join(root, "preferred");
  seed(legacy);

  const first = migrateLegacyHomeIfNeeded({ legacy, preferred, env: {} });
  assert.equal(first.migrated, true);

  const second = migrateLegacyHomeIfNeeded({ legacy, preferred, env: {} });
  assert.equal(second.migrated, false);
});
