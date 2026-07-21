import { load } from 'js-yaml'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))

function readWorkflow(fileName) {
  return load(
    readFileSync(join(rootDir, '.github/workflows', fileName), 'utf8'),
  )
}

function readDoc(relativePath) {
  return readFileSync(join(rootDir, relativePath), 'utf8')
}

// Branch protection requires a single aggregate check per workflow, so any job
// that is not wired into `ci-ok` silently stops gating merges.
test('the ci-ok gate depends on every other job in ci.yml', () => {
  const ci = readWorkflow('ci.yml')
  const gate = ci.jobs['ci-ok']
  const otherJobs = Object.keys(ci.jobs).filter((job) => job !== 'ci-ok')

  for (const job of otherJobs) {
    assert.ok(
      gate.needs.includes(job),
      `ci.yml job "${job}" is missing from the ci-ok gate's needs`,
    )
  }
})

test('CodeQL runs inside ci.yml so its failures block the merge gate', () => {
  const ci = readWorkflow('ci.yml')
  const codeql = ci.jobs.codeql

  assert.ok(codeql, 'ci.yml is missing a codeql job')
  assert.equal(codeql.uses, './.github/workflows/codeql.yml')
})

test('codeql.yml is reusable and does not run standalone on pull requests', () => {
  const triggers = Object.keys(readWorkflow('codeql.yml').on)

  assert.ok(
    triggers.includes('workflow_call'),
    'codeql.yml must be callable from ci.yml',
  )
  assert.ok(
    !triggers.includes('pull_request'),
    'codeql.yml must not also trigger on pull_request, which would run the ' +
      'analysis twice and outside the ci-ok gate',
  )
})

// The documented list is what contributors and maintainers configure branch
// protection from, so it has to name the checks the workflows actually report.
test('CONTRIBUTING documents exactly the required status checks', () => {
  const contributing = readDoc('CONTRIBUTING.md')
  const section = contributing
    .split('### Required status checks')[1]
    ?.split(/^#{2,3} /m)[0]

  assert.ok(
    section,
    'CONTRIBUTING.md is missing a required status checks section',
  )

  const documented = [...section.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1])
  const expected = [
    readWorkflow('ci.yml').jobs['ci-ok'].name,
    readWorkflow('pr-title.yml').jobs['conventional-title'].name,
  ]

  assert.deepEqual(documented, expected)
})
