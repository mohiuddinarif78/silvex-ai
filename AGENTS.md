<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Telegram browsing screens use the short-lived in-memory catalogue cache; final purchases always re-read product and user data for correctness and safety.
- Telegram channel membership is checked only on `/start`; non-members may skip the prompt and continue using the bot.
- Supplier refreshes triggered by Telegram are single-flight and locally limited to once per minute to prevent interaction traffic from creating overlapping sync work.
Pandora Digital provider added to PROVIDERS (id 'pandora', string product ids, Idempotency-Key header, available_balance).
- Telegram button presentation settings live under `site_settings/button_colors`, `button_names`, and `product_buttons`; emoji metadata stays under `telegramEmoji` so premium IDs are preserved.
- Bot purchases deduct wallet and claim auto-stock via ETag transactions (`dbTransact`), refund automatically when automatic delivery fails, and split bulk deliveries into multiple messages plus a .txt file — prevents duplicate accounts, lost money and Telegram's 4096-char limit.
- Supplier orders send both `qty` and `quantity` — shops disagree on the field name and silently default to 1.
- Supplier stock changes (back in stock, +5 or more with a 3h per-product cooldown, new imports) are announced via a background queue, combined into one digest when several change; Railway also runs a 2-minute supplier check timer.
- Broadcasts run one at a time (`runBroadcast` lane), are tagged `_broadcast` so `tg()` can pause them on 429s, and shrink free-mode waves while customers use the bot — keeps live replies responsive.
- Website wallet changes (checkout, cancel refunds, crypto deposits, signup referral) run server-side in src/lib/wallet.server.ts after verifying the Firebase ID token; Firebase rules forbid customers writing wallet/history/referral fields — prevents self-credited balances.
- Access control lives in `src/lib/cloud-access.server.ts` + Supabase RLS (in the schema SQL); the old Firebase `database.rules.json` was removed after the migration. Products and `site_settings/config|smtp|providers` are admin-only; customers get products/config through the server snapshot with secret keys stripped — prevents leaking stock, bot token and payment keys.
- Admin rights require both an `owner`/`admin` role row and an email in `OWNER_EMAILS` (env) — a role alone grants nothing.
- Lovable Cloud schema: customers (legacy_uid ↔ Firebase uid, auth_user_id nullable for Telegram-only), roles in user_roles via has_role/is_staff, stock in private product_stock claimed by claim_stock(), money via wallet_adjust()/claim_payment() — row-locked atomic changes replace Firebase ETag transactions; bot-internal nodes live in kv_store keyed by path.
- scripts/copy-firebase-to-cloud.py reloads Cloud from a Firebase JSON export in DO-block batches (sandbox DB role is insert-only, so wipes go through run_sql).

- Server data access goes through Firebase-style paths in telegram.server db* helpers; `DATA_BACKEND=cloud` routes them to src/lib/cloud-db.server.ts (users/products/orders/site_settings → tables, everything else → kv_store, CAS on updated_at). Why: switch the bot over with one setting, no rewrite of ~300 calls.
- Website data/logins use src/lib/fb/{auth,database}.ts (Firebase-shaped API over Lovable Cloud auth + cloudRead/cloudWrite server fns); access rules live in src/lib/cloud-access.server.ts. Why: kept 28 pages unchanged while removing Firebase.
