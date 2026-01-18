import { Database } from 'bun:sqlite';
import fs from 'fs';

export class DBHandler {
    constructor(dbPath = './database/global_monitor.db') {
        if (!fs.existsSync('./database')) {
            fs.mkdirSync('./database', { recursive: true });
        }
        this.db = new Database(dbPath);
    }

    wipeDB() {
        try {
            this.db.exec('DROP TABLE IF EXISTS ranges');
            this.db.exec('DROP TABLE IF EXISTS clis');
            this.db.exec('DROP TABLE IF EXISTS calls_history');
            console.log('[DB] Database wiped');
        } catch (e) {
            console.error('[DB] Wipe error:', e.message);
        }
    }

    initDB() {
        try {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS ranges (
                    name TEXT PRIMARY KEY,
                    country TEXT,
                    calls INTEGER DEFAULT 0,
                    clis_count INTEGER DEFAULT 0,
                    last_seen_timestamp INTEGER
                );
            `);

            try {
                this.db.exec('ALTER TABLE ranges ADD COLUMN last_seen_timestamp INTEGER;');
            } catch (e) {
            }

            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_ranges_sort ON ranges (calls DESC, clis_count DESC);`);

            this.db.exec(`
                CREATE TABLE IF NOT EXISTS clis (
                    range_name TEXT,
                    cli TEXT,
                    call_count INTEGER DEFAULT 0,
                    last_seen INTEGER DEFAULT 0,
                    PRIMARY KEY (range_name, cli)
                );
            `);

            try {
                this.db.exec('ALTER TABLE clis ADD COLUMN call_count INTEGER DEFAULT 0;');
            } catch (e) { }
            try {
                this.db.exec('ALTER TABLE clis ADD COLUMN last_seen INTEGER DEFAULT 0;');
            } catch (e) { }

            this.db.exec(`
                CREATE TABLE IF NOT EXISTS calls_history(
                id TEXT PRIMARY KEY,
                created_at INTEGER
            );
            `);

            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_history_created_at ON calls_history(created_at); `);
        } catch (e) {
            console.error('DB init error:', e.message);
        }
    }

    cleanupOldData(retentionSeconds = 3600) {
        try {
            const nowMs = Date.now();
            const nowSeconds = Math.floor(nowMs / 1000);
            const cutoffMs = nowMs - (retentionSeconds * 1000);

            // Delete old call history (uses seconds)
            this.db.prepare('DELETE FROM calls_history WHERE created_at < ?').run(nowSeconds - retentionSeconds);

            // Delete ranges that haven't been seen in the retention period (uses milliseconds)
            this.db.prepare('DELETE FROM ranges WHERE last_seen_timestamp < ?').run(cutoffMs);

            // Delete individual CLIs that haven't been seen in the retention period (uses milliseconds)
            this.db.prepare('DELETE FROM clis WHERE last_seen < ?').run(cutoffMs);

            // Delete orphaned CLIs (where range no longer exists)
            this.db.exec('DELETE FROM clis WHERE range_name NOT IN (SELECT name FROM ranges)');

        } catch (e) {
            console.error('Cleanup error:', e.message);
        }
    }

    getTopRanges(limit = 10) {
        try {
            return this.db.query('SELECT name, country, calls, clis_count as clis, last_seen_timestamp as lastSeenTimestamp FROM ranges ORDER BY calls DESC, clis_count DESC LIMIT ?').all(limit);
        } catch (e) {
            return [];
        }
    }

    searchRanges(keyword, limit = 10) {
        try {
            return this.db.query('SELECT name, country, calls, clis_count as clis, last_seen_timestamp as lastSeenTimestamp FROM ranges WHERE name LIKE ? OR country LIKE ? ORDER BY calls DESC, clis_count DESC LIMIT ?').all(`%${keyword}%`, `%${keyword}%`, limit);
        } catch (e) {
            return [];
        }
    }

    getTopClisForRange(rangeName, limit = 3) {
        try {
            // Changed to order by last_seen DESC as requested
            const rows = this.db.query('SELECT cli FROM clis WHERE range_name = ? ORDER BY last_seen DESC LIMIT ?').all(rangeName, limit);
            return rows.map(r => r.cli);
        } catch (e) {
            return [];
        }
    }

    processBatchTransaction(allFingerprints, fingerprintToRecordMap, rangeUpdates, clisToInsert, now, allRangeTimestamps) {
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
                            lastSeenTimestamp: rec.timestamp
                        });
                    }
                    const update = rangeUpdates.get(rec.range);
                    update.calls++;
                    if (rec.timestamp > (update.lastSeenTimestamp || 0)) {
                        update.lastSeenTimestamp = rec.timestamp;
                    }
                }
            }

            if (historyValues.length > 0) {
                const insertHistStmt = this.db.prepare('INSERT OR IGNORE INTO calls_history (id, created_at) VALUES (?, ?)');
                for (const [id, created_at] of historyValues) {
                    insertHistStmt.run(id, created_at);
                }
            }

            if (clisToInsert.length > 0) {
                // Aggregating counts for the current batch
                const cliMap = new Map(); // key: range|cli -> count

                for (const [range, cli] of clisToInsert) {
                    const key = `${range}\x00${cli}`;
                    cliMap.set(key, (cliMap.get(key) || 0) + 1);
                }

                const upsertCliStmt = this.db.prepare(`
                    INSERT INTO clis (range_name, cli, call_count, last_seen) 
                    VALUES (?, ?, ?, ?) 
                    ON CONFLICT(range_name, cli) 
                    DO UPDATE SET call_count = call_count + excluded.call_count, last_seen = excluded.last_seen
                `);

                for (const [key, count] of cliMap.entries()) {
                    const [range, cli] = key.split('\x00');
                    // now is in seconds, convert to ms for last_seen
                    upsertCliStmt.run(range, cli, count, now * 1000);
                }
            }

            // Always update last_seen_timestamp for all ranges we saw in this batch
            for (const [rangeName, timestamp] of allRangeTimestamps.entries()) {
                const existing = this.db.query('SELECT name FROM ranges WHERE name = ?').get(rangeName);
                if (existing) {
                    this.db.prepare('UPDATE ranges SET last_seen_timestamp = ? WHERE name = ? AND (last_seen_timestamp IS NULL OR last_seen_timestamp < ?)')
                        .run(timestamp, rangeName, timestamp);
                }
            }

            if (rangeUpdates.size > 0) {
                const updates = Array.from(rangeUpdates.values());
                for (const u of updates) {
                    const existing = this.db.query('SELECT calls FROM ranges WHERE name = ?').get(u.name);

                    if (existing) {
                        // Only update calls count, timestamp already updated above
                        this.db.prepare('UPDATE ranges SET calls = calls + ? WHERE name = ?')
                            .run(u.calls, u.name);
                    } else {
                        this.db.prepare('INSERT INTO ranges (name, country, calls, clis_count, last_seen_timestamp) VALUES (?, ?, ?, 0, ?)')
                            .run(u.name, u.country, u.calls, u.lastSeenTimestamp);
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
            console.error('DB Transaction error:', e.message || e);
            throw e;
        }
    }
}

export const dbHandler = new DBHandler();
