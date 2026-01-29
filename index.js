require('dotenv').config();
const puppeteer = require('puppeteer-core');
const { Telegraf, Markup } = require('telegraf');
const https = require('https');
const http = require('http');
const fs = require('fs');
const countries = require('i18n-iso-countries');

const enLocale = require('i18n-iso-countries/langs/en.json');
const sqlite3 = require('sqlite3').verbose();

// Hardcoded credentials
const BOT_TOKEN = '8598442515:AAGxJ98DBHhQx5j_QNT6DBJvBcsbPIjlsfc';
const BROWSERLESS_API_KEY = '2Tl8dA0AoBjpxtPee97a830d14a013a06f640ce1e383f9afc';

// Environment detection
const isRailway = !!process.env.RAILWAY_ENVIRONMENT;
const USE_BROWSERLESS = isRailway;

// Configuration
const CONFIG = {
    SESSION: process.env.ORANGE_CARRIER_SESSION || '',
    CSRF: process.env.X_CSRF_TOKEN || '',
    BATCH_SIZE: 50,
    REQUEST_TIMEOUT: 15000,
    BATCH_DELAY: 500,
    TOKEN_REFRESH_INTERVAL: 110 * 60 * 1000,
    CLEANUP_INTERVAL: 60000,
    DATA_RETENTION: 300
};


// Database setup - NO UNIQUE CONSTRAINT
const db = new sqlite3.Database('dedup.db');

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS seen_records (id INTEGER PRIMARY KEY AUTOINCREMENT, range TEXT, cli TEXT, timestamp INTEGER)");
    db.run("CREATE INDEX IF NOT EXISTS idx_range_timestamp ON seen_records(range, timestamp)");
    db.run("CREATE INDEX IF NOT EXISTS idx_timestamp ON seen_records(timestamp)");
});

function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}
// Global state
const leaderboard = new Map();

// seenRecords replaced by SQLite
const liveMessages = new Map();

const globalStats = {
    totalRequests: 0,
    totalRecords: 0,
    initialProgress: 0,
    totalCountries: 0,
    statusMessage: 'System Active',
    botStatus: 'Initializing...'
};

countries.registerLocale(enLocale);

// Authentication

function updateEnvFile(session, csrf) {
    try {
        const envPath = '.env';
        let content = '';
        if (fs.existsSync(envPath)) {
            content = fs.readFileSync(envPath, 'utf8');
        }

        const updates = {
            'ORANGE_CARRIER_SESSION': session,
            'X_CSRF_TOKEN': csrf,
            'LAST_TOKEN_REFRESH': Date.now().toString()
        };

        let lines = content.split('\n');
        const newLines = [];
        const keysUpdated = new Set();

        for (const line of lines) {
            const match = line.match(/^([^=]+)=/);
            if (match && updates[match[1]]) {
                newLines.push(`${match[1]}=${updates[match[1]]}`);
                keysUpdated.add(match[1]);
            } else {
                newLines.push(line);
            }
        }

        for (const [key, value] of Object.entries(updates)) {
            if (!keysUpdated.has(key)) {
                if (newLines.length > 0 && newLines[newLines.length - 1] !== '') {
                    newLines.push('');
                }
                newLines.push(`${key}=${value}`);
            }
        }

        fs.writeFileSync(envPath, newLines.join('\n'));
        console.log('Updated .env with new tokens');
    } catch (e) {
        console.error('Failed to update .env:', e.message);
    }
}

