import { Telegraf, Markup } from 'telegraf';
import { DBHandler } from './db.js';
import dotenv from 'dotenv';

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN || '');
const dbHandler = new DBHandler();

const liveMessages = new Map();

function formatTimeAgo(timestamp) {
    if (!timestamp) return 'N/A';
    const seconds = Math.floor((Date.now() - timestamp) / 1000);

    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

function formatRangeList(ranges, title) {
    if (ranges.length === 0) {
        return `${title}\n\nNo results found.`;
    }

    let msg = `*${title}*\n\n`;

    ranges.forEach((r, i) => {
        const rank = `#${i + 1}`;
        const name = r.name;
        const country = r.country;
        const timeAgo = formatTimeAgo(r.lastSeenTimestamp);

        msg += `${rank} \`${name}\`\n`;
        msg += `${country} | Calls: ${r.calls} | Last: ${timeAgo}\n\n`;
    });

    return msg;
}

function getMainKeyboard() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback('Top 10', 'top'),
            Markup.button.callback('Refresh', 'refresh')
        ]
    ]);
}

async function sendOrUpdateMessage(ctx, text, isNew = false) {
    try {
        if (isNew) {
            const msg = await ctx.reply(text, {
                parse_mode: 'Markdown',
                ...getMainKeyboard()
            });
            liveMessages.set(ctx.chat.id, { chatId: ctx.chat.id, messageId: msg.message_id });
            return msg;
        }

        const live = liveMessages.get(ctx.chat.id);
        if (live) {
            await bot.telegram.editMessageText(
                live.chatId,
                live.messageId,
                undefined,
                text,
                {
                    parse_mode: 'Markdown',
                    ...getMainKeyboard()
                }
            );
        }
    } catch (e) {
        if (e.description && e.description.includes('message is not modified')) {
            return;
        }
    }
}

async function updateLiveMessage(chatId) {
    const live = liveMessages.get(chatId);
    if (!live) return;

    try {
        let ranges;
        let title;

        if (live.keyword) {
            ranges = dbHandler.searchRanges(live.keyword, 10);
            title = `Search: "${live.keyword}"`;
        } else {
            ranges = dbHandler.getTopRanges(10);
            title = `TOP 10 RANGES`;
        }

        const text = formatRangeList(ranges, title);

        await bot.telegram.editMessageText(
            chatId,
            live.messageId,
            undefined,
            text,
            {
                parse_mode: 'Markdown',
                ...getMainKeyboard()
            }
        );
    } catch (e) {
        if (e.description && e.description.includes('message is not modified')) {
            return;
        }
    }
}

bot.start(async (ctx) => {
    try {
        dbHandler.initDB();
        const text = formatRangeList(dbHandler.getTopRanges(10), 'TOP 10 RANGES');
        await sendOrUpdateMessage(ctx, text, true);
    } catch (e) {
        await ctx.reply('Error starting bot. Please try again.');
    }
});

bot.command('top', async (ctx) => {
    try {
        const live = liveMessages.get(ctx.chat.id);
        if (live) {
            live.keyword = undefined;
            await updateLiveMessage(ctx.chat.id);
        } else {
            const text = formatRangeList(dbHandler.getTopRanges(10), 'TOP 10 RANGES');
            await sendOrUpdateMessage(ctx, text, true);
        }
    } catch (e) {
        await ctx.reply('Error fetching top ranges.');
    }
});

bot.command('search', async (ctx) => {
    try {
        const keyword = ctx.message.text.split(' ').slice(1).join(' ').trim();
        if (!keyword) {
            await ctx.reply('Usage: /search <keyword>');
            return;
        }

        const ranges = dbHandler.searchRanges(keyword, 10);
        const text = formatRangeList(ranges, `Search: "${keyword}"`);
        const msg = await ctx.reply(text, {
            parse_mode: 'Markdown',
            ...getMainKeyboard()
        });
        liveMessages.set(ctx.chat.id, { chatId: ctx.chat.id, messageId: msg.message_id, keyword: keyword });
    } catch (e) {
        await ctx.reply('Error searching ranges.');
    }
});

bot.action('top', async (ctx) => {
    try {
        const live = liveMessages.get(ctx.chat.id);
        if (live) {
            live.keyword = undefined;
        }
        const ranges = dbHandler.getTopRanges(10);
        const text = formatRangeList(ranges, 'TOP 10 RANGES');
        await ctx.editMessageText(text, {
            parse_mode: 'Markdown',
            ...getMainKeyboard()
        });
        await ctx.answerCbQuery('Showing Top 10');
    } catch (e) {
        await ctx.answerCbQuery('Error');
    }
});

bot.action('refresh', async (ctx) => {
    try {
        const live = liveMessages.get(ctx.chat.id);
        let ranges;
        let title;

        if (live && live.keyword) {
            ranges = dbHandler.searchRanges(live.keyword, 10);
            title = `Search: "${live.keyword}"`;
        } else {
            ranges = dbHandler.getTopRanges(10);
            title = 'TOP 10 RANGES';
        }

        const text = formatRangeList(ranges, title);
        await ctx.editMessageText(text, {
            parse_mode: 'Markdown',
            ...getMainKeyboard()
        });
        await ctx.answerCbQuery('Refreshed');
    } catch (e) {
        await ctx.answerCbQuery('Error refreshing');
    }
});

bot.on('text', async (ctx) => {
    try {
        const keyword = ctx.message.text.trim();
        if (keyword.startsWith('/')) return;

        const ranges = dbHandler.searchRanges(keyword, 10);
        const text = formatRangeList(ranges, `Search: "${keyword}"`);
        const msg = await ctx.reply(text, {
            parse_mode: 'Markdown',
            ...getMainKeyboard()
        });
        liveMessages.set(ctx.chat.id, { chatId: ctx.chat.id, messageId: msg.message_id, keyword: keyword });
    } catch (e) {
        await ctx.reply('Error processing your message.');
    }
});

setInterval(() => {
    for (const chatId of liveMessages.keys()) {
        updateLiveMessage(chatId);
    }
}, 1000);

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

