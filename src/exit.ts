/**
 * The exit codes `pathways` returns. Scripts branch on these, so they are stable.
 *
 * @example
 * ```ts
 * if (code === EXIT.notFound) console.error("no such message");
 * ```
 */
export const EXIT = {
  /** The command did what was asked. */
  ok: 0,
  /**
   * A test failed, the engine, a command or an extension module could not start or stopped on an
   * error, init could not write, rekey left a value that is not under the current key, or a replay,
   * resend or clear was refused or ended with the message failed, or `secrets check` found a secret
   * or the key provider that could not be had.
   */
  failed: 1,
  /** The arguments were not understood; nothing was done. */
  usage: 2,
  /** The project's configuration is invalid; nothing was done. */
  config: 3,
  /** A message named does not exist. Any others named were still acted on. */
  notFound: 4,
} as const;
