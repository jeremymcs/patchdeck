import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "../../..");

type ParsedSource = {
  source: string;
  sourceFile: ts.SourceFile;
};

type SourceExpectation = [string, string | RegExp];

async function readProjectFile(relativePath: string) {
  return readFile(path.join(projectRoot, relativePath), "utf-8");
}

async function parseProjectFile(relativePath: string): Promise<ParsedSource> {
  const source = await readProjectFile(relativePath);
  return {
    source,
    sourceFile: ts.createSourceFile(
      relativePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      relativePath.endsWith(".tsx")
        ? ts.ScriptKind.TSX
        : relativePath.endsWith(".mjs")
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS,
    ),
  };
}

function walk(sourceFile: ts.SourceFile, callback: (node: ts.Node) => void) {
  const visit = (node: ts.Node) => {
    callback(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function getJsxAttributes(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement) {
  return node.attributes.properties.filter(ts.isJsxAttribute);
}

function getJsxAttributeValue(
  sourceFile: ts.SourceFile,
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string,
): string | true | undefined {
  const attr = getJsxAttributes(node).find((property) => property.name.getText(sourceFile) === name);
  if (!attr) return undefined;
  if (!attr.initializer) return true;
  if (ts.isStringLiteral(attr.initializer)) return attr.initializer.text;
  if (ts.isJsxExpression(attr.initializer)) {
    return attr.initializer.expression?.getText(sourceFile) ?? true;
  }
  return attr.initializer.getText(sourceFile);
}

function collectJsxAttributeValues(sourceFile: ts.SourceFile, name: string) {
  const values: Array<string | true> = [];
  walk(sourceFile, (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const value = getJsxAttributeValue(sourceFile, node, name);
      if (value !== undefined) values.push(value);
    }
  });
  return values;
}

function collectStringValues(sourceFile: ts.SourceFile) {
  const values: string[] = [];
  walk(sourceFile, (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      values.push(node.text);
    }
    if (ts.isJsxText(node)) {
      const text = node.getText(sourceFile).replace(/\s+/g, " ").trim();
      if (text) values.push(text);
    }
  });
  return values;
}

function valueMatches(value: string, expected: string | RegExp) {
  return typeof expected === "string" ? value === expected : expected.test(value);
}

function assertHasJsxAttribute(
  sourceFile: ts.SourceFile,
  attributeName: string,
  label: string,
  expected: string | RegExp,
) {
  const values = collectJsxAttributeValues(sourceFile, attributeName);
  assert.ok(
    values.some((value) => typeof value === "string" && valueMatches(value, expected)),
    `Expected ${label} to expose ${attributeName} ${expected}`,
  );
}

function assertHasTestId(sourceFile: ts.SourceFile, label: string, expected: string | RegExp) {
  assertHasJsxAttribute(sourceFile, "data-testid", label, expected);
}

function assertHasStringValue(sourceFile: ts.SourceFile, label: string, expected: string | RegExp) {
  const values = collectStringValues(sourceFile);
  assert.ok(
    values.some((value) => valueMatches(value, expected)),
    `Expected ${label} to include text/string ${expected}`,
  );
}

function assertHasExpression(sourceFile: ts.SourceFile, label: string, expected: RegExp) {
  let found = false;
  walk(sourceFile, (node) => {
    if (!found && expected.test(node.getText(sourceFile))) {
      found = true;
    }
  });
  assert.ok(found, `Expected ${label} to match ${expected}`);
}

function getFunctionText(sourceFile: ts.SourceFile, name: string) {
  let functionText: string | undefined;
  walk(sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      functionText = node.getText(sourceFile);
    }
  });
  assert.ok(functionText, `Expected ${name} function to exist`);
  return functionText;
}

function assertHasJsxTag(sourceFile: ts.SourceFile, label: string, tagName: string) {
  let found = false;
  walk(sourceFile, (node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      && node.tagName.getText(sourceFile) === tagName
    ) {
      found = true;
    }
  });
  assert.ok(found, `Expected ${label} to render <${tagName}>`);
}

