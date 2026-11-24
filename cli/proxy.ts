import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { caddyfile, type Server } from "./caddyfile";
import { readConfig } from "./config";
import { OrcaError } from "./errors";
import { tilde, type Context } from "./context";
import { docker, dockerSaid, probe } from "./docker";
import { execIn, IN_CONTAINER, ranOutput } from "./in-container";
import { containerName, hostFor, label, LABELS, networkName, PROXY, PROXY_DATA, PROXY_IMAGE } from "./names";
import { caFile, configFile, proxyConfigFile, proxyDir } from "./state";
import { listContainers } from "./containers";
import { allForwards, innerPort, parseAddress, type Forward } from "./forwards";

/**
 * Forwards: one Caddy container, orca-proxy, is the only thing published on the Mac
 * (127.0.0.1:<proxyPort>, and the ports of any extra addresses). Each forward is a hostname,
 * http://<port>.<project>.localhost:<proxyPort>, plus any URLs it was given (orca forward --url),
 * routed to that project's container over the project's own network, which only the proxy
 * also joins. Orca starts the proxy while any project has forwards and removes it when none do.
 */

/** The command that makes this Mac trust it, for the platforms orca knows one for. */
export const trustCommand = (ctx: Context) =>
  process.platform === "darwin" ? `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${tilde(ctx, caFile(ctx))}` : null;

/** Refuses, saying which and what to do, when a port the proxy publishes is taken on the Mac. */
async function checkPortsFree(ctx: Context, port: number, ports: number[]) {
  for (const p of [port, ...ports])
    if (!(await ctx.portFree(p)))
      throw p === port
        ? new OrcaError(`Port ${port} on this Mac is already taken, so the forwards proxy can't start.`, `Choose another in ${tilde(ctx, configFile(ctx))}: {"proxyPort": ${port + 1}}`)
        : new OrcaError(`Port ${p} on this Mac is already taken, so the forwards proxy can't serve addresses on it.`, "Stop what's using it, or use a URL with another port.");
}

/** Makes sure the project's own network exists. */
export async function ensureNetwork(ctx: Context, project: string): Promise<string> {
  const name = networkName(project);
  if ((await probe(ctx, ["network", "inspect", name])).code !== 0)
    await docker(ctx, ["network", "create", "--label", label("network", project), name]);
  return name;
}

/** Removes the project's own network, if it has one; the proxy leaves it first. */
export async function removeNetwork(ctx: Context, project: string) {
  const network = networkName(project);
  if ((await probe(ctx, ["network", "inspect", network])).code !== 0) return;
  const proxy = (await listContainers(ctx)).find((c) => c.name === PROXY);
  if (proxy?.networks.includes(network)) await docker(ctx, ["network", "disconnect", network, PROXY]);
  await docker(ctx, ["network", "rm", network]);
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
    const r = await probe(ctx, execIn(PROXY, IN_CONTAINER.proxyCa));
    const cert = r.code === 0 ? (ranOutput(IN_CONTAINER.proxyCa, r.stdout)?.join("\n") ?? "") + "\n" : "";
    if (cert.includes("BEGIN CERTIFICATE")) {
      const file = caFile(ctx);
      if (!existsSync(file) || readFileSync(file, "utf8") !== cert) writeFileSync(file, cert);
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
    // Published ports must be free on the Mac: checked first, so the error says which and why
    await checkPortsFree(ctx, port, ports);
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
      // A port taken since the check (or that a check from here can't see) says so; anything else, Docker says
      await checkPortsFree(ctx, port, ports);
      throw new OrcaError(`The forwards proxy didn't start: ${dockerSaid(r)}`);
    }
  } else if (!proxy.running) {
    await docker(ctx, ["start", PROXY]);
  }

  // A proxy made just now has joined none yet
  const joined = proxy?.networks ?? [];
  for (const n of networks) if (!joined.includes(n.name)) await docker(ctx, ["network", "connect", n.name, PROXY]);
  // A reload is handed the config by orca, so it doesn't depend on reading it through a folder
  // shared from the Mac
  if (reload)
    await docker(ctx, execIn(PROXY, IN_CONTAINER.proxyReload(config)));
  if (forwards.some((f) => f.urls.some((u) => parseAddress(u).https))) await copyCa(ctx);
  return { port, ports, running: true };
}

/** Whether the proxy is running, without changing anything. */
export async function proxyState(ctx: Context): Promise<ProxyState> {
  const proxy = (await listContainers(ctx)).find((c) => c.name === PROXY);
  return { port: readConfig(ctx).proxyPort, ports: extraPorts(ctx, allForwards(ctx)), running: Boolean(proxy?.running) };
}
