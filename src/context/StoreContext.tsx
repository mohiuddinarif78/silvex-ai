import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Context,
} from "react";
import type { Auth, User } from "@/lib/fb/auth";
import type { Database } from "@/lib/fb/database";
import { toast } from "sonner";
import { getFirebase } from "@/lib/firebase";
import { isOriginProject } from "@/lib/origin";
import { PERMANENT_OWNER_EMAILS, isPermanentOwner, isRevokedAdmin } from "@/lib/owners";
import { applyReferralConfig } from "@/lib/referral";
import { slotChar } from "@/lib/web-emoji";
import { readStoreSnapshot } from "@/context/store-prime";

export type Product = {
  id: string;
  title: string;
  desc?: string;
  price: number;
  logo?: string;
  type?: string;
  link?: string;
  salesCount?: number;
  /** auto = one stock line per unit, repeat = same link, manual = admin delivers, supplier = bought live from the supplier shop */
  delivery?: "auto" | "repeat" | "manual" | "supplier";
  stock?: string[];
  usedStock?: Record<string, { content: string; orderId?: string; email?: string; date?: string }>;
  /** Linked supplier shop product (price and stock follow the supplier automatically) */
  supplierId?: string | number;
  /** Selling price = supplier price × this percent (e.g. 130 = +30%) */
  markup?: number;
  supplierPrice?: number;
  supplierStock?: number;
  supplierSyncedAt?: string;
  /** Which reseller API shop this item comes from */
  provider?: string;
  providerName?: string;
  /** Hidden products are only visible in the admin panel */
  hidden?: boolean;
  /** Hidden on the website only */
  hideWeb?: boolean;
  /** Hidden in the Telegram bot only */
  hideBot?: boolean;
  /** Optional different price used in the Telegram bot */
  botPrice?: number;
  /** Out of stock products stay listed but cannot be bought */
  soldOut?: boolean;
  /** Imported API products cannot be deleted, only hidden */
  locked?: boolean;
  /** Products sharing the same folder name show up as one item with variations */
  group?: string;
};

/** Folder key used in links and bot buttons. */
export const groupSlug = (name: string) =>
  String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);


export type CartItem = Product & {
  qty: number;
  originalPrice: number;
  discountLabel?: string | null | undefined;
};

export type Profile = {
  name?: string;
  email?: string;
  wallet?: number;
  phone?: string;
  myRefCode?: string;
  usedRef?: string;
  refBy?: string;
  refEarned?: Record<string, number>;
  history?: Record<string, { type?: string; amount?: number; date?: string; desc?: string }>;
  lastBonus?: string;
  isAdmin?: boolean;
  isOwner?: boolean;
  ownerRevoked?: boolean;
};

export type Category = { label: string; icon?: string };
export type SiteConfig = {
  qr?: string;
  fee?: number;
  marquee?: string;
  siteName?: string;
  siteTagline?: string;
  depositAddress?: string;
  supportLink?: string;
  /** Telegram support username or link (e.g. @silvexai). */
  supportTelegram?: string;
  /** When true, the website and bot show a maintenance notice to non-admins. */
  maintenanceMode?: boolean;
  /** Custom maintenance notice text shown to visitors. */
  maintenanceText?: string;
  minOrder?: number;
  lowStockAlert?: number;
  categories?: Category[];
  /** Public website address, used for links, referrals and the reseller API. */
  siteUrl?: string;
  /** Telegram bot username, without the @. */
  botUsername?: string;
  /** Telegram bot token from BotFather (set in the admin panel). */
  botToken?: string;
  /** Referral commission percent (e.g. 2) and the cap per referred friend. */
  referralRate?: number;
  referralCap?: number;
  /** Emails that always keep owner access, comma separated in the admin panel. */
  ownerEmails?: string;
  /** Telegram numeric IDs of the bot owners, comma separated. */
  telegramOwners?: string;
  /** Supplier shop reseller API (address + key), set in the admin panel. */
  supplierApiUrl?: string;
  supplierApiKey?: string;
  /** Razorpay card/UPI deposits, set in the admin panel. */
  razorpayKeyId?: string;
  razorpayKeySecret?: string;
  razorpayWebhookSecret?: string;
  /** Rupees that equal one dollar (default 100). */
  inrPerDollar?: number;
  /** Binance deposits (read-only API key, checked automatically). */
  binanceApiKey?: string;
  binanceApiSecret?: string;
  binanceAddress?: string;
  binancePayId?: string;
  binanceNetwork?: string;
  binanceCoins?: string;

};

