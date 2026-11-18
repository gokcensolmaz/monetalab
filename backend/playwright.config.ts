import { defineConfig } from '@playwright/test';

// HTTP API tests only: they use the `request` fixture and never launch a browser.
// All output lives under test-results/ in dedicated subfolders. Playwright empties `outputDir` at startup,
// so it must NOT be test-results/ itself, which also holds the unit/integration JUnit files.
const ci = process.env.PLAYWRIGHT_REPORTS === '1';

export default defineConfig({
  testDir: './tests/api',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results/playwright-artifacts',
  globalSetup: './tests/api/support/global-setup.ts',
  fullyParallel: true,
  forbidOnly: ci,
  retries: 0,
  timeout: 30_000,
  reporter: ci
    ? [
        ['list'],
        ['junit', { outputFile: 'test-results/api.junit.xml' }],
        ['html', { outputFolder: 'test-results/playwright-report', open: 'never' }],
      ]
    : [['list']],
});
