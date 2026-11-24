// What every container orca creates for a project has beyond its image: the folders from the
// Mac, its own network, its memory and CPUs, and what it's told about itself. Part of every
// container, so in effect whenever it runs. (container-features.md lists these with what the
// image and the creation features add; a test keeps it in step.)
import { resourceArgs, type Resources } from "./box-settings";
import { dirname } from "node:path";
import { UP_MARK } from "./in-container";

/** Where the project folder and its home are inside every container */
export const WORKSPACE = "/workspace";
export const HOME = "/home/node";

export type Box = { name: string; folder: string; home: string; network: string | null; resources: Resources };

/** The folders from the Mac in every container orca creates: the project folder and its own home; everything else is the image's */
export const mounts = (b: Pick<Box, "folder" | "home">) => [
  { source: b.folder, target: WORKSPACE },
  { source: b.home, target: HOME },
];

/** docker run arguments for every container orca creates (the every-time features). */
export function containerArgs(b: Box): string[] {
  return [
    ...mounts(b).flatMap((m) => ["-v", `${m.source}:${m.target}`]),
    // Its own network, which only the forwards proxy also joins
    ...(b.network ? ["--network", b.network] : []),
    // Its memory and CPUs (box settings): 8 GB and 4 unless set
    ...resourceArgs(b.resources),
    // Where `orca up` marks it to keep running; emptied on every start, so a stop ends it
    "--tmpfs", `${dirname(UP_MARK)}:mode=1777`,
    // The project's name, for terminal titles, and for naming its Remote Control sessions
    // (otherwise the container's random hostname)
    "-e", `ORCA_PROJECT=${b.name}`,
    "-e", `CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX=${b.name}`,
  ];
}
