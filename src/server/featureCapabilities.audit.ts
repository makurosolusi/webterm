// Jejak keputusan pengguna (grant/revoke/ubah) tanpa secret, bertahan lintas restart.
// Bentuk `AuditDb` struktural supaya modul ini tidak mengimpor bun:sqlite saat dimuat vitest (node).

/** Batas baris tersimpan; terlama dibuang saat menulis. */
export const AUDIT_MAX_ROWS = 1000
/** `detail` dipotong supaya satu baris tak membengkak. */
const DETAIL_MAX_CHARS = 200

export type AuditAction = 'grant' | 'revoke' | 'sub' | 'advanced' | 'denied' | 'reset' | 'download'

export interface AuditEntry {
  /** Id katalog atau 'advanced'. */
  capability: string
  action: AuditAction
  peer: 'loopback' | 'remote'
  via: 'ui' | 'token' | 'rejected'
  /** Nama kunci / alasan generik saja, tak pernah nilai. */
  detail?: string
}

/** Bagian `bun:sqlite` Database yang dipakai audit. */
export interface AuditDb {
  exec(sql: string): unknown
  query(sql: string): { run(...params: Array<string | number | null>): unknown }
}

/** Buat tabel audit bila belum ada (idempoten; Rule 4). */
export function ensureAuditSchema(db: AuditDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS capability_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    capability TEXT NOT NULL,
    action TEXT NOT NULL,
    peer TEXT NOT NULL,
    via TEXT NOT NULL,
    detail TEXT
  );
  CREATE INDEX IF NOT EXISTS capability_audit_at ON capability_audit(at);`)
}

/** Tulis satu baris audit lalu pangkas ke `AUDIT_MAX_ROWS` terbaru. */
export function recordAudit(db: AuditDb, entry: AuditEntry, now: number = Date.now()): void {
  const detail = entry.detail === undefined ? null : entry.detail.slice(0, DETAIL_MAX_CHARS)
  db.query('INSERT INTO capability_audit (at, capability, action, peer, via, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .run(now, entry.capability, entry.action, entry.peer, entry.via, detail)
  db.query('DELETE FROM capability_audit WHERE id NOT IN (SELECT id FROM capability_audit ORDER BY id DESC LIMIT ?)')
    .run(AUDIT_MAX_ROWS)
}
