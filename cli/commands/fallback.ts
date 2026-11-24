import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { OrcaError } from "../errors";
import { type Context } from "../context";
import { ensureImage } from "../images";
import { attach, docker } from "../docker";
import { homeDir, listContainers } from "../projects";
import { projectAt } from "../proxy";
import { fallbackName } from "../names";

/** The kinds of plain container orca fallback runs */
export const KINDS = {
  home: "Your folder and home: for when orca's own machinery is what's broken",
  "fresh-home": "Your folder, a fresh home: for when something in the home is (log in again inside)",
  "no-folders": "No folders from the Mac: for when the container can't see them (work from a clone)",
} as const;
export type Kind = keyof typeof KINDS;

/** The one place a fallback's docker command is made: run, and printed for pasting */
export function fallbackArgs(f: { kind: Kind; folder: string; home: string | null; image: string; name: string; command?: string[] }): string[] {
  // A kept container's main process is always a shell, so going back in opens it as it was left
  if (f.kind === "no-folders") return ["run", "-it", "--name", f.name, f.image, "bash"];
  const command = f.command?.length ? f.command : ["bash"];
  return ["run", "-it", "--rm", "-v", `${f.folder}:/workspace`, ...(f.kind === "home" ? ["-v", `${f.home}:/home/node`] : []), f.image, ...command];
}

/**
 * A plain container to work in when orca's usual one doesn't work: one `docker run`, with none
 * of orca's terminals, proxy or networks. Prints the command first, so it can be pasted when
 * even this doesn't run. `command` runs in place of a shell.
 */
export async function fallback(ctx: Context, path: string, opts: { kind?: string; image?: string; command?: string[] }): Promise<number> {
  const folder = resolve(path);
  const project = projectAt(ctx, folder);
  const home = project ? homeDir(ctx, project) : null;
  const hasHome = home !== null && existsSync(home) && readdirSync(home).length > 0;

  let kind = opts.kind as Kind | undefined;
  if (kind !== undefined && !(kind in KINDS)) throw new OrcaError(`There's no fallback "${kind}".`, `Choose one of: ${Object.keys(KINDS).join(", ")}`);
  if (!kind) {
    if (!ctx.choose) throw new OrcaError("Choosing a fallback needs a terminal.", `Name it: orca fallback --kind ${Object.keys(KINDS).join("|")}`);
    const options = (Object.keys(KINDS) as Kind[]).filter((k) => k !== "home" || hasHome).map((k) => ({ label: KINDS[k], value: k }));
    const answer = await ctx.choose("Which plain container?", options);
    if (answer === null) return 0;
    kind = answer as Kind;
  }
  if (kind === "home" && !hasHome) throw new OrcaError(`${folder} has no orca home to use.`, "Use a fresh one: orca fallback --kind fresh-home");
  if (kind !== "no-folders" && !(existsSync(folder) && statSync(folder).isDirectory())) throw new OrcaError(`${folder} isn't a folder.`);

  const { ref } = await ensureImage(ctx, opts.image ?? "current");
  // Kept when it exits, since the work is in it until pushed
  const name = fallbackName(project ?? basename(folder).replace(/[^a-zA-Z0-9_.-]/g, "-"));
  if (kind === "no-folders" && (await listContainers(ctx)).some((c) => c.name === name)) {
    ctx.print(`Back into ${name}, as you left it. docker rm ${name} removes it once your work is pushed.`);
    if (!opts.command?.length) return attach(ctx, ["start", "-ai", name]);
    await docker(ctx, ["start", name]);
    return attach(ctx, ["exec", "-it", name, ...opts.command]);
  }
  if (kind === "no-folders") ctx.print("In it: gh auth login, then cd ~ && gh repo clone <owner>/<repo>, then claude. Push before you're done; exiting keeps it, and orca fallback goes back in.");
  if (kind === "fresh-home") ctx.print("A fresh home: log in to Claude and gh inside. It's thrown away when you exit; your folder isn't.");
  const args = fallbackArgs({ kind, folder, home, image: ref, name, command: opts.command });
  ctx.print(`Running (to paste if orca won't run): docker ${args.map(quote).join(" ")}`);
  if (kind === "no-folders" && opts.command?.length) {
    // Its shell keeps it going in the background; the command runs beside it
    await docker(ctx, ["run", "-d", ...args.slice(1)]);
    return attach(ctx, ["exec", "-it", name, ...opts.command]);
  }
  return attach(ctx, args);
}

const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
