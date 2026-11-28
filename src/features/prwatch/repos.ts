// Repository names as the PR watcher matches them (kept apart from prWatch.ts: Settings uses them too).

/** The repository of a pull request ("api" from https://github.com/acme/api/pull/7, any GitHub host). */
export const repoOfPr = (url: string) => /\/\/[^/]+\/[^/]+\/([^/]+)\/pull\/\d+/.exec(url)?.[1] ?? ""

/** A repository as Settings lists it: "acme/api" and "api" both mean "api". */
export const repoName = (r: string) => r.trim().replace(/\.git$/, "").split("/").filter(Boolean).pop() ?? ""