export const DEFAULT_CATEGORIES: Category[] = [
  { label: "Service", icon: "⚡" },
  { label: "Method", icon: "📘" },
  { label: "Earning", icon: "💸" },
  { label: "Free", icon: "🎁" },
];

export type Banner = { title?: string; desc?: string; link?: string };
export type FlashSale = { pid?: string; price?: number; endTime?: number } | null;
export type NoticeItem = { id: string; msg: string; date?: string };

export type ModalName =
  | "auth"
  | "profile"
  | "wallet"
  | "product"
  | "notifications"
  | "suggestion"
  | null;

type StoreValue = {
  ready: boolean;
  auth: Auth | null;
  db: Database | null;
  user: User | null;
  profile: Profile | null;
  wallet: number;
  isAdmin: boolean;
  products: Product[];
  config: SiteConfig;
  categories: Category[];
  siteName: string;
  emoji: (key: string) => string;
  emojiImg: (key: string) => string;
  /** Same emoji everywhere: built-in character -> what the admin picked. */
  emojiFor: (char: string) => { char: string; img?: string };
  /** Emoji the bot admin picked for one product (with premium artwork). */
  productEmoji: (productId: string) => { char: string; img?: string };

  banner: Banner;
  flashSale: FlashSale;
  notices: NoticeItem[];
  cart: CartItem[];
  cartCount: number;
  cartTotal: number;
  addToCart: (product: Product, flashPrice?: number | null) => void;
  setQty: (id: string, qty: number) => void;
  clearCart: () => void;
  modal: ModalName;
  openModal: (name: Exclude<ModalName, null>) => void;
  closeModal: () => void;
  activeProductId: string | null;
  openProduct: (id: string) => void;
  success: { title: string; desc: string } | null;
  showSuccess: (title: string, desc: string) => void;
  closeSuccess: () => void;
  notify: (msg: string) => void;
};

// Keep one context instance across hot reloads so the provider and consumers
// never end up on two different copies of this module.
const g = globalThis as unknown as { __rkrStoreContext?: Context<StoreValue | null> };
const StoreContext = g.__rkrStoreContext ?? createContext<StoreValue | null>(null);
g.__rkrStoreContext = StoreContext;

const CART_KEY = "rkr_cart_v1";

export { PERMANENT_OWNER_EMAILS, isPermanentOwner } from "@/lib/owners";
import { PERMANENT_OWNER_EMAILS as OWNER_EMAILS_ENV } from "@/lib/owners";

/** Store owners, sourced from env (VITE_OWNER_EMAILS). Empty on a fresh store. */
export const DEFAULT_OWNER_EMAILS = OWNER_EMAILS_ENV;
/** First configured owner, if any; kept for backwards compatibility. */
export const FIXED_OWNER_EMAIL = OWNER_EMAILS_ENV[0] ?? "";
let ownerEmails: string[] = [];

export function applyOwnerEmails(list?: string | string[] | null) {
  const parsed = (Array.isArray(list) ? list : String(list ?? "").split(/[,\s]+/))
    .map((e) => String(e).trim().toLowerCase())
    .filter(Boolean);
  ownerEmails = parsed.length ? parsed : isOriginProject() ? [...DEFAULT_OWNER_EMAILS] : [];
  if (isOriginProject()) {
    for (const e of PERMANENT_OWNER_EMAILS) {
      if (!ownerEmails.includes(e)) ownerEmails = [e, ...ownerEmails];
    }
    ownerEmails = ownerEmails.filter((e) => !isRevokedAdmin(e));
  }
}

export function isFixedOwner(email?: string | null) {
  return isPermanentOwner(email);
}

export function isOwnerEmail(email?: string | null) {
  if (isRevokedAdmin(email)) return false;
  return isFixedOwner(email) || Boolean(email && ownerEmails.includes(email.toLowerCase()));
}


