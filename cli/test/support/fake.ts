import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "../../context";
import type { Docker, Result } from "../../docker";

export type FakeContainer = {
  name: string;
  running?: boolean;
  startedAt?: string;
  image?: string;
  labels?: Record<string, string>;
  workspace?: string;
  home?: string;
  networks?: string[];
  /** Open terminals, as tmux list-sessions prints them (name|attached|activity|command|host|title) */
  terminals?: string[];
  /** Marked by orca up (the mark is emptied on every start) */
  up?: boolean;
  /** Its resources: memory in bytes, CPUs (8 GB and 4 unless set) */
  memory?: number;
  cpus?: number;
  /** What docker stats says it uses, e.g. "2.1GiB" */
  used?: string;
  /** Docker can't run any command in it (here with runc's message for a working directory it can't reach) */
  refusesExec?: boolean;
  /** Mount targets that aren't there inside it, e.g. ["/home/node"] */
  missing?: string[];
};

export type FakeNetwork = { name: string; subnet: string; labels: Record<string, string> };

export type FakeState = {
  containers: FakeContainer[];
  volumes: string[];
  networks: FakeNetwork[];
  /** id of orca:latest, or null if the image isn't there */
  latest: string | null;
  created: Record<string, string>;
  /** Images made before terminals (no orca.terminals label) */
  noTerminals?: string[];
  /** Image names besides orca:latest on this Mac, and the ids they point at (e.g. orca:previous) */
  tags?: Record<string, string>;
  /** Published images by their dated tag (yyyy-mm-dd-commit), and their ids; `docker pull` brings one here */
  published?: Record<string, string>;
  /** orca's published builds, as GitHub's releases API lists them */
  releases?: { tag_name: string; published_at: string }[];
  /** what `docker pull` makes orca:latest's remote tag point at */
  pulled?: string;
  failPull?: boolean;
  /** docker commands that fail, by their first arguments, e.g. "network create" or "update" */
  failing?: string[];
  /** Mac ports something else is listening on, so publishing them fails */
  taken?: number[];
  /** What Docker has in all (docker info); 16 GB and 10 CPUs unless set */
  total?: { memory: number; cpus: number };
};

