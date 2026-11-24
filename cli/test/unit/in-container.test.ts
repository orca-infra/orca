// What orca runs inside containers, run for real under sh, so the scripts themselves are tested
// (the fake Docker only knows them by name). Paths inside a container are swapped for temporary ones.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IN_CONTAINER, ranOutput, UP_MARK, type InContainer } from "../../in-container";

/** Runs a command as `docker exec` would, with each of `paths` swapped for another */
function run(c: InContainer, paths: Record<string, string> = {}) {
  const args = c.args.map((a) => Object.entries(paths).reduce((s, [from, to]) => s.replaceAll(from, to), a));
  const r = Bun.spawnSync(args, { env: { PATH: process.env.PATH } });
  return { code: r.exitCode, out: ranOutput(c, r.stdout.toString()) };
}
const dir = () => mkdtempSync(join(tmpdir(), "orca-in-container-"));

test("ready names each folder that isn't there, and only those", () => {
  const here = dir();
  const gone = join(here, "gone");
  expect(run(IN_CONTAINER.ready([here, gone])).out).toEqual([`missing ${gone}`]);
  expect(run(IN_CONTAINER.ready([here])).out).toEqual([]);
});

test("keepUp leaves the mark, and activity reports it", () => {
  const mark = join(dir(), "up");
  expect(run(IN_CONTAINER.activity, { [UP_MARK]: mark }).out).not.toContain("up");
  expect(run(IN_CONTAINER.keepUp, { [UP_MARK]: mark }).code).toBe(0);
  expect(existsSync(mark)).toBe(true);
  expect(run(IN_CONTAINER.activity, { [UP_MARK]: mark }).out?.[0]).toBe("up");
});

test("keepUp fails when there's nowhere to leave the mark", () => {
  expect(run(IN_CONTAINER.keepUp, { [UP_MARK]: join(dir(), "no/such/folder/up") }).code).not.toBe(0);
});

test("the proxy's reload writes the config it's handed, as it is, before loading it", () => {
  const file = join(dir(), "Caddyfile");
  const config = '{\n\tlocal_certs\n}\nhttp://:80 {\n\trespond "it\'s 100% $HOME" 200\n}\n';
  // caddy isn't here; what matters is the config reaches the file untouched
  run(IN_CONTAINER.proxyReload(config), { "/tmp/Caddyfile": file, "exec caddy reload": "true" });
  expect(readFileSync(file, "utf8")).toBe(config);
});

test("the proxy's certificate comes back whole, after the name line", () => {
  const d = dir();
  mkdirSync(join(d, "local"));
  const cert = join(d, "local/root.crt");
  writeFileSync(cert, "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n");
  expect(run(IN_CONTAINER.proxyCa, { "/data/caddy/pki/authorities/local/root.crt": cert }).out).toEqual(["-----BEGIN CERTIFICATE-----", "abc", "-----END CERTIFICATE-----"]);
});

test("output that isn't from the command (Docker's own, when it couldn't run it) isn't taken for it", () => {
  expect(ranOutput(IN_CONTAINER.activity, "OCI runtime exec failed: …\n")).toBeNull();
});
