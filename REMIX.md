# Set up this store on a new database

The store runs on Supabase. Nothing store-specific is hardcoded: owners, bot
admins, the deposit wallet and links all come from environment variables or
Admin → Settings. Copy `.env.example` to `.env` (and add the same variables in
Railway → Variables).

## 1. Database

1. Create a Supabase project, enable Email auth.
2. In the SQL editor run the files in `drizzle/migrations/` in order
   (`0000_…`, `0001_…`, `0002_…`).
3. Set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   and the three `VITE_SUPABASE_*` copies.

## 2. Owners

- Website admin = a verified login whose email is in `OWNER_EMAILS` (server
  env, read at runtime). Nothing to edit in the database: the server creates or
  removes the `user_roles` rows on login. Keep "Confirm email" on in Supabase
  Auth. After changing `OWNER_EMAILS`, restart the service (no rebuild needed).
- Bot admins = Settings → Telegram owner IDs, or `TELEGRAM_OWNER_IDS`. There is
  no "first person who opens the bot becomes owner" rule.

## 3. Store values (Settings overrides env)

| Env variable | Settings field |
| --- | --- |
| `SITE_URL` | Website address |
| `TELEGRAM_BOT_USERNAME` | Telegram bot username |
| `TELEGRAM_OWNER_IDS` | Telegram owner IDs |
| `TELEGRAM_NOTIFY_GROUP` | Notification group ID |
| `DEPOSIT_ADDRESS` | Crypto deposit address |
| `PROVIDER_*_KEY` | API shops → key |

Everything else — store name, banners, SMTP, bot token (**Save & connect
Telegram bot**), Razorpay/Binance keys, products, coupons — is set from the
admin panel.
