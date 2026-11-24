/** A failure the user can act on: what happened, and the command that fixes it. */
export class OrcaError extends Error {
  constructor(
    message: string,
    readonly fix?: string,
  ) {
    super(message);
  }
}
