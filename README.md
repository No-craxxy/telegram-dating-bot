# Telegram Dating Bot

Telegram dating bot built with Node.js, Telegraf, MongoDB, Telegram Stars, and AdsGram rewarded ads.

## AdsGram: What to fill in the ad block form
Use these values in the AdsGram `Edit ad block` page:

- Name: any name you want
- Ad platform: your created bot platform
- Block type: `Bot`
- Reward URL (for strict validator): `https://telegram-dating-bot-production.up.railway.app/adsgram/reward/YOUR_LONG_SECRET?userid=[userid]`

After saving, copy these from AdsGram:

- API token
- Block ID

## Environment variables
Set these in Railway service variables:

```env
BOT_TOKEN=your_telegram_bot_token
MONGODB_URI=your_mongodb_connection_string
BOT_USERNAME=your_bot_username_without_at

# Optional admin users
ADMIN_IDS=123456789,987654321

# AdsGram
ADSGRAM_API_TOKEN=your_adsgram_api_token
ADSGRAM_BLOCK_ID=bot-23872
ADSGRAM_LANGUAGE=en
ADSGRAM_REWARD_SWIPES=5
ADSGRAM_DEEP_LINK_PAYLOAD=ads_reward
ADSGRAM_REWARD_TTL_MS=3600000
ADSGRAM_MIN_CLAIM_DELAY_MS=10000
ADSGRAM_REWARD_SECRET=your_long_random_secret

# Railway
PORT=3000
```

## Reward flow (already implemented in `index.js`)

1. User hits daily swipe limit.
2. User taps `Watch Video & Get 5 Swipes`.
3. Bot requests an ad from AdsGram (`/api/advbot`) and sends sponsor links.
4. After ad completion, AdsGram calls your Reward URL with `userid=[userid]`.
5. Bot credits reward swipes once and sends a confirmation message to that user.

## Railway deployment steps

1. Push this repo to GitHub.
2. In Railway, create a new project from the repo.
3. Use service type `Web Service` (this app now listens on `PORT`).
4. Set all env vars listed above.
5. Deploy.
6. Open health check:
   - `https://telegram-dating-bot-production.up.railway.app/health`
   - Must return `ok`.
7. In AdsGram, keep Reward URL exactly:
   - `https://telegram-dating-bot-production.up.railway.app/adsgram/reward/YOUR_LONG_SECRET?userid=[userid]`
8. Test in Telegram:
   - Reach swipe limit
   - Tap watch video button
   - Complete ad and claim reward

## Run locally

```bash
npm install
npm start
```

## Notes

- Telegram Stars purchases (`40` and `80` swipes) are still enabled.
- If `BOT_USERNAME` is missing, Reward URL redirect cannot return user to your bot.
- If no ad inventory is available, bot tells user to try again later.
