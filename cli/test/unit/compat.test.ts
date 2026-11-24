import { afterEach, expect, test } from "bun:test";
import { CURRENT, checkSupported, generation, HOMES, OLDER, olderFor, TERMINALS, UP, type Status } from "../../compat";
import type { Container } from "../../docker";
import { fakeContext } from "../support/fake";

const box = (labels: Record<string, string>, home: string | null = "/h"): Container => ({
  name: "orca-app",
  running: false,
  startedAt: 0,
  image: "sha256:x",
  labels,
  workspace: "/w",
  home,
  networks: [],
  memory: 0,
  cpus: 0,
});

const statuses = OLDER.map((o) => o.status);
afterEach(() => OLDER.forEach((o, i) => (o.status = statuses[i])));
const set = (id: string, status: Status) => (OLDER.find((o) => o.id === id)!.status = status);

test("older containers are known by what they lack; newer ones by their label", () => {
  expect(generation(box({}, null))).toBe(0);
  expect(generation(box({}))).toBe(HOMES);
  expect(generation(box({ "orca.terminals": "1" }))).toBe(TERMINALS);
  expect(generation(box({ "orca.terminals": "1", "orca.up": "1" }))).toBe(UP);
  expect(generation(box({ "orca.generation": "7" }))).toBe(7);
  expect(olderFor(box({ "orca.generation": String(CURRENT) }))).toEqual([]);
  expect(olderFor(box({})).map((o) => o.id)).toEqual(["before-terminals", "before-up"]);
});

test("every older generation is supported, silently, until one is deprecated", () => {
  const t = fakeContext();
  checkSupported(t.ctx, box({}), "orca start --fresh");
  expect(t.output()).toBe("");
});

test("a deprecated generation says to recreate before its date", () => {
  const t = fakeContext();
  set("before-up", { deprecated: "2027-01-31" });
  checkSupported(t.ctx, box({ "orca.terminals": "1" }), "orca stop app, then orca start --fresh ~/dev/app");
  expect(t.output()).toContain("orca-app was made by an older orca (before-up), supported until 2027-01-31. Recreate it before then (keeps the folder and the home): orca stop app, then orca start --fresh ~/dev/app");
});

test("a removed generation is refused, saying how to recreate", () => {
  const t = fakeContext();
  set("before-terminals", "removed");
  expect(() => checkSupported(t.ctx, box({}), "orca start --fresh")).toThrow("no longer supports");
});
