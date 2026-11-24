// The code's structure, checked: what may import what, and where the one way of doing each
// thing lives. A failure here means a change has gone around that structure; the fix is to use
// the module that owns it, not to loosen the rule.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { Glob } from "bun";
import { CURRENT } from "../../compat";
import { mounts } from "../../container-spec";
import { CREATION } from "../../creation";
import { LABELS } from "../../names";
import { WORKSPACE_FILE } from "../../workspace-file";

const CLI = join(import.meta.dir, "../..");
const files = [...new Glob("**/*.{ts,tsx}").scanSync(CLI)].filter((f) => !f.startsWith("test/"));
const moduleOf = (f: string) => f.replace(/\.tsx?$/, "");
const modules = new Set(files.map(moduleOf));
// Without a #! line, which the parser doesn't take
const source = (f: string) => readFileSync(join(CLI, f), "utf8").replace(/^#!.*\n/, "");
const transpiler = new Bun.Transpiler({ loader: "tsx" });
/** The code as it runs: without comments or types, so the rules see what code does, not what comments mention */
const code = (f: string) => transpiler.transformSync(source(f));

/** Lowest first: a module may load modules only from its own layer or below */
const LAYERS = ["core", "ui", "commands", "server", "entry"] as const;
/** Folders of cli/, and the layer each is; a new one needs a place here */
const FOLDERS: Record<string, (typeof LAYERS)[number] | "web"> = { ui: "ui", commands: "commands", server: "server", web: "web" };
function layerOf(m: string): (typeof LAYERS)[number] | "web" {
  if (m === "orca" || m === "build") return "entry";
  if (!m.includes("/")) return "core";
  const layer = FOLDERS[m.split("/")[0]];
  if (!layer) throw new Error(`cli/${m.split("/")[0]}/ has no layer: add it to FOLDERS in architecture.test.ts`);
  return layer;
}

/** Each module's local imports that load at runtime (every form: import, export … from, import(), require), as Bun's parser finds them */
const imports = new Map<string, string[]>();
const unknown: string[] = [];
for (const f of files) {
  const local = transpiler
    .scanImports(source(f))
    .map((i) => i.path)
    .filter((p) => p.startsWith("."))
    .filter((p) => !p.endsWith(".html") && !p.endsWith(".css"));
  imports.set(
    moduleOf(f),
    local.map((p) => {
      const target = normalize(join(dirname(moduleOf(f)), p)).replace(/\.(tsx?|jsx?)$/, "");
      if (!modules.has(target)) unknown.push(`${f} → ${p}`);
      return target;
    }),
  );
}

test("every local import is of a module the rules know", () => {
  expect(unknown).toEqual([]);
});

test("no module imports, even indirectly, one that imports it back", () => {
  const cycles: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (m: string, path: string[]) => {
    if (state.get(m) === "done") return;
    if (state.get(m) === "visiting") return void cycles.push([...path.slice(path.indexOf(m)), m].join(" → "));
    state.set(m, "visiting");
    for (const d of imports.get(m) ?? []) visit(d, [...path, m]);
    state.set(m, "done");
  };
  for (const m of imports.keys()) visit(m, []);
  expect(cycles).toEqual([]);
});

test(`modules import only from their own layer or below (${LAYERS.join(" < ")})`, () => {
  const upward = [...imports].flatMap(([m, deps]) => {
    const own = layerOf(m);
    if (own === "web") return [];
    return deps.filter((d) => {
      const theirs = layerOf(d);
      return theirs === "web" || LAYERS.indexOf(theirs) > LAYERS.indexOf(own);
    }).map((d) => `${m} → ${d}`);
  });
  expect(upward).toEqual([]);
});

test("the web UI takes only types from outside itself (it runs in the browser)", () => {
  const outside = [...imports].filter(([m]) => layerOf(m) === "web").flatMap(([m, deps]) => deps.filter((d) => layerOf(d) !== "web").map((d) => `${m} → ${d}`));
  expect(outside).toEqual([]);
});

/** Things only one module does: what, its owner (and any other module allowed), and code that does it */
const labels = Object.values(LABELS).map((l) => l.replace(".", "\\.")).join("|");
const OWNED: { what: string; owners: string[]; pattern: RegExp }[] = [
  { what: "calling Docker (use docker(), probe() or attach())", owners: ["docker"], pattern: /\.docker\b|\[\s*["'`]docker["'`]\s*\]|\{\s*docker\s*\}\s*=|spawn\(\s*\[\s*["'`]docker["'`]/ },
  { what: "making a path under ~/.orca (use state.ts)", owners: ["state", "context"], pattern: /\borcaDir\b|ORCA_DIR|homedir\(|["'`]\.orca\b/ },
  { what: "writing a Docker label (use LABELS)", owners: ["names"], pattern: new RegExp(`(${labels})\\b|label=orca\\.`) },
  { what: "naming a Docker object or image (use names.ts)", owners: ["names"], pattern: /orca:(latest|previous)\b|["'`]orca-(net|proxy|fallback)\b/ },
  { what: "running something in a container (use in-container.ts)", owners: ["in-container"], pattern: /["'`]exec["'`]/ },
  { what: "naming where folders are mounted (use container-spec.ts)", owners: ["container-spec"], pattern: /["'`]\/(workspace|home\/node)\b/ },
];
for (const { what, owners, pattern } of OWNED)
  test(`only ${owners[0]}.ts does this: ${what}`, () => {
    // The rule is live: its owner does what it describes
    expect(pattern.test(code(`${owners[0]}.ts`))).toBe(true);
    expect(files.filter((f) => !owners.includes(moduleOf(f)) && pattern.test(code(f)))).toEqual([]);
  });

test("the Dockerfile's image generation is the one compat.ts says orca makes", () => {
  const label = /orca\.generation="(\d+)"/.exec(readFileSync(join(CLI, "../Dockerfile"), "utf8"))?.[1];
  expect(Number(label)).toBe(CURRENT);
});

test("container-features.md names every feature and mount in the code, and the files it cites exist", () => {
  const doc = readFileSync(join(CLI, "../container-features.md"), "utf8");
  const named = [...CREATION.map((f) => f.id), WORKSPACE_FILE, ...mounts({ folder: "", home: "" }).map((m) => m.target)];
  expect(named.filter((n) => !doc.includes(`\`${n}\``))).toEqual([]);
  const cited = [...doc.matchAll(/`((?:cli|image)\/[\w./-]+)`/g)].map((m) => join(CLI, "..", m[1]));
  expect(cited.filter((p) => !existsSync(p) || !statSync(p).isFile())).toEqual([]);
});
