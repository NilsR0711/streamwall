import type { ForgeMakeResult } from '@electron-forge/shared-types'
import { dump } from 'js-yaml'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Generates electron-updater's update metadata (`latest.yml` /
 * `latest-mac.yml`) as a forge `postMake` hook (#432).
 *
 * electron-updater discovers updates by fetching this file from the latest
 * GitHub release and comparing its `version`; the `sha512` is verified
 * against the downloaded artifact before install. electron-builder normally
 * generates the file, but forge's makers do not, so it is derived here from
 * the artifacts forge just made and appended to the make results, which is
 * what `@electron-forge/publisher-github` uploads.
 */

/** electron-updater's per-platform metadata file names. Linux has none: .deb/.rpm installs update through the package manager (#433). */
export function updateMetadataFileName(platform: string): string | null {
  switch (platform) {
    case 'win32':
      return 'latest.yml'
    case 'darwin':
      return 'latest-mac.yml'
    default:
      return null
  }
}

/**
 * The artifacts electron-updater can actually install: the NSIS installer on
 * Windows and the ZIP (Squirrel.Mac's required format) on macOS. Everything
 * else in the make output - blockmaps, .deb/.rpm - is published but must not
 * be listed as an update payload.
 */
export function isUpdateArtifact(
  platform: string,
  artifactPath: string,
): boolean {
  switch (platform) {
    case 'win32':
      return artifactPath.endsWith('.exe')
    case 'darwin':
      return artifactPath.endsWith('.zip')
    default:
      return false
  }
}

export interface UpdateFileEntry {
  url: string
  sha512: string
  size: number
}

/**
 * Renders the YAML shape electron-updater's GitHub provider expects: `files`
 * for current clients plus the legacy top-level `path`/`sha512` pair older
 * clients still read.
 */
export function renderUpdateMetadata(
  version: string,
  files: UpdateFileEntry[],
  releaseDate: Date,
): string {
  return dump({
    version,
    files,
    path: files[0].url,
    sha512: files[0].sha512,
    releaseDate: releaseDate.toISOString(),
  })
}

/** Base64 (not hex - electron-updater's convention) SHA-512 of a file, streamed so installers never sit in memory whole. */
export function sha512Base64(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    createReadStream(filePath)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('base64')))
  })
}

/**
 * Writes the update metadata file for every platform in the make results and
 * appends it to that platform's artifact list, so the GitHub publisher
 * uploads it alongside the installers. Returns the results forge should
 * continue with.
 *
 * A release run builds one platform per CI job, but the grouping also keeps
 * a hypothetical multi-arch make correct: one metadata file listing every
 * arch's artifact, since electron-updater fetches exactly one per platform.
 */
export async function appendUpdateMetadata(
  makeResults: ForgeMakeResult[],
  releaseDate: Date = new Date(),
): Promise<ForgeMakeResult[]> {
  const resultsByPlatform = new Map<string, ForgeMakeResult[]>()
  for (const result of makeResults) {
    const group = resultsByPlatform.get(result.platform) ?? []
    group.push(result)
    resultsByPlatform.set(result.platform, group)
  }

  for (const [platform, results] of resultsByPlatform) {
    const fileName = updateMetadataFileName(platform)
    const artifactPaths = results
      .flatMap((result) => result.artifacts)
      .filter((artifact) => isUpdateArtifact(platform, artifact))
    if (!fileName || artifactPaths.length === 0) {
      continue
    }

    const files: UpdateFileEntry[] = []
    for (const artifactPath of artifactPaths) {
      files.push({
        // The URL is the bare asset name: electron-updater resolves it
        // against the GitHub release the metadata file itself came from.
        url: path.basename(artifactPath),
        sha512: await sha512Base64(artifactPath),
        size: (await stat(artifactPath)).size,
      })
    }

    const version: string = results[0].packageJSON.version
    const metadataPath = path.join(path.dirname(artifactPaths[0]), fileName)
    await writeFile(
      metadataPath,
      renderUpdateMetadata(version, files, releaseDate),
    )
    results[0].artifacts.push(metadataPath)
  }

  return makeResults
}
