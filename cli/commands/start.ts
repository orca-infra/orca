import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { OrcaError } from "../errors";
import { tilde, type Context } from "../context";
import { attach, docker, probe } from "../docker";
import { readConfig } from "../config";
import { built, ensureImage, inspectImage, latestImage, type Image } from "../images";
import { applyCreation, checkWithout, containerArgs, mounts, workspaceFile } from "../features";
import { applySettings, describeResources, effective } from "../box-settings";
import { allForwards, ensureNetwork, syncProxy } from "../proxy";
import { beforeHomes, checkSupported, hasTerminals, TERMINALS } from "../compat";
import { activity, checkReady, describe, keepUp, listTerminals, nextName } from "../terminals";
import { terminalArgs } from "../in-container";
import { containerName, CURRENT_IMAGE, label, PROXY } from "../names";
import { configFile, homeDir } from "../state";
import { listContainers, type Container } from "../containers";
import { claimRecord, migrated, recordFor } from "../records";
import { runSteps, type Step } from "../steps";

export type StartOptions = {
  fresh?: boolean;
  /** Run this in a new terminal instead of a shell */
  command?: string[];
  /** Open a new terminal without asking about the open ones */
  new?: boolean;
  /** Attach to this terminal, creating it if it isn't open */
  terminal?: string;
  /** Creation features to leave out, if this creates the project's home */
  without?: string[];
  /** Start it without a terminal, to keep running until it's stopped (orca up) */
  up?: boolean;
  /** The image to make its container from, when this makes one (image names as in orca image use) */
  image?: string;
  /** Only (re)make its container, stopped, without starting it or opening a terminal */
  makeOnly?: boolean;
};

/** What orca start knows as its steps go: each step reads it, and some fill it in. */
type Start = {
  ctx: Context;
  opts: StartOptions;
  folder: string;
  name: string;
  container: string;
  home: string;
  without: string[];
  containers: Container[];
  existing: Container | null;
  /** The image asked for with --image, downloaded */
  chosen: { ref: string; image: Image } | null;
  /** A home made now gets the creation features; an existing one is never changed */
  newHome: boolean;
  /** The project's own network, or null when going on without it */
  network: string | null;
};

const reusing = (s: Start) => Boolean(s.existing && !s.opts.fresh);

