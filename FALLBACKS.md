# Fallbacks: working in a project when orca doesn't

In order: use the first that applies. Every one keeps your project folder and your home as they are.

## Orca's usual container doesn't work

```sh
orca fallback
```

Run in the project's folder, it asks which plain container to work in, and runs it with one `docker run`: none of orca's terminals, proxy or networks. Claude runs inside as usual.

- **Your folder and home**: when orca's own machinery is what's broken. Your logins, Claude's memory and sessions are there.
- **Your folder, a fresh home**: when something in the home is what's broken (say, a Claude update or a dotfile that stops every shell). Log in again inside; this home is thrown away when you exit.
- **No folders from the Mac**: when the container can't see the Mac's folders (`/workspace` or `~` isn't there inside it). Work from a clone (`gh auth login`, then `gh repo clone`), and push before you're done. Exiting keeps the container; `orca fallback` goes back into it.

Add `--image <name>` for another image (below). It prints the `docker` command it runs, to paste if even `orca fallback` stops working.

## The image is what's broken

```sh
orca image ls              # the current image, the previous one, the published ones
orca image use previous    # or a published <yyyy-mm-dd>-<commit>, or latest
```

`orca image use` makes that image the one new containers are made from, keeps the one it replaces (so `orca image use previous` goes back), and offers to remake the stopped projects' containers on it. For one project only: `orca start --fresh --image previous`.

## orca itself is what's broken

```sh
orca self ls               # this build, the previous one, the published ones
orca self use previous     # or a published build, or latest
```

If the new `orca` won't run at all, the one it replaced still does: `"$(which orca).previous" self use previous` swaps them back.

## No orca runs at all

Install a published build (`cli-<commit>` at https://github.com/orca-infra/orca/releases), or the newest without a commit:

```sh
curl -fsSL https://raw.githubusercontent.com/orca-infra/orca/main/cli/install.sh | bash -s -- <commit>
```

Or work without orca, from the project's folder (this is what `orca fallback` runs):

```sh
docker run -it --rm -v "$PWD:/workspace" -v ~/.orca/projects/<project>/home:/home/node orca:latest bash
```

## Docker Desktop itself

Restart it: quit it from its menu bar icon and open it again. Project folders and homes are files on the Mac, untouched by it.
