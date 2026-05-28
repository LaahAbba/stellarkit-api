const express = require("express");
const router = express.Router();
const { server } = require("../config/stellar");
const { success } = require("../utils/response");
const { validateAccountId, validateAssetCode, validateLimit } = require("../utils/validators");
const { accountSummaryRateLimiter } = require("../middleware/rateLimiter");

const handleAccountNotFound = (err, next) => {
  if (err.response && err.response.status === 404) {
    const notFoundErr = new Error("Account not found.");
    notFoundErr.status = 404;
    return next(notFoundErr);
  }
  next(err);
};

function formatAccountBalances(account) {
  const xlmBalance = account.balances.find((b) => b.asset_type === "native");
  const assets = account.balances
    .filter((b) => b.asset_type !== "native")
    .map((b) => ({
      assetCode: b.asset_code,
      assetIssuer: b.asset_issuer,
      assetType: b.asset_type,
      balance: b.balance,
      limit: b.limit,
      buyingLiabilities: b.buying_liabilities,
      sellingLiabilities: b.selling_liabilities,
      isAuthorized: b.is_authorized,
      isClawbackEnabled: b.is_clawback_enabled,
    }));

  return {
    xlm: {
      balance: xlmBalance ? xlmBalance.balance : "0.0000000",
      buyingLiabilities: xlmBalance ? xlmBalance.buying_liabilities : "0",
      sellingLiabilities: xlmBalance ? xlmBalance.selling_liabilities : "0",
    },
    assets,
  };
}

/**
 * GET /account/:id
 * Returns full account details including XLM balance, all asset balances,
 * signers, thresholds, flags, and sequence number.
 *
 * @param {string} id - Stellar account public key (G...)
 *
 * @example
 * GET /account/GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN
 */
router.get("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    validateAccountId(id);

    const account = await server.loadAccount(id);

    const balances = formatAccountBalances(account);

    // Minimum balance calculation
    // Min balance = (2 + subentries) * base_reserve
    // We use 0.5 XLM as the current base reserve
    const baseReserve = 0.5;
    const STROOPS_PER_XLM = 10_000_000;
    const accountReserve = 2 * baseReserve;
    const subentryReserve = account.subentry_count * baseReserve;
    const totalLocked = accountReserve + subentryReserve;
    const xlmBalance = parseFloat(balances.xlm.balance || "0");
    const spendable = Math.max(0, xlmBalance - totalLocked);

    const toXLM = (xlm) => xlm.toFixed(7);
    const toStroops = (xlm) => Math.round(xlm * STROOPS_PER_XLM);

    return success(res, {
      accountId: account.id,
      sequence: account.sequence,
      subentryCount: account.subentry_count,
      xlm: {
        ...balances.xlm,
        minimumBalance: totalLocked.toFixed(7),
        spendableBalance: spendable.toFixed(7),
      },
      reserveBreakdown: {
        baseReserve: { xlm: toXLM(baseReserve), stroops: toStroops(baseReserve) },
        accountReserve: { xlm: toXLM(accountReserve), stroops: toStroops(accountReserve) },
        subentryReserve: { xlm: toXLM(subentryReserve), stroops: toStroops(subentryReserve) },
        totalLocked: { xlm: toXLM(totalLocked), stroops: toStroops(totalLocked) },
        spendable: { xlm: toXLM(spendable), stroops: toStroops(spendable) },
      },
      assets: balances.assets,
      assetCount: balances.assets.length,
      signers: account.signers.map((s) => ({
        key: s.key,
        type: s.type,
        weight: s.weight,
      })),
      thresholds: account.thresholds,
      flags: account.flags,
      homeDomain: account.home_domain || null,
      lastModifiedLedger: account.last_modified_ledger,
    });
  } catch (err) {
    handleAccountNotFound(err, next);
  }
});

/**
 * GET /account/:id/balances
 * Returns only native XLM and asset balances for a Stellar account.
 *
 * @param {string} id - Stellar account public key (G...)
 *
 * @example
 * GET /account/GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN/balances
 */
router.get("/:id/balances", async (req, res, next) => {
  try {
    const { id } = req.params;
    validateAccountId(id);

    const account = await server.loadAccount(id);

    return success(res, formatAccountBalances(account));
  } catch (err) {
    handleAccountNotFound(err, next);
  }
});

