/* ============================================================
   PRO PACK — the SIMULATED in-app purchase (thesis prototype).

   No payment is taken anywhere: the checkout is a demo dialog and
   the purchase is only a flag in local storage. This file holds the
   pure pieces (price, bundle, grant maths) so they can be tested.

   The garden's secret quests (Pet and Garden) are NOT part of the
   pack: buying never completes them or their achievements.
   ============================================================ */

export const PRO_PACK_PRICE_USD = 4.99;
export const PRO_PACK_PRICE_LABEL = `$${PRO_PACK_PRICE_USD.toFixed(2)}`;
export const PRO_PACK_FERTILIZER = 1000;
export const PRO_PACK_TOKENS = 1000;
export const PRO_PACK_SEED_PACKS = 1;

export const PRO_PACK_BENEFITS: string[] = [
  "Every PRO tab of My Library: Dashboard, Graph and Chat",
  "The Lab (beta), the pixel pet and the tree of knowledge",
  `${PRO_PACK_FERTILIZER.toLocaleString("en-US")} fertilizer in your hold`,
  `${PRO_PACK_TOKENS.toLocaleString("en-US")} tree tokens`,
  `${PRO_PACK_SEED_PACKS} free seed pack (a new tree for the seed bank)`,
];

export const PRO_PACK_QUEST_NOTE =
  "Unlocks more features – the secret quests are still yours to finish.";

export interface ProPackWallet {
  tokens: number;
  fertilizerHold: number;
  proPurchased: boolean;
}

export interface ProPackGrant {
  /** False when the pack was already owned: nothing is granted. */
  granted: boolean;
  wallet: ProPackWallet;
  /** The seed pack's tree, or null when every tree is already owned. */
  seedSpecies: string | null;
}

/** The seed pack gives the first species (in catalog order) the player
 *  does not own yet; null when they own them all. */
export function pickSeedPackSpecies(
  owned: readonly string[],
  catalog: readonly string[],
): string | null {
  return catalog.find((id) => !owned.includes(id)) ?? null;
}

/** Idempotent grant: the bundle is credited once, ever. */
export function applyProPack(
  wallet: ProPackWallet,
  owned: readonly string[],
  catalog: readonly string[],
): ProPackGrant {
  if (wallet.proPurchased) {
    return { granted: false, wallet, seedSpecies: null };
  }
  return {
    granted: true,
    seedSpecies: pickSeedPackSpecies(owned, catalog),
    wallet: {
      proPurchased: true,
      tokens: wallet.tokens + PRO_PACK_TOKENS,
      fertilizerHold: wallet.fertilizerHold + PRO_PACK_FERTILIZER,
    },
  };
}
