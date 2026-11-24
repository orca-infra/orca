// Every name and label orca gives Docker objects, and the images it uses: made here and nowhere
// else, so they can't drift apart. (Docker's own names, like a volume's mount point, stay where used.)
import { REPO } from "./release";

export const containerName = (project: string) => `orca-${project}`;
export const networkName = (project: string) => `orca-net-${project}`;
/** The plain container orca fallback keeps when it has no Mac folders */
export const fallbackName = (project: string) => `orca-fallback-${project}`;

export const PROXY = "orca-proxy";
/** The volume holding the proxy's certificate authority, so its key never leaves Docker */
export const PROXY_DATA = "orca-proxy-data";
// caddy:2.11.7-alpine (released 2026-10-06), pinned by digest
export const PROXY_IMAGE = "caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f";

/** The current image, which new containers are made from (orca image use changes it) */
export const CURRENT_IMAGE = "orca:latest";
/** The one the last change of the current image replaced */
export const PREVIOUS_IMAGE = "orca:previous";
/** The published image, without a tag; CI tags each one :latest and :<yyyy-mm-dd>-<commit> */
export const REGISTRY_IMAGE = `ghcr.io/${REPO.toLowerCase()}`;
export const REMOTE_IMAGE = `${REGISTRY_IMAGE}:latest`;

/** Labels orca sets (on containers and networks) or reads (on images) */
export const LABELS = {
  /** A project's container, and its project's name */
  project: "orca.project",
  /** The forwards proxy */
  proxy: "orca.proxy",
  /** The Mac ports the proxy's container was made with: the usual one, and the extra ones */
  proxyPort: "orca.port",
  proxyPorts: "orca.ports",
  /** A project's network, and its project's name */
  network: "orca.network",
  /** Which orca generation an image is (compat.ts); images before it carry orca.terminals */
  generation: "orca.generation",
  terminals: "orca.terminals",
} as const;

/** A label's `key=value`, as docker's --label and --filter take it */
export const label = (key: keyof typeof LABELS, value: string) => `${LABELS[key]}=${value}`;

/** The hostname a forward is served at, through the proxy */
export const hostFor = (port: number, project: string) => `${port}.${project.toLowerCase().replace(/[^a-z0-9-]/g, "-")}.localhost`;
