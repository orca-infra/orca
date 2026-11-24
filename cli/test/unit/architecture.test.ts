// The code's structure, checked: what may import what, and where the one way of doing each
// thing lives. A failure here means a change has gone around that structure; the fix is to use
// the module that owns it, not to loosen the rule.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { Glob } from "bun";

const CLI = join(import.meta.dir, "../..");
const files = [...new Glob("**/*.{ts,tsx}").scanSync(CLI)].filter((f) => !f.startsWith("test/"));
const source = (f: string) => readFileSync(join(CLI, f), "utf8");
/** The code without its comments: the rules are about what code does, not what comments mention */
const code = (f: string) => source(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const moduleOf = (f: string) => f.replace(/\.tsx?$/, "");

/** Lowest first: a module may import (other than types) only from its own layer or below */
const LAYERS = ["core", "ui", "commands", "server", "entry"] as const;
function layerOf(m: string): (typeof LAYERS)[number] | "web" {
  if (m === "orca" || m === "build") return "entry";
  const top = m.split("/")[0];
  if (top === "web") return "web";
  return m.includes("/") && (LAYERS as readonly string[]).includes(top) ? (top as (typeof LAYERS)[number]) : "core";
}

/** Each module's local imports: what they load at runtime, and those only for types */
const imports = new Map<string, { values: string[]; types: string[] }>();
for (const f of files) {
  const values: string[] = [];
  const types: string[] = [];
  for (const [, spec, from] of source(f).matchAll(/^import ([^;]*?) from "(\.[^"]+)";/gm)) {
    if (from.endsWith(".html")) continue;
    const target = normalize(join(dirname(moduleOf(f)), from));
    const typeOnly = spec.startsWith("type ") || /^\{[^}]*\}$/.test(spec) && spec.slice(1, -1).split(",").every((n) => !n.trim() || n.trim().startsWith("type "));
    (typeOnly ? types : values).push(target);
  }
  imports.set(moduleOf(f), { values, types });
}

test("no module imports, even indirectly, one that imports it back", () => {
  const cycles: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (m: string, path: string[]) => {
    if (state.get(m) === "done") return;
    if (state.get(m) === "visiting") return void cycles.push([...path.slice(path.indexOf(m)), m].join(" → "));
    state.set(m, "visiting");
    for (const d of imports.get(m)?.values ?? []) if (imports.has(d)) visit(d, [...path, m]);
    state.set(m, "done");
  };
  for (const m of imports.keys()) visit(m, []);
  expect(cycles).toEqual([]);
});

test(`modules import only from their own layer or below (${LAYERS.join(" < ")})`, () => {
  const upward = [...imports].flatMap(([m, { values }]) => {
    const own = layerOf(m);
    if (own === "web") return [];
    return values.filter((d) => imports.has(d)).filter((d) => {
      const theirs = layerOf(d);
      return theirs === "web" || LAYERS.indexOf(theirs) > LAYERS.indexOf(own);
    }).map((d) => `${m} → ${d}`);
  });
  expect(upward).toEqual([]);
});

test("the web UI takes only types from outside itself (it runs in the browser)", () => {
  const outside = [...imports].filter(([m]) => layerOf(m) === "web").flatMap(([m, { values }]) => values.filter((d) => layerOf(d) !== "web").map((d) => `${m} → ${d}`));
  expect(outside).toEqual([]);
});

/** Code that does a thing only its owner should: [what, where it's allowed, the pattern] */
const OWNED: [string, string, RegExp][] = [
  ["calling Docker directly (use docker(), probe() or attach())", "docker", /\bctx\.docker\./],
  ["making a path under ~/.orca (use state.ts)", "state", /\borcaDir\b/],
  ["writing a label orca sets or reads (use LABELS in names.ts)", "names", /["'`]orca\.(project|proxy|port|ports|network|generation|terminals|up)\b/],
];
for (const [what, owner, pattern] of OWNED)
  test(`only ${owner}.ts does this: ${what}`, () => {
    // The context defines orcaDir itself
    const allowed = new Set([owner, ...(owner === "state" ? ["context"] : [])]);
    const elsewhere = files.filter((f) => !allowed.has(moduleOf(f)) && pattern.test(code(f))).map((f) => relative(CLI, join(CLI, f)));
    expect(elsewhere).toEqual([]);
  });

test("container-features.md names every feature and mount in the code, and the files it cites exist", async () => {
  const { CREATION } = await import("../../creation");
  const { WORKSPACE_FILE } = await import("../../workspace-file");
  const { mounts } = await import("../../container-spec");
  const doc = readFileSync(join(CLI, "../container-features.md"), "utf8");
  const named = [...CREATION.map((f) => f.id), WORKSPACE_FILE, ...mounts({ folder: "", home: "" }).map((m) => m.target)];
  expect(named.filter((n) => !doc.includes(`\`${n}\``))).toEqual([]);
  const cited = [...doc.matchAll(/`((?:cli|image)\/[\w./-]+)`/g)].map((m) => m[1]);
  expect(cited.filter((p) => !Bun.file(join(CLI, "..", p)).size)).toEqual([]);
});
