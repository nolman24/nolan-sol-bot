import dotenv from "dotenv";
dotenv.config();

import { Telegraf } from "telegraf";
import fs from "fs";
import WebSocket from "ws";
import fetch from "node-fetch";

// ─── VALIDATE ENV ────────────────────────────────────────────────────────────
for (const key of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) {
  if (!process.env[key]) {
    console.error(`❌ Missing env var: ${key}`);
    process.exit(1);
  }
}

const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID     = process.env.TELEGRAM_CHAT_ID;
const STATE_FILE  = "./state.json";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const RPC_WS  = "wss://api.mainnet-beta.solana.com";
const RPC_HTTP = "https://api.mainnet-beta.solana.com";

const GRADUATION_SOL    = 42;
const PRICE_INTERVAL_MS = 30_000;
const MAX_OPEN_TRADES   = 20;
const WHALE_SOL_THRESH  = 5; // whale detection

// ─── STATE ───────────────────────────────────────────────────────────────────
let state = {
  config: { minScore: 65, tradeAmount: 0.1, paused: false, paperTrading: true, alertWatch: false },
  seenMints: [],
  openTrades: {},
  closedTrades: [],
  stats: { tokensReceived: 0, alertsSent: 0, totalTrades: 0, startedAt: Date.now(), wsConnected: false, lastEventAt: null },
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      state = { ...state, ...saved, config: { ...state.config, ...(saved.config || {}) } };
      console.log(`[state] Loaded — open: ${Object.keys(state.openTrades).length}, closed: ${state.closedTrades.length}`);
    }
  } catch (e) { console.error("[state] Load failed:", e.message); }
}

function saveState() {
  if (state.seenMints.length > 2000) state.seenMints = state.seenMints.slice(-1000);
  if (state.closedTrades.length > 500) state.closedTrades.length = 500;
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { console.error("[state] Save failed:", e.message); }
}

// ─── UTILS ──────────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function rpcCall(method, params = []) {
  const res = await fetch(RPC_HTTP, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    signal: AbortSignal.timeout(12_000),
  });
  const data = await res.json();
  if (data.error) throw new Error(`RPC error: ${data.error.message}`);
  return data.result;
}

// ─── QUEUE ──────────────────────────────────────────────────────────────────
const SYSTEM_ACCOUNTS = new Set([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bv",
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  PUMP_PROGRAM_ID,
]);

const sigQueue   = [];
let   queueBusy  = false;

function enqueueSig(sig) {
  if (sigQueue.some(item => item.sig === sig)) return;
  sigQueue.push({ sig, enqueuedAt: Date.now() });
  if (!queueBusy) processQueue();
}

async function processQueue() {
  queueBusy = true;
  while (sigQueue.length > 0) {
    const item = sigQueue.shift();
    if (Date.now() - item.enqueuedAt > 90_000) continue;
    await getMintFromSignature(item.sig, 3)
      .then(mint => { if (mint) handleMint(mint); })
      .catch(() => {});
    if (sigQueue.length > 0) await sleep(1_100);
  }
  queueBusy = false;
}

async function getMintFromSignature(signature, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const tx = await rpcCall("getTransaction", [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      if (!tx) return null;
      const keys = tx.transaction?.message?.accountKeys ?? tx.transaction?.message?.staticAccountKeys;
      if (!keys?.length) return null;
      for (const key of keys) {
        const k = typeof key === "string" ? key : key.pubkey || key.toString();
        if (!SYSTEM_ACCOUNTS.has(k) && k.length >= 32) return k;
      }
      return null;
    } catch (e) {
      const isRateLimit = e.message.includes("Too many requests") || e.message.includes("429");
      if (isRateLimit && attempt < retries) await sleep(attempt * 2_000);
      else return null;
    }
  }
  return null;
}

// ─── TOKEN SCORING WITH WHALE DETECTION ───────────────────────────────────────
function scoreToken(coin) {
  const solInCurve   = (coin.virtual_sol_reserves || 0) / 1e9;
  const bondingPct   = parseFloat(Math.min(99, (solInCurve / GRADUATION_SOL) * 100).toFixed(1));
  const mcapUSD      = coin.usd_market_cap || 0;
  const ageSeconds   = Math.floor((Date.now() - (coin.created_timestamp || Date.now())) / 1000);
  const replyCount   = coin.reply_count || 0;
  const hasTwitter   = !!coin.twitter;
  const hasTelegram  = !!coin.telegram;
  const hasWebsite   = !!coin.website;
  const isKingOfHill = !!coin.is_currently_king_of_the_hill;
  const ageMinutes   = Math.max(0.1, ageSeconds / 60);
  const velocitySOL  = parseFloat((solInCurve / ageMinutes).toFixed(3));

  let score = 0;
  score += Math.min(28, velocitySOL * 6);
  if (hasTwitter) score += 8;
  if (hasTelegram) score += 6;
  if (hasWebsite) score += 4;
  score += Math.min(12, (replyCount / 25) * 12);
  if (isKingOfHill) score += 8;
  if (ageSeconds < 60) score += 14;
  else if (ageSeconds < 120) score += 10;
  else if (ageSeconds < 300) score += 5;
  if (solInCurve > 5)  score += 5;
  if (solInCurve > 15) score += 5;
  if (solInCurve > 28) score += 4;

  const whaleAlert = solInCurve >= WHALE_SOL_THRESH;
  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    mint: coin.mint || coin,
    symbol: (coin.symbol || "???").toUpperCase(),
    name: coin.name || "Unknown",
    solInCurve: parseFloat(solInCurve.toFixed(3)),
    bondingPct,
    mcapUSD,
    velocitySOL,
    ageSeconds,
    replyCount,
    hasTwitter, hasTelegram, hasWebsite,
    isKingOfHill,
    score,
    whaleAlert,
    verdict: score >= 68 ? "BUY" : score >= 45 ? "WATCH" : "SKIP",
  };
}

// ─── HANDLE MINT ────────────────────────────────────────────────────────────
async function handleMint(mint) {
  if (state.seenMints.includes(mint)) return;
  state.seenMints.push(mint);
  state.stats.tokensReceived++;

  // Fake data fetch for demo — replace with real pump.fun or Solana API call
  const coin = { mint, virtual_sol_reserves: Math.random() * 50, usd_market_cap: 100_000, created_timestamp: Date.now() - Math.random()*300_000, twitter: true, telegram: false, website: true };
  const scored = scoreToken(coin);

  if (scored.score >= state.config.minScore || scored.whaleAlert) {
    const msg = `[${scored.verdict}] ${scored.symbol} | SOL: ${scored.solInCurve} | Score: ${scored.score}${scored.whaleAlert ? " 🐋 WHALE" : ""}`;
    bot.telegram.sendMessage(CHAT_ID, msg);
    state.stats.alertsSent++;
  }

  saveState();
}

// ─── BOT START ──────────────────────────────────────────────────────────────
loadState();
bot.launch().then(() => console.log("[bot] Telegram bot started"));

process.on("uncaughtException", e => console.error("[error]", e));
process.on("unhandledRejection", e => console.error("[promise rejection]", e));

console.log("[bot] Ready! Listening for mints...");
