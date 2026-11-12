/**
 * The checks start makes on the links between channels: each channel destination names a channel
 * whose source is `channel:`, each such source is fed, and no chain of channel destinations comes
 * back to where it started.
 */

/** What the graph checks read of one channel: its name, its source's kind and its links. */
export interface ChannelLinks {
  readonly name: string;
  /** Whether its source is `channel:`, so other channels may hand it messages. */
  readonly takesHandOffs: boolean;
  /** True when only `ctx.route` feeds it, so no destination naming it is looked for. */
  readonly routed: boolean;
  /** The channel each of its destinations hands over to, by destination index; others left out. */
  readonly targets: readonly { readonly index: number; readonly name: string }[];
}

/**
 * Each problem with the links between `channels`, as `channels/<name>/channel.yaml: <key>: <what>`
 * lines, in a stable order: a channel destination naming no channel, or one whose source is not
 * `channel:`; a channel source nothing names (unless it sets `routed: true`); and each cycle of
 * channel destinations, named from its first channel by name back to it. A cycle is named once,
 * however many of its channels start it, and at most {@link MAX_LOOPS_NAMED} are named.
 *
 * @example
 * ```ts
 * channelGraphProblems([
 *   { name: "a", takesHandOffs: true, routed: false, targets: [{ index: 0, name: "b" }] },
 *   { name: "b", takesHandOffs: true, routed: false, targets: [{ index: 0, name: "a" }] },
 * ]); // one line naming the loop a -> b -> a
 * ```
 */
export function channelGraphProblems(channels: readonly ChannelLinks[]): string[] {
  const problems: string[] = [];
  const byName = new Map(channels.map((channel) => [channel.name, channel]));
  const fed = new Set<string>();
  for (const channel of channels) {
    for (const { index, name } of channel.targets) {
      const target = byName.get(name);
      const where = `channels/${channel.name}/channel.yaml: destinations.${String(index)}.channel.name`;
      if (target === undefined) {
        problems.push(`${where}: ${name} is not a channel of this project`);
      } else if (!target.takesHandOffs) {
        problems.push(
          `${where}: ${name} takes no hand-offs; give its channel.yaml source: { channel: {} }`,
        );
      } else {
        fed.add(name);
      }
    }
  }
  for (const channel of channels) {
    if (channel.takesHandOffs && !channel.routed && !fed.has(channel.name)) {
      problems.push(
        `channels/${channel.name}/channel.yaml: source.channel: no channel destination names ${channel.name}, so nothing feeds it; name it in one, or set routed: true when ctx.route feeds it`,
      );
    }
  }
  for (const loop of cycles(channels, byName)) {
    problems.push(
      `channels/${loop[0] ?? ""}/channel.yaml: destinations: channel destinations make a loop, ${[...loop, loop[0]].join(" -> ")}; a message would go round it for ever`,
    );
  }
  return problems;
}

/** The most loops one check names: a project with more has the first ones to fix. */
export const MAX_LOOPS_NAMED = 20;

/**
 * Every elementary cycle reachable through channel destinations whose target takes hand-offs, each
 * once, rotated to start at its least name, up to {@link MAX_LOOPS_NAMED}. Found by a depth-first
 * walk from each channel in name order; a cycle is kept only from its least channel, so it is found
 * once.
 */
function cycles(
  channels: readonly ChannelLinks[],
  byName: ReadonlyMap<string, ChannelLinks>,
): string[][] {
  const found: string[][] = [];
  const next = (name: string): string[] =>
    [
      ...new Set(
        (byName.get(name)?.targets ?? [])
          .map((target) => target.name)
          .filter((target) => byName.get(target)?.takesHandOffs === true),
      ),
    ].sort();
  const names = channels.map((channel) => channel.name).sort();
  for (const start of names) {
    // Only cycles whose least name is `start`: those through a lesser name were found from it.
    const path: string[] = [start];
    const onPath = new Set<string>([start]);
    const walk = (name: string): void => {
      for (const target of next(name)) {
        if (found.length >= MAX_LOOPS_NAMED) return;
        if (target === start) {
          found.push([...path]);
        } else if (target > start && !onPath.has(target)) {
          path.push(target);
          onPath.add(target);
          walk(target);
          onPath.delete(target);
          path.pop();
        }
      }
    };
    walk(start);
  }
  return found;
}
