import type { Context } from "./context";
import { OrcaError } from "./errors";

/**
 * A step of a command, over the command's state `S`. Every step says whether the command needs
 * it: a needed step's failure stops the command; an optional one's is reported with what going
 * on without it means, and the user chooses. A step can't be added without saying which.
 * A step that returns a number ends the command with it (its exit code).
 */
export type Step<S> = {
  name: string;
  /** Only when this holds (unset: always) */
  when?: (s: S) => boolean;
  run: (s: S) => Promise<number | void> | number | void;
} & ({ needed: true } | { optional: { failed: (s: S) => string; skipping: (s: S) => string; question?: (s: S) => string } });

/** Runs the steps in order; the exit code of the step that ended it, or undefined. */
export async function runSteps<S>(ctx: Context, steps: Step<S>[], s: S): Promise<number | undefined> {
  for (const step of steps) {
    if (step.when && !step.when(s)) continue;
    let code: number | void;
    try {
      code = await step.run(s);
    } catch (e) {
      if ("needed" in step) throw e;
      await goOnWithout(ctx, e, step.optional.failed(s), step.optional.skipping(s), step.optional.question?.(s) ?? "Go on without it?");
      continue;
    }
    if (typeof code === "number") return code;
  }
  return undefined;
}

/** Says what failed and what going on without it means, and asks; with no one to ask, or a no, the failure stands. */
async function goOnWithout(ctx: Context, e: unknown, failed: string, skipping: string, question: string) {
  if (!ctx.ask) throw e;
  const detail = e instanceof Error ? e.message : String(e);
  const fix = e instanceof OrcaError && e.fix ? `\n  ${e.fix}` : "";
  ctx.print(`${failed}: ${detail}${fix}`);
  ctx.print(`  ${skipping}`);
  if (!/^(y(es)?)?$/i.test((await ctx.ask(`${question} [Y/n] `)).trim())) throw e;
  ctx.print();
}
