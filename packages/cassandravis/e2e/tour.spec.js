import { test, expect } from '@playwright/test'

// Walks the ENTIRE first-run guided tour, clicking only what it spotlights —
// the same path a new user takes. Rides out real autoplay animations, so the
// timeout is generous and every visibility wait gets a long budget.
const WAIT = { timeout: 45_000 }

test('the guided tour runs end to end: put → sample → get → 🔍 → crash → hint → recover', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const errors = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text())
  })
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))

  await page.goto('/')

  // Welcome card → start.
  await expect(page.locator('.tour-card')).toContainText('Welcome')
  await page.getByRole('button', { name: 'Start the tour' }).click()

  // 1 · Put — spotlight on the request area.
  await expect(page.locator('.tour-tip')).toContainText('Put your first key', WAIT)
  await page.getByRole('button', { name: 'Put', exact: true }).click()

  // 2 · Load sample data (waits out the put's autoplay).
  await expect(page.locator('.tour-tip')).toContainText('Load a richer dataset', WAIT)
  await page.getByRole('button', { name: 'Load sample data' }).click()

  // 3 · Get cart:7 — the deliberately stale key.
  await expect(page.locator('.tour-tip')).toContainText('read something back', WAIT)
  await page.getByRole('button', { name: 'cart:7' }).click()
  await page.getByRole('button', { name: 'Get', exact: true }).click()

  // 4 · Magnify — the tour pauses the read at the query step; the 🔍 opens the
  // replica's local read path with the memtable drawn as a map.
  await expect(page.locator('.tour-tip')).toContainText('Zoom into a replica', WAIT)
  await page.locator('[data-tour="magnify"]').click()
  const card = page.locator('.closeup-card')
  await expect(card).toContainText('read path for cart:7')
  await expect(card.locator('.cu-dict').first()).toBeVisible()
  await card.getByRole('button', { name: 'close' }).click()

  // 5 · Resume via the spotlighted ▶ Play.
  await expect(page.locator('.tour-tip')).toContainText('Resume the read', WAIT)
  await page.locator('[data-tour="stepper-play"]').click()

  // 6 · Crash a node (waits out the get finishing, incl. read repair).
  await expect(page.locator('.tour-tip')).toContainText('break something', WAIT)
  await page.locator('[data-tour="scenario-crash"]').click()

  // 7 · Write through the failure.
  await expect(page.locator('.tour-tip')).toContainText('Write through the failure', WAIT)
  await page.getByRole('button', { name: 'Put', exact: true }).click()

  // 8 · Recover.
  await expect(page.locator('.tour-tip')).toContainText('Bring it back', WAIT)
  await page.locator('[data-tour="scenario-recover"]').click()

  // Finish card.
  await expect(page.locator('.tour-card')).toContainText('core loop', WAIT)
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.locator('.tour-card')).toHaveCount(0)

  expect(errors).toEqual([])
})