/**
 * GET /account/:id/freeze-status/:assetCode/:assetIssuer
 * Checks whether a specific asset trustline is frozen or partially frozen.
 *
 * @param {string} id - Stellar account public key (G...)
 * @param {string} assetCode - Asset code to inspect (e.g. USD)
 * @param {string} assetIssuer - Asset issuer public key or native
 */
router.get("/:id/freeze-status/:assetCode/:assetIssuer", async (req, res, next) => {
  try {
    const { id, assetCode, assetIssuer } = req.params;
    validateAccountId(id);
    validateAssetCode(assetCode);

    const normalizedAssetCode = assetCode.toUpperCase();
    const normalizedAssetIssuer =
      normalizedAssetCode === "XLM" ? assetIssuer.toLowerCase() : assetIssuer;

    if (normalizedAssetCode === "XLM") {
      if (normalizedAssetIssuer !== "native") {
        const err = new Error('Invalid asset issuer for XLM. Use "native" as the issuer.');
        err.isValidation = true;
        throw err;
      }
    } else {
      validateAccountId(assetIssuer);
    }

    const account = await server.loadAccount(id);

    const trustline =
      normalizedAssetCode === "XLM"
        ? account.balances.find((b) => b.asset_type === "native")
        : account.balances.find(
          (b) =>
            b.asset_type !== "native" &&
            b.asset_code === normalizedAssetCode &&
            b.asset_issuer === assetIssuer,
        );

    if (!trustline) {
      const notFoundErr = new Error(
        `Account does not hold asset ${normalizedAssetCode}:${assetIssuer}.`
      );
      notFoundErr.status = 404;
      throw notFoundErr;
    }

    const isAuthorized = trustline.is_authorized !== false;
    const isAuthorizedToMaintainLiabilities =
      trustline.is_authorized_to_maintain_liabilities === true;
    const isFrozen =
      normalizedAssetCode === "XLM"
        ? false
        : !isAuthorized && !isAuthorizedToMaintainLiabilities;
    const isPartiallyFrozen =
      normalizedAssetCode !== "XLM" &&
      !isAuthorized &&
      isAuthorizedToMaintainLiabilities;
    const canReceive = normalizedAssetCode === "XLM" ? true : isAuthorized;
    const canSend =
      normalizedAssetCode === "XLM"
        ? true
        : isAuthorized || isAuthorizedToMaintainLiabilities;

    const detail = (() => {
      if (normalizedAssetCode === "XLM") {
        return "Native XLM is not subject to issuer freeze authorization.";
      }

      if (!isAuthorized && isAuthorizedToMaintainLiabilities) {
        return "The issuer has revoked authorization for this trustline but allows the account to maintain liabilities. The account can send via existing liabilities but cannot receive new amounts.";
      }

      if (!isAuthorized) {
        return "The issuer has revoked authorization for this trustline. The account cannot send or receive the asset.";
      }

      return "The trustline is authorized and the account can send and receive this asset normally.";
    })();

    return success(res, {
      accountId: account.id,
      asset: {
        assetCode: normalizedAssetCode,
        assetIssuer:
          normalizedAssetCode === "XLM" ? "native" : assetIssuer,
      },
      isFrozen,
      isPartiallyFrozen,
      canSend,
      canReceive,
      detail,
    });
  } catch (err) {
    handleAccountNotFound(err, next);
  }
});

/**
 * GET /account/:id/sequence
 * Returns only the current sequence number for a Stellar account.
 *
 * @param {string} id - Stellar account public key (G...)
 *
 * @example
 * GET /account/GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN/sequence
 */
router.get("/:id/sequence", async (req, res, next) => {
  try {
    const { id } = req.params;
    validateAccountId(id);

    const account = await server.loadAccount(id);

    return success(res, {
      accountId: account.id,
      sequence: account.sequence,
      lastModifiedLedger: account.last_modified_ledger,
    });
  } catch (err) {
    handleAccountNotFound(err, next);
  }
});

