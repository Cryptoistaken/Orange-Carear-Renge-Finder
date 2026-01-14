import { Telegraf } from 'telegraf';
import { DBHandler } from './db.js';
import dotenv from 'dotenv';

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN || '');
const dbHandler = new DBHandler();

const liveMessages = new Map();

function formatRangeList(ranges, title) {
    if (ranges.length === 0) {
        return `${title}\n\nNo results found.`;
    }

    let msg = `${title}\n\n`;
    msg += `\`\`\`\n`;
    msg += `${'#'.padEnd(3)}${'Range'.padEnd(35)}${'Country'.padEnd(12)}${'Calls'.padEnd(7)}${'CLIs'.padEnd(6)}\n`;
    msg += `${'─'.repeat(63)}\n`;

    ranges.forEach((r, i) => {
        const rank = `${i + 1}`;
        const name = r.name.length > 33 ? r.name.substring(0, 30) + '...' : r.name;
        const country = r.country.length > 10 ? r.country.substring(0, 8) + '..' : r.country;
        msg += `${rank.padEnd(3)}${name.padEnd(35)}${country.padEnd(12)}${String(r.calls).padEnd(7)}${String(r.clis).padEnd(6)}\n`;
    });

    msg += `\`\`\``;
    return msg;
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
            { parse_mode: 'Markdown' }
        );
    } catch (e) {
    }
}

bot.start(async (ctx) => {
    dbHandler.initDB();
    const msg = await ctx.reply(formatRangeList(dbHandler.getTopRanges(10), 'TOP 10 RANGES'), { parse_mode: 'Markdown' });
    liveMessages.set(ctx.chat.id, { chatId: ctx.chat.id, messageId: msg.message_id });
});

bot.command('top', async (ctx) => {
    const live = liveMessages.get(ctx.chat.id);
    if (live) {
        live.keyword = undefined;
        await updateLiveMessage(ctx.chat.id);
    } else {
        const msg = await ctx.reply(formatRangeList(dbHandler.getTopRanges(10), 'TOP 10 RANGES'), { parse_mode: 'Markdown' });
        liveMessages.set(ctx.chat.id, { chatId: ctx.chat.id, messageId: msg.message_id });
    }
});

bot.command('search', async (ctx) => {
    const keyword = ctx.message.text.split(' ').slice(1).join(' ').trim();
    if (!keyword) {
        await ctx.reply('Usage: /search <keyword>');
        return;
    }

    const ranges = dbHandler.searchRanges(keyword, 10);
    const msg = await ctx.reply(formatRangeList(ranges, `Search: "${keyword}"`), { parse_mode: 'Markdown' });
    liveMessages.set(ctx.chat.id, { chatId: ctx.chat.id, messageId: msg.message_id, keyword: keyword });
});

bot.on('text', async (ctx) => {
    const keyword = ctx.message.text.trim();
    if (keyword.startsWith('/')) return;

    const ranges = dbHandler.searchRanges(keyword, 10);
    const msg = await ctx.reply(formatRangeList(ranges, `Search: "${keyword}"`), { parse_mode: 'Markdown' });
    liveMessages.set(ctx.chat.id, { chatId: ctx.chat.id, messageId: msg.message_id, keyword: keyword });
});

setInterval(() => {
    for (const chatId of liveMessages.keys()) {
        updateLiveMessage(chatId);
    }
}, 5000);

export async function main() {
    bot.launch();
    console.log('Bot started');

    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

if (import.meta.main) {
    main();
}