async function login() {
    console.log('Logging in via Browserless');

    const browser = await puppeteer.connect({
        browserWSEndpoint: `wss://production-sfo.browserless.io?token=${BROWSERLESS_API_KEY}`,
    });

    let csrfToken = '';
    let sessionCookie = '';

    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        await page.setViewport({ width: 1920, height: 1080 });

        await page.setRequestInterception(true);
        page.on('request', (request) => {
            if (request.url().includes('/testaccount/services/cli/access/get')) {
                const headers = request.headers();
                csrfToken = headers['x-csrf-token'] || '';
                const cookieHeader = headers['cookie'] || '';
                const sessionMatch = cookieHeader.match(/orange_carrier_session=([^;]+)/);
                if (sessionMatch) {
                    sessionCookie = sessionMatch[1];
                }
            }
            request.continue();
        });

        await page.goto('https://www.orangecarrier.com/login', { waitUntil: 'networkidle2', timeout: 60000 });
        await page.waitForSelector('text/Log in to Your IPRN Account', { timeout: 30000 });

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }),
            page.evaluate(() => {
                const link = Array.from(document.querySelectorAll('a')).find(el => el.textContent.toLowerCase().includes('test account'));
                if (link) link.click();
            })
        ]);

        const currentUrl = page.url();
        if (currentUrl.includes('login') || !currentUrl.includes('cli/access')) {
            await page.goto('https://www.orangecarrier.com/testaccount/services/cli/access', { waitUntil: 'networkidle2', timeout: 60000 });
        }

        await page.addStyleTag({ content: '.popup-message { display: none !important; }' });

        await page.evaluate(() => {
            const el = document.querySelector('#CLI');
            if (el) {
                el.value = '000';
                el.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });

        await page.waitForFunction(() => {
            const btns = Array.from(document.querySelectorAll('button, input[type="submit"], a'));
            return btns.some(b => (b.textContent && b.textContent.toLowerCase().includes('search')));
        }, { timeout: 30000 });

        await Promise.all([
            page.waitForResponse(resp => resp.url().includes('/testaccount/services/cli/access/get'), { timeout: 60000 }),
            page.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('button, input[type="submit"], a'));
                const btn = elements.find(b => (b.textContent && b.textContent.toLowerCase().includes('search')));
                if (btn) btn.click();
            }),
        ]);

        await page.waitForFunction(() => document.body.innerText.includes('Termination'), { timeout: 60000 });

        const cookies = await page.cookies();
        const sessionCookieObj = cookies.find(c => c.name === 'orange_carrier_session');
        if (sessionCookieObj) {
            sessionCookie = sessionCookieObj.value;
        }

        CONFIG.SESSION = sessionCookie;
        CONFIG.CSRF = csrfToken;

        updateEnvFile(sessionCookie, csrfToken);

        console.log('Tokens acquired');
        return { csrfToken, sessionCookie };

    } finally {
        await browser.close();
    }
}

let refreshTimeout = null;

async function refreshTokens() {
    try {
        globalStats.statusMessage = 'Refreshing tokens';
        await login();
        globalStats.statusMessage = 'Tokens refreshed';
        scheduleNextRefresh();
        return true;
    } catch (e) {
        globalStats.statusMessage = 'Login failed';
        console.error('Refresh failed:', e.message);
        throw e;
    }
}

function scheduleNextRefresh() {
    if (refreshTimeout) clearTimeout(refreshTimeout);
    refreshTimeout = setTimeout(() => refreshTokens(), CONFIG.TOKEN_REFRESH_INTERVAL);
}