router.get("/:id/summary", accountSummaryRateLimiter, async (req, res, next) => {
  try {
    const { id } = req.params;
    validateAccountId(id);

    const [
      accountResult,
      txResult,
      offersResult,
      claimableResult,
    ] = await Promise.allSettled([
      server.loadAccount(id),
      server.transactions().forAccount(id).limit(10).order("desc").call(),
      server.offers().forAccount(id).limit(50).call(),
      server.claimableBalances().forAccount(id).limit(50).call(),
    ]);

    return success(res, {
      account:
        accountResult.status === "fulfilled"
          ? accountResult.value
          : null,

      recentTransactions:
        txResult.status === "fulfilled"
          ? txResult.value.records
          : [],

      openOffers:
        offersResult.status === "fulfilled"
          ? offersResult.value.records
          : [],

      claimableBalances:
        claimableResult.status === "fulfilled"
          ? claimableResult.value.records
          : [],
    });
  } catch (err) {
    handleAccountNotFound(err, next);
  }
});

/**
 * GET /account/:id/merge-eligibility
 * Checks whether an account is eligible to be merged.
 *
 * Verifies:
 * - Zero non-native asset balances
 * - No open offers
 * - No open trustlines (excluding native XLM)
 * - No data entries
 *
 * @param {string} id - Stellar account public key (G...)
 *
 * @example
 * GET /account/GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN/merge-eligibility
 */
router.get("/:id/merge-eligibility", async (req, res, next) => {
  try {
    const { id } = req.params;
    validateAccountId(id);

    const account = await server.loadAccount(id);
    const blockers = [];

    // 1. Check for non-native asset balances and open trustlines
    const nonNativeBalances = account.balances.filter(b => b.asset_type !== "native");
    if (nonNativeBalances.length > 0) {
      const hasPositiveBalance = nonNativeBalances.some(b => parseFloat(b.balance) > 0);
      if (hasPositiveBalance) {
        blockers.push("Account has non-native asset balances. All assets must be sent or burned before merging.");
      }
      blockers.push(`Account has ${nonNativeBalances.length} open trustline(s). All trustlines must be removed.`);
    }

    // 2. Check for open offers
    const offers = await server.offers().forAccount(id).limit(1).call();
    if (offers.records.length > 0) {
      blockers.push("Account has open offers. All offers must be cancelled.");
    }

    // 3. Check for data entries
    const dataEntries = Object.keys(account.data_attr || {});
    if (dataEntries.length > 0) {
      blockers.push(`Account has ${dataEntries.length} data entry/entries. All data entries must be removed.`);
    }

    return success(res, {
      eligible: blockers.length === 0,
      blockers,
      accountDetails: {
        accountId: account.id,
        subentryCount: account.subentry_count,
        balances: account.balances.map(b => ({
          asset: b.asset_type === "native" ? "XLM" : `${b.asset_code}:${b.asset_issuer}`,
          balance: b.balance
        }))
      }
    });
  } catch (err) {
    handleAccountNotFound(err, next);
  }
});

/**
 * GET /account/:id/payments
 * Returns only payment and create_account operations for an account,
 * filtered from the full operations list.
 *
 * Query params:
 *   - limit   (number, default: 10, max: 200)
 *   - cursor  (string, pagination cursor from previous response)
 *   - order   ("asc" | "desc", default: "desc")
 *
 * @param {string} id - Stellar account public key (G...)
 *
 * @example
 * GET /account/GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN/payments
 * GET /account/GAAZI4.../payments?limit=20&order=asc
 */
