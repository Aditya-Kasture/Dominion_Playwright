/**
 * BGE Portal Automation
 * ─────────────────────
 * Modes (set BGE_MODE env var):
 *   audit      — Navigate & screenshot key pages only, no writes
 *   paperless  — Enable paperless billing for every account
 *   bills      — Retrieve bill amount + due date for every account
 *   full       — All of the above (default)
 *
 * Run:
 *   BGE_MODE=full npx playwright test tests/bge.spec.ts --project=chromium
 *
 * AUDIT NOTE: Selectors throughout are best-guess from common BGE portal patterns.
 * Run in audit mode first (HEADLESS=false) to discover actual selectors, then update.
 */

import { test, expect, Page, BrowserContext } from '@playwright/test';
import * as dotenv from 'dotenv';
import { fetchBGEAccounts, logBGERun, closePool, BGEAccount, validateEnv } from './helpers/db';
import { fetchBGEOtp } from './helpers/emailOTP';
import { hideAutomationSignals, randomDelay, parseDollarAmount, parseDate, screenshot, getRandomUserAgent, detectBotBlock } from './helpers/utils';

dotenv.config();

// ─── Config ───────────────────────────────────────────────────────────────────
const VALID_MODES = ['audit', 'paperless', 'bills', 'full'] as const;
type Mode = typeof VALID_MODES[number];
const rawMode = process.env.BGE_MODE ?? 'full';
if (!VALID_MODES.includes(rawMode as Mode)) throw new Error(`Invalid BGE_MODE: "${rawMode}". Must be: ${VALID_MODES.join(', ')}`);
const MODE = rawMode as Mode;
const LOGIN_URL = process.env.BGE_LOGIN_URL ?? 'https://myaccount.bge.com/sign-in';
const BGE_EMAIL = process.env.BGE_EMAIL ?? '';
const BGE_PASSWORD = process.env.BGE_PASSWORD ?? '';
const IMAP_HOST = process.env.IMAP_HOST ?? 'imap.gmail.com';
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 993);
const IMAP_EMAIL = process.env.IMAP_EMAIL ?? BGE_EMAIL;
const IMAP_PASSWORD = process.env.IMAP_PASSWORD ?? '';

let context: BrowserContext;
let page: Page;
let accounts: BGEAccount[] = [];
let loginSucceeded = false;

// ─── Setup ────────────────────────────────────────────────────────────────────

