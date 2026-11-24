import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { OrcaError, projectsDir, tilde, type Context } from "../context";
import {
  containerName,
  docker,
  homeDir,
  imageName,
  inspectImage,
  latestImage,
  listContainers,
  migrated,
  readFolder,
  lostFoldersError,
  recordDir,
} from "../projects";
import { readConfig } from "../config";
import { applyCreation, checkWithout, containerArgs, workspaceFile } from "../features";
import { applySettings, describeResources, effective } from "../box-settings";
import { allForwards, ensureNetwork, PROXY, syncProxy } from "../proxy";
import { beforeHomes, canKeepUp, checkSupported, hasTerminals, TERMINALS, UP } from "../compat";
import { activity, describe, keepUp, listTerminals, nextName, terminalArgs } from "../terminals";

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
};

/** Starts (or enters) the container for the project folder at `path`; with `up`, keeps it running instead. */
export async function start(ctx: Context, path: string, opts: StartOptions): Promise<number> {
  const folder = resolve(path);
  if (!existsSync(folder) || !statSync(folder).isDirectory())
    throw new OrcaError(`${tilde(ctx, folder)} doesn't exist.`, "Pass a project folder, or create one with: orca new <name>");

  const name = recordFor(ctx, folder) ?? basename(folder);
  const without = [...(readConfig(ctx).without ?? []), ...(opts.without ?? [])];
  checkWithout(opts.without ?? [], "--without");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name))
    throw new OrcaError(
      `"${name}" can't be used as a project name: use letters, numbers, ".", "_" or "-".`,
      "Rename the folder, or create a project with: orca new <name>",
    );

  const container = containerName(name);
  const home = homeDir(ctx, name);
  const containers = await listContainers(ctx);
  const existing = containers.find((c) => c.name === container) ?? null;

  // A home created now gets the creation features; an existing one is never changed
  const newHome = isEmpty(home);
  claimRecord(ctx, name, folder);
  workspaceFile(ctx, name, folder, without);

  const legacy = containers.find((c) => beforeHomes(c) && c.workspace === folder);
  if (legacy && !existing && !migrated(ctx, name))
    throw new OrcaError(
      isEmpty(home)
        ? `${tilde(ctx, folder)} still has its container from before project homes, ${legacy.name}. Starting now would begin with an empty home.`
        : `${tilde(ctx, folder)}'s migration from ${legacy.name} didn't finish, so its home may be incomplete.`,
      isEmpty(home)
        ? `Migrate it first: ~/orca/orca-migrate.sh ${tilde(ctx, folder)}`
        : `Remove the partial copy and migrate again: rm -r ${tilde(ctx, home)} && ~/orca/orca-migrate.sh ${tilde(ctx, folder)}`,
    );

  const other = containers.find((c) => c.running && c.name !== container && c.workspace === folder);
  if (other)
    throw new OrcaError(`${other.name} is already running on this folder; both would edit the same files.`, `Exit it first, or: docker stop ${other.name}`);

  // The project's own network, which only the forwards proxy also joins
  const network = await skippable(
    ctx,
    async () => {
      const n = await ensureNetwork(ctx, name);
      if (existing && !opts.fresh && !existing.networks.includes(n)) await docker(ctx, ["network", "connect", n, container]);
      return n;
    },
    {
      failed: `${name}'s own network couldn't be set up`,
      skipping:
        existing && !opts.fresh
          ? `Its forwards won't reach it until it is; the next orca start tries again.`
          : `It would be created on Docker's default network, so forwards won't reach it until it's recreated: orca start --fresh.`,
      question: `Start ${name} without it?`,
    },
  );
  if (allForwards(ctx).length)
    await skippable(ctx, () => syncProxy(ctx), {
      failed: "The forwards proxy couldn't be brought up to date",
      skipping: `Every project's forwards may not work until it is; ${name} itself is unaffected. To start the proxy afresh: docker rm -f ${PROXY}`,
      question: `Start ${name} without it?`,
    });

  if (existing && opts.fresh) {
    if (existing.running) {
      const open = hasTerminals(existing) ? await listTerminals(ctx, container) : [];
      throw new OrcaError(
        `${container} is running${open.length ? `, with ${count(open.length)} open` : ""}.`,
        `Stop it first (this ends every terminal in it): orca stop ${name}`,
      );
    }
    ctx.print(`Removing ${container} to recreate it (--fresh)`);
    await docker(ctx, ["rm", container]);
  } else if (existing) {
    checkSupported(ctx, existing, `orca stop ${name}, then orca start --fresh ${tilde(ctx, folder)}`);
    await noticeOutdated(ctx, existing.image, folder, name);
    // Box settings changed since (orca settings, or new defaults) reach it without recreating it
    const resources = effective(ctx, name);
    const old = await skippable(ctx, () => applySettings(ctx, existing, resources), {
      failed: `Box settings (${describeResources(resources)}) couldn't be applied`,
      skipping: `It would start with the memory and CPUs it has (${describeResources(existing)}); the next orca start tries again.`,
      question: `Start ${name} with those?`,
    });
    if (old) ctx.print(`Box settings: ${describeResources(resources)} (was ${describeResources(old)})`);
    if (opts.up && !canKeepUp(existing))
      throw new OrcaError(
        `${container} is from an image before orca up, so it can't be kept running without terminals.`,
        `Recreate it on the newest image: orca update, then orca start --fresh ${tilde(ctx, folder)}`,
      );
    if (!hasTerminals(existing)) return plainShell(ctx, name, container, existing.running, opts);
    if (!existing.running) {
      ctx.print(`Starting ${name}`);
      await docker(ctx, ["start", container]);
    }
    const box = { name, container, folder, keepsUp: canKeepUp(existing) };
    return opts.up ? up(ctx, box) : openTerminal(ctx, box, opts);
  }

  const latest = await latestImage(ctx);
  if (!latest)
    throw readConfig(ctx).image
      ? new OrcaError(`The image config.json pins, ${imageName(ctx)}, isn't on this Mac.`, `Download it: docker pull ${imageName(ctx)}, or remove "image" from ${tilde(ctx, join(ctx.orcaDir, "config.json"))}`)
      : new OrcaError("The orca image isn't on this Mac yet.", "Run: orca update");
  if (opts.up && latest.generation < UP) throw new OrcaError("The orca image is from before orca up.", "Run: orca update");
  ctx.print(`Creating ${name}: ${tilde(ctx, folder)}, home in ${tilde(ctx, home)}`);
  if (newHome) await applyCreation(ctx, home, without);
  const create = ["--name", container, "--label", `orca.project=${name}`, ...containerArgs({ name, folder, home, network, resources: effective(ctx, name) }), imageName(ctx)];
  if (latest.generation < TERMINALS) {
    // An image from before terminals: its main process is the first window's shell
    ctx.print("This image has no terminals yet; for them: orca update, then orca start --fresh");
    if (!opts.command) return ctx.docker.attach(["run", "-it", ...create, "bash"]);
    await docker(ctx, ["run", "-d", "-it", ...create, "bash"]);
    return ctx.docker.attach(["exec", "-it", container, ...opts.command]);
  }
  // The container runs in the background while any terminal is open, or until it's stopped
  // if kept up (the image's orca-keepalive)
  await docker(ctx, ["run", "-d", ...create]);
  const box = { name, container, folder, keepsUp: latest.generation >= UP };
  return opts.up ? up(ctx, box) : openTerminal(ctx, box, opts);
}

