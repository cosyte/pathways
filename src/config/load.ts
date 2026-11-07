import { access, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { parse as parseYaml, YAMLParseError } from "yaml";
import type { z } from "zod";

import {
  channelSchema,
  DEFAULT_DATABASE_FILE,
  DEFAULT_MIN_AGE_MS,
  DEFAULT_SETTINGS,
  projectSchema,
  type ChannelConfig,
  type ProjectConfig,
  type Settings,
} from "./schema.js";

/**
 * A project that could not be loaded. `problems` name the file and the key at fault; they hold no
 * message content, since configuration never does.
 *
 * @example
 * ```ts
 * try {
 *   await loadProject(".");
 * } catch (error) {
 *   if (error instanceof ConfigError) console.error(error.problems.join("\n"));
 * }
 * ```
 */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  /** @param problems One line per problem: the file, the key, and what is wrong. */
  constructor(problems: readonly string[]) {
    super(problems.join("\n"));
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/**
 * Loads `pathways.yaml` (optional) and every `channels/<name>/channel.yaml` under `root`, validates
 * them, and resolves every relative path against the file that declares it.
 *
 * @example
 * ```ts
 * const project = await loadProject(process.cwd());
 * console.log(project.channels.map((c) => c.name));
 * ```
 */
export async function loadProject(root: string): Promise<ProjectConfig> {
  const projectRoot = resolve(root);
  const problems: string[] = [];
  const show = (file: string): string => relative(projectRoot, file) || file;

  const projectFile = join(projectRoot, "pathways.yaml");
  let project: z.infer<typeof projectSchema> = {};
  if (await exists(projectFile)) {
    const parsed = await readYaml(projectFile, show, problems);
    if (parsed !== undefined) {
      const result = projectSchema.safeParse(parsed ?? {});
      if (result.success) project = result.data;
      else problems.push(...describeIssues(show(projectFile), result.error.issues));
    }
  }

  const settings: Settings = mergeSettings(DEFAULT_SETTINGS, project.defaults ?? {});
  const databaseFile = resolve(projectRoot, project.storage?.sqlite.file ?? DEFAULT_DATABASE_FILE);

  const channelsDir = join(projectRoot, "channels");
  const channels: ChannelConfig[] = [];
  let folders: string[] = [];
  try {
    folders = (await readdir(channelsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    problems.push(
      `${show(channelsDir)}: no channels folder; each channel lives in channels/<name>/channel.yaml`,
    );
  }

  for (const folder of folders) {
    const channelDir = join(channelsDir, folder);
    const file = join(channelDir, "channel.yaml");
    if (!(await exists(file))) {
      problems.push(`${show(channelDir)}: no channel.yaml`);
      continue;
    }
    const parsed = await readYaml(file, show, problems);
    if (parsed === undefined) continue;
    const result = channelSchema.safeParse(parsed ?? {});
    if (!result.success) {
      problems.push(...describeIssues(show(file), result.error.issues));
      continue;
    }
    const channel = result.data;
    if (channel.name !== undefined && channel.name !== folder) {
      problems.push(
        `${show(file)}: name: "${channel.name}" must match its folder name, "${folder}"`,
      );
      continue;
    }
    const transform =
      channel.transform === undefined ? undefined : resolve(channelDir, channel.transform);
    if (transform !== undefined && !(await exists(transform))) {
      problems.push(`${show(file)}: transform: ${show(transform)} does not exist`);
      continue;
    }
    channels.push({
      name: folder,
      dir: channelDir,
      format: channel.format ?? "hl7v2",
      source: {
        kind: "file",
        dir: resolve(channelDir, channel.source.file.dir),
        minAgeMs: channel.source.file.minAge ?? DEFAULT_MIN_AGE_MS,
      },
      transform,
      destinations: channel.destinations.map((destination) => ({
        kind: "file" as const,
        dir: resolve(channelDir, destination.file.dir),
      })),
      settings: mergeSettings(settings, channel),
    });
  }

  if (problems.length === 0 && channels.length === 0) {
    problems.push(
      `${show(channelsDir)}: no channels; each channel lives in channels/<name>/channel.yaml`,
    );
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return { root: projectRoot, databaseFile, settings, channels };
}

function mergeSettings(
  base: Settings,
  override: {
    timeout?: number | undefined;
    memory?: number | undefined;
    pollInterval?: number | undefined;
  },
): Settings {
  return {
    timeoutMs: override.timeout ?? base.timeoutMs,
    memoryMb: override.memory ?? base.memoryMb,
    pollIntervalMs: override.pollInterval ?? base.pollIntervalMs,
  };
}

async function readYaml(
  file: string,
  show: (file: string) => string,
  problems: string[],
): Promise<unknown> {
  try {
    return parseYaml(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof YAMLParseError) {
      const at = error.linePos?.[0];
      const where = at === undefined ? "" : ` at line ${at.line}, column ${at.col}`;
      problems.push(`${show(file)}: not valid YAML${where} (${error.code})`);
    } else {
      problems.push(`${show(file)}: could not be read`);
    }
    return undefined;
  }
}

function describeIssues(
  file: string,
  issues: ReadonlyArray<{ readonly path: readonly PropertyKey[]; readonly message: string }>,
): string[] {
  return issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    return `${file}: ${path === "" ? "" : `${path}: `}${issue.message}`;
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