router.get("/:id/payments", async (req, res, next) => {
  try {
    const { id } = req.params;
    validateAccountId(id);

    const limit = validateLimit(req.query.limit || 10, 200);
    const order = ["asc", "desc"].includes(req.query.order)
      ? req.query.order
      : "desc";
    const cursor = req.query.cursor || undefined;

    let query = server
      .operations()
      .forAccount(id)
      .limit(limit)
      .order(order);

    if (cursor) query = query.cursor(cursor);

    const opResponse = await query.call();
    const rawRecords = opResponse.records;

    const paymentOps = [];
    let lastPaymentIndex = -1;

    rawRecords.forEach((op, idx) => {
      if (op.type === "payment" || op.type === "create_account") {
        const isPayment = op.type === "payment";

        paymentOps.push({
          type: op.type,
          amount: isPayment ? op.amount : op.starting_balance,
          asset: {
            code: isPayment ? (op.asset_code || "XLM") : "XLM",
            issuer: isPayment ? (op.asset_issuer || null) : null,
            type: isPayment ? (op.asset_type || "native") : "native",
          },
          sender: isPayment ? op.from : op.funder,
          receiver: isPayment ? op.to : op.account,
          createdAt: op.created_at,
        });
        lastPaymentIndex = idx;
      }
    });

    const nextCursor = lastPaymentIndex >= 0
      ? rawRecords[lastPaymentIndex].paging_token
      : rawRecords.length > 0
        ? rawRecords[rawRecords.length - 1].paging_token
        : null;

    return success(res, paymentOps, {
      meta: {
        count: paymentOps.length,
        limit,
        order,
        nextCursor,
        hasMore: rawRecords.length === limit,
      },
    });
  } catch (err) {
    handleAccountNotFound(err, next);
  }
});

/**
 * GET /account/:id/timeline
 * Returns a unified chronological array of meaningful events for a Stellar account.
 * Events include account creation, payments, trustline changes, and offer activity,
 * formatted for easy display in a wallet UI.
 *
 * Query params:
 *   - limit  (number, default: 10, max: 50)
 *   - cursor (string, pagination cursor)
 *
 * @param {string} id - Stellar account public key (G...)
 *
 * @example
 * GET /account/GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN/timeline
 * GET /account/GAAZI4.../timeline?limit=20
 */
router.get("/:id/timeline", async (req, res, next) => {
  try {
    const { id } = req.params;
    validateAccountId(id);

    const limit = validateLimit(req.query.limit || 10, 50);
    const cursor = req.query.cursor || undefined;

    let query = server
      .operations()
      .forAccount(id)
      .limit(limit)
      .order("desc");

    if (cursor) query = query.cursor(cursor);

    const opResponse = await query.call();
    const records = opResponse.records;

    const timeline = records.map((op) => {
      const base = {
        id: op.id,
        timestamp: op.created_at,
        transactionHash: op.transaction_hash,
      };

      switch (op.type) {
        case "create_account":
          if (op.account === id) {
            return {
              ...base,
              type: "account_created",
              description: `Account created with ${op.starting_balance} XLM by ${op.funder}`,
              amount: op.starting_balance,
              asset: "XLM",
              counterparty: op.funder,
            };
          } else {
            return {
              ...base,
              type: "payment_sent",
              description: `Sent ${op.starting_balance} XLM to create account ${op.account}`,
              amount: op.starting_balance,
              asset: "XLM",
              counterparty: op.account,
            };
          }

        case "payment":
          const isSent = op.from === id;
          const assetCode = op.asset_type === "native" ? "XLM" : op.asset_code;
          return {
            ...base,
            type: isSent ? "payment_sent" : "payment_received",
            description: isSent
              ? `Sent ${op.amount} ${assetCode} to ${op.to}`
              : `Received ${op.amount} ${assetCode} from ${op.from}`,
            amount: op.amount,
            asset: assetCode,
            counterparty: isSent ? op.to : op.from,
          };

        case "path_payment_strict_receive":
        case "path_payment_strict_send":
          const isPathSent = op.from === id;
          const sentAsset = op.source_asset_type === "native" ? "XLM" : op.source_asset_code;
          const receivedAsset = op.asset_type === "native" ? "XLM" : op.asset_code;

          if (isPathSent) {
            return {
              ...base,
              type: "payment_sent",
              description: `Sent ${op.source_amount} ${sentAsset} (converted to ${op.amount} ${receivedAsset}) to ${op.to}`,
              amount: op.source_amount,
              asset: sentAsset,
              counterparty: op.to,
            };
          } else {
            return {
              ...base,
              type: "payment_received",
              description: `Received ${op.amount} ${receivedAsset} (converted from ${op.source_amount} ${sentAsset}) from ${op.from}`,
              amount: op.amount,
              asset: receivedAsset,
              counterparty: op.from,
            };
          }

        case "change_trust":
          const isAdded = parseFloat(op.limit) > 0;
          return {
            ...base,
            type: isAdded ? "trustline_added" : "trustline_removed",
            description: isAdded
              ? `Added trustline for ${op.asset_code}`
              : `Removed trustline for ${op.asset_code}`,
            amount: op.limit,
            asset: op.asset_code,
            counterparty: op.asset_issuer,
          };

        case "manage_sell_offer":
        case "manage_buy_offer":
        case "create_passive_sell_offer":
          const isRemove = (op.type !== "create_passive_sell_offer" && parseFloat(op.amount) === 0 && op.offer_id !== "0");
          const sellAsset = op.selling_asset_type === "native" ? "XLM" : op.selling_asset_code;
          const buyAsset = op.buying_asset_type === "native" ? "XLM" : op.buying_asset_code;

          if (isRemove) {
            return {
              ...base,
              type: "offer_removed",
              description: `Cancelled offer #${op.offer_id}`,
              amount: null,
              asset: null,
              counterparty: null,
            };
          } else {
            return {
              ...base,
              type: "offer_created",
              description: `Created offer to sell ${op.amount} ${sellAsset} for ${buyAsset}`,
              amount: op.amount,
              asset: sellAsset,
              counterparty: null,
            };
          }

        default:
          return {
            ...base,
            type: op.type,
            description: `Operation of type ${op.type}`,
            amount: null,
            asset: null,
            counterparty: null,
          };
      }
    });

    const lastRecord = records[records.length - 1];
    const nextCursor = lastRecord ? lastRecord.paging_token : null;

    return success(res, timeline, {
      meta: {
        count: timeline.length,
        limit,
        nextCursor,
        hasMore: records.length === limit,
      },
    });
  } catch (err) {
    handleAccountNotFound(err, next);
  }
});

