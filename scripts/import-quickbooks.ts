/**
 * QuickBooks Company File CSV mapper.
 *
 * Usage:
 *   npx tsx scripts/import-quickbooks.ts --file export.csv [--output mapped.csv]
 *
 * What it does:
 *   1. Reads a QuickBooks CSV export (any version — IIF / Company File / Transaction List)
 *   2. Auto-detects QB column names and maps them to Dominion's internal schema
 *   3. Prints a field-mapping report for Jack to confirm
 *   4. Optionally writes a normalized CSV to --output for downstream processing
 *
 * QuickBooks exports vary by version. Supported QB column aliases are listed in
 * FIELD_MAP below. If a field shows "✗ NOT FOUND" in the report, identify the
 * correct QB column name and add it to the alias list.
 *
 * Exit codes: 0 = success, 1 = fatal error
 */

import fs from 'fs';
import path from 'path';
import { createInterface } from 'readline';
import * as dotenv from 'dotenv';

dotenv.config();

// ─── CLI args ────────────────────────────────────────────────────────────────

const fileIdx  = process.argv.indexOf('--file');
const outIdx   = process.argv.indexOf('--output');
const fileArg  = process.argv.find(a => a.startsWith('--file='))?.slice(7)
  ?? (fileIdx !== -1 ? process.argv[fileIdx + 1] : undefined);
const outputArg = process.argv.find(a => a.startsWith('--output='))?.slice(9)
  ?? (outIdx !== -1 ? process.argv[outIdx + 1] : undefined);

if (!fileArg) {
  console.error('Usage: npx tsx scripts/import-quickbooks.ts --file <export.csv> [--output <mapped.csv>]');
  process.exit(1);
}

const csvPath = path.resolve(fileArg);
if (!fs.existsSync(csvPath)) {
  console.error(`File not found: ${csvPath}`);
  process.exit(1);
}

// ─── Field map: internal schema → QB column aliases (priority order) ─────────

const FIELD_MAP: Record<string, string[]> = {
  transaction_date: [
    'date', 'txn date', 'transaction date', 'posting date', 'invoice date', 'bill date',
  ],
  ref_number: [
    'num', 'ref no', 'ref #', 'reference no', 'reference #', 'check no', 'check #',
    'invoice no', 'invoice #', 'transaction #', 'trans no',
  ],
  description: [
    'description', 'memo', 'name', 'payee', 'vendor', 'customer', 'item description',
    'narration', 'particulars',
  ],
  account: [
    'account', 'account name', 'gl account', 'general ledger', 'chart of accounts',
    'expense account', 'income account', 'balance sheet account',
  ],
  amount: [
    'amount', 'debit', 'credit', 'total', 'net amount', 'balance', 'original amount',
    'foreign amount',
  ],
  transaction_type: [
    'type', 'transaction type', 'txn type', 'document type', 'entry type',
  ],
  property_address: [
    'class', 'location', 'job', 'customer:job', 'project', 'property', 'site',
    'department', 'division',
  ],
  utility_vendor: [
    'vendor', 'supplier', 'payee', 'paid to', 'billed by',
  ],
};

// ─── Types ───────────────────────────────────────────────────────────────────

interface QBRow {
  transaction_date: string;
  ref_number: string;
  description: string;
  account: string;
  amount: string;
  transaction_type: string;
  property_address: string;
  utility_vendor: string;
  _raw: Record<string, string>;
}

// ─── CSV helpers ─────────────────────────────────────────────────────────────

function splitLine(line: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

function norm(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function detectMapping(headers: string[]): Record<string, string | null> {
  const normHeaders = headers.map(norm);
  const detected: Record<string, string | null> = {};

  for (const [field, candidates] of Object.entries(FIELD_MAP)) {
    detected[field] = null;
    for (const candidate of candidates) {
      // Exact match first
      const idx = normHeaders.indexOf(norm(candidate));
      if (idx !== -1) { detected[field] = headers[idx]; break; }
    }
    if (!detected[field]) {
      // Partial match fallback
      for (const candidate of candidates) {
        const idx = normHeaders.findIndex(h => h.includes(norm(candidate)));
        if (idx !== -1) { detected[field] = headers[idx]; break; }
      }
    }
  }

  return detected;
}

// ─── Parser ───────────────────────────────────────────────────────────────────

async function parseCsv(filePath: string): Promise<{
  headers: string[];
  rows: QBRow[];
  mapping: Record<string, string | null>;
  skippedLines: number;
}> {
  const rl = createInterface({ input: fs.createReadStream(filePath) });
  let headers: string[] = [];
  let mapping: Record<string, string | null> = {};
  const rawRows: Record<string, string>[] = [];
  let lineNum = 0;
  let skippedLines = 0;

  for await (const line of rl) {
    if (!line.trim()) { skippedLines++; continue; }

    // QB IIF files start with !TRNS / TRNS / ENDTRNS — skip these markers
    if (line.startsWith('!') || line === 'ENDTRNS') { skippedLines++; continue; }

    lineNum++;
    const values = splitLine(line);

    if (lineNum === 1) {
      headers = values;
      mapping = detectMapping(headers);
      continue;
    }

    // Skip QB total/summary rows (first cell often blank or "TOTAL")
    if (!values[0] || values[0].toUpperCase().startsWith('TOTAL')) { skippedLines++; continue; }

    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ''; });
    rawRows.push(row);
  }

  const rows: QBRow[] = rawRows.map(raw => ({
    transaction_date: raw[mapping.transaction_date ?? ''] ?? '',
    ref_number:       raw[mapping.ref_number ?? ''] ?? '',
    description:      raw[mapping.description ?? ''] ?? '',
    account:          raw[mapping.account ?? ''] ?? '',
    amount:           raw[mapping.amount ?? ''] ?? '',
    transaction_type: raw[mapping.transaction_type ?? ''] ?? '',
    property_address: raw[mapping.property_address ?? ''] ?? '',
    utility_vendor:   raw[mapping.utility_vendor ?? ''] ?? '',
    _raw: raw,
  }));

  return { headers, rows, mapping, skippedLines };
}

