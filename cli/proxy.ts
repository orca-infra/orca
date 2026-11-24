import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { caddyfile, type Server } from "./caddyfile";
import { readConfig } from "./config";
import { OrcaError } from "./errors";
import { tilde, type Context } from "./context";
import { docker, probe } from "./docker";
import { containerName, hostFor, label, LABELS, networkName, PROXY, PROXY_DATA, PROXY_IMAGE } from "./names";
import { caFile, configFile, forwardsFile, proxyConfigFile, proxyDir } from "./state";
import { listContainers } from "./containers";
import { recordNames } from "./records";

/**
 * Forwards: one Caddy container, orca-proxy, is the only thing published on the Mac
 * (127.0.0.1:<proxyPort>, and the ports of any extra addresses). Each forward is a hostname,
 * http://<port>.<project>.localhost:<proxyPort>, plus any URLs it was given (orca forward --url),
 * routed to that project's container over the project's own network, which only the proxy
 * also joins. Orca starts the proxy while any project has forwards and removes it when none do.
 */

export const urlFor = (ctx: Context, port: number, project: string) =>
  `http://${hostFor(port, project)}:${readConfig(ctx).proxyPort}`;


/** A forwarded port, and the addresses it has besides its usual one, e.g. https://dev.myapp.com. */
export type Forward = { port: number; urls: string[] };

/** A project's forwards, from its file: a line per port ("3000"), and one per extra address ("3000 https://dev.myapp.com"). */
export function readForwards(ctx: Context, project: string): Forward[] {
  const file = forwardsFile(ctx, project);
  if (!existsSync(file)) return [];
  const forwards = new Map<number, Forward>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const [p, url] = line.trim().split(/\s+/);
    const port = Number(p);
    if (!Number.isInteger(port) || port <= 0) continue;
    const f = forwards.get(port) ?? { port, urls: [] };
    if (url && !f.urls.includes(url)) f.urls.push(url);
    forwards.set(port, f);
  }
  return [...forwards.values()].sort((a, b) => a.port - b.port);
}

export function writeForwards(ctx: Context, project: string, forwards: Forward[]) {
  const sorted = [...forwards].sort((a, b) => a.port - b.port);
  writeFileSync(forwardsFile(ctx, project), sorted.map((f) => [`${f.port}\n`, ...f.urls.map((u) => `${f.port} ${u}\n`)].join("")).join(""));
}

/** Every project's forwards, from the records. */
export function allForwards(ctx: Context): ({ project: string } & Forward)[] {
  // Sorted, so the proxy's config doesn't depend on the order the disk lists them in
  return recordNames(ctx)
    .sort()
    .flatMap((project) => readForwards(ctx, project).map((f) => ({ project, ...f })));
}

/** An extra address for a forward: the URL's origin, since paths go through as they are. */
export type Address = { url: string; https: boolean; host: string; port: number };

export function parseAddress(text: string): Address {
  const bad = () => new OrcaError(`"${text}" isn't a URL orca can serve a forward at.`, "Give the whole URL, starting http:// or https://, e.g. https://dev.myapp.com");
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw bad();
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || !u.hostname) throw bad();
  const https = u.protocol === "https:";
  return { url: u.origin, https, host: u.hostname, port: u.port ? Number(u.port) : https ? 443 : 80 };
}

/** The port inside the proxy's container that serves a Mac port: the usual addresses' is 80. */
export const innerPort = (ctx: Context, macPort: number) => (macPort === readConfig(ctx).proxyPort ? 80 : macPort);

