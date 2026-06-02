/**
 * Sanitize middleware for all incoming route parameters and query strings.
 * - Trims whitespace from all req.params and req.query string values
 * - Strips null bytes (\0) from all string inputs
 * - Returns 400 if any single param or query value exceeds 500 characters
 */

const MAX_PARAM_LENGTH = 500;

function sanitizeValue(value) {
  if (typeof value !== "string") return value;
  return value.trim().replace(/\0/g, "");
}

function sanitize(req, res, next) {
  // Check length before sanitizing
  const allValues = [
    ...Object.values(req.params || {}),
    ...Object.values(req.query || {}),
  ];

  for (const value of allValues) {
    if (typeof value === "string" && value.length > MAX_PARAM_LENGTH) {
      return res.status(400).json({
        success: false,
        error: {
          type: "ValidationError",
          message: `Input exceeds maximum allowed length of ${MAX_PARAM_LENGTH} characters.`,
        },
      });
    }
  }

  // Sanitize req.params
  for (const key of Object.keys(req.params || {})) {
    req.params[key] = sanitizeValue(req.params[key]);
  }

  // Sanitize req.query
  for (const key of Object.keys(req.query || {})) {
    const val = req.query[key];
    if (Array.isArray(val)) {
      req.query[key] = val.map(sanitizeValue);
    } else {
      req.query[key] = sanitizeValue(val);
    }
  }

  next();
}

module.exports = sanitize;
