# Changelog

What people using Orca should know, newest first: anything they have to do (marked **Action needed**), changes they'd notice, and new things worth knowing about. Everything else is in the git history. `orca update` shows the entries since the build it replaces; updating Orca in a project (`/install-orca`) shows the ones since that project's last update.

## 2026-11-20

- When Docker Desktop's file sharing stops working, a container loses its folders from the Mac (`/workspace` and `~`), so logins, `claude` and everything else in it seem to vanish. `orca start` now says that's what happened, and that restarting Docker Desktop is the fix (your files on the Mac are untouched), instead of listing Docker's error as a terminal.
- When a step `orca start` can do without fails (the forwards proxy, the project's own network, applying box settings), it says what failed and what going on without it means, and asks whether to start anyway, instead of failing.
- FALLBACKS.md: how to work in a project with plain `docker` commands when orca doesn't work.
- `orca start --fresh` and `orca delete` no longer remove the `node_modules` volume that containers made before 2026-10-22 had. Once those containers are recreated, remove any such volumes yourself: `docker volume ls`, then `docker volume rm <name>`.

## 2026-11-04

- In the `orca` project list, `u` switches the selected project to the newest image (shown when it has an image update), and `d` asks whether to delete its home too.
- Deleting a project's home now lists what's in it first, with sizes.

## 2026-11-03

- Orca moved to github.com/orca-infra/orca, and its image to ghcr.io/orca-infra/orca. Old links redirect and `orca update` switches over by itself, so there's nothing to do.
- `orca update` now shows what's new here when it updates itself.