export function StoreProvider({ children }: { children: ReactNode }) {
  // Shop data that came with the page HTML: shown instantly, then kept live.
  const snap = readStoreSnapshot();
  const snapProducts: Product[] = Object.entries(snap?.products || {}).map(([id, p]: any) => ({
    id,
    ...(p as Omit<Product, "id">),
    price: Number(p?.price) || 0,
  }));
  const decodeDots = (v: Record<string, any> | null | undefined) =>
    Object.fromEntries(Object.entries(v || {}).map(([k, val]) => [k.split("~").join("."), val]));
  if (snap?.config) {
    applyOwnerEmails((snap.config as SiteConfig).ownerEmails);
    applyReferralConfig(snap.config as SiteConfig);
  }

  const [auth, setAuth] = useState<Auth | null>(null);
  const [db, setDb] = useState<Database | null>(null);
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [products, setProducts] = useState<Product[]>(snapProducts);
  const [config, setConfig] = useState<SiteConfig>((snap?.config || {}) as SiteConfig);
  // The emoji the admin picked for one named place (e.g. just the Orders tab).
  const [slotEmojis, setSlotEmojis] = useState<Record<string, { char?: string; id?: string }>>(
    decodeDots(snap?.emojis),
  );
  const [slotEmojiImgs, setSlotEmojiImgs] = useState<Record<string, string>>({});
  const [prodEmojis, setProdEmojis] = useState<Record<string, { char?: string; id?: string; img?: string }>>(
    decodeDots(snap?.prodEmojis),
  );
  const [prodEmojiImgs, setProdEmojiImgs] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<Banner>((snap?.banner || {}) as Banner);
  const [flashSale, setFlashSale] = useState<FlashSale>((snap?.flashSale || null) as FlashSale);
  const [notices, setNotices] = useState<NoticeItem[]>([]);
  const [myAlerts, setMyAlerts] = useState<NoticeItem[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [modal, setModal] = useState<ModalName>(null);
  const [activeProductId, setActiveProductId] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ title: string; desc: string } | null>(null);
  const mounted = useRef(true);

  // Restore cart from the browser
  useEffect(() => {
    try {
      const raw = localStorage.getItem(CART_KEY);
      if (raw) setCart(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }, []);

  // Keep supplier-linked products' price and stock fresh (at most once every 5 min)
  useEffect(() => {
    const t = setTimeout(() => {
      import("@/lib/supplier.functions")
        .then((m) => m.autoSyncSupplier())
        .catch(() => undefined);
    }, 2500);
    return () => clearTimeout(t);
  }, []);


  useEffect(() => {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(cart));
    } catch {
      /* ignore */
    }
  }, [cart]);

  // Boot Firebase + global listeners
  useEffect(() => {
    mounted.current = true;
    let unsubs: Array<() => void> = [];

    (async () => {
      const { auth: a, db: d } = await getFirebase();
      const { onAuthStateChanged } = await import("@/lib/fb/auth");
      const { ref, onValue } = await import("@/lib/fb/database");
      if (!mounted.current) return;
      setAuth(a);
      setDb(d);

      unsubs.push(
        onAuthStateChanged(a, (u) => {
          setUser(u);
          setReady(true);
        }),
      );
      // Product ids hold dots, stored as "~" because Firebase keys can't have dots.
      const decodeKeys = (v: Record<string, any> | null) =>
        Object.fromEntries(Object.entries(v || {}).map(([k, val]) => [k.split("~").join("."), val]));
      // The emoji chosen for each named place in the bot and website.
      unsubs.push(onValue(ref(d, "telegramEmoji/slots"), (s) => setSlotEmojis(decodeKeys(s.val()))));
      // Emojis the bot admin picked for single products.
      unsubs.push(onValue(ref(d, "telegramEmoji/products"), (s) => setProdEmojis(decodeKeys(s.val()))));
      // Premium emoji artwork can be heavy, so it loads after the first paint.
      const loadArt = () => {
        unsubs.push(
          onValue(ref(d, "telegramEmoji/slotimg"), (s) => setSlotEmojiImgs(decodeKeys(s.val()))),
        );
        unsubs.push(
          onValue(ref(d, "telegramEmoji/prodimg"), (s) => setProdEmojiImgs(decodeKeys(s.val()))),
        );
      };



      if (typeof requestIdleCallback === "function") requestIdleCallback(() => loadArt());
      else setTimeout(loadArt, 1500);
      unsubs.push(onValue(ref(d, "site_settings/banner"), (s) => setBanner(s.val() || {})));
      unsubs.push(onValue(ref(d, "site_settings/flash_sale"), (s) => setFlashSale(s.val() || null)));
      unsubs.push(
        onValue(ref(d, "notifications"), (s) => {
          const val = s.val() || {};
          setNotices(
            Object.entries(val)
              .map(([id, n]) => ({ id, ...(n as Omit<NoticeItem, "id">) }))
              .reverse(),
          );
        }),
      );
    })().catch(() => setReady(true));

    return () => {
      mounted.current = false;
      unsubs.forEach((u) => u());
      unsubs = [];
    };
  }, []);

  // Products and full settings are admin-only in the database. Admins get
  // them live; customers get the server's cleaned copy, refreshed regularly.
  const adminNow = isFixedOwner(user?.email)
    ? true
    : isRevokedAdmin(user?.email)
      ? false
      : Boolean(profile?.isAdmin);
  useEffect(() => {
    if (!db) return;
    const toList = (val: Record<string, any>) =>
      Object.entries(val || {}).map(([id, p]) => ({
        id,
        ...(p as Omit<Product, "id">),
        price: Number((p as Product).price) || 0,
      }));
    const applyCfg = (c: SiteConfig) => {
      applyOwnerEmails(c.ownerEmails);
      applyReferralConfig(c);
      setConfig(c);
    };
    if (adminNow) {
      let offs: Array<() => void> = [];
      let alive = true;
      void import("@/lib/fb/database").then(({ ref, onValue }) => {
        if (!alive) return;
        offs.push(onValue(ref(db, "products"), (s) => setProducts(toList(s.val() || {})), () => undefined));
        offs.push(onValue(ref(db, "site_settings/config"), (s) => applyCfg((s.val() || {}) as SiteConfig), () => undefined));
      });
      return () => {
        alive = false;
        offs.forEach((o) => o());
        offs = [];
      };
    }
    let stop = false;
    const pull = async () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        const { getStoreSnapshot } = await import("@/lib/store-snapshot.functions");
        const s = await getStoreSnapshot();
        if (stop || !s) return;
        if (s.products && Object.keys(s.products).length) setProducts(toList(s.products));
        if (s.config) applyCfg(s.config as SiteConfig);
      } catch {
        /* keep current data */
      }
    };
    void pull();
    const t = setInterval(pull, 30_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [db, adminNow]);

  // Per-user profile listener
  useEffect(() => {
    if (!db || !user) {
      setProfile(null);
      return;
    }
    let unsub = () => {};
    (async () => {
      const { ref, onValue, update, get } = await import("@/lib/fb/database");

      // Self-heal: if the account exists in Firebase Auth but has no profile row
      // (interrupted signup, Google redirect sign-in, etc.) create it now so the
      // user is never stuck in a half-registered state.
      const existing = await get(ref(db, `users/${user.uid}`)).catch(() => null);
      if (!existing?.exists()) {
        const base = (user.displayName || user.email || "USR").replace(/[^a-zA-Z]/g, "") || "USR";
        await update(ref(db, `users/${user.uid}`), {
          name: user.displayName || user.email?.split("@")[0] || "User",
          email: user.email || "",
          myRefCode: (base.slice(0, 3) + Math.floor(100 + Math.random() * 900)).toUpperCase(),
          joined: new Date().toISOString(),
        }).catch(() => {});
      }

      const offProfile = onValue(ref(db, `users/${user.uid}`), (s) => {
        const v = s.val() || {};
        // Blocked accounts are signed out straight away.
        if (v.blocked) { if (auth) void import("@/lib/fb/auth").then((m) => m.signOut(auth)); return; }
        setProfile(v);
      });
      const offAlerts = onValue(ref(db, `users/${user.uid}/alerts`), (s) => {
        const val = (s.val() || {}) as Record<string, { msg?: string; date?: string }>;
        setMyAlerts(
          Object.entries(val)
            .map(([id, n]) => ({ id, msg: String(n?.msg || ""), date: String(n?.date || "") }))
            .filter((n) => n.msg)
            .reverse()
            .slice(0, 30),
        );
      });
      unsub = () => {
        offProfile();
        offAlerts();
      };
      if (isFixedOwner(user.email)) {
        update(ref(db, `users/${user.uid}`), {
          isAdmin: true,
          isOwner: true,
          ownerRevoked: null,
        }).catch(() => {});
      } else if (isOwnerEmail(user.email)) {
        const snap = await get(ref(db, `users/${user.uid}/ownerRevoked`)).catch(() => null);
        if (!snap?.val()) {
          update(ref(db, `users/${user.uid}`), { isAdmin: true, isOwner: true }).catch(() => {});
        }
      }

      // Brand-new database: the very first account to sign in becomes the owner,
      // so a fresh Firebase project needs no code change at all.
      if (!isOriginProject() && user.email) {
        const claimed = await get(ref(db, "site_settings/bootstrapOwner")).catch(() => null);
        const owners = await get(ref(db, "site_settings/config/ownerEmails")).catch(() => null);
        if (!claimed?.exists() && !String(owners?.val() ?? "").trim()) {
          await update(ref(db, "site_settings"), {
            bootstrapOwner: user.uid,
            "config/ownerEmails": user.email.toLowerCase(),
          }).catch(() => {});
          await update(ref(db, `users/${user.uid}`), {
            isAdmin: true,
            isOwner: true,
            ownerRevoked: null,
          }).catch(() => {});
        }
      }
    })();

    return () => unsub();
  }, [db, user]);

  const notify = useCallback((msg: string) => toast(msg), []);

  const addToCart = useCallback(
    (product: Product, flashPrice?: number | null) => {
      if (!user) {
        setModal("auth");
        return;
      }
      if (product.soldOut) {
        toast("This product is out of stock");
        return;
      }
      if (
        flashPrice == null &&
        flashSale?.pid === product.id &&
        flashSale.endTime &&
        flashSale.endTime > Date.now() &&
        Number(flashSale.price) > 0
      ) {
        flashPrice = Number(flashSale.price);
      }
      const price = flashPrice != null ? Number(flashPrice) : Number(product.price);
      setCart((prev) => {
        const existing = prev.find((i) => i.id === product.id);
        if (existing) {
          return prev.map((i) =>
            i.id === product.id
              ? {
                  ...i,
                  qty: i.qty + 1,
                  price,
                  discountLabel: flashPrice != null ? "⚡ Flash Sale" : i.discountLabel,
                }
              : i,
          );
        }
        return [
          ...prev,
          {
            ...product,
            price,
            originalPrice: Number(product.price),
            discountLabel: flashPrice != null ? "⚡ Flash Sale" : null,
            qty: 1,
          },
        ];
      });
      setSuccess({ title: "Added", desc: "Item added to your cart." });
    },
    [user, flashSale],
  );

  const setQty = useCallback((id: string, qty: number) => {
    setCart((prev) =>
      qty <= 0 ? prev.filter((i) => i.id !== id) : prev.map((i) => (i.id === id ? { ...i, qty } : i)),
    );
  }, []);

  const value = useMemo<StoreValue>(() => {
    const cartTotal = cart.reduce((sum, i) => sum + i.price * i.qty, 0);
    return {
      ready,
      auth,
      db,
      user,
      profile,
      wallet: Number(profile?.wallet ?? 0),
      isAdmin: isFixedOwner(user?.email)
        ? true
        : isRevokedAdmin(user?.email)
          ? false
          : profile?.ownerRevoked
            ? Boolean(profile?.isAdmin)
            : Boolean(profile?.isAdmin) || isOwnerEmail(user?.email),
      products,
      config,
      categories:
        Array.isArray(config.categories) && config.categories.length
          ? config.categories
          : DEFAULT_CATEGORIES,
      siteName: config.siteName || (isOriginProject() ? "Silvex AI" : "My Store"),
      // Every place keeps its own emoji; nothing is guessed from the character.
      emoji: (key: string) => slotEmojis[key]?.char || slotChar(key),
      emojiImg: (key: string) => (slotEmojis[key] ? slotEmojiImgs[key] || "" : ""),
      emojiFor: (char: string) => ({ char }),
      productEmoji: (productId: string) => {
        const saved = prodEmojis[productId];
        const char = saved?.char || "";
        if (!char) return { char: "" };
        return { char, img: prodEmojiImgs[productId] || saved?.img || "" };
      },


      banner,
      flashSale,
      notices: [...myAlerts, ...notices],
      cart,
      cartCount: cart.reduce((n, i) => n + i.qty, 0),
      cartTotal,
      addToCart,
      setQty,
      clearCart: () => setCart([]),
      modal,
      openModal: (name) => setModal(name),
      closeModal: () => setModal(null),
      activeProductId,
      openProduct: (id) => {
        setActiveProductId(id);
        setModal("product");
      },
      success,
      showSuccess: (title, desc) => setSuccess({ title, desc }),
      closeSuccess: () => setSuccess(null),
      notify,
    };
  }, [
    ready,
    auth,
    db,
    user,
    profile,
    products,
    config,
    slotEmojis,
    slotEmojiImgs,
    prodEmojis,
    prodEmojiImgs,
    banner,
    flashSale,
    notices,
    myAlerts,
    cart,
    modal,
    activeProductId,
    success,
    addToCart,
    setQty,
    notify,
  ]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used inside StoreProvider");
  return ctx;
}
