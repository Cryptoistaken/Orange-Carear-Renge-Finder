import 'dotenv/config';
import { main as monitorMain } from './monitor.js';
import { main as botMain } from './bot.js';

console.log('Starting Orange Carrier Range Finder System...');

Promise.all([
    monitorMain().catch(err => console.error('Monitor crashed:', err)),
    botMain().catch(err => console.error('Bot crashed:', err))
]).catch(err => {
    console.error('System fatal error:', err);
    process.exit(1);
});
