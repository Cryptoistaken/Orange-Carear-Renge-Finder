import { Database } from 'bun:sqlite';
import fs from 'fs';

export class DBHandler {
    constructor(dbPath = './database/global_monitor.db') {
        if (!fs.existsSync('./database')) {
            fs.mkdirSync('./database', { recursive: true });
        }
        this.db = new Database(dbPath);
    }

    initDB() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS ranges (
                name TEXT PRIMARY KEY,
                country TEXT,
                calls INTEGER DEFAULT 0,
                clis_count INTEGER DEFAULT 0,
                last_seen TEXT
            );
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_ranges_sort ON ranges (calls DESC, clis_count DESC);`);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS clis (
                range_name TEXT,
                cli TEXT,
                PRIMARY KEY (range_name, cli)
            );
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS calls_history (
                id TEXT PRIMARY KEY,
                created_at INTEGER
            );
        `);

        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_history_created_at ON calls_history (created_at);`);
    }

    cleanupOldData(retentionSeconds = 3600) {
        const now = Math.floor(Date.now() / 1000);
        const cutoff = now - retentionSeconds;

        const result = this.db.prepare('DELETE FROM calls_history WHERE created_at < ?').run(cutoff);
        if (result.changes > 0) {
            console.log(`[Cleanup] Removed ${result.changes} old records`);
        }
    }

    getTopRanges(limit = 10) {
        try {
            return this.db.query('SELECT name, country, calls, clis_count as clis, last_seen as lastSeen FROM ranges ORDER BY calls DESC, clis_count DESC LIMIT ?').all(limit);
        } catch (e) {
            return [];
        }
    }

    searchRanges(keyword, limit = 10) {
        try {
            return this.db.query('SELECT name, country, calls, clis_count as clis, last_seen as lastSeen FROM ranges WHERE name LIKE ? OR country LIKE ? ORDER BY calls DESC, clis_count DESC LIMIT ?').all(`%${keyword}%`, `%${keyword}%`, limit);
        } catch (e) {
            return [];
        }
    }

    processBatchTransaction(allFingerprints, fingerprintToRecordMap, rangeUpdates, clisToInsert, now) {
        try {
            this.db.exec('BEGIN TRANSACTION');

            const newFingerprints = new Set(allFingerprints);
            if (newFingerprints.size > 0) {
                const chunkSize = 999;
                const fingerprintsArr = Array.from(newFingerprints);
                for (let i = 0; i < fingerprintsArr.length; i += chunkSize) {
                    const chunk = fingerprintsArr.slice(i, i + chunkSize);
                    if (chunk.length === 0) continue;

                    const placeHolders = chunk.map(() => '?').join(',');
                    const stmt = this.db.query(`SELECT id FROM calls_history WHERE id IN (${placeHolders})`);
                    const rows = stmt.all(...chunk);

                    for (const row of rows) {
                        newFingerprints.delete(row.id);
                    }
                }
            }

            const historyValues = [];

            for (const fp of newFingerprints) {
                historyValues.push([fp, now]);

                const data = fingerprintToRecordMap.get(fp);
                if (data) {
                    const { rec, country } = data;

                    if (!rangeUpdates.has(rec.range)) {
                        rangeUpdates.set(rec.range, {
                            name: rec.range,
                            country: country,
                            calls: 0,
                            newClis: 0,
                            lastSeen: rec.timeStr
                        });
                    }
                    const update = rangeUpdates.get(rec.range);
                    update.calls++;
                }
            }

            if (historyValues.length > 0) {
                const insertHistStmt = this.db.prepare('INSERT OR IGNORE INTO calls_history (id, created_at) VALUES (?, ?)');
                for (const [id, created_at] of historyValues) {
                    insertHistStmt.run(id, created_at);
                }
            }

            if (clisToInsert.length > 0) {
                const insertCliStmt = this.db.prepare('INSERT OR IGNORE INTO clis (range_name, cli) VALUES (?, ?)');
                for (const [range_name, cli] of clisToInsert) {
                    insertCliStmt.run(range_name, cli);
                }
            }

            if (rangeUpdates.size > 0) {
                const updates = Array.from(rangeUpdates.values());
                for (const u of updates) {
                    const existing = this.db.query('SELECT calls FROM ranges WHERE name = ?').get(u.name);

                    if (existing) {
                        this.db.prepare('UPDATE ranges SET calls = calls + ?, last_seen = ? WHERE name = ?')
                            .run(u.calls, u.lastSeen, u.name);
                    } else {
                        this.db.prepare('INSERT INTO ranges (name, country, calls, clis_count, last_seen) VALUES (?, ?, ?, 0, ?)')
                            .run(u.name, u.country, u.calls, u.lastSeen);
                    }
                }

                const rangeNames = updates.map(u => u.name);
                for (const rangeName of rangeNames) {
                    const cliCount = this.db.query('SELECT COUNT(*) as cnt FROM clis WHERE range_name = ?').get(rangeName);
                    this.db.prepare('UPDATE ranges SET clis_count = ? WHERE name = ?').run(cliCount.cnt, rangeName);
                }
            }

            this.db.exec('COMMIT');
        } catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
    }
}

// Export a singleton instance for other modules
export const dbHandler = new DBHandler();