test.beforeAll(async ({ browser }) => {
  validateEnv(['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'BGE_EMAIL', 'BGE_PASSWORD', 'IMAP_HOST', 'IMAP_EMAIL', 'IMAP_PASSWORD']);
  context = await browser.newContext({
    userAgent: getRandomUserAgent(),
    viewport: { width: 1280, height: 800 },
  });
  page = await context.newPage();
  await hideAutomationSignals(page);

  accounts = await fetchBGEAccounts();
  console.log(`[BGE] Loaded ${accounts.length} accounts from DB.`);
});

test.afterAll(async () => {
  await context?.close();
  await closePool();
});

// ─── Test 1: Login ────────────────────────────────────────────────────────────

test('BGE Login (email + password + OTP)', async () => {
  console.log(`[BGE] Navigating to login: ${LOGIN_URL}`);
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });

  // ── Step 1: Enter email ────────────────────────────────────────────────────
  // AUDIT NOTE: Adjust selector if BGE uses a different field id/name
  const emailField = page.locator('input[type="email"], input[name="email"], #email').first();
  await emailField.waitFor({ timeout: 10_000 });
  await emailField.fill(BGE_EMAIL);
  await randomDelay(600, 400);

  const nextBtn = page.locator('button:has-text("Next"), button:has-text("Continue"), button[type="submit"]').first();
  await nextBtn.click();
  await page.waitForTimeout(1500);

  // ── Step 2: Enter password ─────────────────────────────────────────────────
  const passwordField = page.locator('input[type="password"]').first();
  await passwordField.waitFor({ timeout: 10_000 });
  await passwordField.fill(BGE_PASSWORD);
  await randomDelay(800, 600);

  const signInBtn = page.locator('button:has-text("Sign In"), button:has-text("Log In"), button[type="submit"]').first();
  await signInBtn.click();
  await page.waitForTimeout(2500);

  // ── Step 3: OTP (may or may not appear) ───────────────────────────────────
  const otpField = page.locator(
    'input[name="otp"], input[placeholder*="code" i], input[aria-label*="code" i], input[id*="otp" i]'
  ).first();
  const otpVisible = await otpField.isVisible().catch(() => false);

  if (otpVisible) {
    console.log('[BGE] OTP field detected — fetching code from email...');
    const otp = await fetchBGEOtp({
      host: IMAP_HOST,
      port: IMAP_PORT,
      email: IMAP_EMAIL,
      password: IMAP_PASSWORD,
      senderFilter: 'noreply@bge.com',
      maxWaitMs: 120_000,
      pollIntervalMs: 5_000,
    });

    if (!otp) {
      await screenshot(page, 'bge_otp_timeout');
      throw new Error('BGE OTP not received within 2 minutes.');
    }

    await otpField.fill(otp);
    await randomDelay(500, 300);
    await page.locator('button:has-text("Verify"), button:has-text("Confirm"), button[type="submit"]').first().click();
    await page.waitForTimeout(2500);
  }

  // ── Verify login success ───────────────────────────────────────────────────
  await screenshot(page, 'bge_post_login');
  const url = page.url();
  const stillOnLogin = url.includes('sign-in') || url.includes('login');
  if (stillOnLogin) {
    await screenshot(page, 'bge_login_failed');
    throw new Error(`BGE login failed — still on login page: ${url}`);
  }

  loginSucceeded = true;
  console.log('[BGE] Login successful.');

  if (MODE === 'audit') {
    console.log('[BGE] AUDIT MODE — capturing homepage screenshot. No further actions.');
    await screenshot(page, 'bge_audit_home');
    const botRisk = await detectBotBlock(page);
    if (botRisk.signals.length > 0) {
      console.warn('[BGE] Bot/CAPTCHA risk signals detected:', botRisk.signals);
      await screenshot(page, 'bge_audit_bot_risk');
    } else {
      console.log('[BGE] No bot detection signals observed.');
    }
  }
});

// ─── Test 2: Paperless Enrollment ─────────────────────────────────────────────

test('BGE Paperless Enrollment (all accounts)', async () => {
  if (!loginSucceeded) { test.skip(true, 'Login did not succeed.'); return; }
  if (MODE === 'audit' || MODE === 'bills') {
    test.skip(true, `Mode is ${MODE} — skipping paperless enrollment.`);
    return;
  }

  console.log(`[BGE] Starting paperless enrollment for ${accounts.length} accounts.`);

  for (const account of accounts) {
    const { bge_account_number: acctNum, property_id: propId, property_name: propName } = account;
    console.log(`[BGE] Processing paperless for ${acctNum} (${propName})`);

    const found = await navigateToAccount(page, acctNum);
    if (!found) {
      try { await logBGERun({ bge_account_number: acctNum, property_id: propId, action: 'navigate', status: 'FAILED', notes: 'Account not found in portal' }); } catch (e) { console.error(`[BGE] Log failed for ${acctNum}:`, e); }
      continue;
    }

    const ok = await enablePaperless(page, acctNum);
    try {
      await logBGERun({
        bge_account_number: acctNum,
        property_id: propId,
        action: 'paperless_enrollment',
        status: ok ? 'SUCCESS' : 'FAILED',
      });
    } catch (e) { console.error(`[BGE] Log failed for ${acctNum}:`, e); }

    await randomDelay(2000, 1000);
  }
});

// ─── Test 3: Bill Retrieval ───────────────────────────────────────────────────

