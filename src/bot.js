import { Telegraf, Markup } from 'telegraf';
import { dbHandler, globalStats } from './monitor.js';
import dotenv from 'dotenv';

dotenv.config({ debug: false, quiet: true });

if (!process.env.BOT_TOKEN) {
    throw new Error('BOT_TOKEN environment variable is required');
}

const bot = new Telegraf(process.env.BOT_TOKEN);

const liveMessages = new Map();
const userStates = new Map();

function formatTimeAgo(timestamp) {
    if (!timestamp) return 'N/A';
    const seconds = Math.floor((Date.now() - timestamp) / 1000);

    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

function formatRangeList(ranges, title, includeTitle = false) {
    if (ranges.length === 0) {
        if (includeTitle && title) {
            return `*${title}*\n\nNo results found. Try a different keyword.`;
        }
        return 'No results found.';
    }

    let msg = includeTitle ? `*${title}*\n\n` : '';

    ranges.forEach((r, i) => {
        const name = r.name;
        const absoluteTime = new Date(r.lastSeenTimestamp).toLocaleTimeString('en-US', {
            timeZone: 'Asia/Dhaka',
            hour12: true,
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric'
        });

        // Calculate relative time
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

        const clis = dbHandler.getTopClisForRange(name, 3);
        const clisDisplay = clis.length > 0 ? clis.map(c => `\`${c}\``).join(', ') : 'N/A';

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
    return `*Initializing...*\n\nFetching data from all countries.\nProgress: ${progress}\nRecords so far: ${globalStats.totalRecords}\n\n_Updated: ${timeStr}_`;
}

function getDisplayText(keyword = undefined) {
    if (globalStats.isInitialPhase) {
        return getInitMessage();
    }

    let ranges;
    let title;

    if (keyword) {
        ranges = dbHandler.searchRanges(keyword, 10);
        title = `Search: "${keyword}"`;
        return formatRangeList(ranges, title, true);
    } else {
        ranges = dbHandler.getTopRanges(10);
        return formatRangeList(ranges, '', false);
    }
}

function getStartKeyboard() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback('Live Ranges', 'live_ranges'),
            Markup.button.callback('Search Keyword', 'search_prompt')
        ]
    ]);
}

function getRangeListKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('Back to Menu', 'back_menu')]
    ]);
}

function getSearchKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('Back to Menu', 'back_menu')]
    ]);
}

async function updateLiveMessage(chatId) {
    const live = liveMessages.get(chatId);
    if (!live || !live.showingList) return;

    // Prevent concurrent updates for the same chat
    if (live.updating) return;
    live.updating = true;

    if (live.pauseUntil && Date.now() < live.pauseUntil) {
        live.updating = false;
        return;
    }
    live.pauseUntil = undefined;

    try {
        const text = getDisplayText(live.keyword);

        await bot.telegram.editMessageText(
            chatId,
            live.messageId,
            undefined,
            text,
            {
                parse_mode: 'Markdown',
                ...getRangeListKeyboard()
            }
        );
    } catch (e) {
        if (e.description && e.description.includes('message is not modified')) {
            // This is okay, content hasn't changed
        } else if (e.description && e.description.includes('Too Many Requests')) {
            const retryAfter = e.parameters?.retry_after || 5;
            live.pauseUntil = Date.now() + (retryAfter * 1000);
        } else if (e.description && (e.description.includes('message to edit not found') || e.description.includes("message can't be edited"))) {
            liveMessages.delete(chatId);
        } else {
            console.error('Live update error:', e.description || e.message || e);
        }
    } finally {
        // Always release the lock
        const currentLive = liveMessages.get(chatId);
        if (currentLive) {
            currentLive.updating = false;
        }
    }
}

bot.start(async (ctx) => {
    try {
        userStates.delete(ctx.chat.id);
        liveMessages.delete(ctx.chat.id);

        await ctx.reply('Welcome! Choose an option:', getStartKeyboard());
    } catch (e) {
        console.error('Start command error:', e.message || e);
        await ctx.reply('Error starting bot. Please try again.');
    }
});

bot.action('live_ranges', async (ctx) => {
    try {
        userStates.delete(ctx.chat.id);
        const text = getDisplayText();

        const msg = await ctx.reply(text, {
            parse_mode: 'Markdown',
            ...getRangeListKeyboard()
        });

        liveMessages.set(ctx.chat.id, {
            chatId: ctx.chat.id,
            messageId: msg.message_id,
            showingList: true,
            keyword: undefined
        });

        await ctx.answerCbQuery();
    } catch (e) {
        await ctx.answerCbQuery('Error');
    }
});

