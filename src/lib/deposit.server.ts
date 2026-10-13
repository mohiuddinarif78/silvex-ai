/** Server-only on-chain deposit verification (BEP20 + Polygon + Ethereum USDT/USDC). */

/**
 * Fallback deposit wallet when Settings → Deposit address is empty.
 * Comes from the DEPOSIT_ADDRESS env variable; nothing is hardcoded.
 */
export const defaultDepositAddress = (): string => {
  const v = String((globalThis as any)?.process?.env?.["DEPOSIT_ADDRESS"] ?? "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(v) ? v : "";
};


const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export type ChainKey = "bep20" | "polygon" | "ethereum";

export const CHAINS: Record<
  ChainKey,
  {
    label: string;
    rpc: string[];
    minConfirmations: number;
    tokens: Record<string, { symbol: string; decimals: number }>;
  }
> = {
  bep20: {
    label: "BNB Chain (BEP20)",
    rpc: [
      "https://bsc-dataseed.binance.org",
      "https://bsc-rpc.publicnode.com",
      "https://bsc-dataseed1.defibit.io",
      "https://bsc-dataseed1.ninicoin.io",
      "https://1rpc.io/bnb",
    ],
    minConfirmations: 15,
    tokens: {
      "0x55d398326f99059ff775485246999027b3197955": { symbol: "USDT", decimals: 18 },
      "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": { symbol: "USDC", decimals: 18 },
    },
  },
  polygon: {
    label: "Polygon",
    rpc: [
      "https://polygon-bor-rpc.publicnode.com",
      "https://1rpc.io/matic",
      "https://polygon-rpc.com",
      "https://rpc.ankr.com/polygon",
      "https://polygon.drpc.org",
    ],
    minConfirmations: 30,
    tokens: {
      "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": { symbol: "USDT", decimals: 6 },
      "0x2791bca1f2de4661ed88a30c99a7a9449aa84174": { symbol: "USDC", decimals: 6 },
      "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": { symbol: "USDC", decimals: 6 },
    },
  },
  ethereum: {
    label: "Ethereum",
    rpc: [
      "https://ethereum-rpc.publicnode.com",
      "https://eth.llamarpc.com",
      "https://1rpc.io/eth",
      "https://rpc.ankr.com/eth",
      "https://eth.drpc.org",
    ],
    minConfirmations: 12,
    tokens: {
      "0xdac17f958d2ee523a2206206994597c13d831ec7": { symbol: "USDT", decimals: 6 },
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6 },
    },
  },
};

async function rpcAt(url: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

async function rpc(chain: ChainKey, method: string, params: unknown[]): Promise<any> {
  let lastError: unknown = null;
  for (const url of CHAINS[chain].rpc) {
    try {
      return await rpcAt(url, method, params);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Network unavailable");
}

/**
 * Confirm a receipt against a SECOND, independent RPC so we never auto-credit
 * on the word of a single (possibly compromised) endpoint. Returns true only
 * when another endpoint agrees the tx succeeded in the same block.
 *
 * A freshly-mined transaction has often not propagated to every node yet, so a
 * single quick check against one other endpoint produced false negatives (the
 * deposit dropped to manual review even though it was valid). We now poll every
 * other endpoint, with a couple of short retries, until one independent node
 * confirms — the security rule ("a second endpoint must agree") is unchanged,
 * only its reliability improves. If none ever agrees, returns false and the
 * caller falls back to manual approval.
 */
async function receiptAgreedBySecondRpc(
  chain: ChainKey,
  hash: string,
  expectBlock: string,
): Promise<boolean> {
  const [primary, ...others] = CHAINS[chain].rpc;
  void primary;
  if (!others.length) return false;
  const want = String(expectBlock).toLowerCase();
  // Up to 3 passes with a short wait between them, to let a brand-new tx reach
  // the other nodes before we give up and send it to manual review.
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const url of others) {
      try {
        const r = await rpcAt(url, "eth_getTransactionReceipt", [hash]);
        if (r && r.status === "0x1" && String(r.blockNumber).toLowerCase() === want) {
          return true;
        }
      } catch {
        /* try next endpoint */
      }
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 2500));
  }
  return false;
}

function toAmount(hexData: string, decimals: number) {
  const raw = BigInt(hexData.length > 2 ? hexData : "0x0");
  const denom = 10n ** BigInt(decimals);
  const whole = raw / denom;
  const frac = ((raw % denom) * 100n) / denom;
  return Number(whole) + Number(frac) / 100;
}

