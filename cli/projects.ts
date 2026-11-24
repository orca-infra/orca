import { basename } from "node:path";
import { beforeHomes } from "./compat";
import { type Context } from "./context";
import { homeDir, ownWorkspaceDir } from "./state";
import { listContainers, type Container } from "./containers";
import { migrated, readFolder, recordNames } from "./records";
import { latestImage } from "./images";

/**
 * A project is a record, ~/.orca/projects/<name>/, holding its home (mounted as ~) and
 * project-path (the folder mounted as /workspace). Containers are disposable views of it.
 */
export type Project = {
  name: string;
  /** The project folder on the Mac, or null if the record doesn't say */
  folder: string | null;
  /** True when the folder is the record's own workspace (made by `orca new`) */
  managed: boolean;
  /** The project's container, if one exists */
  container: Container | null;
  /**
   * A container from before project homes existed, on the same folder, while it still needs
   * orca-migrate.sh. Once a migration has finished (or the project has its own container),
   * the old one is only a backup and isn't reported.
   */
  legacy: Container | null;
  /** The container was made from an older image than orca:latest */
  outdated: boolean;
};

export async function loadProjects(ctx: Context): Promise<Project[]> {
  const [containers, latest] = await Promise.all([listContainers(ctx), latestImage(ctx)]);
  const names = recordNames(ctx);

  const projects: Project[] = names.map((name) => {
    const folder = readFolder(ctx, name);
    const home = homeDir(ctx, name);
    const container = containers.find((c) => c.home === home) ?? null;
    const old = containers.find((c) => beforeHomes(c) && c.workspace !== null && c.workspace === folder) ?? null;
    const legacy = old && !container && !migrated(ctx, name) ? old : null;
    return {
      name,
      folder,
      managed: folder === ownWorkspaceDir(ctx, name),
      container,
      legacy,
      outdated: Boolean(container && latest && container.image !== latest.id),
    };
  });

  // Pre-migration containers whose folder has no record yet, one per folder (the most
  // recently used). Named after the folder, or the container when that name is taken, since
  // names identify projects everywhere.
  const unrecorded = containers
    .filter((c) => beforeHomes(c) && c.workspace)
    .sort((a, b) => b.startedAt - a.startedAt);
  for (const c of unrecorded) {
    if (projects.some((p) => p.folder === c.workspace)) continue;
    const taken = (n: string) => projects.some((p) => p.name === n);
    let name = basename(c.workspace!);
    if (taken(name)) name = c.name;
    for (let i = 2; taken(name); i++) name = `${c.name}-${i}`;
    projects.push({ name, folder: c.workspace, managed: false, container: null, legacy: c, outdated: false });
  }

  const lastUsed = (p: Project) => Math.max(p.container?.startedAt ?? 0, p.legacy?.startedAt ?? 0);
  return projects.sort((a, b) => lastUsed(b) - lastUsed(a) || a.name.localeCompare(b.name));
}


