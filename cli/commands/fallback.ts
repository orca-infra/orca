import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { OrcaError, type Context } from "../context";
import { ensureImage } from "../images";
import { homeDir, listContainers } from "../projects";
import { projectAt } from "../proxy";

/** The kinds of plain container orca fallback runs */
export const KINDS = {
  home: "Your folder and home: for when orca's own machinery is what's broken",
  "fresh-home": "Your folder, a fresh home: for when something in the home is (log in again inside)",
  "no-folders": "No folders from the Mac: for when the container can't see them (work from a clone)",
} as const;
export type Kind = keyof typeof KINDS;

/**
 * A plain container to work in when orca's usual one doesn't work: one `docker run`, with none
 * of orca's terminals, proxy or networks. Prints the command first, so it can be pasted when
 * even this doesn't run.
 */
export async function fallback(ctx: Context, path: string, opts: { kind?: string; image?: string }): Promise<number> {
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
  let args: string[];
  if (kind === "no-folders") {
    // Kept when it exits, since the work is in it until pushed
    const name = `orca-fallback-${project ?? basename(folder).replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
    const exists = (await listContainers(ctx)).some((c) => c.name === name);
    args = exists ? ["start", "-ai", name] : ["run", "-it", "--name", name, ref, "bash"];
    ctx.print(exists ? `Back into ${name}, as you left it.` : `In it: gh auth login, then cd ~ && gh repo clone <owner>/<repo>, then claude. Push before you're done.`);
    ctx.print(`  Exiting keeps it: orca fallback --kind no-folders goes back in; docker rm ${name} removes it.`);
  } else {
    args = ["run", "-it", "--rm", "-v", `${folder}:/workspace`, ...(kind === "home" ? ["-v", `${home}:/home/node`] : []), ref, "bash"];
    if (kind === "fresh-home") ctx.print("A fresh home: log in to Claude and gh inside. It's thrown away when you exit; your folder isn't.");
  }
  ctx.print(`Running (to paste if orca won't run): docker ${args.map(quote).join(" ")}`);
  return ctx.docker.attach(args);
}

const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