function assertHasQueryKey(sourceFile: ts.SourceFile, label: string, endpoint: string) {
  let found = false;
  walk(sourceFile, (node) => {
    if (
      ts.isPropertyAssignment(node)
      && node.name.getText(sourceFile) === "queryKey"
      && ts.isArrayLiteralExpression(node.initializer)
      && node.initializer.elements.some((element) => ts.isStringLiteral(element) && element.text === endpoint)
    ) {
      found = true;
    }
  });
  assert.ok(found, `Expected ${label} to query ${endpoint}`);
}

function getStringLikeText(sourceFile: ts.SourceFile, node: ts.Expression) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return node.getText(sourceFile);
}

function assertHasApiRequest(
  sourceFile: ts.SourceFile,
  label: string,
  method: string,
  endpoint: string | RegExp,
) {
  let found = false;
  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || node.expression.getText(sourceFile) !== "apiRequest") {
      return;
    }
    const [methodArg, endpointArg] = node.arguments;
    if (!methodArg || !endpointArg || !ts.isExpression(endpointArg)) {
      return;
    }
    if (getStringLikeText(sourceFile, methodArg as ts.Expression) !== method) {
      return;
    }
    if (valueMatches(getStringLikeText(sourceFile, endpointArg), endpoint)) {
      found = true;
    }
  });
  assert.ok(found, `Expected ${label} to call ${method} ${endpoint}`);
}

function assertHasCallTarget(sourceFile: ts.SourceFile, label: string, callee: string, endpoint: string | RegExp) {
  let found = false;
  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || node.expression.getText(sourceFile) !== callee) {
      return;
    }
    if (
      node.arguments.some((argument) =>
        ts.isExpression(argument) && valueMatches(getStringLikeText(sourceFile, argument), endpoint)
      )
    ) {
      found = true;
    }
  });
  assert.ok(found, `Expected ${label} to call ${callee} with ${endpoint}`);
}

function assertContainsAll(sourceFile: ts.SourceFile, expectations: SourceExpectation[]) {
  for (const [label, expected] of expectations) {
    assertHasStringValue(sourceFile, label, expected);
  }
}

function assertHasRoutes(
  sourceFile: ts.SourceFile,
  expectedRoutes: Array<{ label: string; path?: string; component: string }>,
) {
  const routes: Array<{ path?: string; component?: string }> = [];
  walk(sourceFile, (node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      && node.tagName.getText(sourceFile) === "Route"
    ) {
      const routePath = getJsxAttributeValue(sourceFile, node, "path");
      const component = getJsxAttributeValue(sourceFile, node, "component");
      routes.push({
        path: typeof routePath === "string" ? routePath : undefined,
        component: typeof component === "string" ? component : undefined,
      });
    }
  });

  for (const expected of expectedRoutes) {
    assert.ok(
      routes.some((route) => route.path === expected.path && route.component === expected.component),
      `Expected ${expected.label} route to use ${expected.component}`,
    );
  }
}

test("full app QA route matrix is wired through the hash router", async () => {
  const { sourceFile } = await parseProjectFile("client/src/App.tsx");

  assertHasExpression(sourceFile, "hash router", /\buseHashLocation\b/);
  assertHasRoutes(sourceFile, [
    { label: "dashboard", path: "/", component: "Dashboard" },
    { label: "settings", path: "/settings", component: "Settings" },
    { label: "releases", path: "/releases", component: "Releases" },
    { label: "issues", path: "/issues", component: "Issues" },
    { label: "logs", path: "/logs", component: "Logs" },
    { label: "not found fallback", component: "NotFound" },
  ]);
});

