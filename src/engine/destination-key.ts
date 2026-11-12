import { createHash } from "node:crypto";
import { relative, sep } from "node:path";

import type { DestinationConfig } from "../config/schema.js";

/**
 * Where a destination sends, as its identity reads it when it has no `name:`: a local folder or a
 * module by its path from the project's root, so moving the project keeps it; an SFTP folder by its
 * server and path; an HTTP destination by its URL; an MLLP or tcp one by its host and port.
 */
function target(root: string, destination: DestinationConfig): string {
  // The configuration resolves a local folder and a module to absolute paths.
  const fromRoot = (path: string): string => relative(root, path).split(sep).join("/");
  switch (destination.kind) {
    case "file":
      return destination.sftp === undefined
        ? fromRoot(destination.dir)
        : `sftp://${destination.sftp.user}@${destination.sftp.host}:${String(destination.sftp.port)}${destination.dir}`;
    case "http":
      return destination.url;
    case "mllp":
    case "tcp":
      return `${destination.host}:${String(destination.port)}`;
    case "module":
      return fromRoot(destination.module);
  }
}

/**
 * Each destination's key, in the channel's order: what storage records on every delivery and
 * stored output, so a delivery goes to, and a resend or `pathways verify` reads, the destination it
 * was made for, never another one at the same place in the list after a destination was added,
 * removed or moved.
 *
 * A destination is known by its `name:` when it has one, else by its kind and where it sends (see
 * {@link target}); two unnamed destinations of the same kind and target are told apart by their
 * order among themselves. The key is a hash of that identity, so no URL or path is stored. Setting
 * or changing a destination's `name:`, or, without one, its kind or target, gives it a new key.
 *
 * @example
 * ```ts
 * const keys = destinationKeys(project.root, channel.destinations);
 * ```
 */
export function destinationKeys(
  root: string,
  destinations: readonly DestinationConfig[],
): string[] {
  const seen = new Map<string, number>();
  return destinations.map((destination) => {
    let identity =
      destination.name === undefined
        ? `kind\u0000${destination.kind}\u0000${target(root, destination)}`
        : `name\u0000${destination.name}`;
    const count = (seen.get(identity) ?? 0) + 1;
    seen.set(identity, count);
    if (count > 1) identity = `${identity}\u0000${String(count)}`;
    return createHash("sha256").update(identity).digest("hex").slice(0, 32);
  });
}
