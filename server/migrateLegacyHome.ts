import fs from "fs";
import os from "os";
import path from "path";
import { childLogger } from "./logger";

const log = childLogger("migrateLegacyHome");

const ENV_OVERRIDE_VARS = ["PATCHDECK_HOME", "OH_MY_PR_HOME", "CODEFACTORY_HOME"] as const;

export type MigrationResult =
  | { migrated: false; reason: string }
  | { migrated: true; from: string; to: string; mode: "rename" | "copy" };

export type MigrateLegacyHomeOptions = {
  legacy?: string;
  preferred?: string;
  env?: NodeJS.ProcessEnv;
};

function isEnvOverrideSet(env: NodeJS.ProcessEnv): boolean {
  return ENV_OVERRIDE_VARS.some((name) => {
    const value = env[name];
    return typeof value === "string" && value.trim() !== "";
  });
}

export function migrateLegacyHomeIfNeeded(options: MigrateLegacyHomeOptions = {}): MigrationResult {
  const env = options.env ?? process.env;
  const legacy = options.legacy ?? path.join(os.homedir(), ".oh-my-pr");
  const preferred = options.preferred ?? path.join(os.homedir(), ".patchdeck");

  if (isEnvOverrideSet(env)) {
    return { migrated: false, reason: "PATCHDECK_HOME / OH_MY_PR_HOME / CODEFACTORY_HOME is set" };
  }
  if (!fs.existsSync(legacy)) {
    return { migrated: false, reason: "no legacy directory" };
  }
  if (fs.existsSync(preferred)) {
    return { migrated: false, reason: "preferred directory already exists" };
  }

  log.info({ from: legacy, to: preferred }, "Migrating legacy PatchDeck home directory");

  try {
    fs.renameSync(legacy, preferred);
    log.info({ from: legacy, to: preferred, mode: "rename" }, "Legacy home migration complete");
    return { migrated: true, from: legacy, to: preferred, mode: "rename" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EXDEV") {
      throw err;
    }
  }

  // Cross-volume: copy then delete. Not atomic; on interruption the next launch
  // sees both directories exist and skips migration, requiring manual cleanup.
  fs.cpSync(legacy, preferred, { recursive: true, preserveTimestamps: true });
  try {
    fs.rmSync(legacy, { recursive: true, force: true });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), legacy },
      "Copied legacy home but failed to remove the original; delete it manually",
    );
  }

  log.info({ from: legacy, to: preferred, mode: "copy" }, "Legacy home migration complete (cross-volume copy)");
  return { migrated: true, from: legacy, to: preferred, mode: "copy" };
}
