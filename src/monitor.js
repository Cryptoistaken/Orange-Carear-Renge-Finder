import { DBHandler } from './db.js';
import { login } from './auth.js';
import https from 'https';
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
    CLEANUP_INTERVAL: 60000
};

export const globalStats = {
    totalRequests: 0,
    totalRecords: 0,
    currentBatch: [],
    isInitialPhase: true,
    initialProgress: 0,
    totalCountries: 0
};

countries.registerLocale(enLocale);

async function refreshTokens() {
    try {
        await login();
        dotenv.config({ override: true });
    } catch (e) {
        console.error('Login failed');
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
            let data = '';
            res.on('data', c => data += c);
            res.on('end', async () => {
                if (data.includes('Log in to Your IPRN Account') || data.includes('login-form')) {
                    await refreshTokens();
                    resolve([]);
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
                resolve(records);
            });
        });

        req.on('error', () => resolve([]));
        req.setTimeout(CONFIG.REQUEST_TIMEOUT, () => {
            req.destroy();
            resolve([]);
        });
        req.write(body);
        req.end();
    });
}

function updateDisplay() {
    process.stdout.write('\x1b[2J\x1b[H');

    if (globalStats.isInitialPhase) {
        console.log('INITIALIZING...');
        console.log(`Progress: ${globalStats.initialProgress} / ${globalStats.totalCountries}`);
        const countriesStr = globalStats.currentBatch.join(', ');
        console.log(`Current: ${countriesStr.length > 60 ? countriesStr.substring(0, 57) + '...' : countriesStr}`);
        console.log(`Records: ${globalStats.totalRecords}`);
        return;
    }

    const sorted = dbHandler.getTopRanges(10);

    console.log('TOP 10 RANGES');
    console.log('-'.repeat(80));
    console.log('RANK  RANGE                                   COUNTRY        CALLS   CLIS');
    console.log('-'.repeat(80));

    sorted.forEach((r, i) => {
        const rank = `#${i + 1}`;
        const line =
            rank.padEnd(6) +
            (r.name.length > 38 ? r.name.substring(0, 35) + '...' : r.name).padEnd(40) +
            (r.country.length > 12 ? r.country.substring(0, 9) + '...' : r.country).padEnd(15) +
            String(r.calls).padEnd(8) +
            String(r.clis);
        console.log(line);
    });

    console.log('-'.repeat(80));
    console.log(`Requests: ${globalStats.totalRequests} | Records: ${globalStats.totalRecords}`);
}

async function processBatch(batch) {
    globalStats.currentBatch = batch;
    globalStats.totalRequests += batch.length;

    const results = await Promise.all(batch.map(c => fetchPage(c).then(r => ({ country: c, records: r }))));

    try {
        const now = Math.floor(Date.now() / 1000);

        const allFingerprints = [];
        const fingerprintToRecordMap = new Map();
        const rangeUpdates = new Map();
        const clisToInsert = [];

        for (const res of results) {
            if (res.records.length > 0) {
                globalStats.totalRecords += res.records.length;
                for (const rec of res.records) {
                    const ageSeconds = parseTimeSeconds(rec.timeStr);
                    const approxStartTime = now - ageSeconds;
                    const timeBucket = Math.floor(approxStartTime / 120);

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
        console.error('Batch failed:', e);
    }
}

export async function main() {
    process.stdout.write('\x1b[2J');

    dbHandler.initDB();

    if (!CONFIG.SESSION() || !CONFIG.CSRF()) {
        await refreshTokens();
    }

    const allNames = countries.getNames('en', { select: 'official' });
    const countryList = Object.values(allNames);
    globalStats.totalCountries = countryList.length;

    setInterval(updateDisplay, CONFIG.DISPLAY_INTERVAL);

    setInterval(() => {
        dbHandler.cleanupOldData();
    }, CONFIG.CLEANUP_INTERVAL);

    for (let i = 0; i < countryList.length; i += CONFIG.BATCH_SIZE) {
        const batch = countryList.slice(i, i + CONFIG.BATCH_SIZE);

        if (i > 0 && i % 100 === 0) {
            await refreshTokens();
        }

        await processBatch(batch);
        globalStats.initialProgress = Math.min(i + CONFIG.BATCH_SIZE, countryList.length);

        await new Promise(resolve => setTimeout(resolve, CONFIG.BATCH_DELAY));
    }

    globalStats.isInitialPhase = false;
    let index = 0;

    while (true) {
        const batch = [];
        for (let i = 0; i < CONFIG.BATCH_SIZE; i++) {
            batch.push(countryList[index % countryList.length]);
            index++;
        }
        await processBatch(batch);
    }
}

main().catch(console.error);
