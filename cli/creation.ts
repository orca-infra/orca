// What orca does once, when it creates a project's home: never repeated, never overwriting.
// Each can be left out, per project (--without) or for every new one ("without" in config.json).
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Context } from "./context";
import { OrcaError } from "./errors";
import { WORKSPACE_FILE } from "./workspace-file";

type CreationFeature = {
  id: string;
  label: string;
  /** Applies it to a new home; returns what to tell the user */
  apply: (ctx: Context, home: string) => Promise<string>;
};

export const CREATION: CreationFeature[] = [
  {
    // Commits in the project are the user's, as on the Mac
    id: "git-identity",
    label: "Git identity",
    async apply(ctx, home) {
      const get = async (key: string) => {
        const r = await ctx.host(["git", "config", "--global", key]);
        return r.code === 0 ? r.stdout.trim() : "";
      };
      const [name, email] = await Promise.all([get("user.name"), get("user.email")]);
      if (!name || !email) return "Git identity: none on this Mac to copy. Set one in the project: git config --global user.name/user.email";
      const file = join(home, ".gitconfig");
      if (existsSync(file)) return "Git identity: the home already has a ~/.gitconfig, left as it is";
      writeFileSync(file, `[user]\n\tname = ${name}\n\temail = ${email}\n`);
      return `Git identity: ${name} <${email}>, copied from this Mac to the project's ~/.gitconfig`;
    },
  },
];

/** Features that can be left out: the creation ones, and the workspace file. */
export const optionalIds = [...CREATION.map((f) => f.id), WORKSPACE_FILE];

/** Checks feature names given to --without or the "without" setting. */
export function checkWithout(ids: string[], where: string) {
  const unknown = ids.filter((id) => !optionalIds.includes(id));
  if (unknown.length)
    throw new OrcaError(`${where}: there's no feature "${unknown[0]}" to leave out.`, `Features that can be left out: ${optionalIds.join(", ")}`);
}

/** Applies the creation features to a new home, printing what each did. */
export async function applyCreation(ctx: Context, home: string, without: string[]) {
  for (const f of CREATION) ctx.print(without.includes(f.id) ? `${f.label}: left out (without ${f.id})` : await f.apply(ctx, home));
}
