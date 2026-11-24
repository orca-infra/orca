// Everything orca keeps on the Mac, under ~/.orca (ORCA_DIR): plain files a person can read and
// remove. Every path is made here and nowhere else.
import { join } from "node:path";
import type { Context } from "./context";

/** orca's settings: ports, terminal, box settings defaults, features to leave out */
export const configFile = (ctx: Context) => join(ctx.orcaDir, "config.json");
/** The dashboard's (orca serve) token; kept out of containers */
export const serveTokenFile = (ctx: Context) => join(ctx.orcaDir, "serve-token");
/** What the interactive picker and questions log while they run */
export const uiLogFile = (ctx: Context) => join(ctx.orcaDir, "orca.log");

/** One folder per project: its record */
export const projectsDir = (ctx: Context) => join(ctx.orcaDir, "projects");
export const recordDir = (ctx: Context, project: string) => join(projectsDir(ctx), project);
/** The project's home, mounted as ~: logins, Claude's memory and sessions, installed tools */
export const homeDir = (ctx: Context, project: string) => join(recordDir(ctx, project), "home");
/** The folder mounted as /workspace, one line */
export const projectPathFile = (ctx: Context, project: string) => join(recordDir(ctx, project), "project-path");
/** The code of a project made with orca new, when it has no folder of its own */
export const ownWorkspaceDir = (ctx: Context, project: string) => join(recordDir(ctx, project), "workspace");
/** Its forwarded ports, and the extra addresses each has */
export const forwardsFile = (ctx: Context, project: string) => join(recordDir(ctx, project), "forwards");
/** Its memory and CPUs, when it has its own (orca settings) */
export const boxSettingsFile = (ctx: Context, project: string) => join(recordDir(ctx, project), "box-settings.json");
/** What orca last said about the user's own workspace file, so it says it once */
export const workspaceNoticeFile = (ctx: Context, project: string) => join(recordDir(ctx, project), "workspace-file-notice");
/** Written by orca-migrate.sh once the home it copied from an older container checks out */
export const migratedFile = (ctx: Context, project: string) => join(recordDir(ctx, project), "migrated-from");

/** The forwards proxy's config, mounted into it, and the certificate authority's certificate */
export const proxyDir = (ctx: Context) => join(ctx.orcaDir, "proxy");
export const proxyConfigFile = (ctx: Context) => join(proxyDir(ctx), "Caddyfile");
export const caFile = (ctx: Context) => join(proxyDir(ctx), "orca-ca.crt");