/** orca start, in order. Each step says whether starting needs it (steps.ts). */
const STEPS: Step<Start>[] = [
  {
    name: "the image asked for",
    needed: true,
    when: (s) => Boolean(s.opts.image),
    run: async (s) => {
      if (s.existing && !s.opts.fresh) {
        const on = await inspectImage(s.ctx, s.existing.image);
        throw new OrcaError(
          `${s.container} already exists, made from the image built ${built(on)}; --image applies when a container is made.`,
          `To remake it from that image (keeps the folder and the home): ${s.existing.running ? `orca stop ${s.name}, then ` : ""}orca start --fresh --image ${s.opts.image} ${tilde(s.ctx, s.folder)}`,
        );
      }
      // Downloaded now, before anything is removed, so a missing image changes nothing
      s.chosen = await ensureImage(s.ctx, s.opts.image!);
    },
  },
  {
    name: "the project's record",
    needed: true,
    run: (s) => {
      s.newHome = isEmpty(s.home);
      claimRecord(s.ctx, s.name, s.folder);
    },
  },
  {
    name: "the workspace file",
    optional: { failed: () => "The workspace file couldn't be written", skipping: () => "Editors open the folder as one root until it is; the next orca start tries again." },
    run: (s) => workspaceFile(s.ctx, s.name, s.folder, s.without),
  },
  {
    name: "no older container still to migrate",
    needed: true,
    run: (s) => {
      const legacy = s.containers.find((c) => beforeHomes(c) && c.workspace === s.folder);
      if (!legacy || s.existing || migrated(s.ctx, s.name)) return;
      const c = s.ctx;
      throw new OrcaError(
        isEmpty(s.home)
          ? `${tilde(c, s.folder)} still has its container from before project homes, ${legacy.name}. Starting now would begin with an empty home.`
          : `${tilde(c, s.folder)}'s migration from ${legacy.name} didn't finish, so its home may be incomplete.`,
        isEmpty(s.home)
          ? `Migrate it first: ~/orca/orca-migrate.sh ${tilde(c, s.folder)}`
          : `Remove the partial copy and migrate again: rm -r ${tilde(c, s.home)} && ~/orca/orca-migrate.sh ${tilde(c, s.folder)}`,
      );
    },
  },
  {
    name: "no other container on this folder",
    needed: true,
    run: (s) => {
      const other = s.containers.find((c) => c.running && c.name !== s.container && c.workspace === s.folder);
      if (other) throw new OrcaError(`${other.name} is already running on this folder; both would edit the same files.`, `Exit it first, or: docker stop ${other.name}`);
    },
  },
  {
    // Which only the forwards proxy also joins
    name: "the project's own network",
    optional: { failed: (s) => `${s.name}'s own network couldn't be set up`, skipping: () => "Its forwards won't reach it until it's on it; the next orca start tries again." },
    run: async (s) => {
      const n = await ensureNetwork(s.ctx, s.name);
      if (reusing(s) && !s.existing!.networks.includes(n)) await docker(s.ctx, ["network", "connect", n, s.container]);
      s.network = n;
    },
  },
  {
    name: "the forwards proxy",
    when: (s) => allForwards(s.ctx).length > 0,
    optional: {
      failed: () => "The forwards proxy couldn't be brought up to date",
      skipping: (s) => `Every project's forwards may not work until it is; ${s.name} itself is unaffected. To start the proxy afresh: docker rm -f ${PROXY}`,
    },
    run: async (s) => void (await syncProxy(s.ctx)),
  },
  {
    name: "removing the container to remake it (--fresh)",
    needed: true,
    when: (s) => Boolean(s.existing && s.opts.fresh),
    run: async (s) => {
      if (s.existing!.running) {
        const open = hasTerminals(s.existing!) ? await listTerminals(s.ctx, s.container) : [];
        throw new OrcaError(`${s.container} is running${open.length ? `, with ${count(open.length)} open` : ""}.`, `Stop it first (this ends every terminal in it): orca stop ${s.name}`);
      }
      s.ctx.print(`Removing ${s.container} to recreate it (--fresh)`);
      await docker(s.ctx, ["rm", s.container]);
    },
  },
  {
    name: "a container this orca still supports",
    needed: true,
    when: reusing,
    run: (s) => checkSupported(s.ctx, s.existing!, `orca stop ${s.name}, then orca start --fresh ${tilde(s.ctx, s.folder)}`),
  },
  {
    name: "saying when it isn't on the current image",
    when: reusing,
    optional: { failed: () => "Its image couldn't be compared with the current one", skipping: () => "That only decides whether orca mentions an image update." },
    run: (s) => noticeOutdated(s.ctx, s.existing!.image, s.folder, s.name),
  },
  {
    // Changed since (orca settings, or new defaults): they reach it without recreating it
    name: "its box settings",
    when: reusing,
    optional: {
      failed: (s) => `Box settings (${describeResources(effective(s.ctx, s.name))}) couldn't be applied`,
      skipping: (s) => `It would start with the memory and CPUs it has (${describeResources(s.existing!)}); the next orca start tries again.`,
    },
    run: async (s) => {
      const resources = effective(s.ctx, s.name);
      const old = await applySettings(s.ctx, s.existing!, resources);
      if (old) s.ctx.print(`Box settings: ${describeResources(resources)} (was ${describeResources(old)})`);
    },
  },
  {
    name: "opening the container it has",
    needed: true,
    when: reusing,
    run: async (s) => {
      const c = s.ctx;
      if (!hasTerminals(s.existing!)) return plainShell(c, s.name, s.container, s.existing!.running, s.opts);
      if (!s.existing!.running) {
        c.print(`Starting ${s.name}`);
        await docker(c, ["start", s.container]);
      }
      const box = { name: s.name, container: s.container, folder: s.folder };
      return s.opts.up ? up(c, box) : openTerminal(c, box, s.opts);
    },
  },
  {
    name: "making its container",
    needed: true,
    run: async (s) => {
      const c = s.ctx;
      const latest = s.chosen?.image ?? (await latestImage(c));
      if (!latest) throw new OrcaError("The orca image isn't on this Mac yet.", "Run: orca update");
      c.print(`Creating ${s.name}: ${tilde(c, s.folder)}, home in ${tilde(c, s.home)}`);
      if (s.newHome) await applyCreation(c, s.home, s.without);
      const spec = containerArgs({ name: s.name, folder: s.folder, home: s.home, network: s.network, resources: effective(c, s.name) });
      const create = ["--name", s.container, "--label", label("project", s.name), ...spec, s.chosen?.ref ?? CURRENT_IMAGE];
      if (s.opts.makeOnly) {
        await docker(c, ["create", ...create]);
        c.print(`Made ${s.container} from the image built ${built(latest)}; orca start opens it.`);
        return 0;
      }
      if (latest.generation < TERMINALS) {
        // An image from before terminals: its main process is the first window's shell
        c.print("This image has no terminals yet; for them: orca update, then orca start --fresh");
        if (!s.opts.command) return attach(c, ["run", "-it", ...create, "bash"]);
        await docker(c, ["run", "-d", "-it", ...create, "bash"]);
        return attach(c, ["exec", "-it", s.container, ...s.opts.command]);
      }
      // The container runs in the background while any terminal is open, or until it's stopped
      // if kept up (the image's orca-keepalive)
      await docker(c, ["run", "-d", ...create]);
      const box = { name: s.name, container: s.container, folder: s.folder };
      return s.opts.up ? up(c, box) : openTerminal(c, box, s.opts);
    },
  },
];