/**
 * POST /account/:id/validate-signers
 * Checks whether a given set of signers has enough combined weight to meet
 * an account's low, medium, or high thresholds.
 *
 * Body: { signers: ["G...", "G..."] }
 *
 * @param {string} id - Stellar account public key (G...)
 *
 * @example
 * POST /account/GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN/validate-signers
 * Body: { "signers": ["GBA...", "GBC..."] }
 */
router.post("/:id/validate-signers", async (req, res, next) => {
  try {
    const { id } = req.params;
    validateAccountId(id);

    const { signers } = req.body;
    if (!signers || !Array.isArray(signers)) {
      const err = new Error("Signers must be an array of public keys.");
      err.status = 400;
      return next(err);
    }

    // Validate each signer key
    for (const signerKey of signers) {
      try {
        validateAccountId(signerKey);
      } catch (e) {
        const err = new Error(`Invalid signer key: "${signerKey}".`);
        err.status = 400;
        return next(err);
      }
    }

    const account = await server.loadAccount(id);
    const accountSigners = account.signers || [];
    const thresholds = account.thresholds;

    // Calculate combined weight
    let combinedWeight = 0;
    const matchedSigners = [];

    for (const providedSigner of signers) {
      const match = accountSigners.find(s => s.key === providedSigner);
      if (match) {
        combinedWeight += match.weight;
        matchedSigners.push({
          key: match.key,
          weight: match.weight
        });
      }
    }

    return success(res, {
      lowThreshold: thresholds.low_threshold,
      medThreshold: thresholds.med_threshold,
      highThreshold: thresholds.high_threshold,
      combinedWeight,
      canSignLow: combinedWeight >= thresholds.low_threshold,
      canSignMed: combinedWeight >= thresholds.med_threshold,
      canSignHigh: combinedWeight >= thresholds.high_threshold,
      matchedSigners
    });
  } catch (err) {
    handleAccountNotFound(err, next);
  }
});

/**
 * Helper to evaluate Stellar claimable balance predicates.
 * 
 * @param {Object} predicate - The predicate object from Horizon
 * @param {number} currentTime - Current unix timestamp in seconds
 * @returns {boolean} Whether the predicate is satisfied
 */
