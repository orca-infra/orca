import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fallback } from "../../commands/fallback";
import { imageLs, imageUse } from "../../commands/image";
import { selfLs, selfUse } from "../../commands/self";
import { RELEASES } from "../../release";
import { fakeContext } from "../support/fake";

const U = { "orca.terminals": "1", "orca.up": "1" };
const CREATED = { "sha256:new": "2026-11-20T06:00:00Z", "sha256:old": "2026-11-04T00:02:00Z", "sha256:older": "2026-10-31T00:01:00Z" };

/** Projects with containers: each [name, image id, running] */
function world(projects: [string, string, boolean][], state: Parameters<typeof fakeContext>[0] = {}, answers: string[] = []) {
  const t = fakeContext({ latest: "sha256:new", created: CREATED, ...state }, answers);
  for (const [name, image, running] of projects) {
    const folder = join(t.home, "dev", name);
    const record = join(t.ctx.orcaDir, "projects", name);
    mkdirSync(folder, { recursive: true });
    mkdirSync(join(record, "home"), { recursive: true });
    writeFileSync(join(record, "home", ".bashrc"), "");
    writeFileSync(join(record, "project-path"), folder + "\n");
    t.state.containers.push({ name: `orca-${name}`, running, image, labels: U, workspace: folder, home: join(record, "home") });
  }
  return t;
}

// ── orca image ──────────────────────────────────────────────────────────────────────────

test("image ls: the current and previous images, which projects use them, and what's published", async () => {
  const t = world(
    [["app", "sha256:new", false], ["web", "sha256:old", false], ["api", "sha256:older", false]],
    { tags: { "orca:previous": "sha256:old", "ghcr.io/orca-infra/orca:2026-11-20-aaaaaaa": "sha256:new" }, published: { "2026-11-20-aaaaaaa": "sha256:new", "2026-11-04-bbbbbbb": "sha256:old" } },
  );
  await imageLs(t.ctx);
  const out = t.output();
  expect(out).toContain("Current: built 2026-11-20 06:00; used by app. New containers are made from it.");
  expect(out).toContain("Previous: built 2026-11-04 00:02; used by web. Go back to it: orca image use previous");
  expect(out).toContain("api: on another image, built 2026-10-31 00:01");
  expect(out).toMatch(/2026-11-20-aaaaaaa {2}current\n {2}2026-11-04-bbbbbbb$/m);
});

test("image ls offline still shows what's on this Mac", async () => {
  const t = world([]);
  await imageLs(t.ctx);
  expect(t.output()).toContain("Current: built 2026-11-20 06:00");
  expect(t.output()).toContain("Published: couldn't be read");
});

test("image use previous swaps the current and previous images, and remakes stopped projects on a yes", async () => {
  const t = world([["app", "sha256:new", false], ["web", "sha256:new", true]], { tags: { "orca:previous": "sha256:old" } }, [""]);
  await imageUse(t.ctx, "previous");
  expect(t.state.latest).toBe("sha256:old");
  expect(t.state.tags?.["orca:previous"]).toBe("sha256:new");
  // The stopped one is remade on it, stopped, with its home; the running one gets the commands
  const app = t.state.containers.find((c) => c.name === "orca-app")!;
  expect(app).toMatchObject({ image: "sha256:old", running: false });
  expect(existsSync(join(t.ctx.orcaDir, "projects/app/home/.bashrc"))).toBe(true);
  expect(t.state.containers.find((c) => c.name === "orca-web")!.image).toBe("sha256:new");
  expect(t.output()).toContain("web is running; stopping it ends its terminals: orca stop web, then orca start --fresh ~/dev/web");
});

test("image use a published one downloads it first; already current says so", async () => {
  const t = world([], { published: { "2026-11-04-bbbbbbb": "sha256:old" } });
  await imageUse(t.ctx, "2026-11-04-bbbbbbb");
  expect(t.attached).toContainEqual(["pull", "ghcr.io/orca-infra/orca:2026-11-04-bbbbbbb"]);
  expect(t.state.latest).toBe("sha256:old");
  await imageUse(t.ctx, "2026-11-04-bbbbbbb");
  expect(t.output()).toContain("already the current image");
});

test("image use with nothing to go back to, or an unknown name, says what there is", async () => {
  const t = world([]);
  await expect(imageUse(t.ctx, "previous")).rejects.toMatchObject({ fix: "See what there is: orca image ls" });
  await expect(imageUse(t.ctx, "2026-01-01-ccccccc")).rejects.toMatchObject({ fix: "See what's published: orca image ls" });
});

// ── orca self ───────────────────────────────────────────────────────────────────────────

const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

