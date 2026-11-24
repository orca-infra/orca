// Docker's containers, as orca sees them.
import type { Context } from "./context";
import { docker } from "./docker";

/** What `docker inspect` says about a container, reduced to what Orca uses. */
export type Container = {
  name: string;
  running: boolean;
  startedAt: number; // ms since epoch, 0 if never started
  image: string; // image id
  labels: Record<string, string>;
  workspace: string | null; // host folder mounted at /workspace
  home: string | null; // host folder mounted at /home/node
  networks: string[];
  /** Its resources: memory in bytes and CPUs, 0 for no limit */
  memory: number;
  cpus: number;
};

type Inspected = {
  Name: string;
  State: { Running: boolean; StartedAt: string };
  Image: string;
  Config: { Labels: Record<string, string> | null };
  Mounts: { Source: string; Destination: string }[];
  NetworkSettings?: { Networks?: Record<string, unknown> | null };
  HostConfig?: { Memory?: number; NanoCpus?: number };
};

export function parseContainer(c: Inspected): Container {
  // Docker Desktop sometimes reports Mac folders from inside its VM, as /host_mnt/Users/…
  const mount = (dest: string) => c.Mounts.find((m) => m.Destination === dest)?.Source.replace(/^\/host_mnt(?=\/)/, "") ?? null;
  const started = Date.parse(c.State.StartedAt);
  return {
    name: c.Name.replace(/^\//, ""),
    running: c.State.Running,
    startedAt: Number.isNaN(started) || started < 0 ? 0 : started,
    image: c.Image,
    labels: c.Config.Labels ?? {},
    workspace: mount("/workspace"),
    home: mount("/home/node"),
    networks: Object.keys(c.NetworkSettings?.Networks ?? {}),
    memory: c.HostConfig?.Memory ?? 0,
    cpus: (c.HostConfig?.NanoCpus ?? 0) / 1e9,
  };
}

export async function listContainers(ctx: Context): Promise<Container[]> {
  const ids = await docker(ctx, ["ps", "-a", "-q"]);
  const list = ids.split("\n").filter(Boolean);
  if (list.length === 0) return [];
  return (JSON.parse(await docker(ctx, ["inspect", ...list])) as Parameters<typeof parseContainer>[0][]).map(parseContainer);
}
