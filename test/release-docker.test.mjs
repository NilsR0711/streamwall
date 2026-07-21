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

function releaseJob(name) {
  const job = readYaml('.github/workflows/release.yml').jobs[name]
  assert.ok(job, `release.yml is missing a ${name} job`)
  return job
}

function dockerJob() {
  return releaseJob('docker-image')
}

function manifestJob() {
  return releaseJob('docker-manifest')
}

// Both jobs address the same repository: the build legs push digests into it,
// the manifest job tags them. A mismatch would publish tags that resolve to
// nothing.
function imageNameStep(job, jobName) {
  const step = job.steps.find((candidate) => candidate.id === 'image')
  assert.ok(step, `the ${jobName} job must derive the image name`)
  return step.run
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
  assert.match(
    push.with.outputs,
    /push=true/,
    'the build legs must push their layers, not just build them',
  )
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

// arm64 self-hosting targets (Raspberry Pi, Ampere/Graviton) otherwise get a
// failed pull or slow QEMU emulation (#524). Each architecture builds on a
// runner of its own kind, because emulating the arm64 leg would dominate the
// release wall-clock time.
test('the image is built natively for amd64 and arm64', () => {
  const job = dockerJob()
  const platforms = job.strategy.matrix.platform

  assert.deepEqual(
    platforms.map((platform) => platform.arch).sort(),
    ['amd64', 'arm64'],
    'the image must be published for both architectures',
  )
  for (const { arch, runner } of platforms) {
    assert.match(
      runner,
      arch === 'arm64' ? /-arm$/ : /^ubuntu-latest$/,
      `the ${arch} leg must build on a native ${arch} runner`,
    )
  }

  const push = job.steps.find((step) =>
    step.uses?.startsWith('docker/build-push-action@'),
  )
  assert.equal(
    push.with.platforms,
    'linux/${{ matrix.platform.arch }}',
    'each leg must build only its own architecture',
  )
  assert.ok(
    !job.steps.some((step) => step.uses?.includes('setup-qemu-action')),
    'a native matrix must not fall back to QEMU emulation',
  )
})

// The legs cannot share a tag without racing, so each pushes an untagged,
// digest-addressed image and hands the digest to the manifest job.
test('each architecture is pushed by digest and handed on', () => {
  const steps = dockerJob().steps

  const push = steps.find((step) =>
    step.uses?.startsWith('docker/build-push-action@'),
  )
  assert.match(push.with.outputs, /push-by-digest=true/)
  assert.ok(
    !push.with.tags,
    'a digest-addressed push must stay untagged, or the legs overwrite ' +
      'each other',
  )

  const upload = steps.find((step) =>
    step.uses?.startsWith('actions/upload-artifact@'),
  )
  assert.ok(upload, 'each leg must publish its digest for the manifest job')
  assert.match(
    upload.with.name,
    /\$\{\{ matrix\.platform\.arch \}\}/,
    'the digest artifacts need per-architecture names to coexist',
  )
  assert.equal(
    upload.with['if-no-files-found'],
    'error',
    'a missing digest must fail the leg, not the manifest merge',
  )
})

// A GITHUB_TOKEN without `packages: write` fails at push time, after the whole
// image has been built.
test('the docker-image job is granted package write access', () => {
  assert.equal(dockerJob().permissions.packages, 'write')
})

// Both the version tag (to pin or roll back to) and `latest` (what the
// documented compose stack resolves by default) have to exist for every
// release, and they must point at the merged multi-arch manifest rather than
// at one architecture's digest.
test('the published manifest is tagged with the version and latest', () => {
  const job = manifestJob()

  assert.equal(
    job.permissions.packages,
    'write',
    'tagging the merged manifest is a registry write',
  )
  assert.ok(
    job.needs.includes('docker-image'),
    'the manifest can only be merged once both legs have pushed',
  )

  const meta = job.steps.find((step) =>
    step.uses?.startsWith('docker/metadata-action@'),
  )
  assert.ok(meta, 'the docker-manifest job must derive its tags from the ref')
  assert.match(meta.with.tags, /type=semver,pattern=\{\{version\}\}/)
  assert.match(meta.with.tags, /type=raw,value=latest/)

  const imageName = imageNameStep(job, 'docker-manifest')
  assert.match(imageName, new RegExp(`ghcr\\.io/.+/${IMAGE_REPOSITORY}`))
  assert.equal(
    imageName,
    imageNameStep(dockerJob(), 'docker-image'),
    'the tags must be applied to the repository the legs pushed into',
  )
})

// A manifest that silently lost an architecture looks identical to a good one
// until an arm64 host tries to pull it.
test('the multi-arch manifest is merged and verified', () => {
  const runs = manifestJob()
    .steps.map((step) => step.run)
    .filter(Boolean)
    .join('\n')

  assert.match(
    runs,
    /docker buildx imagetools create/,
    'the per-architecture digests must be merged into one manifest',
  )
  assert.match(
    runs,
    /docker buildx imagetools inspect/,
    'the published manifest must be inspected before the release is done',
  )
  for (const platform of ['linux/amd64', 'linux/arm64']) {
    assert.ok(
      runs.includes(platform),
      `the verification must assert ${platform} is in the manifest`,
    )
  }
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
    doc,
    /linux\/arm64/,
    'self-hosters on arm64 need to know the published image covers them',
  )
  assert.match(
    readText('deploy/.env.example'),
    /STREAMWALL_IMAGE_TAG/,
    '.env.example must document the tag the compose stack resolves',
  )
})