/** A docker stand-in that answers from `state` and records every command. */
export function fakeDocker(state: FakeState) {
  const calls: string[][] = [];
  const attached: string[][] = [];
  const ok = (stdout = ""): Result => ({ code: 0, stdout, stderr: "" });
  const fail = (stderr: string): Result => ({ code: 1, stdout: "", stderr });
  const find = (n: string) => state.containers.find((c) => c.name === n);
  // An image name, as Docker finds it on this Mac: orca:latest, an id, or another tag
  const resolve = (ref: string) => (ref === "orca:latest" ? state.latest : ref.startsWith("sha256:") ? ref : state.tags?.[ref]);
  const imageLabels = (id: string): Record<string, string> =>
    state.noTerminals?.includes(id) ? {} : { "orca.terminals": "1", "orca.up": "1", "orca.generation": "2" };

  function network([sub, ...a]: string[]): Result {
    const net = (n: string) => state.networks.find((x) => x.name === n);
    if (sub === "ls") {
      const label = a[a.indexOf("--filter") + 1].replace(/^label=/, "");
      return ok(state.networks.filter((n) => label in n.labels).map((n) => n.name).join("\n"));
    }
    if (sub === "inspect") {
      const found = a.map(net);
      if (found.some((n) => !n)) return fail("network not found");
      return ok(JSON.stringify(found.map((n) => ({ Name: n!.name, IPAM: { Config: [{ Subnet: n!.subnet }] } }))));
    }
    if (sub === "create") {
      const [k, v] = a[a.indexOf("--label") + 1].split("=");
      state.networks.push({ name: a[a.length - 1], subnet: `172.${20 + state.networks.length}.0.0/16`, labels: { [k]: v } });
      return ok();
    }
    if (sub === "connect" || sub === "disconnect") {
      const [n, c] = a;
      const target = find(c);
      if (!target || !net(n)) return fail("not found");
      target.networks ??= [];
      if (sub === "connect") {
        if (target.networks.includes(n)) return fail(`endpoint with name ${c} already exists in network ${n}`);
        target.networks.push(n);
      } else target.networks = target.networks.filter((x) => x !== n);
      return ok();
    }
    if (sub === "rm") {
      state.networks = state.networks.filter((n) => n.name !== a[0]);
      return ok();
    }
    return fail(`fake docker: unhandled network ${sub}`);
  }

  const docker: Docker = {
    async run(args) {
      if (state.failing?.some((f) => args.join(" ").startsWith(f))) return fail(`fake docker: ${args.slice(0, 2).join(" ")} failed`);
      calls.push(args);
      const [cmd, ...rest] = args;
      if (cmd === "version") return ok("27.0.0");
      if (cmd === "ps") return ok(state.containers.map((c) => c.name).join("\n"));
      if (cmd === "inspect") {
        const found = rest.filter((n) => !n.startsWith("-")).map(find).filter((c) => c !== undefined);
        return ok(JSON.stringify(found.map(inspected)));
      }
      if (cmd === "image" && rest[0] === "inspect") {
        const id = resolve(rest[rest.length - 1]);
        if (!id) return fail("No such image");
        return ok(JSON.stringify([{ Id: id, Created: state.created[id] ?? "2026-01-01T00:00:00Z", Config: { Labels: imageLabels(id) } }]));
      }
      if (cmd === "rm") {
        state.containers = state.containers.filter((c) => c.name !== rest[rest.length - 1]);
        return ok();
      }
      if (cmd === "volume" && rest[0] === "inspect") return state.volumes.includes(rest[1]) ? ok("[]") : fail("no such volume");
      if (cmd === "volume" && rest[0] === "rm") {
        if (!state.volumes.includes(rest[1])) return fail("no such volume");
        state.volumes = state.volumes.filter((v) => v !== rest[1]);
        return ok();
      }
      if (cmd === "network") return network(rest);
      if ((cmd === "run" && rest[0] === "-d") || cmd === "create") {
        const flag = (f: string) => rest.flatMap((a, i) => (a === f ? [rest[i + 1]] : []));
        const taken = flag("-p").map((p) => Number(p.split(":")[1])).find((p) => state.taken?.includes(p));
        if (taken) return fail(`Bind for 127.0.0.1:${taken} failed: port is already allocated`);
        // Like Docker: the image is the last argument, and the container gets its labels too
        const ref = rest[rest.length - 1];
        const image = resolve(ref) ?? ref;
        const labels = { ...imageLabels(image), ...Object.fromEntries(flag("--label").map((l) => l.split("=") as [string, string])) };
        const limit = (f: string) => rest.find((a) => a.startsWith(`${f}=`))?.slice(f.length + 1);
        const mount = (dest: string) => flag("-v").find((v) => v.endsWith(`:${dest}`))?.slice(0, -dest.length - 1);
        state.containers.push({ name: flag("--name")[0], running: cmd === "run", image, labels, networks: [], memory: Number(limit("--memory")), cpus: Number(limit("--cpus")), workspace: mount("/workspace"), home: mount("/home/node") });
        return ok("id");
      }
      if (cmd === "update") {
        const c = find(rest[rest.length - 1]);
        if (!c) return fail("No such container");
        for (const a of rest) {
          if (a.startsWith("--memory=")) c.memory = Number(a.slice(9));
          if (a.startsWith("--cpus=")) c.cpus = Number(a.slice(7));
        }
        return ok(c.name);
      }
      if (cmd === "info") {
        const t = state.total ?? { memory: 16 * 1024 ** 3, cpus: 10 };
        return ok(`${t.memory} ${t.cpus}\n`);
      }
      if (cmd === "stats") {
        const c = find(rest[rest.length - 1]);
        return c?.running ? ok(`${c.used ?? "1GiB"} / ${c.memory}B\n`) : fail("not running");
      }
      if (cmd === "start") {
        const c = find(rest[rest.length - 1]);
        if (c) (c.running = true), (c.up = false);
        return c ? ok() : fail("No such container");
      }
      if (cmd === "stop") {
        const c = find(rest[rest.length - 1]);
        if (c) (c.running = false), (c.up = false);
        return c ? ok() : fail("No such container");
      }
      // Docker prints runc's refusal on stdout
      if (cmd === "exec" && find(rest.find((a) => !a.startsWith("-") && !a.includes("=")) ?? "")?.refusesExec)
        return {
          code: 126,
          stdout: "OCI runtime exec failed: exec failed: unable to start container process: current working directory is outside of container mount namespace root -- possible container breakout detected: unknown\n",
          stderr: "",
        };
      // What a terminal needs, as orca checks it (checkReady): the folders it mounts
      if (cmd === "exec" && rest.some((a) => a.includes("|| echo 'missing"))) {
        const c = find(rest[0]);
        return ok(["orca-ran", ...(c?.missing ?? []).map((m) => `missing ${m}`)].join("\n") + "\n");
      }
      // The mark and the terminals together, as orca asks for them (terminals.ts)
      if (cmd === "exec" && rest.some((a) => a.includes("list-sessions"))) {
        const c = find(rest[0]);
        const lines = ["orca-ran", ...(c?.up ? ["up"] : []), ...(c?.terminals ?? [])];
        return { code: c?.terminals?.length ? 0 : 1, stdout: lines.map((l) => l + "\n").join(""), stderr: c?.terminals?.length ? "" : "no server running" };
      }
      if (cmd === "exec" && rest.includes("touch")) {
        const c = find(rest[0]);
        if (!c?.running || c.labels?.["orca.up"] !== "1") return fail("touch: cannot touch '/run/orca/up': No such file or directory");
        c.up = true;
        return ok();
      }
      // The proxy's certificate authority, as Caddy makes it
      if (cmd === "exec" && rest.some((a) => a.endsWith("root.crt"))) return ok("-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n");
      if (cmd === "exec") return ok();
      if (cmd === "tag") {
        const id = resolve(rest[0]);
        if (!id) return fail("No such image");
        if (rest[1] === "orca:latest") state.latest = id;
        else state.tags = { ...state.tags, [rest[1]]: id };
        return ok();
      }
      return fail(`fake docker: unhandled ${args.join(" ")}`);
    },
    async attach(args) {
      attached.push(args);
      if (args[0] === "pull") {
        if (state.failPull) return 1;
        // The published :latest is what `pulled` says; a dated one, what `published` has
        const tag = args[1].split(":").pop()!;
        const id = tag === "latest" ? (state.pulled ?? state.latest) : state.published?.[tag];
        if (!id) return 1;
        state.tags = { ...state.tags, [args[1]]: id };
        return 0;
      }
      return 0;
    },
  };
  return { docker, calls, attached };
}

