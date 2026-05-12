# PatchDeck

[![npm version](https://img.shields.io/npm/v/patchdeck.svg)](https://www.npmjs.com/package/patchdeck)
[![CI](https://github.com/jeremymcs/patchdeck/actions/workflows/ci.yml/badge.svg)](https://github.com/jeremymcs/patchdeck/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)

PatchDeck is a local-first GitHub PR babysitter. It watches the pull requests you care about, reads review feedback and CI failures, then dispatches your local Codex or Claude CLI to make fixes in isolated worktrees and push them back to the PR branch.

If you regularly lose time to review comments, flaky checks, merge conflicts, and back-and-forth cleanup before merge, this is the tool for that.

<!-- TODO: drop a fresh screenshot of the PatchDeck dashboard here. -->

> ⚠ PatchDeck helps developers ship high-quality code fast, and the tradeoff is heavy coding-agent usage. Expect it to use a lot of tokens, which can increase your AI provider costs. It's built for tokenmaxing.

## Why it exists

Pull requests stall for boring reasons:

- review comments arrive after you've switched context
- CI fails after you think the work is done
- fixes require reopening local context and rebuilding the same mental model
- merge prep becomes repetitive babysitting instead of real development

PatchDeck keeps that loop moving from your machine. You push a branch, let it watch the PR, and come back to something much closer to merge-ready.

## Quick start

Prerequisites:

- Node.js 22+
- `git`
- GitHub auth via `gh auth login` **or** `GITHUB_TOKEN`
- one of the `codex` or `claude` CLIs installed and authenticated locally

Install and launch:

```bash
npm install -g patchdeck
patchdeck
```

That starts the dashboard server and opens the browser dashboard. Then:

1. Add a GitHub repository to watch (or paste a single PR URL).
2. Choose per-repo whether to auto-discover only your PRs or your team's PRs too.
3. Let PatchDeck sync feedback and start working.

## What it does

**Watches and reacts** to review activity, comments, and failing checks on tracked PRs.

**Triages every comment** before touching code — runs an LLM evaluation that decides whether a comment needs a code fix, an acknowledgement, or no action. Comments from **trusted reviewers** skip the evaluation entirely and go straight to the fix queue.

**Dispatches agents in isolation** — every fix runs in an app-owned repo cache and an isolated git worktree under `~/.patchdeck`. Agent changes stay scoped to the PR branch, never your day-to-day checkout.

**Pushes verified fixes** back to the PR branch and posts threaded replies on the GitHub conversation. Resolves the conversation when the fix lands.

**Generates release artifacts** — when a merged PR is significant enough to release, PatchDeck can propose a version bump, write release notes, and create the GitHub release. The Releases page surfaces both PatchDeck's pipeline runs and the actual GitHub releases (including ones created outside the pipeline), with a one-click **Generate social post** button that produces Twitter/X + LinkedIn copy from any release's notes.

**Heals CI failures** — optional bounded-attempt healing for failing PR heads, plus deployment health monitoring for merged changes on Vercel and Railway.

**Answers questions** about tracked PRs through the dashboard or MCP. Ask "did this fail review?" or "what's the agent doing?" and the local agent reads activity logs and feedback to respond.

## Interfaces

PatchDeck talks to you in four ways — pick whichever fits your workflow.

| Interface | How to launch | What it's for |
| --- | --- | --- |
| Web dashboard | `patchdeck` | Primary UI. PRs, issues, releases, settings. |
| Desktop app | `npm run tauri:build` then open `PatchDeck.app` | Same UI plus a **menu-bar tray** with live PR/issue counts, auto-mode toggles, and quick actions without surfacing the window. |
| MCP server | `patchdeck mcp` | Drive every capability from an MCP-compatible host (Claude Desktop, etc.). |
| Local REST API | bundled with the dashboard server | Same surface programmatically; see [LOCAL_API.md](LOCAL_API.md). |

### Menu-bar tray (macOS)

The desktop build adds a tray icon to your menu bar that:

- shows live PR + issue counts and the most recent activity
- exposes **Auto mode** — independent on/off switches for "Auto PRs" and "Auto Issues" so you can pause one stream without pausing the other
- click the icon → drop-down with "Open PatchDeck" and "Quit PatchDeck"
- closing the main window **hides** it instead of quitting; the tray keeps everything alive until you explicitly quit

The tray polls the local server every 5s, so toggles taken in the web UI reflect immediately in the menu and vice versa.

## Configuration

PatchDeck reads its config from `~/.patchdeck/state.sqlite`. Override the home directory with `PATCHDECK_HOME` if you want it elsewhere.

Key controls (all editable in Settings):

- **Trusted reviewers** — comments from these GitHub logins skip evaluation and go straight to the agent fix queue
- **Ignored bots** — bot logins whose comments and reviews are ignored entirely
- **Auto mode** — global toggles for PR babysitting and issue auto-work; the header chip in the web UI shows current state
- **Drain mode** — emergency pause across all automation (kept separate from the per-area auto toggles)
- **Coding agent** — `codex` or `claude` (per install), plus optional fallback to the other if the primary fails
- **Per-repo settings** — `My PRs only` vs `My PRs + teammates`, auto-create releases on merge, auto-evaluate issues

## Authentication

PatchDeck authenticates to GitHub with the first of these it finds:

1. App config (paste a Personal Access Token into Settings)
2. `GITHUB_TOKEN` environment variable
3. `gh auth token` (the GitHub CLI's stored credential)

The desktop build captures these from your login shell on macOS — `gh` and `GITHUB_TOKEN` defined in `~/.zshrc`/`~/.zshenv`/`~/.bash_profile` resolve correctly even when the app is launched from Finder.

## Commands

```bash
patchdeck              # web dashboard
patchdeck mcp          # MCP server
patchdeck --help       # help
patchdeck --version    # version
```

Logging flags work with both subcommands and can appear before or after the subcommand:

```bash
patchdeck -q                    # errors only
patchdeck --verbose             # debug level
patchdeck --debug               # alias for --verbose
patchdeck --trace               # maximum verbosity
patchdeck --log-level warn      # explicit level
patchdeck --log-file ./out.log  # override file destination
patchdeck --no-log-file         # disable file logging entirely
```

Set `PORT` to change the dashboard port (default `5001`). For `patchdeck mcp` connecting to a non-default port, set `PATCHDECK_PORT`.

## Remote dashboard access

Loopback (local) browser and API access need no login. To use the dashboard from another machine, set credentials before starting the server:

```bash
PATCHDECK_WEB_USERNAME=operator \
PATCHDECK_WEB_PASSWORD='choose-a-long-password' \
PATCHDECK_SESSION_SECRET='choose-a-long-random-secret' \
patchdeck
```

Remote API requests then require a signed dashboard session. Put TLS in front of the server before exposing it over an untrusted network.

## Logging

Server output is structured (pino) and ships to two destinations by default:

- stdout (pretty-printed in dev, JSON in production)
- `~/.patchdeck/log/server.log` (or under `PATCHDECK_HOME`)

Override the file path with `--log-file <path>` or `PATCHDECK_LOG_FILE`. Disable file logging with `--no-log-file` or `PATCHDECK_NO_LOG_FILE=1`. Set the level with `--log-level <trace|debug|info|warn|error|fatal>` or `LOG_LEVEL`. Defaults: `info` in production, `debug` in development.

GitHub tokens are redacted before any log line is written. The sanitizer replaces these values with `[REDACTED]`:

- `ghp_/gho_/ghs_/ghu_/ghr_` prefixes
- `github_pat_…` tokens
- `x-access-token:…@` URLs
- `Bearer …` / `token …` authorization values

## Run from source

```bash
git clone https://github.com/jeremymcs/patchdeck.git
cd patchdeck
npm install
npm run dev
```

Dashboard at `http://localhost:5001` by default. Loopback API requests work without login; remote access requires `PATCHDECK_WEB_USERNAME` and `PATCHDECK_WEB_PASSWORD`.

## Development

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the development server |
| `npm run build` | Build the production bundle |
| `npm run start` | Run the production build |
| `npm run mcp` | Start the MCP server |
| `npm run check` | TypeScript check |
| `npm run lint` | ESLint |
| `npm run test` | Server test suite |
| `npm run test:all` | Server tests + client library tests |
| `npm run tauri:dev` | Start the Tauri desktop app in development |
| `npm run tauri:build` | Build the Tauri desktop app + DMG |

## Docs

- [Getting Started](docs/public/getting-started.md)
- [PR Babysitter](docs/public/pr-babysitter.md)
- [Agent Dispatch](docs/public/agent-dispatch.md)
- [PR Q&A](docs/public/pr-questions.md)
- [Configuration](docs/public/configuration.md)
- [Local API and MCP](LOCAL_API.md)
- [Contributing](CONTRIBUTING.md)

## Credits

PatchDeck began as a fork of [yungookim/oh-my-pr](https://github.com/yungookim/oh-my-pr) by KimY. Thanks for the foundation this builds on.

## License

[MIT](LICENSE) © 2026 KimY
