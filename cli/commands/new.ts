import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { OrcaError } from "../errors";
import { type Context } from "../context";
import { start, type StartOptions } from "./start";
import { ownWorkspaceDir, projectPathFile, recordDir } from "../state";

export const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** Makes a project whose code lives in ~/.orca/projects/<name>/workspace, then starts it. */
export async function create(ctx: Context, name: string, opts: Pick<StartOptions, "without"> = {}): Promise<number> {
  return start(ctx, makeRecord(ctx, name), opts);
}

/** The record for a new project, with an empty workspace for its code; returns the workspace. */
export function makeRecord(ctx: Context, name: string): string {
  if (!NAME.test(name))
    throw new OrcaError(`"${name}" can't be a project name: use letters, numbers, ".", "_" or "-", starting with a letter or number.`);
  const record = recordDir(ctx, name);
  if (existsSync(record)) throw new OrcaError(`A project named "${name}" already exists.`, `Start it with: orca start, or pick another name`);
  const workspace = ownWorkspaceDir(ctx, name);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(projectPathFile(ctx, name), workspace + "\n");
  return workspace;
}
