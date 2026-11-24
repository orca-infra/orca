// The workspace file, checked on every start: editors search and index each git repo in a
// project folder only when it's a root of its own, so orca writes one root per repo.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Context } from "./context";
import { workspaceNoticeFile } from "./state";

/** Its feature id, for leaving it out (--without, or "without" in config.json) */
export const WORKSPACE_FILE = "workspace-file";

const MARK = "// Made by orca start";
/** Folders the repo search never looks in, besides hidden ones: what's in them isn't a repo to edit */
export const SKIPPED = ["node_modules"];
const DEPTH = 3;
const RULES = `looked for git repos up to ${DEPTH} levels down, skipping hidden folders and ${SKIPPED.join(", ")}`;

/**
 * Writes <project>.code-workspace in a folder that holds git repos below its top: a root for the
 * top (its own files) and one per repo, each hidden from the top's root. Rewritten when the repos
 * change, but only while its first line is orca's; without that line, it's the user's, and orca
 * says once when the repos it would list have changed.
 */
export function workspaceFile(ctx: Context, name: string, folder: string, without: string[]) {
  if (without.includes(WORKSPACE_FILE)) return;
  const repos = findRepos(folder);
  const file = join(folder, `${name}.code-workspace`);
  const old = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (old !== null && !old.startsWith(MARK)) return noticeUsersFile(ctx, name, file, old, repos);
  if (!repos.length) return;
  const workspace = {
    folders: [{ name, path: "." }, ...repos.map((path) => ({ path }))],
    // Editors apply this in every root: a repo another one has a folder at the same path as stays
    // shown (twice) rather than hide that folder
    settings: { "files.exclude": Object.fromEntries(repos.filter((r) => !repos.some((o) => existsSync(join(folder, o, r)))).map((r) => [r, true])) },
  };
  const text = `${MARK} for ${name}: one root per git repo, so editors search each. It's rewritten
// when repos are added or removed; to keep your own version, remove this comment.
${JSON.stringify(workspace, null, 2)}
`;
  if (text === old) return;
  writeFileSync(file, text);
  const n = `${repos.length} repo${repos.length === 1 ? "" : "s"}`;
  ctx.print(`Workspace file: ${name}.code-workspace, ${old === null ? `with ${n}` : `updated: ${n}`}: ${repos.join(", ")}`);
  ctx.print(`  It ${RULES}.${old === null ? " Open it in VS Code or Cursor." : ""}`);
}

/** The user's own workspace file: left as it is, saying once (per difference) how it differs from the folder: repos it doesn't list, and folders it lists that aren't in the folder. */
function noticeUsersFile(ctx: Context, name: string, file: string, text: string, repos: string[]) {
  let listed: string[];
  try {
    // JSON with comments: whole-line ones are all orca reads past; anything else, it can't tell
    const w = JSON.parse(text.replace(/^\s*\/\/.*$/gm, "")) as { folders?: { path?: string }[] };
    listed = (w.folders ?? []).map((f) => (f.path ?? "").replace(/^\.\//, "").replace(/\/$/, "")).filter((p) => p && p !== ".");
  } catch {
    return;
  }
  const missing = repos.filter((r) => !listed.includes(r));
  const notThere = listed.filter((p) => !existsSync(join(file, "..", p)));
  const seen = workspaceNoticeFile(ctx, name);
  const now = JSON.stringify({ missing, notThere });
  if (!missing.length && !notThere.length) return rmSync(seen, { force: true });
  if (existsSync(seen) && readFileSync(seen, "utf8") === now) return;
  writeFileSync(seen, now);
  const parts = [missing.length && `doesn't list ${missing.join(", ")}`, notThere.length && `lists ${notThere.join(", ")}, which ${notThere.length === 1 ? "isn't" : "aren't"} in the folder`].filter(Boolean);
  ctx.print(`Workspace file: ${name}.code-workspace is yours (no orca mark), so it's left as it is; it ${parts.join(", and ")}.`);
  ctx.print(`  Edit it yourself, or delete it for orca to write one (orca ${RULES}).`);
}

/** Git repos up to DEPTH levels below `top`, skipping hidden folders and SKIPPED. */
function findRepos(top: string, rel = "", depth = 1): string[] {
  if (depth > DEPTH) return [];
  let entries;
  try {
    entries = readdirSync(join(top, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIPPED.includes(e.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => {
      const path = rel ? `${rel}/${e.name}` : e.name;
      // .git is a folder in a clone, a file in a worktree or submodule
      const repo = existsSync(join(top, path, ".git")) ? [path] : [];
      return [...repo, ...findRepos(top, path, depth + 1)];
    });
}
