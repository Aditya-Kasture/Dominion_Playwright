/**
 * Baltimore City Water Portal Automation
 * ───────────────────────────────────────
 * Modes (set WATER_MODE env var):
 *   audit      — Navigate & screenshot key pages only, no writes
 *   paperless  — Enable paperless billing for every owner-responsible unit
 *   bills      — Retrieve bill amount, due date, and consumption per unit
 *   full       — All of the above (default)
 *
 * Consumption threshold logic (from Phase Plan):
 *   < 25 units/quarter  → auto_pay
 *   25–35 units/quarter → pay_alert_pm (elevated — notify PM)
 *   > 35 units/quarter  → pay_work_order (likely leak — create work order)
 *
 * Run:
 *   WATER_MODE=full npx playwright test tests/water.spec.ts --project=chromium
 *
 * AUDIT NOTE: Water portal URL and selectors must be confirmed during the
 * Phase 1 portal audit. Run with HEADLESS=false, WATER_MODE=audit first.
 */

import { test, Page, BrowserContext } from '@playwright/test';
import * as dotenv from 'dotenv';
import { fetchWaterAccounts, logWaterRun, closePool, WaterAccount } from './helpers/db';
import { hideAutomationSignals, randomDelay, parseDollarAmount, parseDate, screenshot, determineWaterAction } from './helpers/utils';

dotenv.config();

// ─── Config ───────────────────────────────────────────────────────────────────
const MODE = (process.env.WATER_MODE ?? 'full') as 'audit' | 'paperless' | 'bills' | 'full';
// AUDIT NOTE: Confirm the exact login URL during the water portal audit
const LOGIN_URL = process.env.WATER_LOGIN_URL ?? 'https://cityservices.baltimorecity.gov/water/Login';
const WATER_EMAIL = process.env.WATER_EMAIL ?? 'construction@thedominiongroup.com';
const WATER_PASSWORD = process.env.WATER_PASSWORD ?? '';

let context: BrowserContext;
let page: Page;
let units: WaterAccount[] = [];

// ─── Setup ────────────────────────────────────────────────────────────────────

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  page = await context.newPage();
  await hideAutomationSignals(page);

  units = await fetchWaterAccounts();
  console.log(`[Water] Loaded ${units.length} owner-responsible units from DB.`);
});

test.afterAll(async () => {
  await context?.close();
  await closePool();
});

// ─── Test 1: Login ────────────────────────────────────────────────────────────

test('Water Portal Login', async () => {
  console.log(`[Water] Navigating to login: ${LOGIN_URL}`);
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });
  await screenshot(page, 'water_login_page');

  // AUDIT NOTE: Water portal login may use email+password, account number, or SSO.
  // Confirm field selectors during the portal audit.
  const emailField = page.locator(
    'input[type="email"], input[name="email"], #email, #username, input[name="username"]'
  ).first();
  await emailField.waitFor({ timeout: 10_000 });
  await emailField.fill(WATER_EMAIL);
  await randomDelay(600, 400);

  const passwordField = page.locator('input[type="password"], #password').first();
  await passwordField.fill(WATER_PASSWORD);
  await randomDelay(800, 500);

  const submitBtn = page.locator(
    'button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign In")'
  ).first();
  await submitBtn.click();
  await page.waitForTimeout(2500);

  const url = page.url();
  if (url.toLowerCase().includes('login') || url.toLowerCase().includes('signin')) {
    await screenshot(page, 'water_login_failed');
    throw new Error(`Water portal login failed — still on login page: ${url}`);
  }

  console.log('[Water] Login successful.');
  await screenshot(page, 'water_post_login');

  if (MODE === 'audit') {
    console.log('[Water] AUDIT MODE — capturing account overview screenshot.');
    await screenshot(page, 'water_audit_overview');
  }
});

// ─── Test 2: Paperless Enrollment ─────────────────────────────────────────────

test('Water Paperless Enrollment (all units)', async () => {
  if (MODE === 'audit' || MODE === 'bills') {
    test.skip(true, `Mode is ${MODE} — skipping paperless enrollment.`);
    return;
  }

  console.log(`[Water] Starting paperless enrollment for ${units.length} units.`);

  for (const unit of units) {
    const address = `${unit.street1}, ${unit.city}, ${unit.state} ${unit.zip}`;
    console.log(`[Water] Processing paperless: ${address} (${unit.unit_name})`);

    const found = await navigateToUnit(page, unit);
    if (!found) {
      await logWaterRun({ unit_id: unit.unit_id, property_id: unit.property_id, action: 'navigate', status: 'FAILED', notes: 'Address not found in portal' });
      continue;
    }

    const ok = await enableWaterPaperless(page, address);
    await logWaterRun({
      unit_id: unit.unit_id,
      property_id: unit.property_id,
      action: 'paperless_enrollment',
      status: ok ? 'SUCCESS' : 'FAILED',
    });

    await randomDelay(2000, 1000);
  }
});