/** Starts (or enters) the container for the project folder at `path`; with `up`, keeps it running instead. */
export async function start(c: Context, path: string, opts: StartOptions): Promise<number> {
  const folder = resolve(path);
  if (!existsSync(folder) || !statSync(folder).isDirectory())
    throw new OrcaError(`${tilde(c, folder)} doesn't exist.`, "Pass a project folder, or create one with: orca new <name>");
  const name = recordFor(c, folder) ?? basename(folder);
  checkWithout(opts.without ?? [], "--without");
  checkWithout(readConfig(c).without ?? [], `without in ${tilde(c, configFile(c))}`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name))
    throw new OrcaError(`"${name}" can't be used as a project name: use letters, numbers, ".", "_" or "-".`, "Rename the folder, or create a project with: orca new <name>");

  const container = containerName(name);
  const containers = await listContainers(c);
  const s: Start = {
    ctx: c,
    opts,
    folder,
    name,
    container,
    home: homeDir(c, name),
    without: [...(readConfig(c).without ?? []), ...(opts.without ?? [])],
    containers,
    existing: containers.find((x) => x.name === container) ?? null,
    chosen: null,
    newHome: false,
    network: null,
  };
  return (await runSteps(c, STEPS, s)) ?? 0;
}

type Started = { name: string; container: string; folder: string };

/** Marks a started container to keep running, terminals or not, until it's stopped. */
async function up(ctx: Context, { name, container, folder }: Started): Promise<number> {
  await checkReady(ctx, name, container, mounts({ folder, home: homeDir(ctx, name) }));
  if (!(await keepUp(ctx, container)))
    throw new OrcaError(`${container} couldn't be marked to keep running.`, `Recreate it (keeps the folder and the home): orca stop ${name}, then orca start --fresh ${tilde(ctx, folder)}`);
  ctx.print(`${name} is up: it keeps running, with or without terminals, until orca stop ${name}.`);
  return 0;
}