/**
 * Runs a step that starting can do without, returning its result, or null when skipped. If it
 * fails, says what failed and what going on without it means, and asks; with no one to ask, or
 * a no, the failure stands.
 */
async function skippable<T>(ctx: Context, step: () => Promise<T>, say: { failed: string; skipping: string; question: string }): Promise<T | null> {
  try {
    return await step();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const fix = e instanceof OrcaError && e.fix ? `\n  ${e.fix}` : "";
    if (!ctx.ask) throw e;
    ctx.print(`${say.failed}: ${detail}${fix}`);
    ctx.print(`  ${say.skipping}`);
    if (!/^(y(es)?)?$/i.test((await ctx.ask(`${say.question} [Y/n] `)).trim())) throw e;
    ctx.print();
    return null;
  }
}

type Started = { name: string; container: string; folder: string; keepsUp: boolean };

/** Marks a started container to keep running, terminals or not, until it's stopped. */
async function up(ctx: Context, { name, container, folder }: Started): Promise<number> {
  if (!(await keepUp(ctx, container)))
    throw new OrcaError(`${container} has nowhere to mark it kept up: an older orca made it.`, `Recreate it: orca stop ${name}, then orca start --fresh ${tilde(ctx, folder)}`);
  ctx.print(`${name} is up: it keeps running, with or without terminals, until orca stop ${name}.`);
  return 0;
}

