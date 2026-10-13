/** The /setemoji screens: pick a slot or a product, then send a premium emoji. */
import {
  be,
  clearProductEmoji,
  clearSlotEmoji,
  fetchEmojiImage,
  listSlotOverrides,
  premiumEnabled,
  productEmojiChar,
  productEmojiEntry,
  productEmojiStats,
  readEmoji,
  saveSlotImage,
  setPremiumEnabled,
  setProductEmoji,
  setSlotEmoji,
  slotEntry,
  slotStats,
  verifyEntry,
  EMOJI_SLOTS,
} from "@/lib/emoji.server";
import { VALID_EMOJI_ID } from "@/lib/telegram-entities";
import { allProducts, say, setState } from "./core";

const EM_PAGE = 12;

/**
 * Hide "ghost" product rows — ones left with no title but a non-manual
 * delivery, created when a product is deleted while a supplier sync patch is
 * mid-flight. They would otherwise show as blank "Item" buttons here.
 */
function liveProducts(all: Record<string, any>): [string, any][] {
  return Object.entries(all).filter(
    ([, p]) => p && (String(p.title || "").trim() !== "" || String(p.delivery || "manual") === "manual"),
  );
}

/** Show the saved custom emoji on setup buttons, not just in the shop. */
function emojiButton(text: string, callback_data: string, id?: string) {
  return {
    text,
    callback_data,
    ...(premiumEnabled() && id && VALID_EMOJI_ID.test(id) ? { icon_custom_emoji_id: id } : {}),
  };
}

function emPager(prefix: string, page: number, total: number) {
  const pages = Math.max(1, Math.ceil(total / EM_PAGE));
  if (pages < 2) return [] as any[];
  const row: any[] = [];
  if (page > 0) row.push({ text: "⬅️ Previous Page", callback_data: `${prefix}${page - 1}` });
  row.push({ text: `${page + 1}/${pages}`, callback_data: "noop" });
  if (page < pages - 1) row.push({ text: "Next Page ➡️", callback_data: `${prefix}${page + 1}` });
  return [row];
}

export async function emojiHome(chatId: number, note = "") {
  const all = await allProducts();
  const p = productEmojiStats(liveProducts(all).map(([id]) => id));
  const s = slotStats();
  const on = premiumEnabled();
  await say(
    chatId,
    `😍 <b>Emoji setup</b>\n\nPick the place you want to change, then send the premium emoji for it. Each place keeps its own emoji, so nothing else changes with it.\n\n🎯 Places set: ${s.set}/${s.total} (✨${s.premium} premium)\n🛍 Product emojis: ${p.set}/${p.total} (✨${p.premium})\n⚙️ Premium emojis: ${on ? "on" : "off"}${note ? `\n\n${note}` : ""}`,
    {
      inline_keyboard: [
        [
          { text: "🔘 Button emojis", callback_data: "a:emg:button:0" },
          { text: "🔤 Normal emojis", callback_data: "a:emg:normal:0" },
        ],
        [{ text: "🌐 Website emojis", callback_data: "a:emg:web:0" }],
        [
          { text: "📋 Saved emojis", callback_data: "a:em:list" },
          { text: "🛍 Product emojis", callback_data: "a:em:prod" },
        ],
        [{ text: "🔄 Sync website artwork", callback_data: "a:em:sync" }],
        [{ text: on ? "🚫 Turn premium off" : "✨ Turn premium on", callback_data: "a:em:tog" }],
        [{ text: "♻️ Reset all emojis", callback_data: "a:em:rst" }],
        [{ text: "⬅️ Back to Admin Panel", callback_data: "a:home" }],
      ],
    },
  );
}

const GROUP_TITLE: Record<string, string> = {
  button: "🔘 <b>Button emojis</b>",
  normal: "🔤 <b>Normal emojis</b>",
  web: "🌐 <b>Website emojis</b>",
};

/** Every place the bot/website shows an emoji, grouped by where it appears. */
export async function emojiGroup(chatId: number, group: string, page = 0) {
  const slots = Object.entries(EMOJI_SLOTS).filter(([, v]) => v.group === group);
  if (!slots.length)
    return say(chatId, "Nothing here yet.", {
      inline_keyboard: [[{ text: "⬅️ Back to Emoji Setup", callback_data: "a:em" }]],
    });
  const slice = slots.slice(page * EM_PAGE, page * EM_PAGE + EM_PAGE);
  await say(
    chatId,
    `${GROUP_TITLE[group] || "Emojis"}\nTap one, then send the emoji you want to use instead.`,
    {
      inline_keyboard: [
        ...slice.map(([key, v]) => [emojiButton(`${be(key)} ${v.label}`, `a:emk:${key}`, slotEntry(key)?.id)]),
        ...emPager(`a:emg:${group}:`, page, slots.length),
        [{ text: "⬅️ Back to Emoji Setup", callback_data: "a:em" }],
      ],
    },
  );
}

