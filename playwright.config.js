// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:8080',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Tall enough to fit baseplate + full gallery without scrolling so
        // mouse-driven drag tests can address every brick by viewport coords.
        viewport: { width: 1400, height: 1800 },
      },
    },
  ],
  webServer: {
    command: 'python3 -m http.server 8080',
    url: 'http://localhost:8080/lego.html',
    reuseExistingServer: true,
    timeout: 10_000,
  },
});
