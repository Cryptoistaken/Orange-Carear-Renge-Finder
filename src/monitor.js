import { DBHandler } from './db.js';
import { login } from './auth.js';
import https from 'https';
import fs from 'fs';
import dotenv from 'dotenv';
import countries from 'i18n-iso-countries';
import enLocale from 'i18n-iso-countries/langs/en.json';

dotenv.config({ debug: false, quiet: true });

export const dbHandler = new DBHandler();

const CONFIG = {
    SESSION: () => process.env.ORANGE_CARRIER_SESSION || '',
    CSRF: () => process.env.X_CSRF_TOKEN || '',
    BATCH_SIZE: 50,
    DISPLAY_INTERVAL: 1000,
    REQUEST_TIMEOUT: 15000,
    BATCH_DELAY: 500,
    CLEANUP_INTERVAL: 60000,
    TOKEN_REFRESH_INTERVAL: 110 * 60 * 1000,
    ZERO_THRESHOLD: 10
};

let refreshPromise = null;


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
    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
        try {
            globalStats.statusMessage = 'Refreshing tokens...';
            await login();
            globalStats.statusMessage = 'Tokens refreshed';
            globalStats.lastAuthError = false;
            scheduleNextRefresh();
            return true;
        } catch (e) {
            globalStats.statusMessage = 'Login failed';
            console.error('Refresh token failed:', e);
            throw e;
        } finally {
            refreshPromise = null;
        }
    })();

    return refreshPromise;
}

let refreshTimeout = null;