test("dashboard keeps the QA-tested PR, repo, feedback, and side-panel workflows wired", async () => {
  const { sourceFile } = await parseProjectFile("client/src/pages/dashboard.tsx");

  for (const [label, testId] of [
    ["active tab", "tab-active"],
    ["archived tab", "tab-archived"],
    ["run-now action", "button-apply"],
    ["pause-resume watch action", "button-toggle-watch"],
    ["CI healing panel", "panel-ci-healing"],
    ["ask agent tab", "tab-ask"],
    ["activity tab", "tab-activity"],
    ["ask input", "input-question"],
    ["ask submit", "button-ask"],
    ["dashboard error pill", "dashboard-error-pill"],
    ["dashboard errors panel", "dashboard-errors-panel"],
    ["dashboard clear issue failure", "dashboard-clear-issue-failure"],
  ] satisfies SourceExpectation[]) {
    assertHasTestId(sourceFile, label, testId);
  }

  assertHasExpression(sourceFile, "feedback retry action", /\bretryMutation\b/);
  assertHasExpression(sourceFile, "feedback manual decisions", /\[\s*["']accept["']\s*,\s*["']reject["']\s*,\s*["']flag["']\s*\]/);

  for (const [label, endpoint] of [
    ["active PR API", "/api/prs"],
    ["archived PR API", "/api/prs/archived"],
    ["repo settings API", "/api/repos/settings"],
    ["activity API", "/api/activities"],
    ["config API", "/api/config"],
    ["runtime API", "/api/runtime"],
    ["healing session API", "/api/healing-sessions"],
  ] satisfies SourceExpectation[]) {
    assertHasQueryKey(sourceFile, label, endpoint);
  }

  assertHasApiRequest(sourceFile, "failed activity clear mutation", "DELETE", "/api/activities/failed");
  assertHasApiRequest(sourceFile, "issue failure clear mutation", "DELETE", "/api/issues/work/failures");
  assertHasApiRequest(sourceFile, "ask agent mutation", "POST", /`\/api\/prs\/\$\{prId\}\/questions`/);
  assertHasTestId(sourceFile, "dashboard drain banner", "dashboard-drain-banner");
  assertHasTestId(sourceFile, "dashboard drain reason", "dashboard-drain-reason");
  assertHasTestId(sourceFile, "activity drain note", "activity-drain-note");
  assertHasStringValue(sourceFile, "drain mode action label", "Paused by drain mode");
  assertHasStringValue(sourceFile, "blocked manual copy", "Manual runs are blocked while global automation is paused.");
  assertHasStringValue(sourceFile, "drained PR copy", "Background and manual runs are paused by drain mode.");
  assertHasStringValue(sourceFile, "drained ask copy", "Ask Agent is paused by drain mode.");
  assertHasStringValue(sourceFile, "queued drain copy", "Queued automation is paused until drain mode is disabled.");
  assertHasStringValue(sourceFile, "dashboard errors heading", "Needs attention");
  assertHasExpression(sourceFile, "dashboard drain state", /\bglobalDrainMode\b/);
  assertHasExpression(sourceFile, "dashboard active error count", /\bactiveErrorCount\b/);
});

