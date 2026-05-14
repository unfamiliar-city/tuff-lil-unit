import type Database from 'better-sqlite3';

interface ColumnInfo {
  name: string;
}

/**
 * Sync schema to DB — creates new tables via IF NOT EXISTS, adds new columns
 * via PRAGMA table_info diffing + ALTER TABLE ADD COLUMN.
 */
export function syncSchema(db: Database.Database, statements: string[]): void {
  for (const sql of statements) {
    db.exec(sql);

    // After CREATE TABLE IF NOT EXISTS, diff columns for additive migrations
    const match = sql.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/i);
    if (!match) continue;
    const tableName = match[1]!;

    const existingCols = new Set(
      (db.prepare(`PRAGMA table_info('${tableName}')`).all() as ColumnInfo[])
        .map((c) => c.name),
    );

    // Parse column definitions — strip table constraints before splitting on commas
    const bodyMatch = sql.match(/\(([^]*)\)/);
    if (!bodyMatch) continue;

    // Remove PRIMARY KEY(...) and similar table constraints before comma-splitting
    const body = bodyMatch[1]!.replace(/,?\s*PRIMARY\s+KEY\s*\([^)]*\)/gi, '');

    for (const line of body.split(',')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const colName = trimmed.split(/\s+/)[0]!;
      if (!existingCols.has(colName)) {
        db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${trimmed}`);
      }
    }
  }
}