function scheduleNextRefresh() {
    if (refreshTimeout) clearTimeout(refreshTimeout);

    const lastRefresh = parseInt(process.env.LAST_TOKEN_REFRESH || '0');
    const now = Date.now();
    const elapsed = now - lastRefresh;
    const remaining = CONFIG.TOKEN_REFRESH_INTERVAL - elapsed;

    const delay = remaining > 0 ? remaining : 1000;

    console.log(`[Scheduler] Last refresh: ${new Date(lastRefresh).toISOString()}, Next refresh in ${Math.round(delay / 60000)} minutes`);

    refreshTimeout = setTimeout(async () => {
        globalStats.statusMessage = 'Scheduled token refresh...';

        const maxRetries = 3;
        const baseDelay = 30000; // 30 seconds

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await refreshTokens();
                return; // Success, exit
            } catch (e) {
                console.error(`Scheduled refresh attempt ${attempt}/${maxRetries} failed:`, e.message);
                globalStats.statusMessage = `Refresh failed (attempt ${attempt}/${maxRetries})`;

                if (attempt < maxRetries) {
                    const retryDelay = baseDelay * Math.pow(2, attempt - 1);
                    console.log(`Retrying in ${retryDelay / 1000}s...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                } else {
                    console.error('All refresh attempts failed. Will retry in 5 minutes.');
                    globalStats.statusMessage = 'Refresh failed. Retrying in 5m...';
                    // Schedule a retry in 5 minutes
                    setTimeout(() => scheduleNextRefresh(), 5 * 60 * 1000);
                }
            }
        }
    }, delay);
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
    const fetchPromise = new Promise((resolve) => {
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

        let resolved = false;
        const safeResolve = (value) => {
            if (!resolved) {
                resolved = true;
                resolve(value);
            }
        };

        const req = https.request(options, (res) => {
            if (res.statusCode === 401 || res.statusCode === 403 || (res.statusCode === 302 && res.headers.location && res.headers.location.includes('login'))) {
                globalStats.statusMessage = `Session Expired (${res.statusCode}). Refreshing...`;
                globalStats.lastAuthError = true;
                res.resume();
                refreshTokens()
                    .then(() => safeResolve({ records: [], authError: true, refreshed: true }))
                    .catch(() => safeResolve({ records: [], authError: true, refreshed: false }));
                return;
            }

            let data = '';
            res.on('data', c => data += c);
            res.on('end', async () => {
                if (data.includes('Log in to Your IPRN Account') || data.includes('login-form')) {
                    globalStats.statusMessage = 'Login form detected. Refreshing...';
                    globalStats.lastAuthError = true;
                    try {
                        await refreshTokens();
                        safeResolve({ records: [], authError: true, refreshed: true });
                    } catch (e) {
                        safeResolve({ records: [], authError: true, refreshed: false });
                    }
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

                safeResolve({ records, authError: false });
            });

            res.on('error', () => safeResolve({ records: [], authError: false }));
        });

        req.on('error', () => safeResolve({ records: [], authError: false }));
        req.setTimeout(CONFIG.REQUEST_TIMEOUT, () => {
            req.destroy();
            safeResolve({ records: [], authError: false });
        });
        req.write(body);
        req.end();
    });

    // Wrap with a hard timeout to prevent any hanging
    const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => {
            resolve({ records: [], authError: false });
        }, CONFIG.REQUEST_TIMEOUT + 5000);
    });

    return Promise.race([fetchPromise, timeoutPromise]);
}

let displayInitialized = false;
const DISPLAY_LINES = 17;

function formatDhakaTime(timestamp) {
    if (!timestamp) return 'N/A';
    const absoluteTime = new Date(timestamp).toLocaleTimeString('en-US', {
        timeZone: 'Asia/Dhaka',
        hour12: true,
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric'
    });

    // Calculate relative time
    const diffSec = Math.floor((Date.now() - timestamp) / 1000);
    let relativeTime;
    if (diffSec < 60) {
        relativeTime = `${diffSec}s`;
    } else if (diffSec < 3600) {
        const mins = Math.floor(diffSec / 60);
        const secs = diffSec % 60;
        relativeTime = `${mins}m ${secs}s`;
    } else {
        const hrs = Math.floor(diffSec / 3600);
        const mins = Math.floor((diffSec % 3600) / 60);
        relativeTime = `${hrs}h ${mins}m`;
    }

    return `${absoluteTime} ${relativeTime}`;
}

function updateDisplay() {
    const isInteractive = process.stdout.isTTY && !process.env.RAILWAY_ENVIRONMENT;

    // ANSI color codes
    const C = {
        reset: '\x1b[0m',
        bold: '\x1b[1m',
        dim: '\x1b[2m',
        cyan: '\x1b[36m',
        green: '\x1b[32m',
        yellow: '\x1b[33m',
        magenta: '\x1b[35m',
        white: '\x1b[97m',
        gray: '\x1b[90m',
        bgBlue: '\x1b[44m',
        orange: '\x1b[38;5;208m'
    };

    if (globalStats.isInitialPhase) {
        const pct = globalStats.totalCountries > 0 ? Math.floor((globalStats.initialProgress / globalStats.totalCountries) * 100) : 0;
        const barLen = 30;
        const filled = Math.floor((pct / 100) * barLen);
        const bar = `${C.orange}${'█'.repeat(filled)}${C.gray}${'░'.repeat(barLen - filled)}${C.reset}`;

        const line = `${C.cyan}[INIT]${C.reset} ${bar} ${C.white}${pct}%${C.reset} ${C.dim}|${C.reset} ${C.green}${globalStats.totalRecords}${C.reset} records ${C.dim}|${C.reset} ${C.yellow}${globalStats.statusMessage}${C.reset}`;
        if (isInteractive) {
            process.stdout.write(`\r${line}\x1b[K`);
        } else {
            if (globalStats.totalRequests % 50 === 0) {
                console.log(`[Init] ${globalStats.initialProgress}/${globalStats.totalCountries} | Records: ${globalStats.totalRecords}`);
            }
        }
        return;
    }

    const sorted = dbHandler.getTopRanges(10);

    if (isInteractive) {
        if (!displayInitialized) {
            process.stdout.write('\x1b[2J\x1b[H\x1b[?25l'); // Clear + hide cursor
            displayInitialized = true;
        }

        process.stdout.write('\x1b[H');

        const lines = [];

        // Header
        lines.push('');
        lines.push(`  ${C.bold}${C.orange}ORANGE CARRIER RANGE FINDER${C.reset}`);
        lines.push(`  ${C.dim}${'─'.repeat(70)}${C.reset}`);
        lines.push('');

        // Column headers
        lines.push(`  ${C.dim}#${C.reset}   ${C.cyan}RANGE${C.reset}                                 ${C.cyan}CALLS${C.reset}  ${C.cyan}CLI${C.reset}  ${C.cyan}LAST SEEN${C.reset}`);
        lines.push(`  ${C.dim}${'─'.repeat(70)}${C.reset}`);

        for (let i = 0; i < 10; i++) {
            if (sorted[i]) {
                const r = sorted[i];
                const rankColor = i === 0 ? C.orange : i < 3 ? C.yellow : C.gray;
                const rank = `${rankColor}${String(i + 1).padStart(2)}${C.reset}`;
                const name = (r.name.length > 35 ? r.name.substring(0, 32) + '...' : r.name).padEnd(38);
                const calls = `${C.green}${String(r.calls).padStart(5)}${C.reset}`;
                const clis = `${C.magenta}${String(r.clis).padStart(4)}${C.reset}`;

                const diffSec = r.lastSeenTimestamp ? Math.floor((Date.now() - r.lastSeenTimestamp) / 1000) : 999999;
                let timeColor = diffSec < 30 ? C.green : diffSec < 120 ? C.yellow : C.dim;
                let timeStr = diffSec < 60 ? `${diffSec}s` : diffSec < 3600 ? `${Math.floor(diffSec / 60)}m` : `${Math.floor(diffSec / 3600)}h`;
                const lastSeen = `${timeColor}${timeStr.padStart(8)}${C.reset}`;

                lines.push(`  ${rank}  ${C.white}${name}${C.reset} ${calls}  ${clis}  ${lastSeen}`);
            } else {
                lines.push('');
            }
        }

        lines.push(`  ${C.dim}${'─'.repeat(70)}${C.reset}`);

        // Stats footer
        const statsLine = `  ${C.dim}Requests:${C.reset} ${C.cyan}${globalStats.totalRequests}${C.reset}  ${C.dim}Records:${C.reset} ${C.green}${globalStats.totalRecords}${C.reset}  ${C.dim}Blacklisted:${C.reset} ${C.yellow}${blacklist.size}${C.reset}`;
        lines.push(statsLine);
        lines.push(`  ${C.dim}Status:${C.reset} ${C.white}${globalStats.statusMessage}${C.reset}`);
        lines.push('');

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
        const allRangeTimestamps = new Map(); // Track latest timestamp for ALL records

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

                    // Always track the latest timestamp for this range (for display)
                    if (!allRangeTimestamps.has(rec.range) || timestamp > allRangeTimestamps.get(rec.range)) {
                        allRangeTimestamps.set(rec.range, timestamp);
                    }

                    const fingerprint = `${rec.range}|${rec.call}|${rec.cli}|${timeBucket}`;

                    if (!fingerprintToRecordMap.has(fingerprint)) {
                        allFingerprints.push(fingerprint);
                        fingerprintToRecordMap.set(fingerprint, { rec, country: res.country });
                        clisToInsert.push([rec.range, rec.cli]);
                    }
                }
            }
        }

        dbHandler.processBatchTransaction(allFingerprints, fingerprintToRecordMap, rangeUpdates, clisToInsert, now, allRangeTimestamps);

    } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        globalStats.statusMessage = `Batch error: ${msg.substring(0, 50)}`;
        console.error('Batch processing error:', msg);
    }
}

export async function main() {
    loadBlacklist();
    dbHandler.wipeDB();
    dbHandler.initDB();

    if (!CONFIG.SESSION() || !CONFIG.CSRF()) {
        await refreshTokens();
    } else {
        // We have tokens, just schedule the next refresh
        scheduleNextRefresh();
    }

    const allNames = countries.getNames('en', { select: 'official' });
    const countryList = Object.values(allNames).filter(c => !blacklist.has(c));
    globalStats.totalCountries = countryList.length;

    setInterval(updateDisplay, CONFIG.DISPLAY_INTERVAL);

    setInterval(() => {
        dbHandler.cleanupOldData(300);
    }, CONFIG.CLEANUP_INTERVAL);

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