test('BGE Bill Retrieval (all accounts)', async () => {
  if (!loginSucceeded) { test.skip(true, 'Login did not succeed.'); return; }
  if (MODE === 'audit' || MODE === 'paperless') {
    test.skip(true, `Mode is ${MODE} — skipping bill retrieval.`);
    return;
  }

  console.log(`[BGE] Starting bill retrieval for ${accounts.length} accounts.`);

  for (const account of accounts) {
    const { bge_account_number: acctNum, property_id: propId, property_name: propName } = account;
    console.log(`[BGE] Retrieving bill for ${acctNum} (${propName})`);

    const found = await navigateToAccount(page, acctNum);
    if (!found) {
      try { await logBGERun({ bge_account_number: acctNum, property_id: propId, action: 'navigate', status: 'FAILED', notes: 'Account not found in portal' }); } catch (e) { console.error(`[BGE] Log failed for ${acctNum}:`, e); }
      continue;
    }

    const bill = await retrieveBill(page, acctNum);
    try {
      await logBGERun({
        bge_account_number: acctNum,
        property_id: propId,
        action: 'bill_retrieval',
        status: bill.amount !== null ? 'SUCCESS' : 'PARTIAL',
        bill_amount: bill.amount,
        due_date: bill.dueDate,
      });
    } catch (e) { console.error(`[BGE] Log failed for ${acctNum}:`, e); }

    await randomDelay(2000, 1000);
  }
});

// ─── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Navigates to a specific BGE account.
 * AUDIT NOTE: BGE may use a dropdown, sidebar list, or account switcher.
 * Confirm the correct selector during the portal audit and update below.
 */
async function navigateToAccount(page: Page, accountNumber: string): Promise<boolean> {
  try {
    // Strategy 1: Account switcher dropdown
    // AUDIT NOTE: Look for a "Select Account" or account dropdown near the top of the page
    const dropdown = page.locator('select[name*="account" i], [data-testid*="account-select"]').first();
    if (await dropdown.isVisible().catch(() => false)) {
      await dropdown.selectOption({ label: accountNumber });
      await page.waitForTimeout(1500);
      return true;
    }

    // Strategy 2: Click a link that contains the account number
    const link = page.locator(`a:has-text("${accountNumber}"), [data-account="${accountNumber}"]`).first();
    if (await link.isVisible().catch(() => false)) {
      await link.click();
      await page.waitForTimeout(1500);
      return true;
    }

    // Strategy 3: Search through account list rows/cards
    // AUDIT NOTE: Update selector to match the actual account list container
    const rows = await page.locator('table tr, .account-list-item, .account-card').all();
    for (const row of rows) {
      const text = await row.innerText().catch(() => '');
      if (text.includes(accountNumber)) {
        await row.click();
        await page.waitForTimeout(1500);
        return true;
      }
    }

    console.warn(`[BGE] Account ${accountNumber} not found in any list.`);
    await screenshot(page, `bge_account_not_found_${accountNumber}`);
    return false;
  } catch (err) {
    console.error(`[BGE] Error navigating to account ${accountNumber}:`, err);
    return false;
  }
}

/**
 * Enables paperless billing for the currently visible account.
 * AUDIT NOTE: Navigation path and toggle selector must be confirmed during audit.
 * Common paths: Account Settings > Billing Preferences, or My Profile > Notifications.
 */
