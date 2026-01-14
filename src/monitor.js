import { DBHandler } from './db.js';
import { login } from './auth.js';
import https from 'https';
import fs from 'fs';
import dotenv from 'dotenv';
import countries from 'i18n-iso-countries';
import enLocale from 'i18n-iso-countries/langs/en.json';

dotenv.config();

export const dbHandler = new DBHandler();

const CONFIG = {
    SESSION: () => process.env.ORANGE_CARRIER_SESSION || '',
    CSRF: () => process.env.X_CSRF_TOKEN || '',
    BATCH_SIZE: 25,
    DISPLAY_INTERVAL: 1000,
    REQUEST_TIMEOUT: 15000,
    BATCH_DELAY: 500,
    CLEANUP_INTERVAL: 60000,
    TOKEN_REFRESH_INTERVAL: 110 * 60 * 1000,
    ZERO_THRESHOLD: 10
};

const BLACKLIST_PATH = './database/blacklist_country.json';
let blacklist = new Set();
const zeroCountMap = new Map();

export const globalStats = {
    totalRequests: 0,
    totalRecords: 0,
    currentBatch: [],
    isInitialPhase: true,
    initialProgress: 0,
    totalCountries: 0,
    statusMessage: 'System Active',
    lastAuthError: false
};

countries.registerLocale(enLocale);

function loadBlacklist() {
    try {
        if (fs.existsSync(BLACKLIST_PATH)) {
            const data = JSON.parse(fs.readFileSync(BLACKLIST_PATH, 'utf-8'));
            blacklist = new Set(data.blacklisted || []);
        }
    } catch (e) {
        blacklist = new Set();
    }
}

function saveBlacklist() {
    try {
        const data = {
            blacklisted: Array.from(blacklist),
            lastUpdated: new Date().toISOString()
        };
        fs.writeFileSync(BLACKLIST_PATH, JSON.stringify(data, null, 2));
    } catch (e) {
        process.stdout.write('\r[Error] Failed to save blacklist\n');
    }
}

function checkAndBlacklist(country, recordCount, wasAuthError) {
    if (wasAuthError) return;
    if (recordCount === 0) {
        const count = (zeroCountMap.get(country) || 0) + 1;
        zeroCountMap.set(country, count);
        if (count >= CONFIG.ZERO_THRESHOLD) {
            blacklist.add(country);
            saveBlacklist();
            globalStats.statusMessage = `Blacklisted: ${country} (10 zeros)`;
        }
    } else {
        zeroCountMap.delete(country);
    }
}

async function refreshTokens() {
    try {
        globalStats.statusMessage = 'Refreshing tokens...';
        await login();
        dotenv.config({ override: true });
        globalStats.statusMessage = 'Tokens refreshed';
        globalStats.lastAuthError = false;
    } catch (e) {
        globalStats.statusMessage = 'Login failed';
    }
}

function parseTimeSeconds(timeStr) {
    const lower = timeStr.toLowerCase().trim();
    if (lower.includes('now') || lower.includes('moment')) return 0;

    const num = parseInt(lower, 10);
    if (isNaN(num)) return 999999;

    if (lower.includes('sec')) return num;
    if (lower.includes('min')) return num * 60;
    if (lower.includes('hour') || lower.includes('hr')) return num * 3600;

    return 999999;
}

function fetchPage(country) {
    return new Promise((resolve) => {
        const body = `q=${encodeURIComponent(country)}`;
        const options = {
            hostname: 'www.orangecarrier.com',
            path: '/testaccount/services/cli/access/get',
            method: 'POST',
            headers: {
                'accept': '*/*',
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'x-csrf-token': CONFIG.CSRF(),
                'x-requested-with': 'XMLHttpRequest',
                'cookie': `orange_carrier_session=${CONFIG.SESSION()}`,
                'Content-Length': Buffer.byteLength(body).toString()
            }
        };

        const req = https.request(options, (res) => {
            if (res.statusCode === 401 || res.statusCode === 403 || (res.statusCode === 302 && res.headers.location && res.headers.location.includes('login'))) {
                globalStats.statusMessage = `Session Expired (${res.statusCode}). Refreshing...`;
                globalStats.lastAuthError = true;
                res.resume();
                refreshTokens().then(() => resolve({ records: [], authError: true }));
                return;
            }

            let data = '';
            res.on('data', c => data += c);
            res.on('end', async () => {
                if (data.includes('Log in to Your IPRN Account') || data.includes('login-form')) {
                    globalStats.statusMessage = 'Login form detected. Refreshing...';
                    globalStats.lastAuthError = true;
                    await refreshTokens();
                    resolve({ records: [], authError: true });
                    return;
                }

                const records = [];
                const regex = /<tr>\s*<td>(.*?)<\/td>\s*<td>(.*?)<\/td>\s*<td>.*?<\/td>\s*<td>(.*?)<\/td>\s*<td>.*?<\/td>\s*<td>(.*?)<\/td>/g;
                let match;
                while ((match = regex.exec(data)) !== null) {
                    const timeStr = (match[4] || '').trim();
                    const age = parseTimeSeconds(timeStr);

                    if (age <= 300) {
                        records.push({
                            range: (match[1] || '').trim(),
                            call: (match[2] || '').trim(),
                            cli: (match[3] || '').trim(),
                            timeStr: timeStr
                        });
                    }
                }

                resolve({ records, authError: false });
            });
        });

        req.on('error', () => resolve({ records: [], authError: false }));
        req.setTimeout(CONFIG.REQUEST_TIMEOUT, () => {
            req.destroy();
            resolve({ records: [], authError: false });
        });
        req.write(body);
        req.end();
    });
}