/** Attaches this window to a terminal: the one asked for, a new one, or one the user picks. */
async function openTerminal(ctx: Context, { name, container, folder }: Started, opts: StartOptions): Promise<number> {
  await checkReady(ctx, name, container, mounts({ folder, home: homeDir(ctx, name) }));
  const open = await listTerminals(ctx, container);
  let pick = opts.terminal ?? null;
  if (!pick && !opts.new && !opts.command && open.length && ctx.choose) {
    const options = [{ label: "New terminal", value: "" }, ...open.map((t) => ({ label: describe(t), value: t.name }))];
    const answer = await ctx.choose(`${name} has ${count(open.length)} open. Attach to which?`, options);
    if (answer === null) return 0;
    pick = answer || null;
  }
  if (opts.command && pick && open.some((t) => t.name === pick))
    throw new OrcaError(`Terminal ${pick} is already open, so it can't run a new command.`, "Leave out --terminal to run it in a new one.");
  const terminal = pick ?? nextName(open);
  ctx.print(open.some((t) => t.name === terminal) ? `Attaching to ${name} terminal ${terminal}` : `Opening ${name} terminal ${terminal}`);
  ctx.print("  Closing this window leaves it running; exit its shell to end it.");
  const code = await attach(ctx, terminalArgs(container, terminal, opts.command));
  // Stopped here, where the last terminal ended, and said so, rather than unseen (a terminal
  // that ends with no window on it is the keepalive's to notice)
  const now = await activity(ctx, container);
  if (!now.up && now.terminals.length === 0) {
    ctx.print(`That was ${name}'s last terminal, so it's stopping. To keep it running without terminals: orca up ${tilde(ctx, folder)}`);
    await probe(ctx, ["stop", container]);
  }
  return code;
}

/** A container from an image before terminals: shells as before, its first one being the container's own. */
async function plainShell(ctx: Context, name: string, container: string, running: boolean, opts: StartOptions): Promise<number> {
  ctx.print(`${name}'s container is from before terminals, so its shells end with their window. For terminals: orca start --fresh`);
  if (opts.command) {
    if (!running) await docker(ctx, ["start", container]);
    return attach(ctx, ["exec", "-it", container, ...opts.command]);
  }
  if (running) {
    ctx.print(`${name} is already running: opening another shell in it`);
    return attach(ctx, ["exec", "-it", container, "bash"]);
  }
  ctx.print(`Resuming ${name}`);
  return attach(ctx, ["start", "-ai", container]);
}

const count = (n: number) => `${n} terminal${n === 1 ? "" : "s"}`;

const isEmpty = (dir: string) => !existsSync(dir) || readdirSync(dir).length === 0;

/** What recreating a container on a newer image keeps, and what it resets. */
export const RECREATING = ["Kept:  the project folder, ~ (logins, memory, settings, installed tools)", "Reset: everything else in the container, such as system packages"];

async function noticeOutdated(ctx: Context, used: string, folder: string, name: string) {
  const latest = await latestImage(ctx);
  if (!latest || latest.id === used) return;
  const when = (created: string | undefined) => created?.slice(0, 16).replace("T", " ");
  const usedBuilt = when((await inspectImage(ctx, used))?.created);
  const newestBuilt = when(latest.created);
  // Dates only help when they tell the two images apart
  ctx.print(
    usedBuilt && newestBuilt && usedBuilt !== newestBuilt
      ? `Not on the current image: this container's image was built ${usedBuilt}, the current one ${newestBuilt}.`
      : "Not on the current image: this container was made from another orca image.",
  );
  ctx.print(`  To switch:  orca stop ${name}, then orca start --fresh ${tilde(ctx, folder)}`);
  for (const line of RECREATING) ctx.print(`  ${line}`);
  ctx.print();
}
