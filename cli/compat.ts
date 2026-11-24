import { OrcaError, type Context } from "./context";
import type { Container } from "./docker";

/**
 * Containers made by older orca versions, by generation: the one place orca tells them apart,
 * so supporting one can be deprecated with a date and then removed on purpose (as Node does its
 * deprecations). Images carry their generation (`orca.generation`); older ones are known by what
 * they lack. Every check for an older container goes through generation(), never a label.
 *
 * This list is the deprecations' source: what orca says about them comes from it.
 * To deprecate one: set its status to { deprecated: "yyyy-mm-dd" }; `orca start` then says to
 * recreate such containers before that date. To remove one: set it to "removed", delete the code
 * its entry lists, and the helper below that checks for it; the compiler finds what's left.
 * compat.test.ts checks the list is well formed.
 */

/** Containers with their home on the Mac (~/.orca/projects/<project>/home) */
export const HOMES = 1;
/** Images whose terminals are tmux sessions that outlive their window, and that orca up can keep running */
export const TERMINALS = 2;
/** What orca makes now; the Dockerfile's orca.generation label */
export const CURRENT = TERMINALS;

export type Status = "supported" | { deprecated: string } | "removed";

export type Older = {
  /** Containers below this generation */
  below: number;
  id: string;
  /** What supporting them means */
  what: string;
  /** Where that support is, to delete when it's removed */
  code: string;
  status: Status;
};

export const OLDER: Older[] = [
  {
    below: HOMES,
    id: "before-homes",
    what: "containers from before project homes, whose home is inside the container: orca-migrate.sh copies it out",
    code: "beforeHomes() and its callers (loadProjects, start, delete, pick, the dashboard's not-migrated state); orca-migrate.sh, orca-migrate-select.sh, orca-legacy.sh, migrate/",
    status: "supported",
  },
  {
    below: TERMINALS,
    id: "before-terminals",
    what: "containers from images before terminals: their shells end with their window",
    code: "hasTerminals() and its callers (plainShell and the no-terminals image path in start; stop, terminals, the dashboard)",
    status: "supported",
  },
];

/** A generation from labels: the label itself, or, on images before it, what they have. */
export function labelGeneration(labels: Record<string, string>): number {
  const g = Number(labels["orca.generation"]);
  if (Number.isInteger(g) && g > 0) return g;
  if (labels["orca.terminals"] === "1") return TERMINALS;
  return HOMES;
}

/** The generation a container is (a container takes its image's labels). */
export const generation = (c: Container) => (c.home ? labelGeneration(c.labels) : 0);

export const beforeHomes = (c: Container) => generation(c) < HOMES;
export const hasTerminals = (c: Container) => generation(c) >= TERMINALS;

/** The older generations a container belongs to, oldest first. */
export const olderFor = (c: Container) => OLDER.filter((o) => generation(c) < o.below);

/**
 * Says when a container is from a deprecated generation, and refuses one from a removed one.
 * `recreate` is the command that makes it current again.
 */
export function checkSupported(ctx: Context, c: Container, recreate: string) {
  for (const o of olderFor(c)) {
    if (o.status === "removed")
      throw new OrcaError(`${c.name} was made by an older orca (${o.id}: ${o.what}), which this one no longer supports.`, `Recreate it (keeps the folder and the home): ${recreate}`);
    if (typeof o.status === "object")
      ctx.print(`${c.name} was made by an older orca (${o.id}), supported until ${o.status.deprecated}. Recreate it before then (keeps the folder and the home): ${recreate}`);
  }
}
