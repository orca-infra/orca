import { OrcaError } from "../errors";
import { tilde, type Context } from "../context";
import { built, ensureImage, makeCurrent, publishedTags } from "../images";
import { CURRENT_IMAGE, inspectImage, loadProjects, PREVIOUS_IMAGE, type Image, type Project } from "../projects";
import { REGISTRY_IMAGE } from "../release";
import { start } from "./start";

const SHOWN = 10;

/** The current image, the previous one, the published ones, and which projects are on each. */
export async function imageLs(ctx: Context): Promise<void> {
  const [current, previous, projects, published] = await Promise.all([
    inspectImage(ctx, CURRENT_IMAGE),
    inspectImage(ctx, PREVIOUS_IMAGE),
    loadProjects(ctx),
    publishedTags(ctx),
  ]);
  const on = (image: Image | null) => (image ? projects.filter((p) => p.container?.image === image.id).map((p) => p.name) : []);
  const usedBy = (names: string[]) => (names.length ? `; used by ${names.join(", ")}` : "");

  ctx.print(current ? `Current: built ${built(current)}${usedBy(on(current))}. New containers are made from it.` : "Current: none yet. Get it: orca update");
  ctx.print(previous ? `Previous: built ${built(previous)}${usedBy(on(previous))}. Go back to it: orca image use previous` : "Previous: none yet (one is kept whenever the current image is replaced).");

  // Containers on an image that's neither, e.g. made before the last two changes
  const known = new Set([current?.id, previous?.id]);
  const others = projects.filter((p) => p.container && !known.has(p.container.image));
  for (const p of others) ctx.print(`${p.name}: on another image, built ${built(await inspectImage(ctx, p.container!.image))}`);

  ctx.print();
  if (!published) {
    ctx.print(`Published: couldn't be read from ${REGISTRY_IMAGE} (offline?).`);
    return;
  }
  ctx.print("Published, newest first. Switch to one: orca image use <name>; or for one project: orca start --fresh --image <name>");
  for (const tag of published.slice(0, SHOWN)) {
    const here = await inspectImage(ctx, `${REGISTRY_IMAGE}:${tag}`);
    const note = here?.id === current?.id ? "current" : here?.id === previous?.id ? "previous" : here ? "on this Mac" : "";
    ctx.print(`  ${tag}${note ? `  ${note}` : ""}`);
  }
  if (published.length > SHOWN) ctx.print(`  and ${published.length - SHOWN} older`);
}

/**
 * Makes an image the current one (keeping the one it replaces as previous), then offers to remake
 * the stopped projects' containers on it; running ones get the commands, since that ends terminals.
 */
export async function imageUse(ctx: Context, name: string): Promise<void> {
  const { image } = await ensureImage(ctx, name);
  if (!(await makeCurrent(ctx, image))) {
    ctx.print(`That's already the current image (built ${built(image)}).`);
    return;
  }
  ctx.print(`Current image: built ${built(image)}. The one it replaces is kept: orca image use previous goes back to it.`);

  const elsewhere = (await loadProjects(ctx)).filter((p) => p.container && p.folder && p.container.image !== image.id);
  if (!elsewhere.length) return;
  const stopped = elsewhere.filter((p) => !p.container!.running);
  const running = elsewhere.filter((p) => p.container!.running);
  ctx.print(`Containers switch when they're remade (that keeps the folder and the home). Not on it yet: ${elsewhere.map((p) => p.name).join(", ")}`);
  for (const p of running) ctx.print(`  ${p.name} is running; stopping it ends its terminals: orca stop ${p.name}, then orca start --fresh ${tilde(ctx, p.folder!)}`);
  if (!stopped.length) return;
  if (!ctx.ask) {
    for (const p of stopped) ctx.print(`  ${p.name}: orca start --fresh ${tilde(ctx, p.folder!)}`);
    return;
  }
  if (!/^(y(es)?)?$/i.test((await ctx.ask(`Remake the stopped ones now (${stopped.map((p) => p.name).join(", ")})? [Y/n] `)).trim())) return;
  for (const p of stopped) await remake(ctx, p);
}

async function remake(ctx: Context, p: Project) {
  try {
    await start(ctx, p.folder!, { fresh: true, makeOnly: true });
  } catch (e) {
    const fix = e instanceof OrcaError && e.fix ? ` ${e.fix}` : "";
    ctx.print(`  ${p.name} wasn't remade: ${e instanceof Error ? e.message : String(e)}${fix}`);
  }
}
