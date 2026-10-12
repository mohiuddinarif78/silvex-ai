import { createServerFn } from "@tanstack/react-start";
import type { DepositCheck } from "./deposit.server";
import { isOriginProject } from "./origin";

/** Wallet of the original store. A different Firebase project starts with none. */
export const ORIGIN_DEPOSIT_ADDRESS = "0x4c1506bd7a564ad416925997f4f75f79c3da07f2";
export const DEPOSIT_ADDRESS = ORIGIN_DEPOSIT_ADDRESS;
export const fallbackDepositAddress = () => (isOriginProject() ? ORIGIN_DEPOSIT_ADDRESS : "");

export type { DepositCheck };

/**
 * Reads a public blockchain transaction and reports how many dollars of
 * stablecoin it delivered to the store's deposit address.
 */
export const checkDeposit = createServerFn({ method: "POST" })
  .inputValidator((input: { hash: string; chain: string; address?: string }) => {
    const hash = String(input.hash || "").trim();
    const chain = String(input.chain || "").trim();
    const address = String(input.address || "").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("That does not look like a transaction hash.");
    if (chain !== "bep20" && chain !== "polygon") throw new Error("Unknown network.");
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Deposit address is not valid.");
    return { hash, chain: chain as "bep20" | "polygon", address };
  })

  .handler(async ({ data }): Promise<DepositCheck> => {
    const rl = await import("./rate-limit.server");
    rl.limitByIp("deposit-check", 20, rl.MINUTE);
    const { verifyDepositOnChain } = await import("./deposit.server");
    return verifyDepositOnChain(data.hash, data.chain, data.address);
  });
