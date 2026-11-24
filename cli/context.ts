import { createServer } from "node:net";
import { OrcaError } from "./errors";
import { lookup } from "node:dns/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { realDocker, type Docker, type Result } from "./docker";

/** One answer to a question asked with `choose`: what it shows, and what choosing it returns. */
export type Option = { label: string; value: string };

/** Everything a command needs from the outside world, so tests can replace any of it. */
export type Context = {
  docker: Docker;
  /** ~/.orca on the Mac (ORCA_DIR overrides it) */
  orcaDir: string;
  /** The user's home on the Mac, for showing paths as ~/... */
  home: string;
  print: (line?: string) => void;
  /** Asks a question on the terminal; null when there's no terminal to ask on. */
  ask: ((question: string) => Promise<string>) | null;
  /** Asks a question answered with the arrow keys; resolves to the chosen value, or null if the user quit. Null when there's no terminal. */
  choose: ((question: string, options: Option[]) => Promise<string | null>) | null;
  color: boolean;
  /** Starts a program on the Mac without waiting for it (e.g. a terminal window) */
  launch: (argv: string[]) => Promise<void>;
  /** Runs a program on the Mac and captures its output (e.g. git config, for a new home) */
  host: (argv: string[]) => Promise<Result>;
  /** A hostname's addresses, looked up on the Mac as a browser there would; none if it doesn't resolve */
  lookup: (hostname: string) => Promise<string[]>;
  /** Whether a port on the Mac's 127.0.0.1 is free to publish: false only when something listens on it */
  portFree: (port: number) => Promise<boolean>;
  /** The web, for what's published on GitHub (images, orca's builds) */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
};

export function realContext(): Context {
  const home = homedir();
  const orcaDir = process.env.ORCA_DIR ?? join(home, ".orca");
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return {
    docker: realDocker,
    orcaDir,
    home,
    print: (line = "") => console.log(line),
    ask: interactive ? (q) => Promise.resolve(prompt(q) ?? "") : null,
    // Set by the entry point, which has the terminal UI (ui/show.tsx), when there's a terminal
    choose: null,
    color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
    launch: async (argv) => {
      const proc = Bun.spawn(argv, { stdio: ["ignore", "ignore", "pipe"] });
      if ((await proc.exited) !== 0) throw new OrcaError(`Couldn't open a terminal: ${(await new Response(proc.stderr).text()).trim()}`);
    },
    host: async (argv) => {
      try {
        // Detached from the terminal, as docker's runs are, so it doesn't take the window's title
        const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", detached: true });
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        return { code, stdout, stderr };
      } catch {
        return { code: 127, stdout: "", stderr: `${argv[0]}: command not found` };
      }
    },
    fetch: (url, init) => fetch(url, init),
    portFree: (port) =>
      new Promise((resolve) => {
        // Only "in use" means taken: ports below 1024 refuse an unprivileged listener on macOS,
        // yet Docker publishes them
        const server = createServer().once("error", (e: NodeJS.ErrnoException) => resolve(e.code !== "EADDRINUSE"));
        server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
      }),
    lookup: async (hostname) => {
      const timeout = new Promise<[]>((resolve) => setTimeout(() => resolve([]), 2000));
      const found = lookup(hostname, { all: true }).then((all) => all.map((a) => a.address), () => []);
      return Promise.race([found, timeout]);
    },
  };
}


/** Shows a host path the way the user would type it. */
export function tilde(ctx: Context, path: string): string {
  return path === ctx.home || path.startsWith(ctx.home + "/") ? "~" + path.slice(ctx.home.length) : path;
}
