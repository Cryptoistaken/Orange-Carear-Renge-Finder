import puppeteer from 'puppeteer-core';
import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';

const USE_BROWSERLESS = process.env.USE_BROWSERLESS === 'true' || !!process.env.RAILWAY_ENVIRONMENT;
const BROWSERLESS_API_KEY = process.env.BROWSERLESS_API_KEY;

if (USE_BROWSERLESS && !BROWSERLESS_API_KEY) {
    throw new Error('BROWSERLESS_API_KEY environment variable is required when using Browserless');
}

async function loginWithPuppeteer() {
    console.log('Connecting to Browserless...');

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

        return { csrfToken, sessionCookie };

    } finally {
        await browser.close();
    }
}

async function loginWithPlaywright() {
    console.log('Launching local browser...');

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        viewport: { width: 1920, height: 1080 },
    });
    const page = await context.newPage();

    // Set default navigation timeout
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);

    let csrfToken = '';
    let sessionCookie = '';

    try {
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
        });

        await page.goto('https://www.orangecarrier.com/login', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });
        await page.waitForSelector('text=Log in to Your IPRN Account', { timeout: 30000 });

        await page.getByRole('link', { name: 'Test Account' }).click();

        // Wait for navigation after clicking Test Account
        await page.waitForLoadState('domcontentloaded');

        await page.goto('https://www.orangecarrier.com/testaccount/services/cli/access', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        await page.addStyleTag({ content: '.popup-message { display: none !important; }' });

        await page.locator('#CLI').evaluate((el) => {
            el.value = '000';
            el.dispatchEvent(new Event('input', { bubbles: true }));
        });

        const responsePromise = page.waitForResponse(
            resp => resp.url().includes('/testaccount/services/cli/access/get'),
            { timeout: 60000 }
        );
        await page.locator('button:has-text("Search")').evaluate(el => el.click());
        await responsePromise;

        await page.waitForSelector('th:has-text("Termination")', { timeout: 60000 });

        const cookies = await context.cookies();
        const sessionCookieObj = cookies.find(c => c.name === 'orange_carrier_session');
        if (sessionCookieObj) {
            sessionCookie = sessionCookieObj.value;
        }

        return { csrfToken, sessionCookie };

    } finally {
        await browser.close();
    }
}

export async function login() {
    try {
        let tokens;
        if (USE_BROWSERLESS) {
            tokens = await loginWithPuppeteer();
        } else {
            tokens = await loginWithPlaywright();
        }

        const { csrfToken, sessionCookie } = tokens;
        const envPath = path.join(process.cwd(), '.env');
        let envContent = '';

        if (fs.existsSync(envPath)) {
            envContent = fs.readFileSync(envPath, 'utf-8');
        }

        const updateEnvVar = (content, key, value) => {
            const regex = new RegExp(`^${key}=.*$`, 'm');
            if (regex.test(content)) {
                return content.replace(regex, `${key}=${value}`);
            } else {
                return content + (content.endsWith('\n') || content === '' ? '' : '\n') + `${key}=${value}\n`;
            }
        };

        envContent = updateEnvVar(envContent, 'X_CSRF_TOKEN', csrfToken);
        envContent = updateEnvVar(envContent, 'ORANGE_CARRIER_SESSION', sessionCookie);
        const ts = Date.now().toString();
        envContent = updateEnvVar(envContent, 'LAST_TOKEN_REFRESH', ts);

        // Write file first, then update process.env only on success
        try {
            fs.writeFileSync(envPath, envContent);
        } catch (writeError) {
            console.error('Failed to write env file:', writeError.message);
            throw writeError;
        }

        // Update process.env only after file write succeeds
        process.env.X_CSRF_TOKEN = csrfToken;
        process.env.ORANGE_CARRIER_SESSION = sessionCookie;
        process.env.LAST_TOKEN_REFRESH = ts;

        console.log('Tokens saved');

        return tokens;

    } catch (error) {
        console.error('Login error:', error.message);
        throw error;
    }
}

if (import.meta.main) {
    login();
}
