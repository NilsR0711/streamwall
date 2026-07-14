export interface RepositoryOwnerName {
  owner: string
  name: string
}

/**
 * Parses npm's `github:owner/name` repository shorthand into the
 * owner/name pair `@electron-forge/publisher-github` expects, so the
 * publish target is derived from package.json instead of a hardcoded
 * value that can drift out of sync with it (see issue #209).
 */
export function parseGithubRepository(repository: string): RepositoryOwnerName {
  const match = /^github:([^/]+)\/(.+)$/.exec(repository)
  if (!match) {
    throw new Error(
      `Expected package.json "repository" to be in "github:owner/name" form, got: ${repository}`,
    )
  }
  const [, owner, name] = match
  return { owner, name }
}
