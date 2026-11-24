import { OrcaError } from "./errors";
import { labelGeneration } from "./compat";
import type { Context } from "./context";
import { attach, docker, probe } from "./docker";
import { CURRENT_IMAGE, PREVIOUS_IMAGE, REGISTRY_IMAGE, REMOTE_IMAGE } from "./names";

/** A published image's tag: the day it was built and its commit */
const DATED = /^\d{4}-\d{2}-\d{2}-[0-9a-f]{7,40}$/;

/**
 * The image a name given to orca means: "latest" (the newest published), "previous" (the one
 * the last change of the current image replaced), "current", a published <yyyy-mm-dd>-<commit>,
 * or any image name Docker knows.
 */
export function imageRef(name: string): string {
  if (name === "latest") return REMOTE_IMAGE;
  if (name === "previous") return PREVIOUS_IMAGE;
  if (name === "current") return CURRENT_IMAGE;
  if (DATED.test(name)) return `${REGISTRY_IMAGE}:${name}`;
  return name;
}

/** The image a name means, downloaded first if it's published and not on this Mac (or is "latest"). */
export async function ensureImage(ctx: Context, name: string): Promise<{ ref: string; image: Image }> {
  const ref = imageRef(name);
  let image = ref === REMOTE_IMAGE ? null : await inspectImage(ctx, ref);
  if (!image && ref.startsWith(`${REGISTRY_IMAGE}:`)) {
    await pull(ctx, ref, "See what's published: orca image ls");
    image = await inspectImage(ctx, ref);
  }
  if (image) return { ref, image };
  if (ref === PREVIOUS_IMAGE)
    throw new OrcaError("There's no previous image on this Mac yet: one is kept whenever orca update or orca image use replaces the current one.", "See what there is: orca image ls");
  throw new OrcaError(`There's no image ${name} on this Mac, or published.`, "See what there is: orca image ls");
}

/** Downloads an image, in the terminal so Docker shows its progress; on failure, says what to try. */
export async function pull(ctx: Context, ref: string, fix: string) {
  if ((await attach(ctx, ["pull", ref])) === 0) return;
  await docker(ctx, ["version"]); // turns "Docker isn't running" into its own message
  throw new OrcaError(`Couldn't download ${ref} (Docker's message is above).`, fix);
}

/**
 * Makes an image the current one, which new containers are made from, keeping the one it
 * replaces as previous. False when it already was.
 */
export async function makeCurrent(ctx: Context, image: Image): Promise<boolean> {
  const current = await inspectImage(ctx, CURRENT_IMAGE);
  if (current?.id === image.id) return false;
  if (current) await docker(ctx, ["tag", current.id, PREVIOUS_IMAGE]);
  await docker(ctx, ["tag", image.id, CURRENT_IMAGE]);
  return true;
}

/** The published images' tags, newest first; null when they can't be read (offline, say). */
export async function publishedTags(ctx: Context): Promise<string[] | null> {
  const repo = REGISTRY_IMAGE.replace(/^ghcr\.io\//, "");
  try {
    // The registry hands out a token for reading a public image without logging in
    const auth = await ctx.fetch(`https://ghcr.io/token?scope=repository:${repo}:pull`);
    if (!auth.ok) return null;
    const { token } = (await auth.json()) as { token: string };
    const r = await ctx.fetch(`https://ghcr.io/v2/${repo}/tags/list?n=1000`, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const { tags } = (await r.json()) as { tags: string[] | null };
    return (tags ?? []).filter((t) => DATED.test(t)).sort().reverse();
  } catch {
    return null;
  }
}

/** When an image was built, as yyyy-mm-dd hh:mm */
export const built = (image: Image | null) => image?.created.slice(0, 16).replace("T", " ") ?? "unknown";

/** `generation`: which orca made it (compat.ts) */
export type Image = { id: string; created: string; generation: number };

export async function latestImage(ctx: Context): Promise<Image | null> {
  return inspectImage(ctx, CURRENT_IMAGE);
}

export async function inspectImage(ctx: Context, ref: string): Promise<Image | null> {
  const r = await probe(ctx, ["image", "inspect", ref]);
  if (r.code !== 0) return null;
  const [img] = JSON.parse(r.stdout) as { Id: string; Created: string; Config?: { Labels?: Record<string, string> | null } }[];
  const labels = img.Config?.Labels ?? {};
  return { id: img.Id, created: img.Created, generation: labelGeneration(labels) };
}
