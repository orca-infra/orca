import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { start } from "../../commands/start";
import { fakeContext } from "../support/fake";

function project(home: string, repos: string[]) {
  const dir = join(home, "dev", "app");
  mkdirSync(dir, { recursive: true });
  for (const r of repos) mkdirSync(join(dir, r, ".git"), { recursive: true });
  return dir;
}

const file = (dir: string) => join(dir, "app.code-workspace");
// The file is JSON with comments
const parse = (dir: string) => JSON.parse(readFileSync(file(dir), "utf8").replace(/^\/\/.*$/gm, ""));

test("a folder holding git repos gets a workspace file: a root per repo, each hidden from the top", async () => {
  const t = fakeContext();
  const dir = project(t.home, ["api", "web", "libs/shared"]);
  await start(t.ctx, dir, {});
  const w = parse(dir);
  expect(w.folders).toEqual([{ name: "app", path: "." }, { path: "api" }, { path: "libs/shared" }, { path: "web" }]);
  expect(w.settings["files.exclude"]).toEqual({ api: true, "libs/shared": true, web: true });
  expect(readFileSync(file(dir), "utf8").split("\n")[0]).toStartWith("// Made by orca");
  expect(t.output()).toContain("Workspace file: app.code-workspace, with 3 repos: api, libs/shared, web");
  expect(t.output()).toContain("It looked for git repos up to 3 levels down, skipping hidden folders and node_modules.");
});

test("a repo isn't hidden when another repo has a folder at the same path: editors hide it in every root", async () => {
  const t = fakeContext();
  const dir = project(t.home, ["api", "web"]);
  mkdirSync(join(dir, "web/api"));
  await start(t.ctx, dir, {});
  expect(parse(dir).settings["files.exclude"]).toEqual({ web: true });
});

test("a single repo, or a folder without repos, gets none", async () => {
  const t = fakeContext();
  const dir = project(t.home, ["."]);
  await start(t.ctx, dir, {});
  expect(existsSync(file(dir))).toBe(false);
  expect(t.output()).not.toContain("Workspace file");
});

test("node_modules, hidden folders, and repos too deep are skipped", async () => {
  const t = fakeContext();
  const dir = project(t.home, ["api", "node_modules/dep", ".cache/thing", "a/b/c/d"]);
  await start(t.ctx, dir, {});
  expect(parse(dir).folders.map((f: { path: string }) => f.path)).toEqual([".", "api"]);
});

test("it's rewritten when the repos change, and left alone (and quiet) when they haven't", async () => {
  const t = fakeContext();
  const dir = project(t.home, ["api"]);
  await start(t.ctx, dir, {});
  mkdirSync(join(dir, "web/.git"), { recursive: true });
  await start(t.ctx, dir, {});
  expect(parse(dir).folders.map((f: { path: string }) => f.path)).toEqual([".", "api", "web"]);
  expect(t.output()).toContain("Workspace file: app.code-workspace, updated: 2 repos");

  const before = t.lines.length;
  await start(t.ctx, dir, {});
  expect(t.lines.slice(before).join("\n")).not.toContain("Workspace file");
});

test("without orca's first line, it's the user's: never rewritten", async () => {
  const t = fakeContext();
  const dir = project(t.home, ["api", "web"]);
  writeFileSync(file(dir), '{ "folders": [{ "path": "api" }] }\n');
  await start(t.ctx, dir, {});
  expect(readFileSync(file(dir), "utf8")).toBe('{ "folders": [{ "path": "api" }] }\n');
});

test('"without": ["workspace-file"] in the config leaves it out', async () => {
  const t = fakeContext();
  const dir = project(t.home, ["api"]);
  mkdirSync(t.ctx.orcaDir, { recursive: true });
  writeFileSync(join(t.ctx.orcaDir, "config.json"), JSON.stringify({ without: ["workspace-file"] }));
  await start(t.ctx, dir, {});
  expect(existsSync(file(dir))).toBe(false);
});

test("the user's own file is left alone, saying once which repos it doesn't list and what it lists that's gone", async () => {
  const t = fakeContext();
  const dir = project(t.home, ["api", "web"]);
  const own = '// mine\n{ "folders": [{ "path": "." }, { "path": "api" }, { "path": "old" }] }\n';
  writeFileSync(file(dir), own);
  await start(t.ctx, dir, {});
  expect(readFileSync(file(dir), "utf8")).toBe(own);
  expect(t.output()).toContain("app.code-workspace is yours (no orca mark), so it's left as it is; it doesn't list web, and lists old, which no longer exists.");

  let before = t.lines.length;
  await start(t.ctx, dir, {});
  expect(t.lines.slice(before).join("\n")).not.toContain("Workspace file");

  mkdirSync(join(dir, "docs/.git"), { recursive: true });
  before = t.lines.length;
  await start(t.ctx, dir, {});
  expect(t.lines.slice(before).join("\n")).toContain("doesn't list docs, web");
});

test("a user's file that lists every repo says nothing", async () => {
  const t = fakeContext();
  const dir = project(t.home, ["api"]);
  writeFileSync(file(dir), '{ "folders": [{ "path": "./api/" }, { "path": "notes" }] }\n');
  mkdirSync(join(dir, "notes"));
  await start(t.ctx, dir, {});
  expect(t.output()).not.toContain("Workspace file");
});
