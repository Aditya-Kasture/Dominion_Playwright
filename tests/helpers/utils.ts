import { Page } from '@playwright/test';
import fs from 'fs';

/** Random delay within [base, base+jitter) ms to reduce bot detection risk. */
export function randomDelay(baseMs = 800, jitterMs = 600): Promise<void> {
  return new Promise(resolve =>
    setTimeout(resolve, baseMs + Math.random() * jitterMs)
  );
}

/** Parse a dollar amount from strings like "$142.50", "Amount Due: $142.50". */
export function parseDollarAmount(text: string): number | null {
  const match = text.replace(/,/g, '').match(/\$?([\d]+\.?\d{0,2})/);
  return match ? parseFloat(match[1]) : null;
}

/** Parse a date from "05/15/2026" or "May 15, 2026" format. */
export function parseDate(text: string): string | null {
  const match = text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Z][a-z]+ \d{1,2},? \d{4})/);
  return match ? match[1] : null;
}

/** Hides navigator.webdriver to reduce bot detection signals. */
export async function hideAutomationSignals(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // Spoof plugins length (headless Chrome has 0)
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });
}

/** Take a screenshot with a timestamped filename into screenshots/. */
export async function screenshot(page: Page, label: string): Promise<void> {
  fs.mkdirSync('screenshots', { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = `screenshots/${label}_${ts}.png`;
  await page.screenshot({ path: filePath, fullPage: true });
  console.log(`[Screenshot] Saved: ${filePath}`);
}

/**
 * Consumption threshold logic from the Phase Plan.
 * Returns the action string used for audit logging and downstream decisions.
 */
export function determineWaterAction(
  consumption: number | null,
  baseline: number | null
): 'auto_pay' | 'pay_alert_pm' | 'pay_work_order' {
  if (consumption === null || baseline === null) return 'auto_pay';
  if (consumption < 25) return 'auto_pay';
  if (consumption <= 35) return 'pay_alert_pm';
  return 'pay_work_order';
}