// Data fetching
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
                'x-csrf-token': CONFIG.CSRF,
                'x-requested-with': 'XMLHttpRequest',
                'cookie': `orange_carrier_session=${CONFIG.SESSION}`,
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
                globalStats.statusMessage = `Session expired (${res.statusCode})`;
                res.resume();
                refreshTokens()
                    .then(() => safeResolve({ records: [], authError: true }))
                    .catch(() => safeResolve({ records: [], authError: true }));
                return;
            }

            let data = '';
            res.on('data', c => data += c);
            res.on('end', async () => {
                if (data.includes('Log in to Your IPRN Account') || data.includes('login-form')) {
                    globalStats.statusMessage = 'Login form detected';
                    try {
                        await refreshTokens();
                        safeResolve({ records: [], authError: true });
                    } catch (e) {
                        safeResolve({ records: [], authError: true });
                    }
                    return;
                }

                const records = [];
                const regex = /<tr>\s*<td>(.*?)<\/td>\s*<td>(.*?)<\/td>\s*<td>.*?<\/td>\s*<td>.*?<\/td>\s*<td>.*?<\/td>\s*<td>(.*?)<\/td>/g;
                let match;
                while ((match = regex.exec(data)) !== null) {
                    const range = (match[1] || '').trim();
                    const cli = (match[2] || '').trim();
                    const timeStr = (match[3] || '').trim();
                    const age = parseTimeSeconds(timeStr);

                    if (age <= 300) {
                        records.push({
                            range: range,
                            call: cli,
                            cli: cli,
                            timeStr: timeStr,
                            timestamp: Date.now() - (age * 1000)
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

    const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => {
            resolve({ records: [], authError: false });
        }, CONFIG.REQUEST_TIMEOUT + 5000);
    });

    return Promise.race([fetchPromise, timeoutPromise]);
}

// Leaderboard management - Deduplicate by range+cli combination
async function updateLeaderboard(records) {
    const now = Date.now();
    const cutoff = now - (CONFIG.DATA_RETENTION * 1000);

    // Deduplicate incoming records by range+cli
    const uniqueRecords = new Map();
    for (const rec of records) {
        const key = `${rec.range}|${rec.cli}`;
        if (!uniqueRecords.has(key) || rec.timestamp > uniqueRecords.get(key).timestamp) {
            uniqueRecords.set(key, rec);
        }
    }

    // Update leaderboard
    for (const rec of uniqueRecords.values()) {
        // Create entry if it doesn't exist
        if (!leaderboard.has(rec.range)) {
            leaderboard.set(rec.range, {
                name: rec.range,
                uniqueCalls: new Map(),
                recentClis: []
            });
        }

        const entry = leaderboard.get(rec.range);

        // Add this CLI to the map (or update timestamp if newer)
        const existingTimestamp = entry.uniqueCalls.get(rec.cli);
        if (!existingTimestamp || rec.timestamp > existingTimestamp) {
            entry.uniqueCalls.set(rec.cli, rec.timestamp);

            // Update recent CLIs display list
            entry.recentClis = entry.recentClis.filter(item => item.cli !== rec.cli);
            entry.recentClis.push({ cli: rec.cli, timestamp: rec.timestamp });
            entry.recentClis.sort((a, b) => b.timestamp - a.timestamp);
            entry.recentClis = entry.recentClis.slice(0, 3);
        }
    }

    // Clean up expired entries
    for (const [name, entry] of leaderboard.entries()) {
        // Remove expired CLIs from the map
        for (const [cli, timestamp] of entry.uniqueCalls.entries()) {
            if (timestamp < cutoff) {
                entry.uniqueCalls.delete(cli);
            }
        }

        // Clean up recent CLIs list
        entry.recentClis = entry.recentClis.filter(r => r.timestamp >= cutoff);

        // Remove range if no active CLIs
        if (entry.uniqueCalls.size === 0) {
            leaderboard.delete(name);
        }
    }

    // Optional: Database persistence (can be removed for pure in-memory)
    for (const rec of uniqueRecords.values()) {
        try {
            await dbRun(
                "INSERT OR REPLACE INTO seen_records (range, cli, timestamp) VALUES (?, ?, ?)",
                [rec.range, rec.cli, rec.timestamp]
            );
        } catch (e) {
            // Ignore DB errors
        }
    }

    // Periodic cleanup
    if (Math.random() < 0.01) {
        try {
            const countRow = await dbGet("SELECT COUNT(*) as count FROM seen_records");
            if (countRow && countRow.count > 50000) {
                await dbRun("DELETE FROM seen_records WHERE id NOT IN (SELECT id FROM seen_records ORDER BY timestamp DESC LIMIT 50000)");
            }
        } catch (e) {
            // Ignore
        }
    }
}

function getTopRanges(limit = 10) {
    const now = Date.now();
    const cutoff = now - (CONFIG.DATA_RETENTION * 1000);

    return Array.from(leaderboard.values())
        .map(entry => {
            // Count active CLIs (within time window)
            const activeClis = new Map();
            for (const [cli, timestamp] of entry.uniqueCalls.entries()) {
                if (timestamp >= cutoff) {
                    activeClis.set(cli, timestamp);
                }
            }

            const lastTimestamp = activeClis.size > 0
                ? Math.max(...activeClis.values())
                : 0;

            return {
                name: entry.name,
                calls: activeClis.size,
                clis: activeClis.size,
                lastSeenTimestamp: lastTimestamp,
                recentClis: entry.recentClis
                    .filter(r => r.timestamp >= cutoff)
                    .map(item => item.cli)
            };
        })
        .filter(entry => entry.calls > 0)
        .sort((a, b) => {
            if (b.calls !== a.calls) return b.calls - a.calls;
            return b.lastSeenTimestamp - a.lastSeenTimestamp;
        })
        .slice(0, limit);
}

// Display
let displayInitialized = false;

function updateDisplay() {
    const isInteractive = process.stdout.isTTY && !isRailway;

    const C = {
        reset: '\x1b[0m',
        bold: '\x1b[1m',
        dim: '\x1b[2m',
        red: '\x1b[31m',
        cyan: '\x1b[36m',
        green: '\x1b[32m',
        yellow: '\x1b[33m',
        magenta: '\x1b[35m',
        white: '\x1b[97m',
        gray: '\x1b[90m',
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

    const sorted = getTopRanges(10);

    if (isInteractive) {
        if (!displayInitialized) {
            process.stdout.write('\x1b[2J\x1b[H\x1b[?25l');
            displayInitialized = true;
        }

        process.stdout.write('\x1b[H');

        const lines = [];

        lines.push('');
        lines.push(`  ${C.bold}${C.orange}ORANGE CARRIER RANGE FINDER${C.reset}`);
        lines.push(`  ${C.dim}${'─'.repeat(70)}${C.reset}`);
        lines.push('');

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

        const statsLine = `  ${C.dim}Requests:${C.reset} ${C.cyan}${globalStats.totalRequests}${C.reset}  ${C.dim}Records:${C.reset} ${C.green}${globalStats.totalRecords}${C.reset}`;
        lines.push(statsLine);
        lines.push(`  ${C.dim}Status:${C.reset} ${C.white}${globalStats.statusMessage.padEnd(20)}${C.reset}  ${C.dim}Bot:${C.reset} ${globalStats.botStatus === 'Online' ? C.green : C.red}${globalStats.botStatus.padEnd(20)}${C.reset}`);
        lines.push('');

        process.stdout.write(lines.join('\n') + '\x1b[K');
    } else {
        console.log(`[Monitor] Req: ${globalStats.totalRequests} | Rec: ${globalStats.totalRecords} | Top: ${sorted.length > 0 ? sorted[0].name : 'None'}`);
    }
}

// Batch processing

async function processBatch(batch) {
    globalStats.totalRequests += batch.length;

    const results = await Promise.all(batch.map(c => fetchPage(c).then(r => ({ country: c, ...r }))));

    const allRecords = [];

    for (const res of results) {

        if (res.records.length > 0) {
            globalStats.totalRecords += res.records.length;
            allRecords.push(...res.records);
        }
    }

    await updateLeaderboard(allRecords);
}

// Telegram Bot
const bot = new Telegraf(BOT_TOKEN);

function formatRangeList(ranges) {
    if (ranges.length === 0) {
        return 'No data available yet';
    }

    let msg = '';

    ranges.forEach((r, i) => {
        const name = r.name;
        const absoluteTime = new Date(r.lastSeenTimestamp).toLocaleTimeString('en-US', {
            timeZone: 'Asia/Dhaka',
            hour12: true,
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric'
        });

        const diffSec = Math.floor((Date.now() - r.lastSeenTimestamp) / 1000);
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

        const clisDisplay = r.recentClis.length > 0 ? r.recentClis.map(c => `\`${c}\``).join(', ') : 'N/A';

        msg += `*#${i + 1}*\n`;
        msg += `├─ Range: \`${name}\`\n`;
        msg += `├─ Calls: ${r.calls}\n`;
        msg += `├─ CLI: ${r.clis || 0}\n`;
        msg += `├─ Latest CLIs: ${clisDisplay}\n`;
        msg += `└─ Last: ${absoluteTime}  ${relativeTime} ago\n`;
        msg += '\n';
    });

    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { timeZone: 'Asia/Dhaka', hour12: true, hour: 'numeric', minute: 'numeric', second: 'numeric' });
    msg += `_Updated: ${timeStr}_`;

    return msg;
}

function getInitMessage() {
    const progress = `${globalStats.initialProgress}/${globalStats.totalCountries}`;
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { timeZone: 'Asia/Dhaka', hour12: true, hour: 'numeric', minute: 'numeric', second: 'numeric' });
    return `*Initializing*\n\nFetching data from all countries\nProgress: ${progress}\nRecords so far: ${globalStats.totalRecords}\n\n_Updated: ${timeStr}_`;
}

function getDisplayText() {
    if (globalStats.isInitialPhase) {
        return getInitMessage();
    }

    const ranges = getTopRanges(10);
    return formatRangeList(ranges);
}

function getStartKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('View Top Ranges', 'live_ranges')]
    ]);
}

