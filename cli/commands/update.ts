import { chmodSync, copyFileSync, renameSync, writeFileSync } from "node:fs";
import { OrcaError } from "../errors";
import { type Context } from "../context";
import { makeCurrent } from "../images";
import { attach, docker } from "../docker";
import { inspectImage } from "../projects";
import { RELEASES, REPO } from "../release";
import { REMOTE_IMAGE } from "../names";


export type SelfUpdate = { version: string; built: string; execPath: string; fetch: typeof fetch; platform: string; arch: string };

export async function update(ctx: Context, opts: { self: SelfUpdate | false }): Promise<void> {
  ctx.print(`Image: checking ${REMOTE_IMAGE}…`);
  // In the terminal, so Docker shows its download progress
  if ((await attach(ctx, ["pull", REMOTE_IMAGE])) !== 0) {
    await docker(ctx, ["version"]); // turns "Docker isn't running" into its own message
    throw new OrcaError(`Couldn't download ${REMOTE_IMAGE} (Docker's message is above).`, "If the image is private: gh auth token | docker login ghcr.io -u <github-user> --password-stdin");
  }
  const pulled = await inspectImage(ctx, REMOTE_IMAGE);
  if (!pulled || !(await makeCurrent(ctx, pulled))) ctx.print("Image: up to date.");
  else {
    ctx.print("Image: updated. Containers switch to it when recreated; `orca start` says when one isn't on it.");
    ctx.print("  The one it replaces is kept: orca image use previous goes back to it.");
  }

  if (opts.self) await updateSelf(ctx, opts.self);
}

async function updateSelf(ctx: Context, s: SelfUpdate) {
  if (s.version === "dev") {
    ctx.print("orca: running from source, so not updating itself.");
    return;
  }
  const latest = (await (await get(s, "latest/download/version")).text()).trim();
  if (latest === s.version) {
    ctx.print("orca: up to date.");
    return;
  }
  await installBuild(ctx, s, latest);
}

const get = async (s: SelfUpdate, path: string) => {
  const r = await s.fetch(`${RELEASES}/${path}`);
  if (!r.ok) throw new OrcaError(`Couldn't download ${path} (${r.status}).`, "Check your connection and try again.");
  return r;
};

/** Installs a published build in place of this one, keeping this one beside it as <orca>.previous. */
export async function installBuild(ctx: Context, s: SelfUpdate, version: string) {
  const asset = `orca-${s.platform}-${s.arch === "x64" ? "x64" : s.arch}`;
  const exists = await s.fetch(`${RELEASES}/download/cli-${version}/${asset}.sha256`).catch(() => null);
  if (!exists?.ok) throw new OrcaError(`There's no published build ${version} for ${asset.slice(5)}.`, "See what's published: orca self ls");
  const expected = (await exists.text()).trim().split(/\s+/)[0];
  ctx.print(`orca: downloading ${version}…`);
  const binary = await download(await get(s, `download/cli-${version}/${asset}`));
  const actual = new Bun.CryptoHasher("sha256").update(binary).digest("hex");
  if (actual !== expected) throw new OrcaError(`The downloaded orca doesn't match its published checksum; not installing it.`);

  const next = `${s.execPath}.new`;
  // The one it replaces stays beside it, to go back to if the new one is broken
  try {
    writeFileSync(next, binary);
    chmodSync(next, 0o755);
    copyFileSync(s.execPath, `${s.execPath}.previous`);
    renameSync(next, s.execPath);
  } catch {
    throw new OrcaError(`Can't replace ${s.execPath}.`, `Reinstall it: curl -fsSL https://raw.githubusercontent.com/${REPO}/main/cli/install.sh | bash`);
  }
  ctx.print(`orca: now ${version} (was ${s.version}). The one it replaces is kept: orca self use previous goes back to it.`);

  ctx.print(`  What's changed: https://github.com/${REPO}/blob/${version}/CHANGELOG.md`);
}

/** Reads a download, showing how far along it is when there's a terminal to show it in. */
async function download(r: Response): Promise<Uint8Array> {
  const total = Number(r.headers.get("content-length")) || 0;
  const show = process.stderr.isTTY && total > 0 && r.body;
  if (!show) return new Uint8Array(await r.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let done = 0;
  for await (const chunk of r.body!) {
    chunks.push(chunk);
    done += chunk.length;
    process.stderr.write(`\r  ${Math.floor((done / total) * 100)}% of ${Math.round(total / 1e6)} MB`);
  }
  process.stderr.write("\n");
  return Buffer.concat(chunks);
}
