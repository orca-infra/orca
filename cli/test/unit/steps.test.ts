import { expect, test } from "bun:test";
import { OrcaError } from "../../errors";
import { runSteps, type Step } from "../../steps";
import { fakeContext } from "../support/fake";

type S = { ran: string[] };
const boom = () => {
  throw new Error("boom");
};
const optional = (name: string, run: () => void): Step<S> => ({ name, optional: { failed: () => `${name} failed`, skipping: () => `without ${name}` }, run });

test("steps run in order, skipping those whose condition doesn't hold, and a number ends them", async () => {
  const s: S = { ran: [] };
  const code = await runSteps(fakeContext().ctx, [
    { name: "a", needed: true, run: (x) => void x.ran.push("a") },
    { name: "b", needed: true, when: () => false, run: (x) => void x.ran.push("b") },
    { name: "c", needed: true, run: (x) => (x.ran.push("c"), 7) },
    { name: "d", needed: true, run: (x) => void x.ran.push("d") },
  ], s);
  expect(s.ran).toEqual(["a", "c"]);
  expect(code).toBe(7);
});

test("a needed step's failure stops them, saying which step when orca didn't foresee it", async () => {
  await expect(runSteps(fakeContext({}, ["y"]).ctx, [{ name: "the network", needed: true, run: boom }], { ran: [] })).rejects.toThrow("the network: boom");
});

test("an optional step's failure says what failed and what going on means, and goes on with a yes", async () => {
  const t = fakeContext({}, [""]);
  const s: S = { ran: [] };
  await runSteps(t.ctx, [optional("net", boom), { name: "after", needed: true, run: (x) => void x.ran.push("after") }], s);
  expect(t.output()).toContain("net failed: boom");
  expect(t.output()).toContain("without net");
  expect(s.ran).toEqual(["after"]);
});

test("an optional step's failure shows the fix it came with", async () => {
  const t = fakeContext({}, [""]);
  const failing = () => {
    throw new OrcaError("the network is gone", "Run: docker network prune");
  };
  await runSteps(t.ctx, [optional("net", failing)], { ran: [] });
  expect(t.output()).toContain("net failed: the network is gone\n  Run: docker network prune");
});

test("an optional step's failure stands on a no, or with no one to ask", async () => {
  await expect(runSteps(fakeContext({}, ["n"]).ctx, [optional("net", boom)], { ran: [] })).rejects.toThrow("boom");
  await expect(runSteps(fakeContext().ctx, [optional("net", boom)], { ran: [] })).rejects.toThrow("boom");
});
