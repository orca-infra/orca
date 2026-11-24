# Orca Framework

This repo is the Orca agent framework — composable tools for AI-assisted software development.

## What This Repo Contains

- `framework/` — the framework files (seed, perspectives, one-shot mode, tools), installed into projects as `.orca/`
- `docs/` — Framework design documentation
- `.claude/skills/` — Claude Code skills; `install-orca` lists the ones installed into projects
- `cli/` — the `orca` command (TypeScript, compiled with Bun) that runs on the Mac and manages project containers; `make help` lists its build and test tasks. `make check` runs every test that runs here (unit, React, browser); the Docker end-to-end tests (`cli/test/e2e/`) run in CI
- Docker/bash infrastructure — `Dockerfile`, `orca-migrate.sh`, etc.
- `container-features.md` — everything orca adds to a project's container (at creation, and every time); a test checks it names every feature and mount in the code

## How `cli/` is built

Each thing is done one way, in the module that owns it; `cli/test/unit/architecture.test.ts` enforces most of this, and a failure there means using the owner, not loosening the rule.

- **Layers**: core (`cli/*.ts`) < `ui/` < `commands/` < `server/` < the entry point (`orca.ts`); a module imports only from its own layer or below, and nothing imports back around in a cycle. `web/` runs in the browser and takes only types from the rest.
- **Owners**: Docker is called through `docker.ts` (`docker()` for what must succeed, `probe()` for questions, `attach()` for a terminal); every path under `~/.orca` comes from `state.ts`; every Docker name, label and image name from `names.ts`; every command run inside a container from `in-container.ts`.
- **Lists of things are registries in code**, typed and tested, added to rather than branched around: a command's steps (`steps.ts`: each needed or optional, so fail-safe is the default), older containers by generation (`compat.ts`), creation features (`creation.ts`), plain-container kinds (`commands/fallback.ts`). A change that needs older containers handled differently raises the generation (the Dockerfile's `orca.generation` label) and adds an entry to `compat.ts`.
- **Act on the state that's needed**, not on failures seen before: check what something needs and report what's missing, always with what actually went wrong. Docs describe what code holds; code never reads them, and a doc that repeats code has a test that keeps it the same.

## Framework / Installed Boundary

**Installed into target projects**: everything in `framework/` (as `.orca/`), and the skills `install-orca` lists

**Stays in the orca repo only**: `docs/`, `AGENTS.md`, `CLAUDE.md`, `CHANGELOG.md`, Docker/bash scripts

## Essential Reading

**`docs/design-principles.md`** — 10 principles governing all framework design. Key ones:
- **P2 (Principles Over Prescriptions)** — State principles, trust the executor
- **P3 (Specification-Creativity Tradeoff)** — Over-specifying REDUCES quality
- **P7 (Lightning-Quick Descriptions)** — Every file costs tokens. Be minimal.

## Framework Design Anti-Patterns

From analysis of OMC, Superpowers, and Gas Town:

- **Prescriptiveness trap**: More rules → more corner cases → more patches → complexity explosion
- **Anti-rationalization tables**: Adversarial arms race. Trust and correct after, don't pre-empt.
- **Over-classification of roles**: 30 agent types creates a routing problem. Keep roles broad.
- **Custom vocabulary**: Invented terminology wastes tokens and confuses.
- **Mandatory activation**: Let the AI decide what applies.

## Container Trust Boundary

Agents in project containers are treated as untrusted by the tooling on the Mac. Current guards, and why: containers see only their own home under `~/.orca` (so secrets there, like the dashboard token, stay out of reach); forwards are reachable from the Mac but not from other projects' containers; the certificate authority behind HTTPS forwards, which the Mac is asked to trust, keeps its key in a Docker volume only the proxy mounts; the `orca serve` dashboard listens on loopback and requires its token, with cross-site and DNS-rebinding checks, because containers and web pages can both reach the Mac's loopback. Change these when there's reason to, keeping the boundary in mind.

## Changelog

`CHANGELOG.md` is what people using Orca should know, not the history: anything they have to do after updating (an entry starting **Action needed:**), changes they'd notice, and new things worth knowing about. Add the entry in the PR that makes the change, under that day's `## yyyy-mm-dd`; `install-orca` reads it, and `orca update` links to it. Code never reads it: what `orca` must tell people (a deprecation, say) comes from code, like `cli/compat.ts`.

## Git Rules

- NEVER push to main directly
- Always work on feature branches
- Small, logical commits with clear messages