function evaluatePredicate(predicate, currentTime) {
  if (predicate.unconditional) return true;

  if (predicate.abs_before) {
    // Horizon might return ISO string or unix timestamp
    const beforeTime = isNaN(predicate.abs_before)
      ? Math.floor(new Date(predicate.abs_before).getTime() / 1000)
      : parseInt(predicate.abs_before);
    return currentTime < beforeTime;
  }

  if (predicate.abs_after) {
    const afterTime = isNaN(predicate.abs_after)
      ? Math.floor(new Date(predicate.abs_after).getTime() / 1000)
      : parseInt(predicate.abs_after);
    return currentTime >= afterTime;
  }

  if (predicate.and) {
    return predicate.and.every(p => evaluatePredicate(p, currentTime));
  }

  if (predicate.or) {
    return predicate.or.some(p => evaluatePredicate(p, currentTime));
  }

  if (predicate.not) {
    return !evaluatePredicate(predicate.not, currentTime);
  }

  return false;
}

/**
 * GET /account/:id/claimable-balances/eligible
 * Returns claimable balances that the account is eligible to claim right now,
 * along with those that are not yet claimable or have expired.
 *
 * @param {string} id - Stellar account public key (G...)
 *
 * @example
 * GET /account/GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN/claimable-balances/eligible
 */
router.get("/:id/claimable-balances/eligible", async (req, res, next) => {
  try {
    const { id } = req.params;
    validateAccountId(id);

    // Fetch all claimable balances where this account is a claimant
    const balancesResponse = await server
      .claimableBalances()
      .forClaimant(id)
      .limit(100)
      .call();

    const records = balancesResponse.records;
    const currentTime = Math.floor(Date.now() / 1000);

    const result = {
      eligible: [],
      notYetClaimable: [],
      expired: []
    };

    records.forEach(cb => {
      const claimant = cb.claimants.find(c => c.destination === id);
      if (!claimant) return;

      const isClaimable = evaluatePredicate(claimant.predicate, currentTime);

      // We categorize as:
      // - eligible: currently claimable
      // - notYetClaimable: has an abs_after predicate that isn't met yet
      // - expired: has an abs_before predicate that has passed

      const formattedBalance = {
        id: cb.id,
        asset: cb.asset,
        amount: cb.amount,
        sponsor: cb.sponsor,
        lastModifiedLedger: cb.last_modified_ledger,
        claimants: cb.claimants
      };

      if (isClaimable) {
        result.eligible.push(formattedBalance);
      } else {
        // Simple heuristic for categorization
        const predStr = JSON.stringify(claimant.predicate);
        if (predStr.includes("abs_before") && !predStr.includes("abs_after")) {
          result.expired.push(formattedBalance);
        } else if (predStr.includes("abs_after")) {
          result.notYetClaimable.push(formattedBalance);
        } else {
          // If it's a complex predicate and false, we'll put it in notYetClaimable by default
          result.notYetClaimable.push(formattedBalance);
        }
      }
    });

    return success(res, result);
  } catch (err) {
    handleAccountNotFound(err, next);
  }
});

/**
 * GET /account/:id/data
 * Returns all data entries for an account with both raw and decoded values.
 *
 * @param {string} id - Stellar account public key (G...)
 *
 * @example
 * GET /account/GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN/data
 */
router.get("/:id/data", async (req, res, next) => {
  try {
    const { id } = req.params;
    validateAccountId(id);

    const account = await server.loadAccount(id);
    const dataEntries = account.data_attr || {};

    const formattedData = Object.entries(dataEntries).map(([key, rawValue]) => {
      let decodedValue = null;
      try {
        decodedValue = Buffer.from(rawValue, "base64").toString("utf8");
      } catch (e) {
        // Not decodable as UTF-8
      }

      return {
        key,
        rawValue,
        decodedValue,
      };
    });

    return success(res, formattedData);
  } catch (err) {
    handleAccountNotFound(err, next);
  }
});

/**
 * GET /account/:id/data/:key
 * Returns a single data entry by key.
 *
 * @param {string} id - Stellar account public key (G...)
 * @param {string} key - The data entry key
 *
 * @example
 * GET /account/GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN/data/my_key
 */
router.get("/:id/data/:key", async (req, res, next) => {
  try {
    const { id, key } = req.params;
    validateAccountId(id);

    const account = await server.loadAccount(id);
    const rawValue = account.data_attr ? account.data_attr[key] : null;

    if (!rawValue) {
      const err = new Error(`Data entry with key "${key}" not found.`);
      err.status = 404;
      return next(err);
    }

    let decodedValue = null;
    try {
      decodedValue = Buffer.from(rawValue, "base64").toString("utf8");
    } catch (e) {
      // Not decodable as UTF-8
    }

    return success(res, {
      key,
      rawValue,
      decodedValue,
    });
  } catch (err) {
    handleAccountNotFound(err, next);
  }
});

