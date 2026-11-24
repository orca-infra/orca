import { OrcaError } from "./errors";
import { tilde, type Context } from "./context";
import { hasTerminals } from "./compat";
import { probe } from "./docker";
import { type Container } from "./containers";

/**
 * A terminal in a project's container: a tmux session, so it keeps running when its window
 * closes. Windows on the Mac attach to one; any number of them can be open in a project.
 */
export type Terminal = {
  name: string;
  /** How many windows show it right now */
  attached: number;
  /** Last input or output, ms since epoch */
  active: number;
  /** What's running in it, e.g. claude or bash */
  command: string;
  /** The title the program running in it set (Claude sets the conversation's), if any */
  title: string | null;
};

/** What keeps a running container up: its open terminals, and whether `orca up` marked it. */
export type Activity = { terminals: Terminal[]; up: boolean };

/** The mark `orca up` leaves, in a folder emptied on every start (container-features.md) */
const UP = "/run/orca/up";

/** The first line of what orca runs in a container, so its output can't be mistaken for anything else */
const RAN = "orca-ran";

const FORMAT = "#{session_name}|#{session_attached}|#{session_activity}|#{pane_current_command}|#{host}|#{pane_title}";

/** A running container's activity (no terminals when tmux has no server yet). */
export async function activity(ctx: Context, container: string): Promise<Activity> {
  // Both in one docker exec, as the dashboard asks every few seconds
  const r = await probe(ctx, ["exec", container, "sh", "-c", `echo ${RAN}; test -e ${UP} && echo up; tmux list-sessions -F '${FORMAT}'`]);
  const [ran, ...lines] = r.stdout.split("\n").filter(Boolean);
  // Anything else on stdout (Docker's own message, when it couldn't run the command) isn't terminals
  if (ran !== RAN) return { terminals: [], up: false };
  const terminals = lines
    .filter((line) => line !== "up")
    .map((line) => {
      const [name, attached, active, command, host, ...title] = line.split("|");
      const t = title.join("|");
      // Until a program sets one, a pane's title is the container's hostname
      return { name, attached: Number(attached) || 0, active: Number(active) * 1000 || 0, command, title: t && t !== host ? t : null };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { terminals, up: lines.includes("up") };
}

/**
 * Whether a running container has what a terminal needs: Docker can run a command in it, and
 * each folder orca mounts from the Mac is there. If not, says what's missing and what to do.
 */
export async function checkReady(ctx: Context, name: string, container: string, mounted: { source: string; target: string }[]) {
  const checks = mounted.map((m) => `[ -d '${m.target}/.' ] && [ -r '${m.target}/.' ] || echo 'missing ${m.target}'`).join("; ");
  const r = await probe(ctx, ["exec", container, "sh", "-c", `echo ${RAN}; ${checks}`]);
  const [ran, ...lines] = r.stdout.split("\n").filter(Boolean);
  const missing = mounted.filter((m) => lines.includes(`missing ${m.target}`));
  const problem =
    ran !== RAN
      ? `Docker couldn't run a command in it (${(r.stdout + r.stderr).trim().split("\n")[0] || `exit ${r.code}`})`
      : missing.length
        ? `${missing.map((m) => `${m.target} (${tilde(ctx, m.source)} on this Mac)`).join(" and ")} ${missing.length === 1 ? "isn't" : "aren't"} there inside it`
        : null;
  if (problem)
    throw new OrcaError(
      `${container} isn't ready: ${problem}.`,
      `Try: orca stop ${name}, then orca start again. If it still isn't ready, restart Docker Desktop. To work meanwhile: orca fallback`,
    );
}

/** The terminals open in a running container. */
export const listTerminals = async (ctx: Context, container: string) => (await activity(ctx, container)).terminals;

/** Marks a running container to keep running until it's stopped; false if it has nowhere to. */
export async function keepUp(ctx: Context, container: string): Promise<boolean> {
  return (await probe(ctx, ["exec", container, "touch", UP])).code === 0;
}

/** Each running project's activity, by project name. */
export async function activities(ctx: Context, projects: { name: string; container: Container | null }[]): Promise<Map<string, Activity>> {
  const running = projects.filter((p) => p.container?.running && hasTerminals(p.container));
  return new Map(await Promise.all(running.map(async (p) => [p.name, await activity(ctx, p.container!.name)] as const)));
}

/** The next terminal name: the lowest number not in use. */
export function nextName(open: Terminal[]): string {
  for (let i = 1; ; i++) if (!open.some((t) => t.name === String(i))) return String(i);
}

/** docker arguments that attach this window to the named terminal, creating it (running `command`) if needed. */
export function terminalArgs(container: string, name: string, command?: string[]): string[] {
  // A terminal type every modern terminal handles, rather than the Mac's own, which the
  // container may not know (e.g. Ghostty's) or may be unusable (CI); COLORTERM for full color
  const exec = ["exec", "-it", "-e", "TERM=xterm-256color", "-e", "COLORTERM", container, "tmux"];
  return command?.length ? [...exec, "new-session", "-s", name, "--", ...command] : [...exec, "new-session", "-A", "-s", name];
}

/** One line per terminal, for the command line. */
export function describe(t: Terminal, now = Date.now()): string {
  const parts = [t.command, t.attached ? "open in a window" : `active ${ago(t.active, now)}`];
  return `${t.name}  ${parts.join(" · ")}${t.title ? `  "${t.title}"` : ""}`;
}

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
