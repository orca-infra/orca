import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { OrcaError } from "../errors";
import { tilde, type Context } from "../context";
import { attach, docker, probe } from "../docker";
import { readConfig } from "../config";
import { built, ensureImage, inspectImage, latestImage } from "../images";
import { applyCreation, checkWithout, containerArgs, mounts, workspaceFile } from "../features";
import { applySettings, describeResources, effective } from "../box-settings";
import { allForwards, ensureNetwork, syncProxy } from "../proxy";
import { beforeHomes, checkSupported, hasTerminals, TERMINALS } from "../compat";
import { activity, checkReady, describe, keepUp, listTerminals, nextName, terminalArgs } from "../terminals";
import { containerName, CURRENT_IMAGE, label, PROXY } from "../names";
import { homeDir } from "../state";
import { listContainers } from "../containers";
import { claimRecord, migrated, recordFor } from "../records";

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
  if (opts.image && existing && !opts.fresh) {
    const on = await inspectImage(ctx, existing.image);
    throw new OrcaError(
      `${container} already exists, made from the image built ${built(on)}; --image applies when a container is made.`,
      `To remake it from that image (keeps the folder and the home): ${existing.running ? `orca stop ${name}, then ` : ""}orca start --fresh --image ${opts.image} ${tilde(ctx, folder)}`,
    );
  }
  // Downloaded now, before anything is removed, so a missing image changes nothing
  const chosen = opts.image ? await ensureImage(ctx, opts.image) : null;

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
      skipping: `Its forwards won't reach it until it's on it; the next orca start tries again.`,
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
    if (!hasTerminals(existing)) return plainShell(ctx, name, container, existing.running, opts);
    if (!existing.running) {
      ctx.print(`Starting ${name}`);
      await docker(ctx, ["start", container]);
    }
    const box = { name, container, folder };
    return opts.up ? up(ctx, box) : openTerminal(ctx, box, opts);
  }

  const latest = chosen?.image ?? (await latestImage(ctx));
  if (!latest) throw new OrcaError("The orca image isn't on this Mac yet.", "Run: orca update");
  ctx.print(`Creating ${name}: ${tilde(ctx, folder)}, home in ${tilde(ctx, home)}`);
  if (newHome) await applyCreation(ctx, home, without);
  const create = ["--name", container, "--label", label("project", name), ...containerArgs({ name, folder, home, network, resources: effective(ctx, name) }), chosen?.ref ?? CURRENT_IMAGE];
  if (opts.makeOnly) {
    await docker(ctx, ["create", ...create]);
    ctx.print(`Made ${container} from the image built ${built(latest)}; orca start opens it.`);
    return 0;
  }
  if (latest.generation < TERMINALS) {
    // An image from before terminals: its main process is the first window's shell
    ctx.print("This image has no terminals yet; for them: orca update, then orca start --fresh");
    if (!opts.command) return attach(ctx, ["run", "-it", ...create, "bash"]);
    await docker(ctx, ["run", "-d", "-it", ...create, "bash"]);
    return attach(ctx, ["exec", "-it", container, ...opts.command]);
  }
  // The container runs in the background while any terminal is open, or until it's stopped
  // if kept up (the image's orca-keepalive)
  await docker(ctx, ["run", "-d", ...create]);
  const box = { name, container, folder };
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
