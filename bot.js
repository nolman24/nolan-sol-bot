// ─────────────────────────────────────────────────────────────────────────────
// pump.fun Telegram Scanner Bot — Paper Trading Edition with Whale Detection
// Stack: Node.js · Telegraf · Solana RPC WebSocket · Groq API (free)
// Deploy: Railway — set env vars, push to GitHub, done.
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";  // loads .env automatically
import { Telegraf } from "telegraf";
import http from "http";
import fs from "fs";
import WebSocket from "ws";
import fetch from "node-fetch"; // in Node18+ this is built-in, but explicit import is safe

// ─── VALIDATE ENV ────────────────────────────────────────────────────────────
for (const key of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "GROQ_API_KEY"]) {
  if (!process.env[key]) { 
    console.error(`❌ Missing env var: ${key}`); 
    process.exit(1); 
  }
}

const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID     = process.env.TELEGRAM_CHAT_ID;
const GROQ_KEY    = process.env.GROQ_API_KEY;
const HELIUS_KEY  = process.env.HELIUS_API_KEY || null;
const STATE_FILE  = "./state.json";

// ─── SOLANA CONFIG ───────────────────────────────────────────────────────────
const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const RPC_WS  = HELIUS_KEY
  ? `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`
  : "wss://api.mainnet-beta.solana.com";
const RPC_HTTP = HELIUS_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`
  : "https://api.mainnet-beta.solana.com";

// ─── BOT CONFIG ──────────────────────────────────────────────────────────────
const GRADUATION_SOL    = 42;
const SOL_PRICE_USD     = 175;
const PRICE_INTERVAL_MS = 30_000;
const MAX_OPEN_TRADES   = 20;
const PNL_ALERT_STEP    = 25;
const RECONNECT_DELAY   = 5_000;
const WHALE_THRESHOLD_SOL = 50; // minimum SOL raised to flag a whale

// ─── STATE ───────────────────────────────────────────────────────────────────
let state = {
  config: {
    minScore:    65,
    tradeAmount: 0.1,
    paused:      false,
    paperTrading: true,
    alertWatch:  false,
  },
  seenMints:    [],
  openTrades:   {},
  closedTrades: [],
  stats: {
    tokensReceived: 0,
    alertsSent:     0,
    totalTrades:    0,
    startedAt:      Date.now(),
    wsConnected:    false,
    lastEventAt:    null,
  },
};

// ─── STATE HELPERS ───────────────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      state = {
        ...state, ...saved,
        config: { ...state.config, ...(saved.config || {}) },
        stats:  { ...state.stats,  ...(saved.stats  || {}), wsConnected: false },
      };
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

// ─── CLIENTS ─────────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── SOLANA RPC HELPERS ───────────────────────────────────────────────────────
let rpcId = 1;
async function rpcCall(method, params = []) {
  const res = await fetch(RPC_HTTP, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
    signal:  AbortSignal.timeout(12_000),
  });
  const data = await res.json();
  if (data.error) throw new Error(`RPC error: ${data.error.message}`);
  return data.result;
}

// ─── SIGNATURE QUEUE ──────────────────────────────────────────────────────────
const SYSTEM_ACCOUNTS = new Set([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bv",
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  PUMP_PROGRAM_ID,
]);

const sigQueue   = [];   // { sig, enqueuedAt }
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
      const tx = await rpcCall("getTransaction", [
        signature,
        { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
      ]);
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
      if (isRateLimit && attempt < retries) {
        await sleep(attempt * 2_000);
      } else {
        return null;
      }
    }
  }
  return null;
}

// ─── TOKEN SCORING ────────────────────────────────────────────────────────────
function scoreToken(coin) {
  const solInCurve   = (coin.virtual_sol_reserves  || 0) / 1e9;
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
  if (hasTwitter)   score += 8;
  if (hasTelegram)  score += 6;
  if (hasWebsite)   score += 4;
  score += Math.min(12, (replyCount / 25) * 12);
  if (isKingOfHill) score += 8;
  if      (ageSeconds < 60)  score += 14;
  else if (ageSeconds < 120) score += 10;
  else if (ageSeconds < 300) score += 5;
  if (solInCurve > 5)  score += 5;
  if (solInCurve > 15) score += 5;
  if (solInCurve > 28) score += 4;

  score = Math.max(0, Math.min(100, Math.round(score)));

  const isWhale = solInCurve >= WHALE_THRESHOLD_SOL;

  return {
    mint:         coin.mint || coin,
    symbol:       (coin.symbol || "???").toUpperCase(),
    name:         coin.name || "Unknown",
    description:  coin.description || "",
    solInCurve:   parseFloat(solInCurve.toFixed(3)),
    bondingPct,
    mcapUSD,
    velocitySOL,
    ageSeconds,
    replyCount,
    hasTwitter, hasTelegram, hasWebsite,
    isKingOfHill,
    complete:     !!coin.complete,
    score,
    verdict: score >= 68 ? "BUY" : score >= 45 ? "WATCH" : "SKIP",
    isWhale,
  };
}

// ─── FETCH TOKEN META ─────────────────────────────────────────────────────────
async function fetchTokenMeta(mint) {
  try {
    const res = await fetch(`https://frontend-api.pump.fun/coins/${mint}`, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
        "Referer": "https://pump.fun/",
        "Origin": "https://pump.fun",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

