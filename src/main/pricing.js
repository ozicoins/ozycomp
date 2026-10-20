'use strict';
/**
 * Pricing — the token-cost table, verbatim from the reference. Per-million
 * USD for the four Claude tiers it knows (Opus / Sonnet / Haiku / Sonnet 5.5),
 * applied to a token accounting {inputTokens, outputTokens, cacheReadTokens,
 * cacheWriteTokens}. Unknown models fall back to the Sonnet tier — the middle
 * of the table, so an estimate is never wild in either direction.
 */
const OPUS = { inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5, cacheWritePerM: 18.75 };
const SONNET = { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 };
const HAIKU = { inputPerM: 0.8, outputPerM: 4, cacheReadPerM: 0.08, cacheWritePerM: 1 };
const SONNET_5_5 = { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5 };
const DEFAULT_PRICE = SONNET;
function normalizeModel(model) {
  return (model ?? "").trim().replace(/\[[^\]]*\]\s*$/, "");
}
function priceFor(model) {
  const m = normalizeModel(model).toLowerCase();
  if (m.includes("opus")) return OPUS;
  if (m.includes("haiku")) return HAIKU;
  if (/sonnet-5-5(?![0-9])/.test(m)) return SONNET_5_5;
  if (m.includes("sonnet")) return SONNET;
  return DEFAULT_PRICE;
}
function estimateCostUsd(model, tokens) {
  const p = priceFor(model);
  return tokens.inputTokens / 1e6 * p.inputPerM + tokens.outputTokens / 1e6 * p.outputPerM + tokens.cacheReadTokens / 1e6 * p.cacheReadPerM + tokens.cacheWriteTokens / 1e6 * p.cacheWritePerM;
}

module.exports = { OPUS, SONNET, HAIKU, SONNET_5_5, DEFAULT_PRICE, normalizeModel, priceFor, estimateCostUsd };
