# Orange Carrier Range Finder

This project is a sophisticated tool for monitoring and finding active IPRN (International Premium Rate Number) ranges on the Orange Carrier platform. It includes a continuous monitoring script, a database for historical data, and a Telegram bot for real-time interaction and alerts.

## 🚀 Features

*   **Global Monitoring**: Scans all countries for active ranges.
*   **Real-time Rankings**: Tracks top-performing ranges based on call volume and unique CLIs.
*   **Data Persistence**: Uses a local SQLite database to store range statistics and history.
*   **Telegram Bot**: Provides live updates, top 10 lists, and keyword search functionality directly from Telegram.
*   **Automated Authentication**: Handles login sessions and CSRF tokens automatically, with support for Browserless.io or local Playwright.

## 📋 Prerequisites

Before you begin, ensure you have the following installed:

*   **[Bun](https://bun.sh/)**: This project is optimized for the Bun runtime.
*   **Node.js**: Compatible connection for some dependencies.

## 🛠️ Installation

1.  **Clone the repository:**
    ```bash
    git clone <repository-url>
    cd "Orange Carear Renge Finder"
    ```

2.  **Install dependencies:**
    ```bash
    bun install
    ```

## ⚙️ Configuration

1.  Create a `.env` file in the root directory. You can copy the structure below:

    ```env
    # Telegram Bot Token (Get this from @BotFather)
    BOT_TOKEN=your_telegram_bot_token_here

    # Browserless Configuration (Optional, for cloud scraping)
    BROWSERLESS_API_KEY=your_key_here
    USE_BROWSERLESS=false

    # Session Tokens (Automatically updated by the auth script)
    X_CSRF_TOKEN=
    ORANGE_CARRIER_SESSION=
    ```

## 🖥️ Usage

The project consists of three main components: Authentication, Monitoring, and the Bot.

### 1. Authentication (`auth.js`)

The system needs valid session identifiers to fetch data. Run the auth script to log in and save tokens to your `.env` file.

```bash
bun run auth
```

*   **Note**: If `USE_BROWSERLESS` is true, it connects to Browserless.io. Otherwise, it launches a local Headless Chrome instance via Playwright.

### 2. Global Monitor (`monitor.js`)

This script runs the core scraping logic. It circles through all countries, collecting data and updating the local SQLite database.

```bash
bun run monitor
```

*   **Display**: Shows a real-time console dashboard with the top 10 ranges.
*   **Background**: Continuously updates `database/global_monitor.db`.

### 3. Telegram Bot (`bot.js`)

The bot allows you to query the database remotely.

```bash
bun run bot
```

#### Bot Commands

| Command | Description |
| :--- | :--- |
| `/start` | Initializes the bot and sends a live-updating message of the Top 10 ranges. |
| `/top` | Sends a fresh "Top 10 Ranges" list. If a live message exists, it updates it. |
| `/search <keyword>` | Searches for ranges or countries matching the keyword (e.g., `/search Cuba`). |

#### Bot Features
*   **Live Updates**: Messages created with `/start` or `/top` are automatically updated every 5 seconds with the latest data from the monitor.
*   **Formatted Output**: Results are displayed in a clean, monospaced code block for easy reading and copying.

## 📂 Project Structure

*   `src/monitor.js`: Main scraping loop and console dashboard.
*   `src/bot.js`: Telegram bot logic and command handling.
*   `src/db.js`: Database wrapper using `bun:sqlite`. Handles tables for ranges, calls history, and CLIs.
*   `src/auth.js`: Puppeteer/Playwright script for handling login flow and capturing session cookies.

## 🛡️ License

Private - For internal use only.
