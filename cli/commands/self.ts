import { existsSync, renameSync } from "node:fs";
import { OrcaError, type Context } from "../context";
import { REPO } from "../release";
import { installBuild, type SelfUpdate } from "./update";

const SHOWN = 10;
const previousOf = (s: SelfUpdate) => `${s.execPath}.previous`;

/** The previous orca's build, asked of it; null when there's none, or it won't say. */
async function previousVersion(ctx: Context, s: SelfUpdate): Promise<string | null> {
  if (!existsSync(previousOf(s))) return null;
  const r = await ctx.host([previousOf(s), "--version"]);
  return r.code === 0 ? r.stdout.trim() : "unknown";
}

/** This build, the previous one, and the published ones, newest first. */
export async function selfLs(ctx: Context, s: SelfUpdate): Promise<void> {
  const previous = await previousVersion(ctx, s);
  ctx.print(`Current: ${s.version}${s.built ? ` (${s.built})` : ""}`);
  ctx.print(previous ? `Previous: ${previous}. Go back to it: orca self use previous` : "Previous: none yet (one is kept whenever orca self use or orca update replaces it).");
  ctx.print();

  const r = await s.fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`).catch(() => null);
  if (!r?.ok) {
    ctx.print(`Published: couldn't be read from github.com/${REPO} (offline?).`);
    return;
  }
  const builds = ((await r.json()) as { tag_name: string; published_at: string }[]).filter((b) => b.tag_name.startsWith("cli-"));
  ctx.print("Published, newest first. Switch to one: orca self use <build>");
  for (const b of builds.slice(0, SHOWN)) {
    const version = b.tag_name.slice(4);
    const note = version === s.version ? "  current" : version === previous ? "  previous" : "";
    ctx.print(`  ${version}  ${b.published_at.slice(0, 10)}${note}`);
  }
}

/** Switches to a published build, the newest ("latest"), or back to the previous one; the one it replaces becomes previous. */
export async function selfUse(ctx: Context, s: SelfUpdate, target: string): Promise<void> {
  if (s.version === "dev") throw new OrcaError("This orca runs from source, so it doesn't switch builds.");
  if (target === "previous") {
    const previous = await previousVersion(ctx, s);
    if (!previous) throw new OrcaError("There's no previous orca yet: one is kept whenever orca self use or orca update replaces it.", "See what's published: orca self ls");
    // A swap, so the same command goes forward again
    const aside = `${s.execPath}.swap`;
    renameSync(s.execPath, aside);
    renameSync(previousOf(s), s.execPath);
    renameSync(aside, previousOf(s));
    ctx.print(`orca: now ${previous} (was ${s.version}). orca self use previous swaps back.`);
    return;
  }
  let version = target;
  if (target === "latest") {
    const r = await s.fetch(`https://github.com/${REPO}/releases/latest/download/version`).catch(() => null);
    if (!r?.ok) throw new OrcaError("Couldn't find the newest build.", "Check your connection and try again.");
    version = (await r.text()).trim();
  }
  if (version === s.version) {
    ctx.print(`orca: already ${version}.`);
    return;
  }
  await installBuild(ctx, s, version);
}