export type DepositCheck = {
  ok: boolean;
  status: "credited" | "manual" | "failed";
  amount: number;
  symbol: string | null;
  chain: string;
  ageMinutes: number;
  confirmations: number;
  message: string;
};

/** Checks one chain for a stablecoin transfer to the deposit address. */
export async function verifyDepositOnChain(
  hash: string,
  chain: ChainKey,
  address: string,
): Promise<DepositCheck> {
  const conf = CHAINS[chain];
  const fail = (message: string): DepositCheck => ({
    ok: false,
    status: "failed",
    amount: 0,
    symbol: null,
    chain: conf.label,
    ageMinutes: 0,
    confirmations: 0,
    message,
  });

  const receipt = await rpc(chain, "eth_getTransactionReceipt", [hash]);
  if (!receipt) return fail("Transaction not found on this network yet. Check the network and try again.");
  if (receipt.status !== "0x1") return fail("That transaction failed on-chain.");

  const block = await rpc(chain, "eth_getBlockByNumber", [receipt.blockNumber, false]);
  const timestamp = Number(BigInt(block?.timestamp ?? "0x0")) * 1000;
  const ageMinutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));

  // How many blocks have been mined on top of this one.
  const head = await rpc(chain, "eth_blockNumber", []).catch(() => null);
  const txBlock = BigInt(receipt.blockNumber ?? "0x0");
  const headBlock = head ? BigInt(head) : txBlock;
  const confirmations = Number(headBlock >= txBlock ? headBlock - txBlock : 0n);

  const target = address.toLowerCase().slice(2);
  let amount = 0;
  let symbol: string | null = null;

  for (const log of (receipt.logs ?? []) as Array<{ address: string; topics: string[]; data: string }>) {
    const token = conf.tokens[log.address?.toLowerCase() ?? ""];
    if (!token) continue;
    if (log.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    const to = log.topics[2]?.toLowerCase() ?? "";
    if (!to.endsWith(target)) continue;
    amount += toAmount(log.data, token.decimals);
    symbol = token.symbol;
  }

  if (amount <= 0) {
    return fail("No USDT/USDC payment to our deposit address was found in this transaction.");
  }

  const rounded = Math.round(amount * 100) / 100;
  const manual = (message: string): DepositCheck => ({
    ok: true,
    status: "manual",
    amount: rounded,
    symbol,
    chain: conf.label,
    ageMinutes,
    confirmations,
    message,
  });

  // Old transactions always go to manual review (unchanged behaviour).
  if (ageMinutes > 10) {
    return manual(`Payment found, but it is ${ageMinutes} minutes old, so an admin will approve it.`);
  }

  // Not enough confirmations yet: a freshly-mined tx can still be reorged out,
  // so hold it for manual approval instead of auto-crediting.
  if (confirmations < conf.minConfirmations) {
    return manual(
      `Payment found with ${confirmations}/${conf.minConfirmations} confirmations — ` +
        `an admin will approve it once it settles.`,
    );
  }

  // Never auto-credit on a single endpoint's word: require a second, independent
  // RPC to agree the tx succeeded in the same block. If none agrees, hold it.
  const agreed = await receiptAgreedBySecondRpc(chain, hash, String(receipt.blockNumber));
  if (!agreed) {
    return manual("Payment found, but it could not be double-checked right now — an admin will approve it.");
  }

  return {
    ok: true,
    status: "credited",
    amount: rounded,
    symbol,
    chain: conf.label,
    ageMinutes,
    confirmations,
    message: "Payment verified on-chain.",
  };
}

/** Tries every supported network and returns the first match. */
export async function verifyDepositAnyChain(hash: string, address: string): Promise<DepositCheck> {
  let last: DepositCheck | null = null;
  for (const chain of Object.keys(CHAINS) as ChainKey[]) {
    try {
      const res = await verifyDepositOnChain(hash, chain, address);
      if (res.ok) return res;
      last = res;
    } catch {
      /* try next network */
    }
  }
  return (
    last ?? {
      ok: false,
      status: "failed",
      amount: 0,
      symbol: null,
      chain: "-",
      ageMinutes: 0,
      confirmations: 0,
      message: "Could not read that transaction. Try again in a minute.",
    }
  );
}
