// What this build of orca is, and where its builds and images are published.

declare const ORCA_VERSION: string | undefined, ORCA_REPO: string | undefined, ORCA_BUILT: string | undefined;
/** The commit this `orca` was built from; "dev" when running from source. */
export const VERSION = typeof ORCA_VERSION === "string" ? ORCA_VERSION : "dev";
/** The repo it was built in (owner/name), which it updates itself and its image from. */
export const REPO = typeof ORCA_REPO === "string" ? ORCA_REPO : "orca-infra/orca";
/** The day its commit was made (yyyy-mm-dd), as orca self ls shows it */
export const BUILT = typeof ORCA_BUILT === "string" ? ORCA_BUILT : "";

/** The published image, without a tag; CI tags each one :latest and :<yyyy-mm-dd>-<commit> */
export const REGISTRY_IMAGE = `ghcr.io/${REPO.toLowerCase()}`;
export const REMOTE_IMAGE = `${REGISTRY_IMAGE}:latest`;
/**
 * CI publishes each build as its own release, cli-<commit>, holding orca-<os>-<arch>, its
 * .sha256 and `version`; the newest is marked latest. Reading `version` from the
 * latest first, then everything else from that one release, keeps a download from mixing two builds.
 */
export const RELEASES = `https://github.com/${REPO}/releases`;