let displayInitialized = false;
const DISPLAY_LINES = 17;

function updateDisplay() {
    const isInteractive = process.stdout.isTTY && !process.env.RAILWAY_ENVIRONMENT;

    if (globalStats.isInitialPhase) {
        const progress = `${globalStats.initialProgress}/${globalStats.totalCountries}`;
        const line = `[Init] ${progress} | Records: ${globalStats.totalRecords} | ${globalStats.statusMessage}`;
        if (isInteractive) {
            process.stdout.write(`\r${line.padEnd(100)}`);
        } else {
            if (globalStats.totalRequests % 50 === 0) {
                console.log(line);
            }
        }
        return;
    }

    const sorted = dbHandler.getTopRanges(10);

    if (isInteractive) {
        if (!displayInitialized) {
            process.stdout.write('\x1b[2J\x1b[H');
            displayInitialized = true;
        }

        process.stdout.write('\x1b[H');

        const lines = [];
        lines.push('TOP 10 RANGES'.padEnd(80));
        lines.push('-'.repeat(80));
        lines.push('RANK  RANGE                                   COUNTRY        CALLS   LAST    ');
        lines.push('-'.repeat(80));

        for (let i = 0; i < 10; i++) {
            if (sorted[i]) {
                const r = sorted[i];
                const rank = `#${i + 1}`;
                const line =
                    rank.padEnd(6) +
                    (r.name.length > 38 ? r.name.substring(0, 35) + '...' : r.name).padEnd(40) +
                    (r.country.length > 12 ? r.country.substring(0, 9) + '...' : r.country).padEnd(15) +
                    String(r.calls).padEnd(8) +
                    (r.lastSeen || 'N/A').padEnd(20);
                lines.push(line);
            } else {
                lines.push(' '.repeat(80));
            }
        }

        lines.push('-'.repeat(80));
        lines.push(`Requests: ${globalStats.totalRequests} | Records: ${globalStats.totalRecords} | Blacklisted: ${blacklist.size}`.padEnd(80));
        lines.push(`Status: ${globalStats.statusMessage}`.padEnd(80));

        process.stdout.write(lines.join('\n') + '\x1b[K');
    } else {
        console.log(`[Monitor] Req: ${globalStats.totalRequests} | Rec: ${globalStats.totalRecords} | Top: ${sorted.length > 0 ? sorted[0].name : 'None'}`);
    }
}

async function processBatch(batch) {
    globalStats.currentBatch = batch;
    globalStats.totalRequests += batch.length;

    const results = await Promise.all(batch.map(c => fetchPage(c).then(r => ({ country: c, ...r }))));

    try {
        const now = Math.floor(Date.now() / 1000);
        const nowMs = Date.now();

        const allFingerprints = [];
        const fingerprintToRecordMap = new Map();
        const rangeUpdates = new Map();
        const clisToInsert = [];

        for (const res of results) {
            checkAndBlacklist(res.country, res.records.length, res.authError);

            if (res.records.length > 0) {
                globalStats.totalRecords += res.records.length;
                for (const rec of res.records) {
                    const ageSeconds = parseTimeSeconds(rec.timeStr);
                    const approxStartTime = now - ageSeconds;
                    const timeBucket = Math.floor(approxStartTime / 120);
                    const timestamp = nowMs - (ageSeconds * 1000);

                    rec.timestamp = timestamp;

                    const fingerprint = `${rec.range}|${rec.call}|${rec.cli}|${timeBucket}`;

                    if (!fingerprintToRecordMap.has(fingerprint)) {
                        allFingerprints.push(fingerprint);
                        fingerprintToRecordMap.set(fingerprint, { rec, country: res.country });
                        clisToInsert.push([rec.range, rec.cli]);
                    }
                }
            }
        }

        dbHandler.processBatchTransaction(allFingerprints, fingerprintToRecordMap, rangeUpdates, clisToInsert, now);

    } catch (e) {
        globalStats.statusMessage = 'Batch processing error';
    }
}

export async function main() {
    loadBlacklist();
    dbHandler.initDB();

    if (!CONFIG.SESSION() || !CONFIG.CSRF()) {
        await refreshTokens();
    }

    const allNames = countries.getNames('en', { select: 'official' });
    const countryList = Object.values(allNames).filter(c => !blacklist.has(c));
    globalStats.totalCountries = countryList.length;

    setInterval(updateDisplay, CONFIG.DISPLAY_INTERVAL);

    setInterval(() => {
        dbHandler.cleanupOldData();
    }, CONFIG.CLEANUP_INTERVAL);

    setInterval(async () => {
        globalStats.statusMessage = 'Scheduled token refresh...';
        await refreshTokens();
    }, CONFIG.TOKEN_REFRESH_INTERVAL);

    for (let i = 0; i < countryList.length; i += CONFIG.BATCH_SIZE) {
        const batch = countryList.slice(i, i + CONFIG.BATCH_SIZE);
        await processBatch(batch);
        globalStats.initialProgress = Math.min(i + CONFIG.BATCH_SIZE, countryList.length);
        await new Promise(resolve => setTimeout(resolve, CONFIG.BATCH_DELAY));
    }

    globalStats.isInitialPhase = false;
    let index = 0;

    while (true) {
        const activeCountries = Object.values(countries.getNames('en', { select: 'official' })).filter(c => !blacklist.has(c));
        const batch = [];
        for (let i = 0; i < CONFIG.BATCH_SIZE; i++) {
            batch.push(activeCountries[index % activeCountries.length]);
            index++;
        }
        await processBatch(batch);
    }
}

if (import.meta.main) {
    main().catch(e => {
        console.error('Fatal error:', e.message);
        process.exit(1);
    });
}
