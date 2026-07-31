import { test, expect } from '@playwright/test'

// Exercises the teaching close-ups end-to-end in real Chromium: open each at
// the op step it belongs to, step it to its verdict, and fail on any console
// error or uncaught exception along the way.

function guardErrors(page) {
  const errors = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text())
  })
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
  return errors
}

// Dismiss the first-run tour and seed the lived-in sample cluster.
async function boot(page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Skip for now' }).click()
  await page.getByRole('button', { name: 'Load sample data' }).click()
  await expect(page.locator('.doc-list')).toBeVisible()
}

// Pause the bottom op timeline and scrub deterministically to op step `n`.
async function gotoOpStep(page, n) {
  const bar = page.locator('.stepper[data-tour="stepper"]')
  const pause = bar.getByRole('button', { name: 'Pause' })
  if (await pause.isVisible().catch(() => false)) await pause.click()
  const prev = bar.getByRole('button', { name: 'Prev' })
  while (await prev.isEnabled()) await prev.click()
  const next = bar.getByRole('button', { name: 'Next' })
  for (let i = 0; i < n; i++) await next.click()
  await expect(bar.locator('.step-count')).toContainText(`Step ${n + 1} / `)
}

// Advance a close-up's own stepper `times` times.
async function stepCloseUp(card, times) {
  const next = card.getByRole('button', { name: 'Next' })
  for (let i = 0; i < times; i++) await next.click()
}

test('write-path zoom: full memtable map + immutable SSTables on disk', async ({ page }) => {
  const errors = guardErrors(page)
  await boot(page)
  await page.getByRole('button', { name: 'Put', exact: true }).click()
  await gotoOpStep(page, 3) // send to ALL replicas

  await page.locator('button.cu-btn[title*="local write path"]').first().click()
  const card = page.locator('.closeup-card')
  await expect(card).toContainText('memtable — a sorted map')
  await expect(card).toContainText('on disk')
  // The on-disk strip renders each SSTable as a dict block (1 from the sample).
  await expect(card.locator('.cu-sst-strip .cu-dict')).toHaveCount(1)
  // The memtable dict shows the write landing as a map upsert.
  await stepCloseUp(card, 2) // arrive → log → mem
  await expect(card.locator('.cu-dict-row.new')).toBeVisible()

  await stepCloseUp(card, 2) // → step 5 of 5 (ack)
  await expect(card).toContainText('ack → coordinator')

  await card.getByRole('button', { name: 'close' }).click()
  expect(errors).toEqual([])
})

test('read-path zoom: memtable lookup → bloom-filter bits → LWW resolve', async ({ page }) => {
  const errors = guardErrors(page)
  await boot(page)
  await page.getByRole('button', { name: 'Get', exact: true }).click()
  await gotoOpStep(page, 3) // query R replicas

  await page.locator('button.cu-btn[title*="local read path"]').first().click()
  const card = page.locator('.closeup-card')
  await expect(card).toContainText('read path for')

  // Step 1: the memtable drawn as a map, with the looked-up key's row
  // (hit or ∅-miss) called out.
  await expect(card.locator('.cu-dict').first()).toBeVisible()
  await expect(card.locator('.cu-dict-row.focus, .cu-dict-row.miss').first()).toBeVisible()

  // Step 2 reveals an SSTable's bloom-filter bits.
  await stepCloseUp(card, 1)
  await expect(card.locator('.cu-bits .cu-bit').first()).toBeVisible()

  await stepCloseUp(card, 1) // → resolve
  await expect(card).toContainText('winner')

  await card.getByRole('button', { name: 'close' }).click()
  expect(errors).toEqual([])
})

test('read repair still fires on the stale cart:7 replica (regression)', async ({ page }) => {
  const errors = guardErrors(page)
  await boot(page)
  await page.getByRole('button', { name: 'cart:7' }).click() // preset: node-1 is stale
  await page.getByRole('button', { name: 'Get', exact: true }).click()
  await gotoOpStep(page, 5) // coord,hash,walk,query,resolve,repair

  const bar = page.locator('.stepper[data-tour="stepper"]')
  await expect(bar.locator('.step-track')).toContainText('repair', { ignoreCase: true })

  // The read-repair zoom lives on the coordinator at this step.
  await page.locator('button.cu-btn[title*="read repair"]').click()
  await expect(page.locator('.closeup-card')).toBeVisible()
  await page.locator('.closeup-card').getByRole('button', { name: 'close' }).click()
  expect(errors).toEqual([])
})