/** Attaches this window to a terminal: the one asked for, a new one, or one the user picks. */
async function openTerminal(ctx: Context, { name, container, folder, keepsUp }: Started, opts: StartOptions): Promise<number> {
  const { terminals: open, broken } = await activity(ctx, container);
  if (broken === "lost-folders") throw lostFoldersError(container);
  if (broken) throw new OrcaError(`Docker can't run anything in ${container}.`, `Stop it and start it again: orca stop ${name}, then orca start ${tilde(ctx, folder)}`);
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
  const code = await ctx.docker.attach(terminalArgs(container, terminal, opts.command));
  // Stopped here, where the last terminal ended, and said so, rather than unseen (a terminal
  // that ends with no window on it is the keepalive's to notice)
  if (keepsUp) {
    const now = await activity(ctx, container);
    if (!now.up && now.terminals.length === 0) {
      ctx.print(`That was ${name}'s last terminal, so it's stopping. To keep it running without terminals: orca up ${tilde(ctx, folder)}`);
      await ctx.docker.run(["stop", container]);
    }
  }
  return code;
}

/** A container from an image before terminals: shells as before, its first one being the container's own. */
async function plainShell(ctx: Context, name: string, container: string, running: boolean, opts: StartOptions): Promise<number> {
  ctx.print(`${name}'s container is from before terminals, so its shells end with their window. For terminals: orca start --fresh`);
  if (opts.command) {
    if (!running) await docker(ctx, ["start", container]);
    return ctx.docker.attach(["exec", "-it", container, ...opts.command]);
  }
  if (running) {
    ctx.print(`${name} is already running: opening another shell in it`);
    return ctx.docker.attach(["exec", "-it", container, "bash"]);
  }
  ctx.print(`Resuming ${name}`);
  return ctx.docker.attach(["start", "-ai", container]);
}

const count = (n: number) => `${n} terminal${n === 1 ? "" : "s"}`;

/** The record already pointing at this folder, if any (e.g. `orca new` projects). */
function recordFor(ctx: Context, folder: string): string | null {
  const dir = projectsDir(ctx);
  if (!existsSync(dir)) return null;
  return readdirSync(dir).find((n) => readFolder(ctx, n) === folder) ?? null;
}

/** One home per project: two folders with the same name must not share memory. */
function claimRecord(ctx: Context, name: string, folder: string) {
  const owner = readFolder(ctx, name);
  if (owner && owner !== folder)
    throw new OrcaError(
      `The project "${name}" belongs to ${tilde(ctx, owner)}, not this folder.`,
      `If that project moved here, update ${tilde(ctx, join(recordDir(ctx, name), "project-path"))} to this path.`,
    );
  mkdirSync(homeDir(ctx, name), { recursive: true });
  if (!owner) writeFileSync(join(recordDir(ctx, name), "project-path"), folder + "\n");
}

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
      ? `Image update available: this container's image was built ${usedBuilt}, the newest ${newestBuilt}.`
      : "Image update available: this container was made from an older orca image.",
  );
  ctx.print(`  To switch:  orca stop ${name}, then orca start --fresh ${tilde(ctx, folder)}`);
  for (const line of RECREATING) ctx.print(`  ${line}`);
  ctx.print();
}
