import type Database from 'better-sqlite3';

interface PragmaColumn {
  name: string;
  pk: number;
}

// Module-level cache: schema is static after syncSchema runs at startup
const pkCache = new Map<string, Set<string>>();

function getPrimaryKeys(db: Database.Database, table: string): Set<string> {
  let cached = pkCache.get(table);
  if (cached) return cached;
  const columns = db.prepare(`PRAGMA table_info('${table}')`).all() as PragmaColumn[];
  cached = new Set(columns.filter((c) => c.pk > 0).map((c) => c.name));
  if (cached.size === 0) {
    throw new Error(`No primary key found on table "${table}"`);
  }
  pkCache.set(table, cached);
  return cached;
}

/** JSON.stringify arrays and plain objects; coerce booleans to 0/1; primitives pass through. */
export function autoStringify(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'boolean') {
      out[k] = v ? 1 : 0;
    } else if (Array.isArray(v) || (v !== null && typeof v === 'object' && v!.constructor === Object)) {
      out[k] = JSON.stringify(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Upsert a row: auto-stringify objects/arrays, build conflict update from non-PK columns.
 * Row keys must match SQL column names (snake_case).
 */
export function upsertRow(
  db: Database.Database,
  table: string,
  row: Record<string, unknown>,
  updateColumns?: string[],
): void {
  const stringified = autoStringify(row);
  const pkNames = getPrimaryKeys(db, table);
  const colNames = Object.keys(stringified);
  const values = Object.values(stringified);
  const placeholders = colNames.map(() => '?').join(', ');

  // Build SET clause: either explicit updateColumns or all non-PK columns present in row
  const updateCols = updateColumns
    ? updateColumns.filter((c) => c in stringified)
    : colNames.filter((c) => !pkNames.has(c));
  const setClause = updateCols.map((c) => `${c} = excluded.${c}`).join(', ');
  const pkList = [...pkNames].join(', ');

  const sql = setClause
    ? `INSERT INTO ${table} (${colNames.join(', ')}) VALUES (${placeholders}) ON CONFLICT (${pkList}) DO UPDATE SET ${setClause}`
    : `INSERT INTO ${table} (${colNames.join(', ')}) VALUES (${placeholders}) ON CONFLICT (${pkList}) DO NOTHING`;

  db.prepare(sql).run(...values);
}
