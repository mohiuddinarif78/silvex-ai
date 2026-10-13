import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  createUserWithEmailAndPassword,
  getRedirectResult,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  updateProfile,
} from "@/lib/fb/auth";
import {
  equalTo,
  get,
  onValue,
  orderByChild,
  push,
  query,
  ref,
  set,
  update,
} from "@/lib/fb/database";
import { useStore } from "@/context/StoreContext";
import { checkDeposit, fallbackDepositAddress } from "@/lib/deposit.functions";
import { checkDepositLink, createDepositLink } from "@/lib/razorpay.functions";
import { submitCryptoDeposit } from "@/lib/wallet.functions";
import { binanceInfo, verifyBinanceDeposit, verifyBinancePay } from "@/lib/binance.functions";
import { Emo } from "@/components/store/Emo";
import { Sheet, inputCls } from "./ui";


export function WalletModal() {
  const { db, user, wallet, profile, config, closeModal, showSuccess, notify } = useStore();
  const [tab, setTab] = useState<"deposit" | "withdraw" | "history">("deposit");
  const [amount, setAmount] = useState("");
  const [txHash, setTxHash] = useState("");
  const [chain, setChain] = useState<"bep20" | "polygon" | "ethereum">("bep20");
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [upi, setUpi] = useState("");
  const [payAmount, setPayAmount] = useState("");
  const [paying, setPaying] = useState(false);
  const [payLink, setPayLink] = useState("");
  const [payLinkId, setPayLinkId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [bnb, setBnb] = useState<{
    enabled: boolean;
    address: string;
    network: string;
    coins: string[];
    payId?: string;
  }>({
    enabled: false,
    address: "",
    network: "",
    coins: [],
    payId: "",
  });
  const [bnbTx, setBnbTx] = useState("");
  const [bnbChecking, setBnbChecking] = useState(false);
  const [bnbCopied, setBnbCopied] = useState(false);
  const [payRef, setPayRef] = useState("");
  const [payChecking, setPayChecking] = useState(false);
  const [payCopied, setPayCopied] = useState(false);
  const [history, setHistory] = useState<
    Array<{ id: string; type: string; amount: number; desc: string; date: string; status?: string }>
  >([]);
  const fee = Number(config.fee ?? 25);
  const depositAddress = config.depositAddress || fallbackDepositAddress();
  const rate = Number(config.inrPerDollar) > 0 ? Number(config.inrPerDollar) : 100;
  const cardsOn = Boolean(config.razorpayKeyId);
  // Deposits have no fees: the customer pays exactly the top-up amount.
  const payBase = Math.round((Number(payAmount) || 0) * rate * 100) / 100;


  async function startCardPayment() {
    if (!user) return notify("Sign in first");
    const usd = Number(payAmount);
    if (!usd || usd <= 0) return notify("Enter how many dollars you want to add");
    setPaying(true);
    try {
      const res = await createDepositLink({
        data: {
          usd,
          uid: user.uid,
          name: profile?.name ?? "",
          email: user.email ?? "",
          phone: profile?.phone ?? "",
          siteUrl: config.siteUrl ?? "",
        },
      });
      if (!res.ok) return notify(res.error);
      setPayLink(res.url);
      setPayLinkId(res.id);
      window.open(res.url, "_blank");
    } catch (e) {
      notify(e instanceof Error ? e.message : "Could not start the payment");
    } finally {
      setPaying(false);
    }
  }

  async function confirmPayment(quiet = false) {
    if (!payLinkId) return;
    if (!quiet) setConfirming(true);
    try {
      const out = await checkDepositLink({ data: { linkId: payLinkId } });
      if (out.status === "paid") {
        setPayLink("");
        setPayLinkId("");
        setPayAmount("");
        closeModal();
        showSuccess("Payment received", out.message);
      } else if (!quiet) {
        notify(
          out.status === "pending"
            ? "We have not received this payment yet. If you just paid, wait a few seconds and tap again."
            : out.message,
        );
      }
    } catch (e) {
      if (!quiet) notify(e instanceof Error ? e.message : "Could not check the payment");
    } finally {
      if (!quiet) setConfirming(false);
    }
  }

  // While the payment page is open, keep checking quietly so the balance
  // appears on its own as soon as the money clears.
  useEffect(() => {
    if (!payLinkId) return;
    const id = setInterval(() => void confirmPayment(true), 6000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payLinkId]);



  useEffect(() => {
    let live = true;
    void binanceInfo()
      .then((info) => {
        if (live) setBnb(info);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  async function submitBinance() {
    if (!user) return notify("Sign in first");
    const tx = bnbTx.trim();
    if (tx.replace(/^0x/i, "").length < 16) return notify("Paste the full transaction id");
    setBnbChecking(true);
    try {
      const out = await verifyBinanceDeposit({ data: { uid: user.uid, txId: tx } });
      if (!out.ok) return notify(out.message);
      setBnbTx("");
      closeModal();
      showSuccess(out.credited ? "Balance added" : "Already added", out.message);
    } catch (e) {
      notify(e instanceof Error ? e.message : "Could not check that transfer");
    } finally {
      setBnbChecking(false);
    }
  }

  async function submitBinancePay() {
    if (!user) return notify("Sign in first");
    const ref = payRef.trim();
    if (ref.replace(/[^0-9A-Za-z]/g, "").length < 6) return notify("Paste the full Binance Pay order id");
    setPayChecking(true);
    try {
      const out = await verifyBinancePay({ data: { uid: user.uid, ref } });
      if (!out.ok) return notify(out.message);
      setPayRef("");
      closeModal();
      showSuccess(out.credited ? "Balance added" : "Already added", out.message);
    } catch (e) {
      notify(e instanceof Error ? e.message : "Could not check that transfer");
    } finally {
      setPayChecking(false);
    }
  }

  useEffect(() => {
    if (!db || !user) return;
    return onValue(ref(db, `users/${user.uid}/history`), (s) => {
      const val = s.val() || {};
      setHistory(
        Object.entries(val)
          .map(([id, h]) => ({ id, ...(h as Omit<(typeof history)[number], "id">) }))
          .reverse(),
      );
    });
  }, [db, user]);

  async function submitDeposit() {
    if (!db || !user) return;
    const hash = txHash.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return notify("Paste the full transaction hash");
    setChecking(true);
    try {
      const res = await submitCryptoDeposit({
        data: { idToken: await user.getIdToken(), hash, chain: chain as "bep20" | "polygon" | "ethereum", name: profile?.name ?? undefined },
      });
      if (!res.ok) return notify(res.message);
      closeModal();
      if (res.credited) showSuccess("Balance added", `$${res.amount} credited to your wallet.`);
      else showSuccess("Sent for review", res.message);
      setTxHash("");
    } catch (e) {
      notify(e instanceof Error ? e.message : "Could not check that transaction");
    } finally {
      setChecking(false);
    }
  }

  async function submitWithdraw() {
    if (!db || !user) return;
    const amt = Number(amount);
    if (!amt || !upi) return notify("Enter amount and UPI ID");
    if (amt > wallet) return notify("Not enough balance");
    await push(ref(db, "requests"), {
      uid: user.uid,
      name: profile?.name ?? user.email,
      email: user.email,
      type: "Withdraw",
      amount: amt,
      payable: Math.round(amt - (amt * fee) / 100),
      upi,
      phone: profile?.phone ?? "",
      status: "Pending",
      date: new Date().toISOString(),
    });
    setAmount("");
    setUpi("");
    closeModal();
    showSuccess("Request sent", "Withdrawal is processed after admin approval.");
  }

  return (
    <Sheet onClose={closeModal} title="Wallet">
      <div className="mb-6 rounded-2xl bg-gradient-to-r from-indigo-500 to-purple-600 p-6 text-center text-white shadow-lg">
        <p className="text-xs font-bold uppercase tracking-widest opacity-80">Available balance</p>
        <div className="mt-1 text-4xl font-black">${wallet}</div>
      </div>
      <div className="mb-4 flex rounded-xl bg-muted p-1">
        {(["deposit", "withdraw", "history"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 rounded-lg py-2 text-xs font-bold capitalize ${
              tab === t ? "bg-card shadow-sm" : "text-muted-foreground"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "deposit" ? (
        <div>
          {cardsOn ? (
            <div className="mb-5 rounded-2xl border border-border bg-card p-4">
              <p className="text-sm font-black">Pay by card, UPI or netbanking</p>
              <p className="mb-2 text-[11px] text-muted-foreground">
                ₹{rate} = $1, no extra fees. Your balance updates on its own once the payment is
                done.
              </p>
              <input
                className={`${inputCls} mb-2`}
                placeholder="Amount in $"
                inputMode="decimal"
                value={payAmount}
                onChange={(e) => setPayAmount(e.target.value)}
              />
              {Number(payAmount) > 0 ? (
                <p className="mb-2 text-[11px] font-bold text-muted-foreground">
                  You pay ₹{payBase.toFixed(2)} and get ${Number(payAmount)} in your balance
                </p>
              ) : null}

              <button
                onClick={startCardPayment}
                disabled={paying}
                className="w-full rounded-xl bg-primary py-3 font-bold text-primary-foreground disabled:opacity-60"
              >
                {paying ? "Creating payment link…" : "Get payment link"}
              </button>
              {payLink ? (
                <>
                  <a
                    href={payLink}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 block break-all text-center text-[11px] font-bold text-primary underline"
                  >
                    Open payment page
                  </a>
                  <button
                    onClick={() => void confirmPayment()}
                    disabled={confirming}
                    className="mt-2 w-full rounded-xl bg-emerald-500 py-3 font-bold text-white disabled:opacity-60"
                  >
                    {confirming ? "Checking payment…" : "✅ I have paid"}
                  </button>
                </>
              ) : null}
            </div>
          ) : null}

          {bnb.enabled && bnb.payId ? (
            <div className="mb-5 rounded-2xl border border-border bg-card p-4">
              <p className="text-sm font-black">Binance Pay (no network fee)</p>
              <p className="mb-2 text-[11px] text-muted-foreground">
                Send {bnb.coins.join(" or ") || "USDT"} straight to our Binance ID — no blockchain
                needed, instant and free inside Binance. Then paste the Pay order id.
              </p>
              <div className="mb-2 rounded-xl border border-dashed border-border bg-muted/50 p-3">
                <p className="break-all font-mono text-[11px] font-bold">{bnb.payId}</p>
                <button
                  onClick={() => {
                    navigator.clipboard?.writeText(bnb.payId || "");
                    setPayCopied(true);
                    setTimeout(() => setPayCopied(false), 1500);
                  }}
                  className="mt-2 rounded-lg bg-foreground px-3 py-1 text-[11px] font-bold text-background"
                >
                  {payCopied ? "Copied" : "Copy Binance ID"}
                </button>
              </div>
              <input
                className={`${inputCls} mb-2 font-mono text-xs`}
                placeholder="Binance Pay order id"
                value={payRef}
                onChange={(e) => setPayRef(e.target.value)}
              />
              <button
                onClick={submitBinancePay}
                disabled={payChecking}
                className="w-full rounded-xl bg-amber-400 py-3 font-bold text-black disabled:opacity-60"
              >
                {payChecking ? "Checking on Binance…" : "Verify Binance Pay transfer"}
              </button>
            </div>
          ) : null}

          {bnb.enabled ? (
            <div className="mb-5 rounded-2xl border border-border bg-card p-4">
              <p className="text-sm font-black">Pay with Binance</p>
              <p className="mb-2 text-[11px] text-muted-foreground">
                Send {bnb.coins.join(" or ") || "USDT"}
                {bnb.network ? ` on ${bnb.network}` : ""} to the address below, then paste the
                transaction id. 1 USDT = $1 and your balance is added on its own.
              </p>
              {bnb.address ? (
                <div className="mb-2 rounded-xl border border-dashed border-border bg-muted/50 p-3">
                  <p className="break-all font-mono text-[11px] font-bold">{bnb.address}</p>
                  <button
                    onClick={() => {
                      navigator.clipboard?.writeText(bnb.address);
                      setBnbCopied(true);
                      setTimeout(() => setBnbCopied(false), 1500);
                    }}
                    className="mt-2 rounded-lg bg-foreground px-3 py-1 text-[11px] font-bold text-background"
                  >
                    {bnbCopied ? "Copied" : "Copy address"}
                  </button>
                </div>
              ) : null}
              <input
                className={`${inputCls} mb-2 font-mono text-xs`}
                placeholder="Transaction id (TXID)"
                value={bnbTx}
                onChange={(e) => setBnbTx(e.target.value)}
              />
              <button
                onClick={submitBinance}
                disabled={bnbChecking}
                className="w-full rounded-xl bg-amber-500 py-3 font-bold text-white disabled:opacity-60"
              >
                {bnbChecking ? "Checking on Binance…" : "Verify Binance payment"}
              </button>
            </div>
          ) : null}

          <p className="mb-2 text-xs font-bold text-muted-foreground">
            Send USDT or USDC to this address, then paste the transaction hash.
          </p>
          <div className="mb-3 rounded-xl border border-dashed border-border bg-muted/50 p-3">
            <p className="break-all font-mono text-[11px] font-bold">{depositAddress}</p>
            <button
              onClick={() => {
                navigator.clipboard?.writeText(depositAddress);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="mt-2 rounded-lg bg-foreground px-3 py-1 text-[11px] font-bold text-background"
            >
              {copied ? "Copied" : "Copy address"}
            </button>

          </div>
          <div className="mb-2 flex gap-2">
            {(
              [
                ["bep20", "BEP20 (BNB)"],
                ["polygon", "Polygon"],
                ["ethereum", "Ethereum"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setChain(key)}
                className={`flex-1 rounded-xl border p-2 text-xs font-bold ${
                  chain === key ? "border-primary bg-primary/10 text-primary" : "border-border"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            className={`${inputCls} mb-3 font-mono text-xs`}
            placeholder="Transaction hash (0x...)"
            value={txHash}
            onChange={(e) => setTxHash(e.target.value)}
          />
          <button
            onClick={submitDeposit}
            disabled={checking}
            className="w-full rounded-xl bg-emerald-500 py-3 font-bold text-white disabled:opacity-60"
          >
            {checking ? "Checking on-chain…" : "Verify & add balance"}
          </button>
          <p className="mt-2 text-center text-[11px] text-muted-foreground">
            Verified payments are credited instantly in $. Anything older than 10 minutes is
            reviewed by an admin.
          </p>
        </div>
      ) : null}

      {tab === "withdraw" ? (
        <div>
          <p className="mb-2 rounded bg-destructive/10 p-2 text-xs font-bold text-destructive">
            Fee: {fee}% will be deducted.
          </p>
          <input
            className={`${inputCls} mb-2`}
            placeholder="Amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <input
            className={`${inputCls} mb-3`}
            placeholder="UPI ID"
            value={upi}
            onChange={(e) => setUpi(e.target.value)}
          />
          <button
            onClick={submitWithdraw}
            className="w-full rounded-xl bg-destructive py-3 font-bold text-destructive-foreground"
          >
            Request withdrawal
          </button>
        </div>
      ) : null}

      {tab === "history" ? (
        <div className="space-y-2 text-sm">
          {history.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">No transactions yet.</p>
          ) : (
            history.map((h) => (
              <div
                key={h.id}
                className="flex items-center justify-between rounded-xl border border-border p-3"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-xs font-bold">
                    {h.type}
                    {h.status ? (
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                          h.status === "Paid"
                            ? "bg-primary/10 text-primary"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {h.status}
                      </span>
                    ) : null}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">{h.desc}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {h.date ? new Date(h.date).toLocaleString() : ""}
                  </p>
                </div>
                <span className="text-sm font-black">${h.amount}</span>
              </div>
            ))
          )}
        </div>
      ) : null}
    </Sheet>
  );
}

