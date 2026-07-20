import type { StreamData } from 'streamwall-shared'
import { expect, test } from './harness.ts'

/**
 * End-to-end coverage for issue #391: the Sidebar's "Custom Streams" panel
 * (`Sidebar.tsx`'s `CustomStreamInput`/`CreateCustomStreamInput`) has no
 * server-side unit test at all, unlike the Access panel's invite round-trip
 * (`invite-management.spec.ts`). These drive the add and delete forms in a
 * real browser and assert the resulting `update-custom-stream` /
 * `delete-custom-stream` commands actually reach the Streamwall peer.
 */

const SEEDED_CUSTOM_STREAM: StreamData = {
  _id: 'https://example.com/seeded-custom-stream',
  _dataSource: 'custom',
  kind: 'video',
  link: 'https://example.com/seeded-custom-stream',
  label: 'Seeded Custom Stream',
}

test('adding a custom stream from the sidebar forwards an update-custom-stream command to the peer', async ({
  page,
  harness,
}) => {
  await page.goto(await harness.createInviteLink())
  await expect(
    page.getByRole('heading', { name: 'Custom Streams' }),
  ).toBeVisible()

  const link = 'https://example.com/new-custom-stream'
  const addForm = page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'add stream' }) })
  await addForm.getByPlaceholder('https://...').fill(link)
  await addForm.getByPlaceholder('Label (optional)').fill('Field Cam')

  const addCommandPromise = harness.waitForCommand('update-custom-stream')
  await addForm.getByRole('button', { name: 'add stream' }).click()

  const addCommand = await addCommandPromise
  expect(addCommand).toMatchObject({
    type: 'update-custom-stream',
    url: link,
    data: { link, kind: 'video', label: 'Field Cam' },
  })
})

test('deleting an existing custom stream forwards a delete-custom-stream command to the peer', async ({
  page,
  harness,
}) => {
  // Seeded before navigation so the row (and its delete button) is already
  // rendered when the browser connects - the harness's default state has no
  // custom streams (see harness.ts's `DEMO_STREAMS`).
  harness.pushState({ streams: [SEEDED_CUSTOM_STREAM] })
  await page.goto(await harness.createInviteLink())

  await expect(
    page.getByRole('link', { name: SEEDED_CUSTOM_STREAM.link }),
  ).toBeVisible()

  const deleteCommandPromise = harness.waitForCommand('delete-custom-stream')
  await page.getByRole('button', { name: 'x', exact: true }).click()

  const deleteCommand = await deleteCommandPromise
  expect(deleteCommand).toMatchObject({
    type: 'delete-custom-stream',
    url: SEEDED_CUSTOM_STREAM.link,
  })
})