async function enablePaperless(page: Page, accountNumber: string): Promise<boolean> {
  try {
    // Navigate to billing preferences section
    // AUDIT NOTE: Try each nav link until one lands on the paperless settings page
    const navOptions = [
      'a:has-text("Billing Preferences")',
      'a:has-text("Paperless Billing")',
      'a:has-text("Settings")',
      'a:has-text("My Profile")',
    ];
    for (const sel of navOptions) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        await el.click();
        await page.waitForTimeout(1200);
        break;
      }
    }

    // Find the paperless toggle
    // AUDIT NOTE: Could be a checkbox, a toggle switch button, or a radio button
    const toggleSel =
      'input[type="checkbox"][id*="paperless" i], ' +
      'input[type="checkbox"][name*="paperless" i], ' +
      'button[aria-label*="paperless" i], ' +
      '[role="switch"][aria-label*="paperless" i]';
    const toggle = page.locator(toggleSel).first();

    if (!(await toggle.isVisible().catch(() => false))) {
      console.warn(`[BGE] No paperless toggle found for ${accountNumber}.`);
      await screenshot(page, `bge_no_paperless_toggle_${accountNumber}`);
      return false;
    }

    // Check current state
    const tagName = await toggle.evaluate(el => el.tagName.toLowerCase());
    const isCheckbox = tagName === 'input';
    const alreadyEnabled = isCheckbox
      ? await toggle.isChecked()
      : (await toggle.getAttribute('aria-checked')) === 'true';

    if (alreadyEnabled) {
      console.log(`[BGE] Paperless already enabled for ${accountNumber}.`);
      return true;
    }

    await toggle.click();
    await randomDelay(800, 400);

    // Confirm any dialog
    const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("Save"), button:has-text("Enroll")').first();
    if (await confirmBtn.isVisible().catch(() => false)) {
      await confirmBtn.click();
      await page.waitForTimeout(1500);
    }

    // Look for success indicator
    const successEl = page.locator('.alert-success, [role="alert"]:has-text("paperless"), .success-message').first();
    const confirmed = await successEl.isVisible({ timeout: 5000 }).catch(() => false);

    if (!confirmed) {
      console.warn(`[BGE] Paperless save confirmation not visible for ${accountNumber}.`);
      await screenshot(page, `bge_paperless_unconfirmed_${accountNumber}`);
    } else {
      console.log(`[BGE] Paperless enabled for ${accountNumber}.`);
    }
    return confirmed;
  } catch (err) {
    console.error(`[BGE] Error enabling paperless for ${accountNumber}:`, err);
    await screenshot(page, `bge_paperless_error_${accountNumber}`);
    return false;
  }
}

/**
 * Retrieves the current bill amount and due date for the active account.
 * AUDIT NOTE: Confirm navigation path and data selectors during portal audit.
 */
async function retrieveBill(page: Page, accountNumber: string): Promise<{ amount: number | null; dueDate: string | null }> {
  const result = { amount: null as number | null, dueDate: null as string | null };
  try {
    // Navigate to billing
    const billNavOptions = [
      'a:has-text("View Bill")',
      'a:has-text("Current Bill")',
      'a:has-text("Billing")',
      'nav a:has-text("Bill")',
    ];
    for (const sel of billNavOptions) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        await el.click();
        await page.waitForTimeout(1500);
        break;
      }
    }

    // Extract amount
    // AUDIT NOTE: Common selectors across BGE portal versions — pick the one that matches
    const amountSelectors = [
      '.bill-amount', '.current-amount', '.amount-due',
      '[data-testid="bill-amount"]', '.balance-due', '.current-balance',
    ];
    for (const sel of amountSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        const text = await el.innerText();
        result.amount = parseDollarAmount(text);
        if (result.amount !== null) break;
      }
    }

    // Extract due date
    const dateSelectors = [
      '.due-date', '.payment-due', '[data-testid="due-date"]',
      'p:has-text("Due")', 'span:has-text("due" i)', 'td:has-text("due" i)',
    ];
    for (const sel of dateSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        const text = await el.innerText();
        result.dueDate = parseDate(text);
        if (result.dueDate !== null) break;
      }
    }

    console.log(`[BGE] ${accountNumber} — Amount: $${result.amount ?? 'N/A'}, Due: ${result.dueDate ?? 'N/A'}`);
  } catch (err) {
    console.error(`[BGE] Error retrieving bill for ${accountNumber}:`, err);
    await screenshot(page, `bge_bill_error_${accountNumber}`);
  }
  return result;
}