test("issues page keeps the QA-tested issue monitor and work surface wired", async () => {
  const { sourceFile } = await parseProjectFile("client/src/pages/issues.tsx");

  assertHasQueryKey(sourceFile, "issues query", "/api/issues");
  assertHasQueryKey(sourceFile, "issue detail query", "/api/issues/detail");
  assertHasQueryKey(sourceFile, "runtime query", "/api/runtime");
  assertHasQueryKey(sourceFile, "issue logs query", "/api/logs");
  assertHasApiRequest(sourceFile, "issue work mutation", "POST", "/api/issues/work");
  assertHasApiRequest(sourceFile, "issue evaluation mutation", "POST", "/api/issues/evaluate");

  for (const [label, testId] of [
    ["refresh button", "button-refresh-issues"],
    ["work issue button", "button-work-issue"],
    ["evaluate issue button", "button-evaluate-issue"],
    ["repo filter bar", "repo-filter-bar"],
    ["auto eligible filter", "issue-auto-eligible-filter"],
    ["needs evaluation filter", "issue-needs-evaluation-filter"],
    ["review filter", "issue-review-filter"],
    ["failed filter", "issue-failed-filter"],
    ["stale filter", "issue-stale-filter"],
    ["issue body markdown", "issue-body-markdown"],
    ["issue work failed", "issue-work-failed"],
    ["clear issue failures action", "button-clear-issue-failures"],
    ["issue work stage", "issue-work-stage"],
    ["issue work attempt", "issue-work-attempt"],
    ["issue auto work state", "issue-auto-work-state"],
    ["issue evaluation state", "issue-evaluation-state"],
    ["issue evaluation state list", "issue-evaluation-state-list"],
    ["issue evaluation detail", "issue-evaluation-detail"],
    ["issue ready to merge", "issue-ready-to-merge"],
    ["issue ready to merge list", "issue-ready-to-merge-list"],
    ["issue work in progress list", "issue-work-in-progress-list"],
    ["issue list", "issue-list"],
    ["issue detail logs", "issue-detail-logs"],
  ] satisfies SourceExpectation[]) {
    assertHasTestId(sourceFile, label, testId);
  }

  assertHasExpression(sourceFile, "issue status tracking", /\bworkStatus\b/);
  assertHasExpression(sourceFile, "issue work logs", /\bissueLogs\b/);
  assertHasExpression(sourceFile, "issue body html rendering", /\bbodyHtml\b/);
  assertHasExpression(sourceFile, "issue markdown class", /issue-markdown/);
  assertHasExpression(sourceFile, "issue author line", /by\s+\{issue\.author\s*\|\|\s*["']unknown["']\}/);
  assertHasExpression(sourceFile, "issue log metadata chips", /\bgetLogMetadataEntries\b/);
  assertHasExpression(sourceFile, "issue work pr field", /\bworkPrUrl\b/);
  assertHasExpression(sourceFile, "issue work stage field", /\bworkStage\b/);
  assertHasExpression(sourceFile, "issue work attempt field", /\bworkAttemptCount\b/);
  assertHasExpression(sourceFile, "issue auto work eligibility", /\bautoWorkEligible\b/);
  assertHasExpression(sourceFile, "issue auto blocked reason", /\bautoWorkBlockedReason\b/);
  assertHasExpression(sourceFile, "issue work filter helper", /\bmatchesIssueWorkFilter\b/);
  assertHasExpression(sourceFile, "stale issue helper", /\bisStaleIssue\b/);
  assertHasExpression(sourceFile, "issue detail refresh", /\brefetchSelectedIssueDetail\b/);
  assertHasExpression(sourceFile, "issue PR mergeability", /\bworkPrMergeable\b/);
  assertHasStringValue(sourceFile, "issue body label", "Issue body");
});

test("dashboard finds latest target activity without sorting the full activity list", async () => {
  const { sourceFile } = await parseProjectFile("client/src/pages/dashboard.tsx");
  const helper = getFunctionText(sourceFile, "latestActivityForTarget");

  assert.match(helper, /\.reduce\(/);
  assert.doesNotMatch(helper, /\.filter\(/);
  assert.doesNotMatch(helper, /\.sort\(/);
  assert.match(helper, /Date\.parse/);
});

test("settings keeps the QA-tested configuration, token, and runtime controls wired", async () => {
  const { sourceFile } = await parseProjectFile("client/src/pages/settings.tsx");

  assertHasQueryKey(sourceFile, "settings config query", "/api/config");
  assertHasQueryKey(sourceFile, "runtime query", "/api/runtime");
  assertHasQueryKey(sourceFile, "repo settings query", "/api/repos/settings");
  assertHasApiRequest(sourceFile, "config mutation", "PATCH", "/api/config");
  assertHasApiRequest(sourceFile, "drain mutation", "POST", "/api/runtime/drain");
  assertHasApiRequest(sourceFile, "add PR mutation", "POST", "/api/prs");
  assertHasApiRequest(sourceFile, "watch repo mutation", "POST", "/api/repos");
  assertHasApiRequest(sourceFile, "repo sync mutation", "POST", "/api/repos/sync");
  assertHasApiRequest(sourceFile, "repo settings mutation", "PATCH", "/api/repos/settings");
  assertHasApiRequest(sourceFile, "repo remove mutation", "DELETE", /`\/api\/repos\/settings\/\$\{encodeURIComponent\(repo\)\}\?mode=\$\{mode\}`/);
  assertHasApiRequest(sourceFile, "manual release mutation", "POST", "/api/repos/release");

  assertHasJsxAttribute(sourceFile, "id", "coding agent selector", "settings-coding-agent");
  for (const [label, testId] of [
    ["add PR input", "input-add-pr"],
    ["add PR submit", "button-add-pr"],
    ["watch repo input", "input-add-repo"],
    ["watch repo submit", "button-add-repo"],
    ["remote access username", "input-remote-access-username"],
    ["remote access password", "input-remote-access-password"],
    ["remote access save", "button-save-remote-access"],
    ["repo sync action", "button-sync-repos"],
    ["fallback toggle", "checkbox-fallback-to-next-coding-agent"],
    ["auto resolve conflicts toggle", "checkbox-auto-resolve-conflicts"],
    ["auto update docs toggle", "checkbox-auto-update-docs"],
    ["runtime drain button", "button-toggle-drain"],
    ["runtime drain status", "text-drain-status"],
    ["release automation toggle", "checkbox-auto-create-releases"],
  ] satisfies SourceExpectation[]) {
    assertHasTestId(sourceFile, label, testId);
  }
  assertHasJsxTag(sourceFile, "repo tracking scope control", "WatchScopeControl");
  assertHasJsxTag(sourceFile, "issue work mode control", "IssueWorkModeControl");
  assertHasTestId(sourceFile, "tracked repo settings", /tracked-repo-\$\{repo\.repo\.replace\(\s*["']\/["']\s*,\s*["']-["']\s*\)\}/);
  assertHasTestId(sourceFile, "tracked repo soft remove", /tracked-repo-soft-remove-\$\{repo\.repo\.replace\(\s*["']\/["']\s*,\s*["']-["']\s*\)\}/);
  assertHasTestId(sourceFile, "tracked repo hard remove", /tracked-repo-hard-remove-\$\{repo\.repo\.replace\(\s*["']\/["']\s*,\s*["']-["']\s*\)\}/);
  assertHasExpression(
    sourceFile,
    "tracked repo issue work mode prefix",
    /testIdPrefix=\{`tracked-repo-issue-work-mode-\$\{repo\.repo\.replace\(\s*["']\/["']\s*,\s*["']-["']\s*\)\}`\}/,
  );
  assertHasExpression(sourceFile, "ordered GitHub tokens", /\bgithubTokens\b/);
});

test("logs route keeps the QA-tested filtering, streaming, copy, and download surface wired", async () => {
  const { sourceFile } = await parseProjectFile("client/src/pages/logs.tsx");

  assertHasCallTarget(sourceFile, "server logs API", "fetchJson", /`\/api\/server-logs\?\$\{params\.toString\(\)\}`/);
  assertHasExpression(sourceFile, "server logs stream API", /`\/api\/server-logs\/stream\?since=\$\{lastSeq\}`/);
  assertHasJsxAttribute(sourceFile, "id", "level filter", "logs-level");
  assertHasJsxAttribute(sourceFile, "id", "source filter", "logs-source");
  assertHasJsxAttribute(sourceFile, "type", "search input", "search");
  assertHasStringValue(sourceFile, "follow tail toggle", "follow tail");
  assertHasExpression(sourceFile, "copy action", /navigator\.clipboard\.writeText/);
  assertHasExpression(sourceFile, "download action", /patchdeck-logs-/);
});

test("releases route keeps the QA-tested list, expand, copy, retry, and GitHub link surfaces wired", async () => {
  const releases = await parseProjectFile("client/src/pages/releases.tsx");

  assertHasQueryKey(releases.sourceFile, "release route query", "/api/releases");
  assertHasQueryKey(releases.sourceFile, "github releases query", "/api/github-releases");
  assertHasApiRequest(releases.sourceFile, "release retry mutation", "POST", /`\/api\/releases\/\$\{id\}\/retry`/);
  assertHasJsxTag(releases.sourceFile, "release notes copy", "CopyButton");
  assertHasJsxTag(releases.sourceFile, "orphan github release card", "GitHubReleaseCard");
  assertContainsAll(releases.sourceFile, [
    ["github link button", "Open on GitHub"],
    ["sync github button tooltip", "Sync from GitHub"],
    ["orphan section header", "Published outside the pipeline"],
    ["empty release state", "No release activity yet."],
    ["watched repositories sidebar", "Watched repositories"],
  ]);
});