/** Admin picked a place — ask for the emoji to use there. */
export async function emojiSlotPick(chatId: number, slotKey: string) {
  const slot = EMOJI_SLOTS[slotKey];
  if (!slot) return emojiHome(chatId);
  await setState(chatId, { k: "em_to", a: slotKey });
  return say(
    chatId,
    `Send the new emoji for <b>${slot.label}</b> (now ${premiumEnabled() && slotEntry(slotKey)?.id ? `<tg-emoji emoji-id="${slotEntry(slotKey)?.id}">${be(slotKey)}</tg-emoji>` : be(slotKey)}).\nPremium (custom) emojis work too.`,
    {
      inline_keyboard: [
        [{ text: "♻️ Use the default", callback_data: `a:emd:${slotKey}` }],
        [{ text: "❌ Cancel", callback_data: `a:emg:${slot.group}:0` }],
      ],
    },
  );
}

export async function emojiList(chatId: number, page = 0) {
  const saved = listSlotOverrides();
  if (!saved.length)
    return say(chatId, "No emoji changed yet.", {
      inline_keyboard: [[{ text: "⬅️ Back to Emoji Setup", callback_data: "a:em" }]],
    });
  const slice = saved.slice(page * EM_PAGE, page * EM_PAGE + EM_PAGE);
  await say(chatId, "📋 <b>Saved emojis</b>\nTap one to put the default back.", {
    inline_keyboard: [
      ...slice.map((r) => [
        emojiButton(`${r.char} ${EMOJI_SLOTS[r.slot]?.label || r.slot}${r.id ? " ✨" : ""}`, `a:emd:${r.slot}`, r.id),
      ]),
      ...emPager("a:emL:", page, saved.length),
      [{ text: "⬅️ Back to Emoji Setup", callback_data: "a:em" }],
    ],
  });
}

export async function emojiProducts(chatId: number, page = 0) {
  const all = await allProducts();
  const entries = liveProducts(all);
  if (!entries.length)
    return say(chatId, "No products yet.", {
      inline_keyboard: [[{ text: "⬅️ Back to Emoji Setup", callback_data: "a:em" }]],
    });
  const slice = entries.slice(page * EM_PAGE, page * EM_PAGE + EM_PAGE);
  await say(chatId, "🛍 <b>Product emojis</b>\nChoose a product, then send the emoji.", {
    inline_keyboard: [
      ...slice.map(([id, p]) => [
        emojiButton(`${productEmojiChar(id)} ${p.title || "Item"}`, `a:emp:${id}`, productEmojiEntry(id).id),
      ]),
      ...emPager("a:emP:", page, entries.length),
      [{ text: "⬅️ Back to Emoji Setup", callback_data: "a:em" }],
    ],
  });
}

/** Save the emoji the admin sent for one place. */
export async function emojiToMessage(
  chatId: number,
  slot: string,
  text: string,
  entities?: any[],
  sticker?: any,
) {
  const raw = readEmoji(text, entities, sticker);
  if (!raw) return say(chatId, "Please send one emoji.");
  const value = await verifyEntry(raw);
  try {
    await setSlotEmoji(slot, value);
  } catch (error) {
    console.error("emoji save failed", error);
    return say(chatId, "❌ That emoji could not be saved. Please try again.");
  }
  await setState(chatId, null);
  let note = "";
  if (value.id) {
    const img = await fetchEmojiImage(value.id);
    if (img) await saveSlotImage(slot, img);
    else note = "\n⚠️ The website could not download this premium emoji's picture.";
  } else if (raw.id) {
    note = "\n⚠️ Telegram did not accept that premium emoji, so the plain one is used.";
  }
  const where = EMOJI_SLOTS[slot]?.label || slot;
  await say(
    chatId,
    `✅ Saved: ${where} ➜ ${value.id ? `<tg-emoji emoji-id="${value.id}">${value.char}</tg-emoji> (premium ✨)` : value.char}${note}`,
  );
  return emojiHome(chatId);
}

/** Product emoji step. */
export async function emojiProductMessage(
  chatId: number,
  productId: string,
  text: string,
  entities?: any[],
  sticker?: any,
) {
  const raw = readEmoji(text, entities, sticker);
  if (!raw) return say(chatId, "Please send one emoji.");
  const value = await verifyEntry(raw);
  try {
    await setProductEmoji(productId, value);
  } catch (error) {
    console.error("product emoji save failed", error);
    return say(chatId, "❌ That emoji could not be saved. Please try again.");
  }
  if (value.id) {
    const img = await fetchEmojiImage(value.id);
    if (img) await setProductEmoji(productId, { ...value, img });
  }
  await setState(chatId, null);
  await say(chatId, `✅ Product emoji saved: ${value.id ? `<tg-emoji emoji-id="${value.id}">${value.char}</tg-emoji> (premium ✨)` : value.char}`);
  return emojiProducts(chatId);
}

/** Put the built-in emoji back for one place. */
export async function emojiSlotReset(chatId: number, slot: string) {
  await clearSlotEmoji(slot);
  await setState(chatId, null);
  return emojiHome(chatId, `♻️ ${EMOJI_SLOTS[slot]?.label || slot} is back to the default.`);
}

/** Switch premium emojis on or off everywhere. */
export async function emojiToggle(chatId: number) {
  const on = !premiumEnabled();
  await setPremiumEnabled(on);
  return emojiHome(chatId, on ? "✨ Premium emojis are on." : "🚫 Premium emojis are off.");
}

export { clearProductEmoji };