/**
 * GET /account/:id/transactions/search
 * Searches transaction history for a Stellar account and filters results by memo content.
 * Useful for developers building payment reference tracking systems.
 *
 * Query params:
 *   - memo        (string, required) - Memo value to search for
 *   - memo_type   (string, optional) - Filter by memo type: text, id, hash, return
 *   - limit       (number, default: 10, max: 200)
 *   - cursor      (string, pagination cursor from previous response)
 *   - order       ("asc" | "desc", default: "desc")
 *
 * @param {string} id - Stellar account public key (G...)
 *
 * @example
 * GET /account/GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN/transactions/search?memo=invoice-123
 * GET /account/GAAZI4.../transactions/search?memo=12345&memo_type=id
 */
router.get("/:id/transactions/search", async (req, res, next) => {
  try {
    const { id } = req.params;
    validateAccountId(id);

    // Validate required memo parameter
    const memoQuery = req.query.memo;
    if (!memoQuery) {
      const err = new Error("Query parameter 'memo' is required.");
      err.status = 400;
      return next(err);
    }

    // Optional memo_type filter
    const memoTypeFilter = req.query.memo_type ? String(req.query.memo_type).toLowerCase() : null;
    const validMemoTypes = ["text", "id", "hash", "return"];

    if (memoTypeFilter && !validMemoTypes.includes(memoTypeFilter)) {
      const err = new Error(
        `Invalid memo_type: "${req.query.memo_type}". Valid values are: text, id, hash, return.`
      );
      err.status = 400;
      return next(err);
    }

    const limit = validateLimit(req.query.limit || 10, 200);
    const order = req.query.order && ["asc", "desc"].includes(req.query.order)
      ? req.query.order
      : "desc";
    const cursor = req.query.cursor || undefined;

    // Fetch transactions from Horizon
    // We'll fetch more than requested to account for filtering
    const fetchLimit = Math.min(limit * 10, 200); // Fetch up to 10x or max 200

    let query = server
      .transactions()
      .forAccount(id)
      .limit(fetchLimit)
      .order(order)
      .includeFailed(false);

    if (cursor) query = query.cursor(cursor);

    const txResponse = await query.call();
    const STROOPS_PER_XLM = 10_000_000;

    // Filter transactions by memo
    const matchingTransactions = [];
    let lastCursor = null;

    for (const tx of txResponse.records) {
      lastCursor = tx.paging_token;

      // Skip transactions without memos if we're searching for a memo
      if (tx.memo_type === "none") {
        continue;
      }

      // Apply memo_type filter if specified
      if (memoTypeFilter && tx.memo_type !== memoTypeFilter) {
        continue;
      }

      // Check if memo matches the search query
      let memoMatches = false;
      const memoValue = tx.memo || "";
      const searchValue = String(memoQuery);

      // For text memos, do case-insensitive substring match
      if (tx.memo_type === "text") {
        memoMatches = memoValue.toLowerCase().includes(searchValue.toLowerCase());
      }
      // For id, hash, return - do exact match
      else if (tx.memo_type === "id" || tx.memo_type === "hash" || tx.memo_type === "return") {
        memoMatches = memoValue === searchValue;
      }

      if (memoMatches) {
        const chargedInStroops = parseInt(tx.fee_charged, 10);
        const opCount = tx.operation_count || 1;
        const perOpStroops = Math.floor(chargedInStroops / opCount);

        matchingTransactions.push({
          id: tx.id,
          hash: tx.hash,
          ledger: tx.ledger,
          createdAt: tx.created_at,
          sourceAccount: tx.source_account,
          fee: {
            charged: tx.fee_charged,
            account: tx.fee_account,
          },
          feeSummary: {
            chargedInStroops,
            chargedInXLM: (chargedInStroops / STROOPS_PER_XLM).toFixed(7),
            perOperationInStroops: perOpStroops,
            perOperationInXLM: (perOpStroops / STROOPS_PER_XLM).toFixed(7),
          },
          operationCount: tx.operation_count,
          memoType: tx.memo_type,
          memo: tx.memo || null,
          successful: tx.successful,
          envelopeXdr: tx.envelope_xdr,
        });

        // Stop if we've collected enough matching transactions
        if (matchingTransactions.length >= limit) {
          break;
        }
      }
    }

    // Determine if there are more results
    const hasMore = matchingTransactions.length === limit && txResponse.records.length === fetchLimit;
    const nextCursor = matchingTransactions.length > 0
      ? matchingTransactions[matchingTransactions.length - 1].id
      : lastCursor;

    return success(res, matchingTransactions, {
      meta: {
        count: matchingTransactions.length,
        limit,
        order,
        searchQuery: {
          memo: memoQuery,
          memoType: memoTypeFilter || "any",
        },
        nextCursor: hasMore ? nextCursor : null,
        hasMore,
      },
    });
  } catch (err) {
    handleAccountNotFound(err, next);
  }
});