function inspected(c: FakeContainer) {
  const mounts = [];
  if (c.workspace) mounts.push({ Source: c.workspace, Destination: "/workspace" });
  if (c.home) mounts.push({ Source: c.home, Destination: "/home/node" });
  return {
    Name: "/" + c.name,
    State: { Running: c.running ?? false, StartedAt: c.startedAt ?? "0001-01-01T00:00:00Z" },
    Image: c.image ?? "sha256:new",
    Config: { Labels: c.labels ?? null },
    Mounts: mounts,
    NetworkSettings: { Networks: Object.fromEntries((c.networks ?? []).map((n) => [n, {}])) },
    HostConfig: { Memory: c.memory ?? 8 * 1024 ** 3, NanoCpus: (c.cpus ?? 4) * 1e9 },
  };
}

/** A context over a fresh temp folder standing in for the Mac's home. */
/** `answers` answer `ask` and `choose` in turn; for `choose`, an option's value, or null to quit. */
/** `names` are what hostnames look up to on the Mac (as /etc/hosts would say). */
export function fakeContext(state: Partial<FakeState> = {}, answers: (string | null)[] = [], host: Record<string, string> = {}, names: Record<string, string[]> = {}) {
  const home = mkdtempSync(join(tmpdir(), "orca-test-"));
  const full: FakeState = { containers: [], volumes: [], networks: [], latest: "sha256:new", created: {}, ...state };
  const { docker, calls, attached } = fakeDocker(full);
  const lines: string[] = [];
  const launched: string[][] = [];
  const ctx: Context = {
    docker,
    orcaDir: join(home, ".orca"),
    home,
    print: (line = "") => lines.push(line),
    ask: answers.length ? async () => answers.shift() ?? "" : null,
    choose: answers.length
      ? async (question, options) => {
          lines.push(question, ...options.map((o) => `  ${o.label}`));
          const answer = answers.shift() ?? null;
          return options.some((o) => o.value === answer) ? answer : null;
        }
      : null,
    color: false,
    launch: async (argv) => void launched.push(argv),
    host: async (argv) => {
      const key = argv.join(" ");
      return key in host ? { code: 0, stdout: host[key] + "\n", stderr: "" } : { code: 1, stdout: "", stderr: "" };
    },
    lookup: async (hostname) => names[hostname] ?? [],
    // What's published: GitHub's container registry (its tags) and orca's releases
    fetch: async (url) => {
      if (url.startsWith("https://ghcr.io/token")) return full.published ? Response.json({ token: "t" }) : new Response("", { status: 503 });
      if (url.includes("/tags/list")) return Response.json({ tags: ["latest", "buildcache-arm64", ...Object.keys(full.published ?? {})] });
      if (url.startsWith("https://api.github.com/repos/") && full.releases) return Response.json(full.releases);
      return new Response("", { status: 404 });
    },
  };
  return { ctx, home, state: full, calls, attached, lines, launched, output: () => lines.join("\n") };
}
