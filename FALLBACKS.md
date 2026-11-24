# Fallbacks: working in a project when orca doesn't

Each of these is one command in a terminal on the Mac, and needs only Docker and an orca image: no `orca` command, terminals, proxy or networks. Claude runs inside, as usual. Start with the first; go down the list when it doesn't work.

## Your folder and home

When `orca` itself, or something it adds, is what's broken. From the project's folder:

```sh
docker run -it --rm -v "$PWD:/workspace" -v ~/.orca/projects/<project>/home:/home/node orca:latest bash
```

Your logins, Claude's memory and sessions are there, as in `orca start`.

## Your folder, a fresh home

When something in the home is what's broken (say, a Claude update or a dotfile that stops every shell): the same, without the home.

```sh
docker run -it --rm -v "$PWD:/workspace" orca:latest bash
```

Log in to Claude and gh again inside. The home is thrown away when you exit; your project's files are on the Mac as always.

## No folders from the Mac

When the container can't see the Mac's folders at all (Docker Desktop's file sharing has stopped working: logins seem gone, `~` doesn't exist). Work from a clone, and push before you're done:

```sh
docker run -it --name orca-fallback orca:latest bash
# inside:
gh auth login
cd ~ && gh repo clone <owner>/<repo> && cd <repo>
claude
```

Exiting keeps the container; `docker start -ai orca-fallback` goes back in, and `docker rm orca-fallback` removes it once your work is pushed.

## An older image

When the image is what's broken: any command above with another image in place of `orca:latest`:

- `orca:previous`: the one the last `orca update` replaced
- a published one, by date and commit: `ghcr.io/orca-infra/orca:<yyyy-mm-dd>-<commit>`, listed at https://github.com/orca-infra/orca/pkgs/container/orca (`docker pull` it first)

For `orca` itself to make containers from it, put it in `~/.orca/config.json`, e.g. `{"image": "orca:previous"}`, then recreate the project's container: `orca stop <project>`, then `orca start --fresh`. Remove `image` to go back to `orca:latest`.

## An older `orca`

When `orca` itself is what's broken: the one the last `orca update` replaced is beside it, as `orca.previous` (`which orca` shows where): `mv "$(which orca).previous" "$(which orca)"`. Or install any published build by its commit (from https://github.com/orca-infra/orca/releases, `cli-<commit>`):

```sh
curl -fsSL https://raw.githubusercontent.com/orca-infra/orca/main/cli/install.sh | bash -s -- <commit>
```

## Docker Desktop itself

Restart it: quit it from its menu bar icon and open it again. Project folders and homes are files on the Mac, untouched by it.