/** Whether a hostname needs pointing at the Mac (localhost and IP addresses already do). */
export const needsPointing = (host: string) => !(host === "localhost" || host.endsWith(".localhost") || /^[\d.]+$|^\[/.test(host));

/** Whether the Mac sends a hostname to itself, as a browser there would look it up. */
export async function pointsHere(ctx: Context, host: string): Promise<boolean> {
  if (!needsPointing(host)) return true;
  return (await ctx.lookup(host)).some((a) => a.startsWith("127.") || a === "::1");
}

const CA_IN_PROXY = "/data/caddy/pki/authorities/local/root.crt";


/** The command that makes this Mac trust it, for the platforms orca knows one for. */
export const trustCommand = (ctx: Context) =>
  process.platform === "darwin" ? `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${tilde(ctx, caFile(ctx))}` : null;

/** Makes sure the project's own network exists. */
export async function ensureNetwork(ctx: Context, project: string): Promise<string> {
  const name = networkName(project);
  if ((await probe(ctx, ["network", "inspect", name])).code !== 0)
    await docker(ctx, ["network", "create", "--label", label("network", project), name]);
  return name;
}

async function projectNetworks(ctx: Context): Promise<{ name: string; subnets: string[] }[]> {
  const names = (await docker(ctx, ["network", "ls", "--filter", `label=${LABELS.network}`, "--format", "{{.Name}}"])).split("\n").filter(Boolean);
  if (names.length === 0) return [];
  const nets = JSON.parse(await docker(ctx, ["network", "inspect", ...names])) as { Name: string; IPAM: { Config: { Subnet?: string }[] | null } }[];
  return nets.map((n) => ({ name: n.Name, subnets: (n.IPAM.Config ?? []).flatMap((c) => (c.Subnet ? [c.Subnet] : [])) }));
}

/** Copies the authority's certificate out of the proxy, waiting the moment Caddy takes to make it the first time. */
async function copyCa(ctx: Context) {
  for (let i = 0; i < 20; i++) {
    const r = await probe(ctx, ["exec", PROXY, "cat", CA_IN_PROXY]);
    if (r.code === 0 && r.stdout.includes("BEGIN CERTIFICATE")) {
      const file = caFile(ctx);
      if (!existsSync(file) || readFileSync(file, "utf8") !== r.stdout) writeFileSync(file, r.stdout);
      return;
    }
    await Bun.sleep(250);
  }
}

/** The Mac ports the proxy is published on for extra addresses, besides proxyPort. */
function extraPorts(ctx: Context, forwards: Forward[]): number[] {
  const ports = forwards.flatMap((f) => f.urls.map((u) => parseAddress(u).port)).filter((p) => innerPort(ctx, p) !== 80);
  return [...new Set(ports)].sort((a, b) => a - b);
}

/** Where the proxy listens: proxyPort, and the ports of extra addresses */
export type ProxyState = { port: number; ports: number[]; running: boolean };

/** Brings the proxy in line with every project's forwards: config, port, networks, running. */
export async function syncProxy(ctx: Context): Promise<ProxyState> {
  const { proxyPort: port } = readConfig(ctx);
  const forwards = allForwards(ctx);
  let proxy = (await listContainers(ctx)).find((c) => c.name === PROXY) ?? null;

  if (forwards.length === 0) {
    if (proxy) await docker(ctx, ["rm", "-f", PROXY]);
    return { port, ports: [], running: false };
  }

  const networks = await projectNetworks(ctx);
  const servers = new Map<number, Server>([[80, { port: 80, https: false, routes: [] }]]);
  for (const f of forwards) {
    const upstream = `${containerName(f.project)}:${f.port}`;
    servers.get(80)!.routes.push({ host: hostFor(f.port, f.project), upstream });
    for (const a of f.urls.map(parseAddress)) {
      const inner = innerPort(ctx, a.port);
      if (!servers.has(inner)) servers.set(inner, { port: inner, https: a.https, routes: [] });
      servers.get(inner)!.routes.push({ host: a.host, upstream });
    }
  }
  const ports = extraPorts(ctx, forwards);
  mkdirSync(proxyDir(ctx), { recursive: true });
  const config = caddyfile([...servers.values()], networks.flatMap((n) => n.subnets));
  writeFileSync(proxyConfigFile(ctx), config);

  // Published ports are fixed when a container is made, so a change means a new proxy
  if (proxy && (proxy.labels[LABELS.proxyPort] !== String(port) || proxy.labels[LABELS.proxyPorts] !== ports.join(","))) {
    await docker(ctx, ["rm", "-f", PROXY]);
    proxy = null;
  }
  const reload = proxy?.running ?? false;
  if (!proxy) {
    // Published ports must be free on the Mac; checked first, so the error says which and why
    for (const p of [port, ...ports])
      if (!(await ctx.portFree(p)))
        throw p === port
          ? new OrcaError(`Port ${port} on this Mac is already taken, so the forwards proxy can't start.`, `Choose another in ${tilde(ctx, configFile(ctx))}: {"proxyPort": ${port + 1}}`)
          : new OrcaError(`Port ${p} on this Mac is already taken, so the forwards proxy can't serve addresses on it.`, "Stop what's using it, or use a URL with another port.");
    const r = await probe(ctx, [
      "run", "-d",
      "--name", PROXY,
      "--label", label("proxy", "true"),
      "--label", label("proxyPort", String(port)),
      "--label", label("proxyPorts", ports.join(",")),
      "-p", `127.0.0.1:${port}:80`,
      ...ports.flatMap((p) => ["-p", `127.0.0.1:${p}:${p}`]),
      "-v", `${proxyDir(ctx)}:/etc/caddy:ro`,
      // Caddy's certificate authority, kept so the Mac's trust in it lasts
      "-v", `${PROXY_DATA}:/data`,
      PROXY_IMAGE,
    ]);
    if (r.code !== 0) {
      await probe(ctx, ["rm", "-f", PROXY]);
      throw new OrcaError(`The forwards proxy didn't start: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`);
    }
    proxy = { name: PROXY, running: true, startedAt: 0, image: "", labels: {}, workspace: null, home: null, networks: [], memory: 0, cpus: 0 };
  } else if (!proxy.running) {
    await docker(ctx, ["start", PROXY]);
  }

  for (const n of networks) if (!proxy.networks.includes(n.name)) await docker(ctx, ["network", "connect", n.name, PROXY]);
  // A reload is handed the config by orca, so it doesn't depend on reading it through a folder
  // shared from the Mac
  if (reload)
    await docker(ctx, ["exec", PROXY, "sh", "-c", 'printf %s "$1" > /tmp/Caddyfile && exec caddy reload --config /tmp/Caddyfile --adapter caddyfile', "sh", config]);
  if (forwards.some((f) => f.urls.some((u) => parseAddress(u).https))) await copyCa(ctx);
  return { port, ports, running: true };
}

/** Whether the proxy is running, without changing anything. */
export async function proxyState(ctx: Context): Promise<ProxyState> {
  const proxy = (await listContainers(ctx)).find((c) => c.name === PROXY);
  return { port: readConfig(ctx).proxyPort, ports: extraPorts(ctx, allForwards(ctx)), running: Boolean(proxy?.running) };
}
