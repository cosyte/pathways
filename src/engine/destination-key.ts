import { createHash } from "node:crypto";
import { relative, sep } from "node:path";

import type { DestinationConfig } from "../config/schema.js";

/**
 * Where a destination sends, as its identity reads it when it has no `name:`: a local folder or a
 * module by its path from the project's root, so moving the project keeps it; an SFTP folder by its
 * server and path; an S3 or Azure Blob prefix by its bucket or container; an HTTP destination by its
 * URL; an MLLP or tcp one by its host and port; an SMTP one by its server and its recipients; a
 * channel destination by the channel it hands to.
 */
function target(root: string, destination: DestinationConfig): string {
  // The configuration resolves a local folder and a module to absolute paths.
  const fromRoot = (path: string): string => relative(root, path).split(sep).join("/");
  switch (destination.kind) {
    case "file": {
      const { dir, sftp, s3, azblob } = destination;
      if (sftp !== undefined) {
        return `sftp://${sftp.user}@${sftp.host}:${String(sftp.port)}${dir}`;
      }
      if (s3 !== undefined) return `s3://${s3.endpoint ?? ""}/${s3.bucket}/${dir}`;
      if (azblob !== undefined) {
        return `azblob://${azblob.endpoint ?? ""}/${azblob.account}/${azblob.container}/${dir}`;
      }
      return fromRoot(dir);
    }
    case "http":
      return destination.url;
    case "mllp":
    case "tcp":
      return `${destination.host}:${String(destination.port)}`;
    case "smtp":
      return `${destination.host}:${String(destination.port)}/${[...destination.to, ...destination.cc].join(",")}`;
    case "module":
      return fromRoot(destination.module);
    case "channel":
      return `channel:${destination.channel}`;
  }
}

/** What a destination is known by: its `name:` when it has one, else its kind and target. */
function identity(root: string, destination: DestinationConfig): string {
  return destination.name === undefined
    ? `kind\u0000${destination.kind}\u0000${target(root, destination)}`
    : `name\u0000${destination.name}`;
}

/**
 * The unnamed destinations that share their kind and target with an earlier unnamed one, each as
 * `[index, earlier]`. Such a pair would share one identity, so nothing would tell their deliveries
 * apart after one of them is removed or moved: the configuration refuses it, and asks for a
 * `name:` on each.
 *
 * @example
 * ```ts
 * for (const [index, earlier] of alikeDestinations(root, destinations)) report(index, earlier);
 * ```
 */
export function alikeDestinations(
  root: string,
  destinations: readonly DestinationConfig[],
): (readonly [number, number])[] {
  const first = new Map<string, number>();
  const alike: (readonly [number, number])[] = [];
  for (const [index, destination] of destinations.entries()) {
    if (destination.name !== undefined) continue;
    const id = identity(root, destination);
    const earlier = first.get(id);
    if (earlier === undefined) first.set(id, index);
    else alike.push([index, earlier]);
  }
  return alike;
}

/**
 * Each destination's key, in the channel's order: what storage records on every delivery and
 * stored output, so a delivery goes to, and a resend or `pathways verify` reads, the destination it
 * was made for, never another one at the same place in the list after a destination was added,
 * removed or moved.
 *
 * A destination is known by its `name:` when it has one, else by its kind and where it sends (see
 * {@link target}). Names are unique in a channel, and the configuration refuses two unnamed
 * destinations of the same kind and target (see {@link alikeDestinations}), so no two destinations
 * of a loaded channel share a key. A list built by hand that holds such a pair is refused here with a
 * `RangeError`, since no key could keep their deliveries apart. The key is a hash of the identity,
 * so no URL or path is stored. Setting or changing a destination's `name:`, or, without one, its
 * kind or target, gives it a new key.
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
  const [pair] = alikeDestinations(root, destinations);
  if (pair !== undefined) {
    throw new RangeError(
      `destinations ${String(pair[1])} and ${String(pair[0])} have no name and send to one place; give each a name`,
    );
  }
  return destinations.map((destination) =>
    createHash("sha256").update(identity(root, destination)).digest("hex").slice(0, 32),
  );
}
