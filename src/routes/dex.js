const express = require("express");
const router = express.Router();
const { Asset } = require("@stellar/stellar-sdk");
const { server } = require("../config/stellar");
const { success } = require("../utils/response");
const { validateAssetCode, validateAccountId } = require("../utils/validators");

/**
 * GET /dex/arbitrage/:assetode/:assetIssuer
 * Checks for circular paths back to the same asset to find arbitrage opportunities.
 *
 * Acceptance Criteria:
 * - GET /dex/arbitrage/:asseCtCode/:assetIssuer checks for circular paths back to the same asset
 * - Uses Horizon's strict-receive path finding to find paths from the asset back to itself
 * - Returns { pathsFound: true/false, paths: [...] } with source amount vs destination amount per path
 * - Returns 400 for invalid asset format
 *
 * @example
 * GET /dex/arbitrage/USDC/GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
 */
router.get("/arbitrage/:assetCode/:assetIssuer", async (req, res, next) => {
  try {
    const { assetCode, assetIssuer } = req.params;

    // Validate asset format
    try {
      if (assetCode.toUpperCase() === "XLM" && assetIssuer.toLowerCase() === "native") {
        // Native XLM is valid
      } else {
        validateAssetCode(assetCode);
        validateAccountId(assetIssuer);
      }
    } catch (err) {
      return res.status(400).json({
        success: false,
        error: {
          type: "ValidationError",
          message: err.message,
        },
      });
    }

    const asset = (assetCode.toUpperCase() === "XLM" && assetIssuer.toLowerCase() === "native")
      ? Asset.native()
      : new Asset(assetCode.toUpperCase(), assetIssuer);

    // Use a fixed destination amount to check for paths
    // We use "10.0" as a standard test amount, but it could be anything.
    const destinationAmount = "10.0000000";

    const pathsResponse = await server
      .strictReceivePaths([asset], asset, destinationAmount)
      .call();

    const paths = (pathsResponse.records || [])
      .map((path) => ({
        sourceAmount: path.source_amount,
        destinationAmount: path.destination_amount,
        path: path.path.map((hop) => ({
          assetCode: hop.asset_code || "XLM",
          assetIssuer: hop.asset_issuer || "native",
          assetType: hop.asset_type,
        })),
        isProfitable: parseFloat(path.source_amount) < parseFloat(path.destination_amount),
      }))
      .filter((p) => p.path.length > 0); // Only include actual paths with hops

    return success(res, {
      pathsFound: paths.length > 0,
      paths: paths,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /dex/spread/:sellAsset/:buyAsset
 * Calculates the bid-ask spread for a trading pair on the Stellar DEX.
 * Helps developers and traders assess market liquidity at a glance.
 *
 * Asset format: CODE:ISSUER or XLM:native
 *
 * @example
 * GET /dex/spread/XLM:native/USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
 * GET /dex/spread/USDC:GA5Z.../EURC:GB...
 */
router.get("/spread/:sellAsset/:buyAsset", async (req, res, next) => {
  try {
    const { sellAsset, buyAsset } = req.params;

    // Parse asset strings (format: CODE:ISSUER)
    const parseStellarAsset = (assetString) => {
      const parts = assetString.split(":");
      if (parts.length !== 2) {
        throw new Error(`Invalid asset format: "${assetString}". Expected format: CODE:ISSUER`);
      }

      const [code, issuer] = parts;

      // Validate
      if (code.toUpperCase() === "XLM" && issuer.toLowerCase() === "native") {
        return Asset.native();
      }

      validateAssetCode(code);
      validateAccountId(issuer);

      return new Asset(code.toUpperCase(), issuer);
    };

    let selling, buying;

    try {
      selling = parseStellarAsset(sellAsset);
      buying = parseStellarAsset(buyAsset);
    } catch (err) {
      return res.status(400).json({
        success: false,
        error: {
          type: "ValidationError",
          message: err.message,
        },
      });
    }

    // Fetch order book from Horizon
    const orderBookResponse = await server
      .orderbook(selling, buying)
      .limit(200)
      .call();

    const bids = orderBookResponse.bids || [];
    const asks = orderBookResponse.asks || [];

    // Check if order book exists
    if (bids.length === 0 && asks.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          type: "NotFound",
          message: "No order book exists for this trading pair.",
        },
      });
    }

    // Calculate best bid and ask
    const bestBid = bids.length > 0 ? {
      price: parseFloat(bids[0].price),
      amount: parseFloat(bids[0].amount),
    } : null;

    const bestAsk = asks.length > 0 ? {
      price: parseFloat(asks[0].price),
      amount: parseFloat(asks[0].amount),
    } : null;

    // Calculate spread
    let spreadAbsolute = null;
    let spreadPercent = null;
    let midPrice = null;

    if (bestBid && bestAsk) {
      spreadAbsolute = bestAsk.price - bestBid.price;
      midPrice = (bestBid.price + bestAsk.price) / 2;
      spreadPercent = (spreadAbsolute / midPrice) * 100;
    } else if (bestBid) {
      midPrice = bestBid.price;
    } else if (bestAsk) {
      midPrice = bestAsk.price;
    }

    // Calculate total order book depth
    const totalBidVolume = bids.reduce((sum, bid) => sum + parseFloat(bid.amount), 0);
    const totalAskVolume = asks.reduce((sum, ask) => sum + parseFloat(ask.amount), 0);
    const totalVolume = totalBidVolume + totalAskVolume;

    // Determine liquidity level
    // These thresholds can be adjusted based on market conditions
    let liquidity;
    if (totalVolume >= 10000) {
      liquidity = "high";
    } else if (totalVolume >= 1000) {
      liquidity = "medium";
    } else {
      liquidity = "low";
    }

    return success(res, {
      bestBid: bestBid ? {
        price: bestBid.price.toFixed(7),
        amount: bestBid.amount.toFixed(7),
      } : null,
      bestAsk: bestAsk ? {
        price: bestAsk.price.toFixed(7),
        amount: bestAsk.amount.toFixed(7),
      } : null,
      spreadAbsolute: spreadAbsolute !== null ? spreadAbsolute.toFixed(7) : null,
      spreadPercent: spreadPercent !== null ? spreadPercent.toFixed(4) : null,
      midPrice: midPrice !== null ? midPrice.toFixed(7) : null,
      liquidity,
      orderBookDepth: {
        bids: bids.length,
        asks: asks.length,
        totalBidVolume: totalBidVolume.toFixed(7),
        totalAskVolume: totalAskVolume.toFixed(7),
        totalVolume: totalVolume.toFixed(7),
      },
    });
  } catch (err) {
    // Handle Horizon errors
    if (err.response && err.response.status === 404) {
      return res.status(404).json({
        success: false,
        error: {
          type: "NotFound",
          message: "No order book exists for this trading pair.",
        },
      });
    }
    next(err);
  }
});

module.exports = router;
