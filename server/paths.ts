import os from "os";
import fs from "fs";
import path from "path";

export type CodeFactoryPaths = {
  rootDir: string;
  stateDbPath: string;
  logRootDir: string;
  repoRootDir: string;
  worktreeRootDir: string;
};

export function getCodeFactoryPaths(rootDirOverride?: string): CodeFactoryPaths {
  const newDefaultRoot = path.join(os.homedir(), ".patchdeck");
  const legacyDefaultRoot = path.join(os.homedir(), ".oh-my-pr");
  const rootDir = rootDirOverride
    || process.env.PATCHDECK_HOME
    || process.env.OH_MY_PR_HOME
    || process.env.CODEFACTORY_HOME
    || (fs.existsSync(legacyDefaultRoot) && !fs.existsSync(newDefaultRoot) ? legacyDefaultRoot : newDefaultRoot);

  return {
    rootDir,
    stateDbPath: path.join(rootDir, "state.sqlite"),
    logRootDir: path.join(rootDir, "log"),
    repoRootDir: path.join(rootDir, "repos"),
    worktreeRootDir: path.join(rootDir, "worktrees"),
  };
}