function getRangeListKeyboard(autoRefresh = false) {
    if (autoRefresh) {
        return Markup.inlineKeyboard([
            [Markup.button.callback('Back to Menu', 'back_menu')]
        ]);
    }
    return Markup.inlineKeyboard([
        [
            Markup.button.callback('Refresh', 'refresh_ranges'),
            Markup.button.callback('Back to Menu', 'back_menu')
        ]
    ]);
}

async function updateLiveMessage(chatId) {
    const live = liveMessages.get(chatId);
    if (!live || !live.showingList) return;

    if (live.updating) return;
    live.updating = true;

    if (live.pauseUntil && Date.now() < live.pauseUntil) {
        live.updating = false;
        return;
    }
    live.pauseUntil = undefined;

    try {
        const text = getDisplayText();

        await bot.telegram.editMessageText(
            chatId,
            live.messageId,
            undefined,
            text,
            {
                parse_mode: 'Markdown',
                ...getRangeListKeyboard(live.autoRefresh)
            }
        );
    } catch (e) {
        if (e.description && e.description.includes('message is not modified')) {
            // OK
        } else if (e.description && e.description.includes('Too Many Requests')) {
            const retryAfter = e.parameters?.retry_after || 5;
            live.pauseUntil = Date.now() + (retryAfter * 1000);
        } else if (e.description && (e.description.includes('message to edit not found') || e.description.includes("message can't be edited"))) {
            liveMessages.delete(chatId);
        } else {
            console.error('Live update error:', e.description || e.message || e);
        }
    } finally {
        const currentLive = liveMessages.get(chatId);
        if (currentLive) {
            currentLive.updating = false;
        }
    }
}

