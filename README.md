# PatchDeck

[![CI](https://github.com/jeremymcs/patchdeck/actions/workflows/ci.yml/badge.svg)](https://github.com/jeremymcs/patchdeck/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)

PatchDeck is a local-first GitHub workbench for pull requests and issues. It watches the stuff you care about, figures out what needs action, then sends your local coding agent into an isolated worktree to fix it and push the result back to GitHub.

If your PRs die slowly from review comments, flaky checks, merge conflicts, "one tiny follow-up", and the usual pre-merge paperwork, this is the tool for that.

![PatchDeck PRs dashboard](docs/assets/PatchDeck-PRs.png)

![PatchDeck Issues dashboard](docs/assets/PatchDeck-Issues.png)

> ⚠ PatchDeck is built for tokenmaxing. It can save real engineering time, but it will happily spend agent tokens doing the boring work. Watch your provider bill like an adult.

## Why it exists

Pull requests usually do not stall because the hard part is hard. They stall because the boring stuff keeps showing back up:

- review comments arrive after you have already moved on
- CI fails after the victory lap
- merge conflicts show up wearing a fake mustache
- issues are clear enough to fix, but still need someone to do the plumbing
- release notes, status replies, and follow-up PRs turn into tiny paper cuts

PatchDeck keeps that loop moving from your machine. You add the repos, keep control of when work runs, and let the app handle the repeatable cleanup.

## Quick start

Prerequisites:

- Node.js 22+
- `git`
- GitHub auth via `gh auth login` **or** `GITHUB_TOKEN`
- one of the `codex` or `claude` CLIs installed and authenticated locally

Install from npm and launch:

```bash
npm install -g @jeremymcs/patchdeck
patchdeck
```

The package name is scoped because `patchdeck` is already taken on npm. The CLI command is still `patchdeck`, because we are not monsters.

That starts the dashboard server and opens the browser dashboard. From there:

1. Add a GitHub repository to watch (or paste a single PR URL).
2. Choose whether PatchDeck should track only your PRs or your team's PRs too.
3. Review PRs on the PRs page and repository issues on the Issues page.
4. Use manual **Work issue** / PR actions until you trust the setup.
5. Turn on auto mode when you are ready to let it cook.

## What it does

### PR monitoring

PatchDeck monitors tracked pull requests from repositories you watch or PR URLs you paste directly. It syncs PR metadata, review threads, top-level comments, failing checks, mergeability, docs assessment state, and release readiness into one dashboard. The goal is simple: one place to see why a PR is not merged yet.

It triages every comment before touching code. PatchDeck decides whether feedback needs a code fix, an acknowledgement, or no action. Comments from **trusted reviewers** can skip the evaluation entirely and go straight to the fix queue, because some people have earned the fast lane.

Every PR fix runs in an app-owned repo cache and an isolated git worktree under `~/.patchdeck`. Agent changes stay scoped to the PR branch, never your day-to-day checkout.

PatchDeck pushes verified fixes back to the PR branch, posts threaded replies on the GitHub conversation, and resolves conversations when the fix lands. Less tab juggling, fewer "what was I doing here?" moments.

### Issues monitoring

PatchDeck also monitors open GitHub issues for watched repositories. The Issues page shows the full issue body, labels, author, comments, latest work state, failed attempts, ready-to-merge PR links, and auto-work eligibility. It is not trying to be Jira. Nobody asked for that.

Manual issue work starts only when you press **Work issue**. PatchDeck creates an isolated worktree, honors repository guidance such as `CONTRIBUTING.md` when present, works the issue, verifies the fix, pushes a branch, and opens a linked PR. If the resulting PR becomes mergeable, the Issues page shows that readiness in both the issue detail view and list view.

Auto issue work is opt-in per repository and gated by labels and safety checks. Issues need an agent-ready label such as `ready-for-agent`, `ready-to-work`, `agent-ready`, or `ready`, and PatchDeck skips blocked/discussion labels such as `blocked`, `question`, `needs-maintainer-review`, `needs-author-feedback`, and `needs-discussion`.

**Generates release artifacts** — when a merged PR is significant enough to release, PatchDeck can propose a version bump, write release notes, and create the GitHub release. The Releases page surfaces PatchDeck pipeline runs and actual GitHub releases, including ones created outside the app. There is also a one-click **Generate social post** button, because apparently we live here now.

**Heals CI failures** — optional bounded-attempt healing for failing PR heads, plus deployment health monitoring for merged changes on Vercel and Railway. It will retry with limits, not vibes.

**Answers questions** about tracked PRs through the dashboard or MCP. Ask "did this fail review?" or "what's the agent doing?" and PatchDeck reads the stored activity logs and feedback instead of making you spelunk through tabs.

## Interfaces

PatchDeck talks to you in four ways. Pick the one that annoys you least.

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

PatchDeck reads its config from `~/.patchdeck/state.sqlite`. Override the home directory with `PATCHDECK_HOME` if you want the state somewhere else.

Key controls (all editable in Settings):

- **Trusted reviewers** — comments from these GitHub logins skip evaluation and go straight to the agent fix queue
- **Priority issue authors** — issues from these GitHub logins are evaluated and worked before the regular issue queue
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

These commands are available after the npm install flow above.

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

Remote API requests then require a signed dashboard session. Put TLS in front of the server before exposing it over an untrusted network. The internet remains undefeated.

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

Dashboard at `http://localhost:5001` by default. Loopback API requests work without login; remote access requires `PATCHDECK_WEB_USERNAME` and `PATCHDECK_WEB_PASSWORD`, or the Settings-page credentials once that config is saved.

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
