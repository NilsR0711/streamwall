import { load } from 'js-yaml'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))

function readYaml(relativePath) {
  return load(readFileSync(join(rootDir, relativePath), 'utf8'))
}

function readText(relativePath) {
  return readFileSync(join(rootDir, relativePath), 'utf8')
}

const IMAGE_REPOSITORY = 'streamwall-control-server'

function dockerJob() {
  const job = readYaml('.github/workflows/release.yml').jobs['docker-image']
  assert.ok(job, 'release.yml is missing a docker-image job')
  return job
}

// Self-hosters otherwise have to clone the repo and run the full toolchain
// build on their own host, with no immutable artifact to pin or roll back to
// (#478).
test('the release publishes the control-server image to GHCR', () => {
  const steps = dockerJob().steps

  const login = steps.find((step) =>
    step.uses?.startsWith('docker/login-action@'),
  )
  assert.ok(login, 'the docker-image job must log in to a registry')
  assert.equal(login.with.registry, 'ghcr.io')

  const push = steps.find((step) =>
    step.uses?.startsWith('docker/build-push-action@'),
  )
  assert.ok(push, 'the docker-image job must build and push the image')
  assert.equal(push.with.push, true)
  assert.equal(
    push.with.file,
    `packages/${IMAGE_REPOSITORY}/Dockerfile`,
    'the published image must come from the self-hosting Dockerfile',
  )
  assert.equal(
    push.with.context,
    '.',
    'the Dockerfile needs the repository root as its build context',
  )
})

// A GITHUB_TOKEN without `packages: write` fails at push time, after the whole
// image has been built.
test('the docker-image job is granted package write access', () => {
  assert.equal(dockerJob().permissions.packages, 'write')
})

// Both the version tag (to pin or roll back to) and `latest` (what the
// documented compose stack resolves by default) have to exist for every
// release.
test('the published image is tagged with the version and latest', () => {
  const meta = dockerJob().steps.find((step) =>
    step.uses?.startsWith('docker/metadata-action@'),
  )
  assert.ok(meta, 'the docker-image job must derive its tags from the ref')
  assert.match(
    meta.with.images,
    new RegExp(`^ghcr\\.io/.+/${IMAGE_REPOSITORY}$`),
  )
  assert.match(meta.with.tags, /type=semver,pattern=\{\{version\}\}/)
  assert.match(meta.with.tags, /type=raw,value=latest/)
})

// The image must not ship code that would have failed a pull request, and a
// `latest` tag pointing at an untested build is worse than no image at all.
test('the image publish waits for the release quality gate', () => {
  const release = readYaml('.github/workflows/release.yml')

  for (const job of release.jobs.publish.needs) {
    assert.ok(
      release.jobs['docker-image'].needs.includes(job),
      `release.yml job "${job}" gates the binaries but not the image`,
    )
  }
})

// Only a tag carries a version to publish under; a manual workflow_dispatch
// run would otherwise move `latest` to an unreleased commit.
test('the image is only published for a version tag', () => {
  assert.match(dockerJob().if, /refs\/tags\/v/)
})

// `docker compose pull` needs an image reference; keeping `build:` alongside
// it preserves the documented local-build path (`up -d --build`).
test('the compose stack can pull the published image', () => {
  const service = readYaml('deploy/docker-compose.yml').services[
    'control-server'
  ]

  assert.match(
    service.image,
    new RegExp(`^ghcr\\.io/.+/${IMAGE_REPOSITORY}:\\$\\{`),
    'the compose service must reference the published image with an ' +
      'overridable tag so a deployment can be pinned',
  )
  assert.ok(
    service.build,
    'the local-build path must keep working for unreleased changes',
  )
})

test('self-hosting documents pulling and pinning the image', () => {
  const doc = readText('docs/self-hosting.md')

  assert.match(doc, /docker compose pull/)
  assert.match(doc, /STREAMWALL_IMAGE_TAG/)
  assert.match(
    readText('deploy/.env.example'),
    /STREAMWALL_IMAGE_TAG/,
    '.env.example must document the tag the compose stack resolves',
  )
})