/**
 * GET /account/:id/pool-positions
 * Calculates the current value of a liquidity provider's position in all Stellar AMM pools
 * based on their pool shares.
 *
 * For each pool, calculates:
 * - The account's share percentage
 * - Equivalent reserve amounts for both assets
 *
 * @param {string} id - Stellar account public key (G...)
 *
 * @example
 * GET /account/GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN/pool-positions
 */
router.get("/:id/pool-positions", async (req, res, next) => {
  try {
    const { id } = req.params;
    validateAccountId(id);

    // Fetch account details to get trustlines
    const account = await server.loadAccount(id);

    // Filter trustlines to find liquidity pool shares
    // Liquidity pool shares have asset_type === "liquidity_pool_shares"
    const poolShareTrustlines = account.balances.filter(
      (balance) => balance.asset_type === "liquidity_pool_shares"
    );

    if (poolShareTrustlines.length === 0) {
      return success(res, [], {
        meta: {
          count: 0,
          accountId: id,
          message: "No liquidity pool positions found for this account.",
        },
      });
    }

    // Fetch pool details for all pools in parallel
    const poolDetailsPromises = poolShareTrustlines.map((trustline) =>
      server
        .liquidityPools()
        .liquidityPoolId(trustline.liquidity_pool_id)
        .call()
        .catch((err) => {
          // If a pool is not found, return null instead of throwing
          if (err.response && err.response.status === 404) {
            return null;
          }
          throw err;
        })
    );

    const poolDetails = await Promise.all(poolDetailsPromises);

    // Calculate positions
    const positions = [];

    for (let i = 0; i < poolShareTrustlines.length; i++) {
      const trustline = poolShareTrustlines[i];
      const pool = poolDetails[i];

      // Skip if pool was not found
      if (!pool) {
        continue;
      }

      const accountShares = parseFloat(trustline.balance);
      const totalShares = parseFloat(pool.total_shares);

      // Calculate share percentage
      const sharePercent = totalShares > 0 ? (accountShares / totalShares) * 100 : 0;

      // Calculate equivalent reserves
      const reserveA = pool.reserves[0];
      const reserveB = pool.reserves[1];

      const equivalentReserveA = (parseFloat(reserveA.amount) * accountShares) / totalShares;
      const equivalentReserveB = (parseFloat(reserveB.amount) * accountShares) / totalShares;

      positions.push({
        poolId: pool.id,
        shares: accountShares.toFixed(7),
        sharePercent: sharePercent.toFixed(4),
        totalPoolShares: totalShares.toFixed(7),
        reserveA: {
          asset: reserveA.asset,
          totalAmount: parseFloat(reserveA.amount).toFixed(7),
          equivalentAmount: equivalentReserveA.toFixed(7),
        },
        reserveB: {
          asset: reserveB.asset,
          totalAmount: parseFloat(reserveB.amount).toFixed(7),
          equivalentAmount: equivalentReserveB.toFixed(7),
        },
        feeBp: pool.fee_bp || 30,
        totalTrustlines: pool.total_trustlines,
        lastModifiedLedger: pool.last_modified_ledger,
      });
    }

    return success(res, positions, {
      meta: {
        count: positions.length,
        accountId: id,
      },
    });
  } catch (err) {
    handleAccountNotFound(err, next);
  }
});

module.exports = router;