bot.start(async (ctx) => {
    try {
        liveMessages.delete(ctx.chat.id);
        await ctx.reply('Welcome! Choose an option:', getStartKeyboard());
    } catch (e) {
        console.error('Start command error:', e.message || e);
        await ctx.reply('Error starting bot');
    }
});

bot.action('live_ranges', async (ctx) => {
    try {
        const text = getDisplayText();

        const msg = await ctx.reply(text, {
            parse_mode: 'Markdown',
            ...getRangeListKeyboard(true)
        });

        liveMessages.set(ctx.chat.id, {
            chatId: ctx.chat.id,
            messageId: msg.message_id,
            showingList: true,
            autoRefresh: true,
            startTime: Date.now()
        });

        await ctx.answerCbQuery();
    } catch (e) {
        await ctx.answerCbQuery('Error');
    }
});

bot.action('refresh_ranges', async (ctx) => {
    try {
        const text = getDisplayText();

        const msg = await ctx.editMessageText(text, {
            parse_mode: 'Markdown',
            ...getRangeListKeyboard(true)
        });

        liveMessages.set(ctx.chat.id, {
            chatId: ctx.chat.id,
            messageId: ctx.message.message_id,
            showingList: true,
            autoRefresh: true,
            startTime: Date.now()
        });

        await ctx.answerCbQuery('Refreshing');
    } catch (e) {
        await ctx.answerCbQuery('Error');
    }
});

