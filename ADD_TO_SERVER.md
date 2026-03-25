# Adding the Bot to a Discord Server

## 1. Create a Discord Application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application**, give it a name, and save
3. Go to the **Bot** tab and click **Add Bot**
4. Under **Token**, click **Reset Token** and copy it — this is your `DISCORD_TOKEN`
5. Under **Privileged Gateway Intents**, enable:
   - **Message Content Intent**
   - **Server Members Intent** (if needed)

## 2. Invite the Bot to Your Server

1. In the Developer Portal, go to **OAuth2 > URL Generator**
2. Under **Scopes**, check:
   - `bot`
   - `applications.commands`
3. Under **Bot Permissions**, check what the bot needs (at minimum: **Send Messages**, **Read Message History**, **Use Slash Commands**)
4. Copy the generated URL, open it in a browser, and select your server

## 3. Configure Environment Variables

Copy `.env.example` to `.env` and fill in the values:

```
CLIENT_ID=      # Your bot's Application ID (from Developer Portal > General Information)
DISCORD_TOKEN=  # Your bot token (from step 1)
GUILD_ID=       # Right-click your server in Discord > Copy Server ID
```

To enable **Developer Mode** in Discord (required for copying IDs):
Settings > Advanced > Developer Mode

Fill in the channel IDs by right-clicking each channel in Discord and selecting **Copy Channel ID**.

## 4. Install Dependencies

```bash
npm install
```

## 5. Register Slash Commands

Commands are registered per-guild (instant updates). Run the deploy step once whenever you add or change commands:

```bash
node -e "import('./apps/familygo/deploy-commands.js').then(m => m.deployCommands())"
```

## 6. Start the Bot

```bash
npm start
```

You should see `Logged in as <BotName>#XXXX` in the console.
