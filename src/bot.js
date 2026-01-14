import { Telegraf, Markup } from 'telegraf';
import { DBHandler } from './db.js';
import dotenv from 'dotenv';

dotenv.config({ debug: false });

const bot = new Telegraf(process.env.BOT_TOKEN || '');
const dbHandler = new DBHandler();

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
        const timeAgo = formatTimeAgo(r.lastSeenTimestamp);
        const clis = dbHandler.getTopClisForRange(name, 3);
        const clisDisplay = clis.length > 0 ? clis.map(c => `\`${c}\``).join(', ') : 'N/A';

        msg += `*#${i + 1}*\n`;
        msg += `├─ Range: \`${name}\`\n`;
        msg += `├─ Calls: ${r.calls}\n`;
        msg += `├─ CLIs: ${r.clis || 0}\n`;
        msg += `├─ Top CLIs: ${clisDisplay}\n`;
        msg += `└─ Last: ${timeAgo}\n`;
        msg += '\n';
    });

    return msg.trim();
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

    try {
        let ranges;
        let title;

        if (live.keyword) {
            ranges = dbHandler.searchRanges(live.keyword, 10);
            title = `Search: "${live.keyword}"`;
        } else {
            ranges = dbHandler.getTopRanges(10);
            title = '';
        }

        const text = formatRangeList(ranges, title, !!live.keyword);

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
            return;
        }
    }
}

bot.start(async (ctx) => {
    try {
        dbHandler.initDB();
        userStates.delete(ctx.chat.id);
        liveMessages.delete(ctx.chat.id);

        await ctx.reply('Welcome! Choose an option:', getStartKeyboard());
    } catch (e) {
        await ctx.reply('Error starting bot. Please try again.');
    }
});

bot.action('live_ranges', async (ctx) => {
    try {
        userStates.delete(ctx.chat.id);
        const ranges = dbHandler.getTopRanges(10);
        const text = formatRangeList(ranges, '', false);

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
        const ranges = dbHandler.getTopRanges(10);
        const text = formatRangeList(ranges, '', false);

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
        const ranges = dbHandler.searchRanges(keyword, 10);
        const text = formatRangeList(ranges, `Search: "${keyword}"`, true);

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
            const ranges = dbHandler.searchRanges(keyword, 10);
            const msgText = formatRangeList(ranges, `Search: "${keyword}"`, true);

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
            const ranges = dbHandler.searchRanges(text, 10);
            const msgText = formatRangeList(ranges, `Search: "${text}"`, true);

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
