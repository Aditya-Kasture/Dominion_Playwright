/**
 * PostgreSQL/Supabase helpers.
 * Install: npm i pg @types/pg
 */
import { Pool, PoolClient } from 'pg';

export interface BGEAccount {
  bge_account_number: string;
  property_address: string;
  property_id: number;
  property_name: string;
  lifecycle_stage: string;
  street1: string;
  city: string;
  state: string;
  zip: string;
}

export interface WaterAccount {
  unit_id: number;
  appfolio_unit_id: string;
  unit_name: string;
  property_id: number;
  property_name: string;
  street1: string;
  city: string;
  state: string;
  zip: string;
  lifecycle_stage: string;
  consumption_baseline: number | null;
  baseline_period: string | null;
}

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT ?? 5432),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

export async function fetchBGEAccounts(): Promise<BGEAccount[]> {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<BGEAccount>(`
      SELECT
        bap.bge_account_number,
        bap.property_address,
        p.id            AS property_id,
        p.name          AS property_name,
        p.lifecycle_stage,
        p.street1, p.city, p.state, p.zip
      FROM bge_account_property_map bap
      JOIN property p ON bap.property_id = p.id
      WHERE p.lifecycle_stage = 'vacant'
        AND p.is_active = TRUE
      ORDER BY p.name
    `);
    return rows;
  } finally {
    client.release();
  }
}

export async function fetchWaterAccounts(): Promise<WaterAccount[]> {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<WaterAccount>(`
      SELECT
        u.id                AS unit_id,
        u.appfolio_unit_id,
        u.unit_name,
        p.id                AS property_id,
        p.name              AS property_name,
        p.street1, p.city, p.state, p.zip,
        p.lifecycle_stage,
        ucb.baseline_amount AS consumption_baseline,
        ucb.period_unit     AS baseline_period
      FROM unit u
      JOIN property p ON u.property_id = p.id
      JOIN unit_utility_responsibility uur
        ON uur.unit_id = u.id
        AND uur.utility_type = 'water'
        AND uur.responsibility IN ('landlord', 'dp')
      LEFT JOIN unit_consumption_baseline ucb
        ON ucb.unit_id = u.id
        AND ucb.utility_type = 'water'
        AND ucb.period_unit = 'quarterly'
      WHERE p.lifecycle_stage IN ('occupied', 'renovation', 'flip')
        AND p.is_active = TRUE
      ORDER BY p.name, u.unit_name
    `);
    return rows;
  } finally {
    client.release();
  }
}

export async function logBGERun(params: {
  bge_account_number: string;
  property_id: number;
  action: string;
  status: string;
  bill_amount?: number | null;
  due_date?: string | null;
  notes?: string | null;
}): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query(
      `INSERT INTO bge_portal_audit_log
         (bge_account_number, property_id, action, status, bill_amount, due_date, notes, run_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT DO NOTHING`,
      [
        params.bge_account_number, params.property_id, params.action, params.status,
        params.bill_amount ?? null, params.due_date ?? null, params.notes ?? null,
      ]
    );
  } finally {
    client.release();
  }
}

export async function logWaterRun(params: {
  unit_id: number;
  property_id: number;
  action: string;
  status: string;
  bill_amount?: number | null;
  consumption_units?: number | null;
  due_date?: string | null;
  threshold_action?: string | null;
  notes?: string | null;
}): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query(
      `INSERT INTO water_portal_audit_log
         (unit_id, property_id, action, status, bill_amount,
          consumption_units, due_date, threshold_action, notes, run_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT DO NOTHING`,
      [
        params.unit_id, params.property_id, params.action, params.status,
        params.bill_amount ?? null, params.consumption_units ?? null,
        params.due_date ?? null, params.threshold_action ?? null, params.notes ?? null,
      ]
    );
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = null;
}
