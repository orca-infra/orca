// A project's forwards: its forwarded ports and the extra addresses each has, recorded in its
// forwards file (state.ts), and how an address is read. The proxy (proxy.ts) serves them.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readConfig } from "./config";
import { type Context } from "./context";
import { OrcaError } from "./errors";
import { hostFor } from "./names";
import { recordNames } from "./records";
import { forwardsFile } from "./state";

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