// ─── Report ───────────────────────────────────────────────────────────────────

function printReport(
  headers: string[],
  mapping: Record<string, string | null>,
  rows: QBRow[],
  skippedLines: number
) {
  console.log('─── QuickBooks CSV Field Mapping Report ────────────────────────────────\n');
  console.log(`  Source file:   ${csvPath}`);
  console.log(`  Total rows:    ${rows.length}`);
  console.log(`  Skipped lines: ${skippedLines}  (blanks, totals, IIF markers)\n`);

  const mapped   = Object.entries(mapping).filter(([, v]) => v !== null);
  const unmapped = Object.entries(mapping).filter(([, v]) => v === null);

  console.log('  Dominion field          QB source column');
  console.log('  ' + '─'.repeat(56));
  for (const [field, src] of mapped) {
    console.log(`  ✓  ${field.padEnd(22)} ← "${src}"`);
  }
  for (const [field] of unmapped) {
    console.log(`  ✗  ${field.padEnd(22)} ← (NOT FOUND — see note below)`);
  }

  const extraHeaders = headers.filter(h => !Object.values(mapping).includes(h));
  if (extraHeaders.length > 0) {
    console.log(`\n  Unused QB columns (${extraHeaders.length}):`);
    extraHeaders.forEach(h => console.log(`     · ${h}`));
  }

  if (rows.length > 0) {
    const sample = rows.slice(0, 5);
    console.log('\n  Sample rows (first 5):\n');
    console.log('  Date           Ref        Description                   Amount       Property');
    console.log('  ' + '─'.repeat(85));
    for (const r of sample) {
      const d = r.transaction_date.padEnd(14);
      const ref = r.ref_number.substring(0, 9).padEnd(10);
      const desc = r.description.substring(0, 28).padEnd(28);
      const amt = r.amount.padEnd(12);
      const prop = r.property_address.substring(0, 20);
      console.log(`  ${d} ${ref} ${desc} ${amt} ${prop}`);
    }
  }

  if (unmapped.length > 0) {
    console.log(`\n  ⚠  ${unmapped.length} field(s) could not be auto-mapped:`);
    for (const [field] of unmapped) {
      console.log(`     · ${field}`);
      console.log(`       Expected QB column names: ${FIELD_MAP[field].slice(0, 4).join(', ')}, ...`);
    }
    console.log('\n  → Send Jack this report. Ask him to identify which QB column');
    console.log('    corresponds to each unmapped field, then re-run.');
  } else {
    console.log('\n  ✓  All fields mapped. Review sample rows, then run with --output to export.');
  }
}

// ─── CSV writer ───────────────────────────────────────────────────────────────

function writeMappedCsv(outputPath: string, rows: QBRow[]) {
  const fields: (keyof QBRow)[] = [
    'transaction_date', 'ref_number', 'description', 'account',
    'amount', 'transaction_type', 'property_address', 'utility_vendor',
  ];
  const escape = (v: string) => (v.includes(',') || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [fields.join(',')];
  for (const row of rows) {
    lines.push(fields.map(f => escape(row[f] as string ?? '')).join(','));
  }
  fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');
  console.log(`\n  Normalized CSV → ${outputPath}`);
  console.log('  Share with Abdul for DB import once Jack confirms the field mapping.\n');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  const { headers, rows, mapping, skippedLines } = await parseCsv(csvPath);
  printReport(headers, mapping, rows, skippedLines);

  if (outputArg) {
    writeMappedCsv(path.resolve(outputArg), rows);
  } else if (rows.length > 0) {
    const missing = Object.entries(mapping).filter(([, v]) => v === null);
    if (missing.length === 0) {
      console.log('\n  Ready to export. Re-run with --output mapped.csv to write the normalized file.');
    }
  }
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