bot.action('back_menu', async (ctx) => {
    try {
        liveMessages.delete(ctx.chat.id);
        await ctx.reply('Choose an option:', getStartKeyboard());
        await ctx.answerCbQuery();
    } catch (e) {
        await ctx.answerCbQuery('Error');
    }
});

bot.command('top', async (ctx) => {
    try {
        const text = getDisplayText();

        const msg = await ctx.reply(text, {
            parse_mode: 'Markdown',
            ...getRangeListKeyboard(true)
        });

        liveMessages.set(ctx.chat.id, {
            chatId: ctx.chat.id,
            messageId: msg.message_id,
            showingList: true,
            autoRefresh: true,
            startTime: Date.now()
        });
    } catch (e) {
        await ctx.reply('Error fetching top ranges');
    }
});

bot.catch((err) => {
    const msg = err && err.message ? err.message : String(err);
    console.error('Bot error:', msg);
});

async function runUpdateCycle() {
    const chatIds = Array.from(liveMessages.keys());
    const now = Date.now();

    for (const chatId of chatIds) {
        try {
            const live = liveMessages.get(chatId);
            if (!live) continue;

            const elapsed = now - live.startTime;
            const fiveMinutes = 5 * 60 * 1000;

            if (live.autoRefresh && elapsed < fiveMinutes) {
                await updateLiveMessage(chatId);
            } else if (live.autoRefresh && elapsed >= fiveMinutes) {
                // Stop auto-refresh, show refresh button
                live.autoRefresh = false;
                try {
                    await bot.telegram.editMessageReplyMarkup(
                        chatId,
                        live.messageId,
                        undefined,
                        getRangeListKeyboard(false).reply_markup
                    );
                } catch (e) {
                    // Ignore
                }
            }
        } catch (err) {
            console.error('Update error for chat', chatId, ':', err.message || err);
        }
    }

    setTimeout(runUpdateCycle, 10000);
}

