const express = require("express");
const router = express.Router();
const { server } = require("../config/stellar");
const { StrKey } = require("@stellar/stellar-sdk");
const { formatTransaction } = require("../utils/formatTransaction");

/**
 * Error codes for SSE stream errors
 */
const STREAM_ERROR_CODES = {
  ACCOUNT_NOT_FOUND: "ACCOUNT_NOT_FOUND",
  INVALID_ACCOUNT_ID: "INVALID_ACCOUNT_ID",
  STREAM_ERROR: "STREAM_ERROR",
  HORIZON_UNAVAILABLE: "HORIZON_UNAVAILABLE",
};

/**
 * GET /stream/transactions/:id
 * Server-Sent Events endpoint that streams real-time transactions for a Stellar account.
 *
 * Path param:
 *   - id: Stellar account public key (G... address, 56 chars)
 *
 * SSE Events:
 *   - connected: Sent immediately after validation passes
 *   - transaction: Sent for each new transaction on the account
 *   - heartbeat: Sent every 25 seconds to keep connection alive
 *   - error: Sent before closing on fatal error
 *
 * @example
 * GET /stream/transactions/GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN
 */
router.get("/transactions/:id", async (req, res, next) => {
  const { id } = req.params;

  // ── Validation Phase ────────────────────────────────────────────────────────
  // Validate before setting SSE headers

  // 1. Non-empty check
  if (!id) {
    return res.status(400).json({
      success: false,
      error: {
        type: "ValidationError",
        message: "Account ID is required",
      },
    });
  }

  // 2. Format check
  if (!StrKey.isValidEd25519PublicKey(id)) {
    return res.status(400).json({
      success: false,
      error: {
        type: "ValidationError",
        message: "Invalid Stellar account ID",
        detail: "Must be a valid G... address",
      },
    });
  }

  // 3. Account existence check (optional but preferred)
  try {
    await server.loadAccount(id);
  } catch (err) {
    // Check if it's an AccountNotFoundError (404 from Horizon)
    if (err.response && err.response.status === 404) {
      return res.status(404).json({
        success: false,
        error: {
          type: "NotFound",
          message: "Account not found",
          detail: "No Stellar account exists for this public key",
        },
      });
    }
    // For other network errors, log but proceed (don't fail the stream)
    if (process.env.NODE_ENV !== "test") {
      console.warn(`[WARN] Account existence check failed for ${id}:`, err.message);
    }
  }

  // ── SSE Setup ───────────────────────────────────────────────────────────────
  // Set SSE headers after validation passes
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Log stream opened
  if (process.env.NODE_ENV !== "test") {
    console.log(`[INFO] Stream opened for account ${id} at ${new Date().toISOString()}`);
  }

  // Send connected event immediately
  res.write(`event: connected\n`);
  res.write(`data: ${JSON.stringify({
    account: id,
    timestamp: new Date().toISOString(),
  })}\n\n`);

  // ── Horizon Stream Setup ────────────────────────────────────────────────────
  let streamClose;
  let heartbeatInterval;

  try {
    // Start streaming transactions from now onwards (not historical)
    streamClose = server
      .transactions()
      .forAccount(id)
      .cursor("now")
      .stream({
        onmessage: (transaction) => {
          // Check if client has disconnected
          if (res.writableEnded || res.destroyed) {
            streamClose();
            return;
          }

          // Log transaction (hash only, not full payload)
          if (process.env.NODE_ENV !== "test") {
            console.debug(`[DEBUG] Transaction forwarded: ${transaction.hash}`);
          }

          // Format and send transaction event
          const payload = formatTransaction(transaction);
          res.write(`event: transaction\n`);
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        },
        onerror: (error) => {
          // Log the error
          if (process.env.NODE_ENV !== "test") {
            console.error(`[ERROR] Horizon stream error for ${id}:`, error);
          }

          // Send error event if connection still open
          if (!res.writableEnded && !res.destroyed) {
            res.write(`event: error\n`);
            res.write(`data: ${JSON.stringify({
              code: STREAM_ERROR_CODES.STREAM_ERROR,
              message: "Transaction stream encountered an error",
            })}\n\n`);
            res.end();
          }

          // Clean up
          streamClose();
          if (heartbeatInterval) clearInterval(heartbeatInterval);
        },
      });
  } catch (err) {
    // Catch any synchronous errors during stream setup
    if (process.env.NODE_ENV !== "test") {
      console.error(`[ERROR] Failed to set up stream for ${id}:`, err);
    }

    if (!res.writableEnded && !res.destroyed) {
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({
        code: STREAM_ERROR_CODES.HORIZON_UNAVAILABLE,
        message: "Failed to connect to transaction stream",
      })}\n\n`);
      res.end();
    }
    return;
  }

  // ── Heartbeat ───────────────────────────────────────────────────────────────
  // Send heartbeat every 25 seconds to keep connection alive through proxies
  heartbeatInterval = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(heartbeatInterval);
      return;
    }

    if (process.env.NODE_ENV !== "test") {
      console.warn(`[WARN] Heartbeat sent to potentially stale connection for ${id}`);
    }

    res.write(`event: heartbeat\n`);
    res.write(`data: ${JSON.stringify({
      timestamp: new Date().toISOString(),
    })}\n\n`);
  }, 25_000);

  // ── Client Disconnect Cleanup ───────────────────────────────────────────────
  req.on("close", () => {
    if (process.env.NODE_ENV !== "test") {
      console.log(`[INFO] Stream closed for account ${id} (client disconnect) at ${new Date().toISOString()}`);
    }

    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (streamClose) streamClose();
  });

  req.on("error", () => {
    if (process.env.NODE_ENV !== "test") {
      console.log(`[INFO] Stream closed for account ${id} (error) at ${new Date().toISOString()}`);
    }

    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (streamClose) streamClose();
  });
});

/**
 * GET /stream/ledgers
 * Server-Sent Events endpoint that streams live Stellar ledger close events.
 *
 * SSE Events:
 *   - data: JSON with { sequence, closedAt, baseFee, transactionCount, operationCount }
 *   - comment (": ping"): heartbeat every 30 seconds
 */
router.get("/ledgers", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Access-Control-Allow-Origin", "*");

  let closeStream;
  let heartbeatInterval;

  try {
    closeStream = server
      .ledgers()
      .cursor("now")
      .stream({
        onmessage: (ledger) => {
          if (res.writableEnded || res.destroyed) {
            closeStream && closeStream();
            return;
          }
          const payload = {
            sequence: ledger.sequence,
            closedAt: ledger.closed_at,
            baseFee: ledger.base_fee_in_stroops,
            transactionCount: ledger.successful_transaction_count,
            operationCount: ledger.operation_count,
          };
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        },
        onerror: () => {
          if (!res.writableEnded && !res.destroyed) res.end();
          closeStream && closeStream();
          clearInterval(heartbeatInterval);
        },
      });
  } catch {
    if (!res.writableEnded && !res.destroyed) res.end();
    return;
  }

  heartbeatInterval = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(heartbeatInterval);
      return;
    }
    res.write(": ping\n\n");
  }, 30_000);

  req.on("close", () => {
    clearInterval(heartbeatInterval);
    closeStream && closeStream();
  });
});

module.exports = router;
