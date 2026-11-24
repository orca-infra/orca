// What orca runs inside containers, each by name. Each is one `sh -c` whose first line of output
// is "orca-ran <name>", so its output can't be mistaken for Docker's own (when Docker couldn't run
// it), and a test fake can tell which ran.

/** A command to run in a container: its name, and the arguments after `docker exec <container>` */
export type InContainer = { name: string; args: string[] };

const script = (name: string, body: string, ...params: string[]): InContainer => ({
  name,
  args: ["sh", "-c", `echo 'orca-ran ${name}'; ${body}`, ...(params.length ? ["sh", ...params] : [])],
});

/** The output after its first line, or null when it didn't run (what's there is someone else's) */
export function ranOutput(c: InContainer, stdout: string): string[] | null {
  const [first, ...rest] = stdout.split("\n").filter(Boolean);
  return first === `orca-ran ${c.name}` ? rest : null;
}

/** The mark `orca up` leaves, in a folder emptied on every start */
export const UP_MARK = "/run/orca/up";
/** Where Caddy keeps its certificate authority's certificate, in the proxy's data volume */
const CA_IN_PROXY = "/data/caddy/pki/authorities/local/root.crt";
/** One line per tmux session: name|attached|activity|command|host|title */
export const TERMINAL_FORMAT = "#{session_name}|#{session_attached}|#{session_activity}|#{pane_current_command}|#{host}|#{pane_title}";

export const IN_CONTAINER = {
  /** Whether orca up marked it, then its terminals; both in one exec, as the dashboard asks every few seconds */
  activity: script("activity", `test -e ${UP_MARK} && echo up; tmux list-sessions -F '${TERMINAL_FORMAT}'`),
  /** A "missing <folder>" line for each of these that isn't there, or can't be read, inside it */
  ready: (folders: string[]) => script("ready", folders.map((f) => `[ -d '${f}/.' ] && [ -r '${f}/.' ] || echo 'missing ${f}'`).join("; ")),
  /** Marks it to keep running until it's stopped (orca up) */
  keepUp: script("keep-up", `touch ${UP_MARK}`),
  /** The proxy loads this config, handed to it rather than read through a shared folder */
  proxyReload: (config: string) => script("proxy-reload", 'printf %s "$1" > /tmp/Caddyfile && exec caddy reload --config /tmp/Caddyfile --adapter caddyfile', config),
  /** The proxy's certificate authority's certificate, for the Mac to trust */
  proxyCa: script("proxy-ca", `cat ${CA_IN_PROXY}`),
};

/** docker arguments that run a command (or a shell) in a container, attached to this window */
export const shellArgs = (container: string, command?: string[]) => ["exec", "-it", container, ...(command?.length ? command : ["bash"])];

/** docker arguments that attach this window to the named terminal (tmux), creating it (running `command`) if needed. */
export function terminalArgs(container: string, name: string, command?: string[]): string[] {
  // A terminal type every modern terminal handles, rather than the Mac's own, which the
  // container may not know (e.g. Ghostty's) or may be unusable (CI); COLORTERM for full color
  const exec = ["exec", "-it", "-e", "TERM=xterm-256color", "-e", "COLORTERM", container, "tmux"];
  return command?.length ? [...exec, "new-session", "-s", name, "--", ...command] : [...exec, "new-session", "-A", "-s", name];
}