// ─── HANDLING NEW TOKENS ─────────────────────────────────────────────────────
async function handleMint(mint) {
  if (!mint || state.seenMints.includes(mint)) return;
  state.seenMints.push(mint);
  state.stats.tokensReceived++;
  state.stats.lastEventAt = Date.now();
  if (state.config.paused) return;

  const coin = await fetchTokenMeta(mint);
  const tokenData = coin || { mint, symbol: "???", name: "Unknown" };
  if (coin?.complete) return;

  const token = scoreToken(tokenData);
  const shouldAlert =
    (token.verdict === "BUY" && token.score >= state.config.minScore) ||
    (token.verdict === "WATCH" && state.config.alertWatch);

  if (!shouldAlert) {
    console.log(`[chain] SKIP $${token.symbol} score=${token.score}`);
    saveState();
    return;
  }

  console.log(`[chain] ${token.verdict} $${token.symbol} score=${token.score}${token.isWhale ? " 🐋" : ""}`);
  if (state.config.paperTrading && token.verdict === "BUY") openTrade(token);
  const analysis = await analyzeToken(token).catch(() => "Analysis unavailable.");
  await sendTokenAlert(token, analysis);
  saveState();
}

// ─── TELEGRAM ALERTS ─────────────────────────────────────────────────────────
async function sendTokenAlert(token, analysis) {
  const emoji   = { BUY: "🟢", WATCH: "🟡", SKIP: "🔴" }[token.verdict] || "⚪";
  const socials = [
    token.hasTwitter  && "🐦 TW",
    token.hasTelegram && "💬 TG",
    token.hasWebsite  && "🌐 Web",
  ].filter(Boolean).join("  ") || "no socials";

  const whaleLine = token.isWhale ? "🐋 Whale Detected" : null;
  const trade = state.openTrades[token.mint];
  const paperLine = trade ? `📝 Paper bought ${trade.solAmount} SOL @ ${fmtUSD(token.mcapUSD)}` : null;

  const lines = [
    `${emoji} *${token.verdict}* — Score: ${token.score}/100`,
    whaleLine,
    `━━━━━━━━━━━━━━━━━━━━`,
    `*$${token.symbol}* — ${token.name}`,
    token.isKingOfHill ? "👑 King of the Hill" : null,
    ``,
    `⏱ Age: ${fmtAge(token.ageSeconds)}`,
    `📊 ${bondingBar(token.bondingPct)}`,
    `◎ ${token.solInCurve} SOL raised  |  MCap: ${fmtUSD(token.mcapUSD)}`,
    `⚡ ${token.velocitySOL} SOL/min  |  💬 ${token.replyCount} replies`,
    `🔗 ${socials}`,
    paperLine,
    ``,
    `🤖 *AI:*`,
    analysis,
    `[View on pump.fun](https://pump.fun/${token.mint})`,
    `\`${token.mint}\``,
  ].filter(l => l !== null);

  await bot.telegram.sendMessage(CHAT_ID, lines.join("\n"), {
    parse_mode: "Markdown", disable_web_page_preview: true,
  });
  state.stats.alertsSent++;
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────
loadState();
bot.launch();
console.log("✅ Telegram bot online");

bot.telegram.sendMessage(CHAT_ID, `🟠 *pump.fun Scanner starting...*`, { parse_mode: "Markdown" }).catch(() => {});
connectSolanaWS();
setInterval(updatePrices, PRICE_INTERVAL_MS);

process.once("SIGINT",  () => { saveState(); bot.stop("SIGINT"); });
process.once("SIGTERM", () => { saveState(); bot.stop("SIGTERM"); });

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function fmtUSD(n) {
  if (n >= 1e6) return `$${(n/1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n/1e3).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}
function fmtAge(s) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}m ${s%60}s`;
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
}
function bondingBar(pct) {
  const f = Math.min(20, Math.round(pct/5));
  return `[${"█".repeat(f)}${"░".repeat(20-f)}] ${pct}%`;
}
