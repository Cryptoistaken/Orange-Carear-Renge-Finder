# Orange Carrier Range Finder

A Telegram bot that monitors and displays live carrier ranges from Orange Carrier.

## Quick Start

```bash
npm install
npm start
```

## Deployment

### Local
```bash
npm install
npm start
```
Uses HTTP polling mode.

### Railway
Deploy directly to Railway. The bot auto-detects Railway environment and:
- Sets up webhook using `RAILWAY_PUBLIC_DOMAIN`
- Starts HTTP server on `PORT`

No additional configuration needed.

## Features

- Live range leaderboard with auto-refresh (every 10 seconds for 5 minutes)
- After 5 minutes, shows "Refresh" button to restart auto-refresh
- In-memory data storage (no database needed)
- Automatic token refresh via Browserless

## Bot Commands

- `/start` - Show main menu
- `/top` - Show live ranges directly

## Project Structure

```
index.js      - Single file containing all bot logic
package.json  - npm dependencies
```