bot.action('search_prompt', async (ctx) => {
    try {
        userStates.set(ctx.chat.id, { waitingForKeyword: true });
        await ctx.reply('Enter the keyword to search:', getSearchKeyboard());
        await ctx.answerCbQuery();
    } catch (e) {
        await ctx.answerCbQuery('Error');
    }
});

bot.action('back_menu', async (ctx) => {
    try {
        userStates.delete(ctx.chat.id);
        liveMessages.delete(ctx.chat.id);
        await ctx.reply('Choose an option:', getStartKeyboard());
        await ctx.answerCbQuery();
    } catch (e) {
        await ctx.answerCbQuery('Error');
    }
});

bot.command('top', async (ctx) => {
    try {
        userStates.delete(ctx.chat.id);
        const text = getDisplayText();

        const msg = await ctx.reply(text, {
            parse_mode: 'Markdown',
            ...getRangeListKeyboard()
        });

        liveMessages.set(ctx.chat.id, {
            chatId: ctx.chat.id,
            messageId: msg.message_id,
            showingList: true,
            keyword: undefined
        });
    } catch (e) {
        await ctx.reply('Error fetching top ranges.');
    }
});

bot.command('search', async (ctx) => {
    try {
        const keyword = ctx.message.text.split(' ').slice(1).join(' ').trim();
        if (!keyword) {
            userStates.set(ctx.chat.id, { waitingForKeyword: true });
            await ctx.reply('Enter the keyword to search:', getSearchKeyboard());
            return;
        }

        userStates.delete(ctx.chat.id);
        const text = getDisplayText(keyword);

        const msg = await ctx.reply(text, {
            parse_mode: 'Markdown',
            ...getRangeListKeyboard()
        });

        liveMessages.set(ctx.chat.id, {
            chatId: ctx.chat.id,
            messageId: msg.message_id,
            showingList: true,
            keyword: keyword
        });
    } catch (e) {
        await ctx.reply('Error searching ranges.');
    }
});

bot.on('text', async (ctx) => {
    try {
        const text = ctx.message.text.trim();
        if (text.startsWith('/')) return;

        const state = userStates.get(ctx.chat.id);

        if (state && state.waitingForKeyword) {
            userStates.delete(ctx.chat.id);
            const keyword = text;
            const msgText = getDisplayText(keyword);

            const msg = await ctx.reply(msgText, {
                parse_mode: 'Markdown',
                ...getRangeListKeyboard()
            });

            liveMessages.set(ctx.chat.id, {
                chatId: ctx.chat.id,
                messageId: msg.message_id,
                showingList: true,
                keyword: keyword
            });
        } else {
            const msgText = getDisplayText(text);

            const msg = await ctx.reply(msgText, {
                parse_mode: 'Markdown',
                ...getRangeListKeyboard()
            });

            liveMessages.set(ctx.chat.id, {
                chatId: ctx.chat.id,
                messageId: msg.message_id,
                showingList: true,
                keyword: text
            });
        }
    } catch (e) {
        console.error('Text handler error:', e.message || e);
        await ctx.reply('Error processing your message.');
    }
});

// Use recursive setTimeout instead of setInterval for reliable sequencing
async function runUpdateCycle() {
    const chatIds = Array.from(liveMessages.keys());

    for (const chatId of chatIds) {
        try {
            await updateLiveMessage(chatId);
        } catch (err) {
            console.error('Update error for chat', chatId, ':', err.message || err);
        }
    }

    // Schedule next update after 1 second
    setTimeout(runUpdateCycle, 1000);
}

bot.catch((err) => {
    const msg = err && err.message ? err.message : String(err);
    console.error('Bot error:', msg);
});

export async function main() {
    try {
        const isRailway = !!process.env.RAILWAY_ENVIRONMENT;

        if (isRailway) {
            const webhookDomain = 'orangecarrier.up.railway.app';
            await bot.telegram.setWebhook(`https://${webhookDomain}/webhook`);
            console.log('Bot webhook set:', webhookDomain);
        } else {
            await bot.launch({
                dropPendingUpdates: true
            });
            console.log('Bot started (polling)');
        }

        // Start the update cycle after bot is initialized
        setTimeout(runUpdateCycle, 1000);

        process.once('SIGINT', () => bot.stop('SIGINT'));
        process.once('SIGTERM', () => bot.stop('SIGTERM'));
    } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.error('Failed to start bot:', msg);
        throw e;
    }
}

export function getWebhookHandler() {
    return bot.webhookCallback('/webhook');
}

if (import.meta.main) {
    main();
}