// Main monitor loop
async function monitorMain() {
    let initialLoginNeeded = true;

    if (CONFIG.SESSION && CONFIG.CSRF) {
        if (process.env.LAST_TOKEN_REFRESH) {
            const lastRefresh = parseInt(process.env.LAST_TOKEN_REFRESH, 10);
            if (!isNaN(lastRefresh)) {
                const elapsed = Date.now() - lastRefresh;
                const remaining = CONFIG.TOKEN_REFRESH_INTERVAL - elapsed;

                if (remaining > 0) {
                    console.log(`Using existing session from env (valid for ${Math.floor(remaining / 60000)}m)`);
                    initialLoginNeeded = false;

                    if (refreshTimeout) clearTimeout(refreshTimeout);
                    refreshTimeout = setTimeout(() => refreshTokens(), remaining);
                } else {
                    console.log('Environment session expired based on LAST_TOKEN_REFRESH');
                }
            }
        } else {
            console.log('Using configured session (no timestamp provided)');
            initialLoginNeeded = false;
            scheduleNextRefresh();
        }
    }

    if (initialLoginNeeded) {
        await refreshTokens();
    }

    const allNames = countries.getNames('en', { select: 'official' });
    const countryList = Object.values(allNames);
    globalStats.totalCountries = countryList.length;

    setInterval(updateDisplay, 1000);

    for (let i = 0; i < countryList.length; i += CONFIG.BATCH_SIZE) {
        const batch = countryList.slice(i, i + CONFIG.BATCH_SIZE);
        await processBatch(batch);
        globalStats.initialProgress = Math.min(i + CONFIG.BATCH_SIZE, countryList.length);
        await new Promise(resolve => setTimeout(resolve, CONFIG.BATCH_DELAY));
    }

    globalStats.isInitialPhase = false;
    let index = 0;

    while (true) {
        const activeCountries = Object.values(countries.getNames('en', { select: 'official' }));
        const batch = [];
        for (let i = 0; i < CONFIG.BATCH_SIZE; i++) {
            batch.push(activeCountries[index % activeCountries.length]);
            index++;
        }
        await processBatch(batch);
        if (globalStats.totalRequests % 100 === 0) {
            const topRange = Array.from(leaderboard.values())
                .sort((a, b) => b.uniqueCalls.size - a.uniqueCalls.size)[0];
            if (topRange) {
                console.log(`Debug: Top range has ${topRange.uniqueCalls.size} unique CLIs`);
            }
        }
        await new Promise(resolve => setTimeout(resolve, CONFIG.BATCH_DELAY));
    }
}

async function botMain() {
    try {
        if (isRailway) {
            const webhookDomain = 'orangecarrier.up.railway.app';
            await bot.telegram.setWebhook(`https://${webhookDomain}/webhook`);
            console.log('Bot webhook set:', webhookDomain);
            globalStats.botStatus = 'Online (Webhook)';
        } else {
            // Verify connection first
            const me = await bot.telegram.getMe();
            console.log(`Bot connected: ${me.username}`);

            // Start polling without awaiting (it blocks until stop)
            bot.launch({
                dropPendingUpdates: true
            }).catch(e => {
                console.error('Bot polling error:', e.message);
                globalStats.botStatus = 'Failed';
                fs.writeFileSync('bot_error.log', `Polling Error: ${e.message}\n${e.stack}`);
            });

            globalStats.botStatus = 'Online';
            console.log('Bot started (polling)');
        }

        setTimeout(runUpdateCycle, 10000);

        process.once('SIGINT', () => bot.stop('SIGINT'));
        process.once('SIGTERM', () => bot.stop('SIGTERM'));
    } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.error('Failed to start bot:', msg);
        fs.writeFileSync('bot_error.log', msg + '\n' + (e.stack || ''));
        globalStats.botStatus = 'Failed';
        throw e;
    }
}

function getWebhookHandler() {
    return bot.webhookCallback('/webhook');
}

// Entry point
if (isRailway) {
    const webhookHandler = getWebhookHandler();
    const server = http.createServer((req, res) => {
        if (req.url === '/webhook' && req.method === 'POST') {
            webhookHandler(req, res);
        } else if (req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('OK');
        } else {
            res.writeHead(404);
            res.end('Not Found');
        }
    });
    const port = process.env.PORT || 3000;
    server.listen(port, () => {
        console.log(`Webhook server listening on port ${port}`);
    });
    monitorMain().catch(err => console.error('Monitor error:', err.message));
    botMain().catch(err => console.error('Bot error:', err.message));
} else {
    Promise.all([
        monitorMain().catch(err => console.error('Monitor error:', err.message)),
        new Promise(resolve => setTimeout(resolve, 5000)).then(() =>
            botMain().catch(err => console.error('Bot error:', err.message))
        )
    ]).catch(err => {
        console.error('Fatal error:', err.message);
        process.exit(1);
    });
}