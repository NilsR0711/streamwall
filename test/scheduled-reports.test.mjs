import { load } from 'js-yaml'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))
const workflowDir = join(rootDir, '.github/workflows')
const reporterPath = './.github/workflows/scheduled-report.yml'

function readWorkflow(fileName) {
  return load(readFileSync(join(workflowDir, fileName), 'utf8'))
}

function scheduledWorkflows() {
  return readdirSync(workflowDir)
    .filter((fileName) => fileName.endsWith('.yml'))
    .map((fileName) => [fileName, readWorkflow(fileName)])
    .filter(([, workflow]) => workflow.on?.schedule)
}

// A scheduled run has no triggering user, so GitHub emails nobody when it goes
// red — the failure only exists as an entry in the Actions tab (#514). Every
// workflow that runs on a schedule therefore has to report its own verdict.
test('every scheduled workflow reports its result', () => {
  const workflows = scheduledWorkflows()
  assert.ok(workflows.length > 0, 'expected at least one scheduled workflow')

  for (const [fileName, workflow] of workflows) {
    const entries = Object.entries(workflow.jobs)
    const reporters = entries.filter(([, job]) => job.uses === reporterPath)
    assert.equal(
      reporters.length,
      1,
      `${fileName} must call ${reporterPath} exactly once`,
    )

    const [reporterName, reporter] = reporters[0]
    const workJobs = entries
      .map(([name]) => name)
      .filter((name) => name !== reporterName)

    for (const name of workJobs) {
      assert.ok(
        reporter.needs?.includes(name),
        `${fileName} job "${name}" is missing from the reporting job's needs, ` +
          'so its failure would go unreported',
      )
    }

    // Without `always()` the reporter inherits the default "only on success"
    // condition and is skipped by exactly the runs it exists to report.
    assert.match(
      String(reporter.if ?? ''),
      /always\(\)/,
      `${fileName}'s reporting job must run with always()`,
    )

    // `needs.*.result` covers every upstream job, including matrix legs, so a
    // new job in the workflow cannot silently fall out of the verdict.
    assert.match(
      String(reporter.with?.result ?? ''),
      /needs\.\*\.result/,
      `${fileName} must derive the reported result from needs.*.result`,
    )

    // The reusable workflow can only use permissions the caller granted.
    assert.equal(
      reporter.permissions?.issues,
      'write',
      `${fileName}'s reporting job must grant issues: write`,
    )
    assert.equal(
      reporter.permissions?.contents,
      undefined,
      `${fileName}'s reporting job must not grant contents access`,
    )
  }
})

// A called workflow is capped at the permissions of its caller, and that cap
// is validated when the run is created — before any job-level `if` is
// evaluated. So a workflow that is both called and scheduled cannot grow a
// reporting job with `issues: write` without failing every caller's run at
// startup; the schedule belongs in a wrapper of its own instead.
test('a workflow another workflow calls does not also run on a schedule', () => {
  const called = new Set(
    readdirSync(workflowDir)
      .filter((fileName) => fileName.endsWith('.yml'))
      .flatMap((fileName) => Object.values(readWorkflow(fileName).jobs))
      .map((job) => job.uses)
      .filter((uses) => uses?.startsWith('./.github/workflows/')),
  )
  assert.ok(called.size > 0, 'expected at least one reusable workflow call')

  for (const path of called) {
    const workflow = readWorkflow(path.split('/').pop())
    assert.equal(
      workflow.on?.schedule,
      undefined,
      `${path} is called by another workflow and must not also be scheduled`,
    )
  }
})

test('the reporter is reusable only and keeps its permissions scoped', () => {
  const reporter = readWorkflow('scheduled-report.yml')

  assert.deepEqual(
    Object.keys(reporter.on),
    ['workflow_call'],
    'scheduled-report.yml must only be callable from another workflow',
  )
  assert.deepEqual(
    reporter.permissions,
    {},
    'scheduled-report.yml must start from no permissions at all',
  )

  const [job] = Object.values(reporter.jobs)
  assert.deepEqual(
    job.permissions,
    { issues: 'write' },
    'the reporting job needs issues: write and nothing else',
  )
})

// Reusing one issue per workflow is what keeps a persistent failure from
// filing a fresh report every week, and closing it on the next green run is
// what keeps the tracker honest about the current state.
test('the reporter reuses one issue per workflow and closes it when green', () => {
  const reporter = readWorkflow('scheduled-report.yml')
  const script = Object.values(reporter.jobs)
    .flatMap((job) => job.steps)
    .map((step) => step.run ?? '')
    .join('\n')

  assert.match(
    script,
    /gh issue list/,
    'the reporter must look for an existing issue before opening one',
  )
  assert.match(script, /gh issue create/)
  assert.match(script, /gh issue comment/)
  assert.match(script, /gh issue close/)
})