// ─── Test 3: Bill Retrieval + Threshold Logic ─────────────────────────────────

test('Water Bill Retrieval (all units)', async () => {
  if (MODE === 'audit' || MODE === 'paperless') {
    test.skip(true, `Mode is ${MODE} — skipping bill retrieval.`);
    return;
  }

  console.log(`[Water] Starting bill retrieval for ${units.length} units.`);

  for (const unit of units) {
    const address = `${unit.street1}, ${unit.city}, ${unit.state} ${unit.zip}`;
    console.log(`[Water] Retrieving bill: ${address} (${unit.unit_name})`);

    const found = await navigateToUnit(page, unit);
    if (!found) {
      await logWaterRun({ unit_id: unit.unit_id, property_id: unit.property_id, action: 'navigate', status: 'FAILED', notes: 'Address not found in portal' });
      continue;
    }

    const bill = await retrieveWaterBill(page, address);
    const thresholdAction = determineWaterAction(bill.consumptionUnits, unit.consumption_baseline);

    const notes = unit.consumption_baseline !== null
      ? `Baseline: ${unit.consumption_baseline} units, Actual: ${bill.consumptionUnits} → ${thresholdAction}`
      : `No baseline on file — defaulting to auto_pay. Actual: ${bill.consumptionUnits}`;

    await logWaterRun({
      unit_id: unit.unit_id,
      property_id: unit.property_id,
      action: 'bill_retrieval',
      status: bill.amount !== null ? 'SUCCESS' : 'PARTIAL',
      bill_amount: bill.amount,
      consumption_units: bill.consumptionUnits,
      due_date: bill.dueDate,
      threshold_action: thresholdAction,
      notes,
    });

    // Console alerts for elevated consumption — downstream can trigger PM notifications
    if (thresholdAction === 'pay_alert_pm') {
      console.warn(
        `[Water] ELEVATED consumption at ${address}: ` +
        `${bill.consumptionUnits} units (baseline: ${unit.consumption_baseline}). ` +
        `ACTION: Alert PM.`
      );
    } else if (thresholdAction === 'pay_work_order') {
      console.error(
        `[Water] POSSIBLE LEAK at ${address}: ` +
        `${bill.consumptionUnits} units (baseline: ${unit.consumption_baseline}). ` +
        `ACTION: Create work order.`
      );
    }

    await randomDelay(2000, 1000);
  }
});

// ─── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Navigates the water portal to the account for a given unit.
 * AUDIT NOTE: The water portal may use account number lookup, address search,
 * or a list of linked accounts. Confirm the approach during the portal audit.
 */