function orca(t: ReturnType<typeof fakeContext>, files: Record<string, string> = {}, previous?: string) {
  const execPath = join(t.home, "orca");
  writeFileSync(execPath, "aaa binary");
  if (previous) writeFileSync(`${execPath}.previous`, previous);
  const fetch = (async (url: string) => {
    if (url.startsWith("https://api.github.com/")) return url in files ? new Response(files[url]) : Response.json([{ tag_name: "cli-ccc", published_at: "2026-11-24T10:00:00Z" }, { tag_name: "cli-aaa", published_at: "2026-11-20T10:00:00Z" }]);
    const path = url.replace(`${RELEASES}/`, "");
    return path in files ? new Response(files[path]) : new Response("", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { execPath, s: { version: "aaa", built: "2026-11-20", execPath, fetch, platform: "darwin", arch: "arm64" } };
}

test("self ls: this build, the previous one, and the published ones", async () => {
  const t = fakeContext();
  const { s } = orca(t, {}, "prev");
  t.ctx.host = async () => ({ code: 0, stdout: "zzz\n", stderr: "" });
  await selfLs(t.ctx, s);
  expect(t.output()).toContain("Current: aaa (2026-11-20)");
  expect(t.output()).toContain("Previous: zzz. Go back to it: orca self use previous");
  expect(t.output()).toMatch(/ccc {2}2026-11-24\n {2}aaa {2}2026-11-20 {2}current/);
});

test("self use previous swaps the two, so it can swap back", async () => {
  const t = fakeContext();
  const { s, execPath } = orca(t, {}, "zzz binary");
  t.ctx.host = async () => ({ code: 0, stdout: "zzz\n", stderr: "" });
  await selfUse(t.ctx, s, "previous");
  expect(readFileSync(execPath, "utf8")).toBe("zzz binary");
  expect(readFileSync(`${execPath}.previous`, "utf8")).toBe("aaa binary");
  expect(t.output()).toContain("orca: now zzz (was aaa)");
});

test("self use a build installs it, keeping this one as previous; an unknown build says what's published", async () => {
  const t = fakeContext();
  const { s, execPath } = orca(t, { "download/cli-ccc/orca-darwin-arm64": "ccc binary", "download/cli-ccc/orca-darwin-arm64.sha256": `${sha("ccc binary")}  orca-darwin-arm64\n` });
  await selfUse(t.ctx, s, "ccc");
  expect(readFileSync(execPath, "utf8")).toBe("ccc binary");
  expect(readFileSync(`${execPath}.previous`, "utf8")).toBe("aaa binary");
  await expect(selfUse(t.ctx, s, "ddd")).rejects.toMatchObject({ fix: "See what's published: orca self ls" });
});

test("self use previous with none kept says so", async () => {
  const t = fakeContext();
  const { s } = orca(t);
  await expect(selfUse(t.ctx, s, "previous")).rejects.toMatchObject({ message: expect.stringContaining("no previous orca") });
});

// ── orca fallback ───────────────────────────────────────────────────────────────────────

test("fallback with the home runs one plain docker run, printing it to paste", async () => {
  const t = world([["app", "sha256:new", false]]);
  const folder = join(t.home, "dev/app");
  await fallback(t.ctx, folder, { kind: "home" });
  const home = join(t.ctx.orcaDir, "projects/app/home");
  expect(t.attached[0]).toEqual(["run", "-it", "--rm", "-v", `${folder}:/workspace`, "-v", `${home}:/home/node`, "orca:latest", "bash"]);
  expect(t.output()).toContain(`docker run -it --rm -v ${folder}:/workspace -v ${home}:/home/node orca:latest bash`);
});

test("fallback with a fresh home leaves the home out; on another image, that one", async () => {
  const t = world([["app", "sha256:new", false]], { tags: { "orca:previous": "sha256:old" } });
  await fallback(t.ctx, join(t.home, "dev/app"), { kind: "fresh-home", image: "previous" });
  expect(t.attached[0]).toEqual(["run", "-it", "--rm", "-v", `${join(t.home, "dev/app")}:/workspace`, "orca:previous", "bash"]);
});

test("fallback with no folders keeps its container, and goes back into it", async () => {
  const t = world([["app", "sha256:new", false]]);
  const folder = join(t.home, "dev/app");
  await fallback(t.ctx, folder, { kind: "no-folders" });
  expect(t.attached[0]).toEqual(["run", "-it", "--name", "orca-fallback-app", "orca:latest", "bash"]);
  t.state.containers.push({ name: "orca-fallback-app", labels: {} });
  await fallback(t.ctx, folder, { kind: "no-folders" });
  expect(t.attached[1]).toEqual(["start", "-ai", "orca-fallback-app"]);
});

test("fallback asks which, offering the home only when there is one", async () => {
  const t = fakeContext({}, ["fresh-home"]);
  const folder = join(t.home, "dev/x");
  mkdirSync(folder, { recursive: true });
  let offered: string[] = [];
  t.ctx.choose = async (_q, options) => ((offered = options.map((o) => o.value)), "fresh-home");
  await fallback(t.ctx, folder, {});
  expect(offered).toEqual(["fresh-home", "no-folders"]);
  await expect(fallback(t.ctx, folder, { kind: "home" })).rejects.toMatchObject({ fix: "Use a fresh one: orca fallback --kind fresh-home" });
});
