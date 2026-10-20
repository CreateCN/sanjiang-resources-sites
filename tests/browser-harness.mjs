import { chromium } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** CI keeps per-context screenshots/traces only when the test step fails. */
export async function launchTestBrowser() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? (!process.env.CI && existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : chromium.executablePath()),
    headless: true, args: ['--no-sandbox'],
  });
  const directory = process.env.TEST_ARTIFACTS_DIR;
  if (!directory) return browser;
  mkdirSync(directory, { recursive: true });
  const newContext = browser.newContext.bind(browser);
  let sequence = 0;
  browser.newContext = async (options) => {
    const context = await newContext(options);
    const id = ++sequence;
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const close = context.close.bind(context);
    let saved = false;
    context.close = async (...args) => {
      if (!saved) {
        saved = true;
        for (const [index, page] of context.pages().entries()) {
          await page.screenshot({ path: join(directory, `context-${id}-page-${index}.png`), fullPage: true, timeout: 5000 }).catch(() => {});
        }
        await context.tracing.stop({ path: join(directory, `context-${id}-trace.zip`) }).catch(() => {});
      }
      return close(...args);
    };
    return context;
  };
  browser.newPage = async (options) => {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    page.close = async () => { await context.close(); };
    return page;
  };
  const close = browser.close.bind(browser);
  browser.close = async (...args) => {
    for (const context of browser.contexts()) await context.close().catch(() => {});
    return close(...args);
  };
  return browser;
}