async function navigateToUnit(page: Page, unit: WaterAccount): Promise<boolean> {
  const address = `${unit.street1}, ${unit.city}`;
  try {
    // Strategy 1: Address search field
    const searchField = page.locator(
      'input[placeholder*="address" i], input[name*="address" i], input[aria-label*="address" i], input[placeholder*="search" i]'
    ).first();
    if (await searchField.isVisible().catch(() => false)) {
      await searchField.fill(address);
      await page.waitForTimeout(800);
      // Dismiss autocomplete or submit
      const suggestion = page.locator('.suggestion, .autocomplete-item, [role="option"]').first();
      if (await suggestion.isVisible({ timeout: 2000 }).catch(() => false)) {
        await suggestion.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(1500);
      return true;
    }

    // Strategy 2: Account number field (water bills often use account # not email)
    // AUDIT NOTE: If the portal uses account number, we need a water_account_map table
    // similar to bge_account_property_map. Flag this during audit if needed.
    const acctField = page.locator(
      'input[name*="account" i], input[placeholder*="account" i]'
    ).first();
    if (await acctField.isVisible().catch(() => false)) {
      // TODO after audit: use unit.water_account_number once that field exists in DB
      console.warn(`[Water] Account number field detected for ${address} — water_account_map needed.`);
      return false;
    }

    // Strategy 3: Scan linked account list
    const streetNum = unit.street1.split(' ')[0];
    const rows = await page.locator('.account-item, .property-row, tr, .location-card').all();
    for (const row of rows) {
      const text = await row.innerText().catch(() => '');
      if (text.includes(streetNum) && text.toLowerCase().includes(unit.city.toLowerCase())) {
        await row.click();
        await page.waitForTimeout(1500);
        return true;
      }
    }

    console.warn(`[Water] Could not locate account for ${address}.`);
    await screenshot(page, `water_account_not_found`);
    return false;
  } catch (err) {
    console.error(`[Water] Error navigating to unit ${unit.unit_name}:`, err);
    return false;
  }
}

/**
 * Enables paperless billing for the currently displayed water account.
 * AUDIT NOTE: Update navigation path and toggle selector after portal audit.
 */
async function enableWaterPaperless(page: Page, address: string): Promise<boolean> {
  try {
    // AUDIT NOTE: Water portal settings may be under "My Account", "Preferences", or inline on the account page
    const navOptions = [
      'a:has-text("Paperless")',
      'a:has-text("Billing Preferences")',
      'a:has-text("Notification Settings")',
      'a:has-text("Account Settings")',
      'a:has-text("My Account")',
    ];
    for (const sel of navOptions) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        await el.click();
        await page.waitForTimeout(1200);
        break;
      }
    }

    const toggle = page.locator(
      'input[type="checkbox"][id*="paperless" i], ' +
      'input[type="checkbox"][name*="paperless" i], ' +
      'button[aria-label*="paperless" i], ' +
      '[role="switch"][aria-label*="paperless" i], ' +
      'label:has-text("Paperless") input'
    ).first();

    if (!(await toggle.isVisible().catch(() => false))) {
      console.warn(`[Water] No paperless toggle found for ${address}.`);
      await screenshot(page, 'water_no_paperless_toggle');
      return false;
    }

    const alreadyEnabled = await toggle.isChecked().catch(async () => {
      return (await toggle.getAttribute('aria-checked')) === 'true';
    });

    if (alreadyEnabled) {
      console.log(`[Water] Paperless already active for ${address}.`);
      return true;
    }

    await toggle.click();
    await randomDelay(800, 400);

    const saveBtn = page.locator('button:has-text("Save"), button:has-text("Confirm"), button:has-text("Update")').first();
    if (await saveBtn.isVisible().catch(() => false)) {
      await saveBtn.click();
      await page.waitForTimeout(1200);
    }

    console.log(`[Water] Paperless enabled for ${address}.`);
    return true;
  } catch (err) {
    console.error(`[Water] Error enabling paperless for ${address}:`, err);
    await screenshot(page, 'water_paperless_error');
    return false;
  }
}

/**
 * Retrieves bill amount, due date, and consumption units for the active water account.
 * AUDIT NOTE: Consumption unit type (HCF, CCF, gallons) must be confirmed during audit.
 * The threshold logic assumes quarterly HCF units per the Phase Plan.
 */
async function retrieveWaterBill(
  page: Page,
  address: string
): Promise<{ amount: number | null; dueDate: string | null; consumptionUnits: number | null }> {
  const result = { amount: null as number | null, dueDate: null as string | null, consumptionUnits: null as number | null };
  try {
    const billNavOptions = [
      'a:has-text("Current Bill")',
      'a:has-text("View Bill")',
      'a:has-text("Billing")',
      'a:has-text("Bill History")',
    ];
    for (const sel of billNavOptions) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        await el.click();
        await page.waitForTimeout(1500);
        break;
      }
    }

    // Amount
    const amountSelectors = [
      '.bill-amount', '.amount-due', '.balance', '.current-charges',
      '[data-testid*="amount"]', 'td:has-text("Amount Due")',
    ];
    for (const sel of amountSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        const text = await el.innerText();
        result.amount = parseDollarAmount(text);
        if (result.amount !== null) break;
      }
    }

    // Due date
    const dateSelectors = [
      '.due-date', '.payment-due', 'p:has-text("Due")',
      '[data-testid*="due"]', 'td:has-text("Due Date")',
    ];
    for (const sel of dateSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        const text = await el.innerText();
        result.dueDate = parseDate(text);
        if (result.dueDate !== null) break;
      }
    }

    // Consumption (HCF / CCF / gallons — depends on portal)
    // AUDIT NOTE: Confirm the unit label (HCF, CCF, gallons, units) during audit
    const consumptionSelectors = [
      '.consumption', '.usage', '.units-used',
      'td:has-text("HCF")', 'td:has-text("CCF")',
      'td:has-text("Consumption")', '[data-testid*="consumption"]',
    ];
    for (const sel of consumptionSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        const text = await el.innerText();
        const match = text.match(/([\d.]+)\s*(?:HCF|CCF|units|gallons)?/i);
        if (match) {
          result.consumptionUnits = parseFloat(match[1]);
          break;
        }
      }
    }

    console.log(
      `[Water] ${address} — Amount: $${result.amount ?? 'N/A'}, ` +
      `Due: ${result.dueDate ?? 'N/A'}, Consumption: ${result.consumptionUnits ?? 'N/A'} units`
    );
  } catch (err) {
    console.error(`[Water] Error retrieving bill for ${address}:`, err);
    await screenshot(page, 'water_bill_error');
  }
  return result;
}
