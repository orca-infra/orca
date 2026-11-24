// Every call to the container runtime goes through here, as `docker` commands with flags
// Podman also accepts, so the runtime stays swappable and tests can use a fake. Commands use
// docker() for what must succeed and probe() for questions; nothing calls ctx.docker.run itself.
import type { Context } from "./context";
import { OrcaError } from "./errors";

export type Result = { code: number; stdout: string; stderr: string };

export interface Docker {
  /** Runs docker and captures its output. */
  run(args: string[]): Promise<Result>;
  /** Runs docker attached to this terminal (for interactive shells); returns the exit code. */
  attach(args: string[]): Promise<number>;
}

export const realDocker: Docker = {
  async run(args) {
    try {
      // Detached from the terminal (its own session): orca serve runs these every few seconds,
      // and a terminal titles its window after the program in front, so it flashed "docker"
      const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", detached: true });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr };
    } catch {
      return { code: 127, stdout: "", stderr: "docker: command not found" };
    }
  },
  async attach(args) {
    const proc = Bun.spawn(["docker", ...args], { stdio: ["inherit", "inherit", "inherit"] });
    const code = await proc.exited;
    // A tmux killed with its container can't undo what it turned on, so the Mac's terminal kept
    // reporting the mouse into the shell as text: turn off mouse reporting and focus events,
    // and show the cursor (all harmless when tmux already did)
    if (process.stdout.isTTY) process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?25h");
    return code;
  },
};

/**
 * Runs a docker command that must succeed, returning its output. A failure always carries what
 * Docker said; when Docker itself doesn't answer, it says that instead.
 */
export async function docker(ctx: Context, args: string[]): Promise<string> {
  const r = await ctx.docker.run(args);
  if (r.code === 0) return r.stdout;
  if (r.code === 127) throw new OrcaError("Docker isn't installed.", "Install Docker Desktop: https://docs.docker.com/desktop/");
  if (!(await answers(ctx))) throw new OrcaError(`Docker isn't running (${dockerSaid(r).split("\n")[0]}).`, "Start Docker Desktop, then try again.");
  throw new OrcaError(`docker ${args[0]} failed: ${dockerSaid(r)}`);
}

/** What Docker said about a failure: on stderr, or for some (an exec it couldn't start) on stdout. */
export const dockerSaid = (r: Result) => r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`;

/** Runs a docker command whose result is the answer to a question (is it there?); never throws. */
export const probe = (ctx: Context, args: string[]): Promise<Result> => ctx.docker.run(args);

/** Runs docker attached to this terminal (an interactive shell), returning its exit code. */
export const attach = (ctx: Context, args: string[]): Promise<number> => ctx.docker.attach(args);

/** Whether the Docker engine answers at all. */
const answers = async (ctx: Context) => (await ctx.docker.run(["info", "--format", "{{.ServerVersion}}"])).code === 0;
