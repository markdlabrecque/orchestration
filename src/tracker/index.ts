import { type Exec, exec } from "../command.ts";
import { createGitHubTracker } from "./github.ts";
import { createGitLabTracker } from "./gitlab.ts";
import type { Tracker } from "./types.ts";

export type Forge = "github" | "gitlab";
export type Repository = { repo: string; host?: string; forge?: Forge };

/** Parse origin without contacting a host or guessing an unknown server's API. */
export function repositoryFromOrigin(origin: string): Repository {
  const value = origin.trim();
  const match =
    value.match(/^https?:\/\/([^/]+)\/(.+)$/) ??
    value.match(/^ssh:\/\/(?:[^/@]+@)?([^/:]+)(?::\d+)?\/(.+)$/) ??
    value.match(/^(?:[^/@:]+@)?([^/:]+):(.+)$/);
  if (!match) throw new Error("Unsupported repository origin");
  const host = match[1].toLowerCase();
  const repo = match[2].replace(/\/$/, "").replace(/\.git$/, "");
  if (
    !/^[\w.-]+(?::[0-9]+)?$/.test(host) ||
    !/^[\w.-]+(?:\/[\w.-]+)+$/.test(repo) ||
    repo.split("/").some((p) => p === "." || p === "..")
  )
    throw new Error("Unsupported repository origin");
  const forge = /(^|\.)github\./.test(host)
    ? "github"
    : /(^|\.)gitlab\./.test(host)
      ? "gitlab"
      : undefined;
  return { host, repo, forge };
}

export function selectForge(
  repository: Pick<Repository, "forge">,
  override?: unknown,
): Forge {
  const forge = override ?? repository.forge;
  if (forge !== "github" && forge !== "gitlab")
    throw new Error("settings.forge: set github or gitlab for this origin");
  return forge;
}

export function createTracker(
  repository: Repository,
  cwd: string,
  execute: Exec = exec,
  override?: unknown,
): Tracker {
  return selectForge(repository, override) === "gitlab"
    ? createGitLabTracker(repository.repo, cwd, execute, repository.host)
    : createGitHubTracker(repository.repo, cwd, execute, repository.host);
}
