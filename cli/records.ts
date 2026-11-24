// A project's record on disk (state.ts says where): which folder it is, whether its home was
// migrated, which project a folder belongs to.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { sep } from "node:path";
import { tilde, type Context } from "./context";
import { OrcaError } from "./errors";
import { homeDir, migratedFile, projectPathFile, projectsDir } from "./state";

/** The projects on record, by name */
export const recordNames = (ctx: Context): string[] =>
  existsSync(projectsDir(ctx)) ? readdirSync(projectsDir(ctx), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];

/** The folder a project's record points at, or null if it doesn't say */
export function readFolder(ctx: Context, name: string): string | null {
  const file = projectPathFile(ctx, name);
  // Without a trailing slash, to match the folders Docker reports
  return existsSync(file) ? readFileSync(file, "utf8").trim().replace(/(.)\/+$/, "$1") || null : null;
}

/** orca-migrate.sh writes migrated-from once the home it copied checks out; a failed run doesn't. */
export const migrated = (ctx: Context, name: string) => existsSync(migratedFile(ctx, name));

/** The record already pointing at this folder, if any (e.g. `orca new` projects). */
export const recordFor = (ctx: Context, folder: string): string | null => recordNames(ctx).find((n) => readFolder(ctx, n) === folder) ?? null;

/** The project whose folder contains `dir`, if any. */
export function projectAt(ctx: Context, dir: string): string | null {
  let best: { name: string; length: number } | null = null;
  for (const name of recordNames(ctx)) {
    const folder = readFolder(ctx, name);
    if (folder && (dir === folder || dir.startsWith(folder + sep)) && (!best || folder.length > best.length)) best = { name, length: folder.length };
  }
  return best?.name ?? null;
}

/** One home per project: two folders with the same name must not share memory. */
export function claimRecord(ctx: Context, name: string, folder: string) {
  const owner = readFolder(ctx, name);
  if (owner && owner !== folder)
    throw new OrcaError(
      `The project "${name}" belongs to ${tilde(ctx, owner)}, not this folder.`,
      `If that project moved here, update ${tilde(ctx, projectPathFile(ctx, name))} to this path.`,
    );
  mkdirSync(homeDir(ctx, name), { recursive: true });
  if (!owner) writeFileSync(projectPathFile(ctx, name), folder + "\n");
}
