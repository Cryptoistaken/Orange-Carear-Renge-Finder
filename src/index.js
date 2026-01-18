import dotenv from 'dotenv';
dotenv.config({ debug: false, quiet: true });
import http from 'http';
import { main as monitorMain } from './monitor.js';
import { main as botMain, getWebhookHandler } from './bot.js';

const isRailway = !!process.env.RAILWAY_ENVIRONMENT;

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
        botMain().catch(err => console.error('Bot error:', err.message))
    ]).catch(err => {
        console.error('Fatal error:', err.message);
        process.exit(1);
    });
}
