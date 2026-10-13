import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: { baseURL: process.env.FUTVR_E2E_URL ?? 'http://127.0.0.1:5173', trace: 'retain-on-failure', screenshot: 'only-on-failure', launchOptions:process.env.FUTVR_E2E_CHROMIUM?{executablePath:process.env.FUTVR_E2E_CHROMIUM}:{} },
  projects: [
    {name:'desktop',testMatch:'desktop.spec.ts',use:{...devices['Desktop Chrome'],viewport:{width:1440,height:1000}}},
    {name:'mobile',testMatch:'mobile.spec.ts',use:{...devices['Pixel 7']}},
  ],
  webServer: [
    {command:'npm run dev -- --host 127.0.0.1',url:'http://127.0.0.1:5173',reuseExistingServer:!process.env.CI,timeout:30_000},
    {command:'PYTHONPATH=backend .venv/bin/uvicorn futvr.api:app --host 127.0.0.1 --port 8000',url:'http://127.0.0.1:8000/api/health',reuseExistingServer:!process.env.CI,timeout:30_000,env:{FUTVR_ENV:'development'}},
  ],
});
