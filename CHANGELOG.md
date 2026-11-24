# Changelog

What people using Orca should know, newest first: anything they have to do (marked **Action needed**), changes they'd notice, and new things worth knowing about. Everything else is in the git history. `orca update` shows the entries since the build it replaces; updating Orca in a project (`/install-orca`) shows the ones since that project's last update.

## 2026-11-24

- Before opening a terminal, `orca start` checks the container has what it needs: Docker can run a command in it, and the folders orca mounts from the Mac are there. If not, it says what's missing and what to try, instead of listing Docker's error as a terminal. A failing `docker` command now always shows what Docker said.
- When a step `orca start` can do without fails (the forwards proxy, the project's own network, applying box settings), it says what failed and what going on without it means, and asks whether to start anyway, instead of failing.
- The workspace file now says which repos it includes and what its search skips (hidden folders, `node_modules`). If it's yours (orca's first line removed), `orca start` says once when it doesn't list a repo, or lists a folder that's gone.
- Going back when an image is broken: `orca image ls` shows the current image, the previous one and the published ones (now tagged by date and commit too), and `orca image use previous` (or a published one) switches, offering to remake stopped projects' containers on it. `orca start --fresh --image <name>` does it for one project.
- Going back when `orca` is broken: `orca self ls` and `orca self use previous` (or a published build). `orca update` and `orca self use` keep the one they replace beside it, as `orca.previous`, which runs on its own; `install.sh` installs a given build: `… | bash -s -- <commit>`.
- `orca fallback`: work in a plain container, without orca's terminals, proxy or networks, when orca's usual one doesn't work.
- FALLBACKS.md: how to work in a project with plain `docker` commands when orca doesn't work.
- `orca start --fresh` and `orca delete` no longer remove the `node_modules` volume that containers made before 2026-10-22 had. Once those containers are recreated, remove any such volumes yourself: `docker volume ls`, then `docker volume rm <name>`.

## 2026-11-04

- In the `orca` project list, `u` switches the selected project to the newest image (shown when it has an image update), and `d` asks whether to delete its home too.
- Deleting a project's home now lists what's in it first, with sizes.

## 2026-11-03

- Orca moved to github.com/orca-infra/orca, and its image to ghcr.io/orca-infra/orca. Old links redirect and `orca update` switches over by itself, so there's nothing to do.
- `orca update` now shows what's new here when it updates itself.
