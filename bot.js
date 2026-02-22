// ─────────────────────────────────────────────────────────────────────────────
// pump.fun Telegram Scanner Bot — Paper Trading Edition
// Stack:   Node.js · Telegraf · Solana RPC WebSocket · Groq API (free)
// Deploy:  Railway — set env vars, push to GitHub, done.
//
// ENV VARS REQUIRED:
//   TELEGRAM_BOT_TOKEN  — from @BotFather
//   TELEGRAM_CHAT_ID    — from @userinfobot
//   GROQ_API_KEY        — from console.groq.com (free)
//
// OPTIONAL (recommended for reliability):
//   HELIUS_API_KEY      — free at helius.dev — better RPC, won't rate-limit you
//
// HOW IT WORKS:
//   Instead of polling pump.fun's Cloudflare-protected HTTP API, we connect
//   directly to a Solana RPC WebSocket and subscribe to logs from the pump.fun
//   program (6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P). Every time a new
//   token is created on-chain we see it instantly. We then fetch metadata from
//   pump.fun for that specific mint — one targeted request, not bulk polling.
// ─────────────────────────────────────────────────────────────────────────────

import { Telegraf } from "telegraf";
import http         from "http";
import fs           from "fs";
import WebSocket    from "ws";

// ─── VALIDATE ENV ────────────────────────────────────────────────────────────

for (const key of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "GROQ_API_KEY"]) {
  if (!process.env[key]) { console.error(`❌ Missing env var: ${key}`); process.exit(1); }
}

const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID     = process.env.TELEGRAM_CHAT_ID;
const GROQ_KEY    = process.env.GROQ_API_KEY;
const HELIUS_KEY  = process.env.HELIUS_API_KEY || null;
const STATE_FILE  = "./state.json";

// ─── SOLANA CONFIG ───────────────────────────────────────────────────────────

const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

// Use Helius if key provided (more reliable), else public RPC
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

// Call Solana JSON-RPC over HTTP
async function rpcCall(method, params = []) {
  const res = await fetch(RPC_HTTP, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
    signal:  AbortSignal.timeout(10_000),
  });
  const data = await res.json();
  if (data.error) throw new Error(`RPC error: ${data.error.message}`);
  return data.result;
}

// Given a transaction signature, extract the mint address of the new token.
// For pump.fun "create" transactions the mint is the first account key.
async function getMintFromSignature(signature) {
  try {
    const tx = await rpcCall("getTransaction", [
      signature,
      { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    ]);
    if (!tx) return null;

    const keys = tx.transaction?.message?.accountKeys
               ?? tx.transaction?.message?.staticAccountKeys;
    if (!keys || !keys.length) return null;

    // pump.fun create: account[0] = mint, account[1] = mint authority/fee payer
    // We return the first account that looks like a mint (not a system account)
    const SYSTEM_ACCOUNTS = new Set([
      "11111111111111111111111111111111",        // System program
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // Token program
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bv",  // ATA program
      "SysvarRent111111111111111111111111111111111",
      "SysvarC1ock11111111111111111111111111111111",
      PUMP_PROGRAM_ID,
    ]);

    for (const key of keys) {
      const k = typeof key === "string" ? key : key.pubkey || key.toString();
      if (!SYSTEM_ACCOUNTS.has(k) && k.length >= 32) return k;
    }
    return null;
  } catch (e) {
    console.error("[rpc] getTransaction failed:", e.message);
    return null;
  }
}

// ─── PUMP.FUN METADATA ───────────────────────────────────────────────────────
// Single targeted fetch for one mint — much less likely to be blocked than bulk.

async function fetchTokenMeta(mint) {
  try {
    const res = await fetch(`https://frontend-api.pump.fun/coins/${mint}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept":     "application/json",
        "Referer":    "https://pump.fun/",
        "Origin":     "https://pump.fun",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

// ─── SCORING ─────────────────────────────────────────────────────────────────

function scoreToken(coin) {
  const solInCurve   = (coin.virtual_sol_reserves  || 0) / 1e9;
  const bondingPct   = parseFloat(Math.min(99, (solInCurve / GRADUATION_SOL) * 100).toFixed(1));
  const mcapUSD      = coin.usd_market_cap || 0;
  const ageSeconds   = Math.floor((Date.now() - (coin.created_timestamp || Date.now())) / 1000);
  const replyCount   = coin.reply_count   || 0;
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

  return {
    mint:         coin.mint || coin,
    symbol:       (coin.symbol      || "???").toUpperCase(),
    name:         coin.name         || "Unknown",
    description:  coin.description  || "",
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
  };
}

// ─── GROQ ANALYSIS ───────────────────────────────────────────────────────────

async function analyzeToken(token) {
  const socials = [
    token.hasTwitter  && "Twitter",
    token.hasTelegram && "Telegram",
    token.hasWebsite  && "Website",
  ].filter(Boolean).join(", ") || "none";

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${GROQ_KEY}`,
    },
    body: JSON.stringify({
      model:       "llama-3.3-70b-versatile",
      max_tokens:  350,
      temperature: 0.7,
      messages: [{
        role: "user",
        content: `You are a pump.fun trading expert. Tokens graduate at ~$34K mcap / ~42 SOL bonding curve.

Token: $${token.symbol} | "${token.name}"
${token.description ? `Desc: "${token.description.slice(0, 150)}"` : ""}
Age: ${fmtAge(token.ageSeconds)} | Score: ${token.score}/100
SOL in curve: ${token.solInCurve} / 42 (${token.bondingPct}%)
MCap: ~$${Math.round(token.mcapUSD).toLocaleString()}
Velocity: ${token.velocitySOL} SOL/min
Replies: ${token.replyCount} | Socials: ${socials}
King of the Hill: ${token.isKingOfHill ? "YES" : "no"}

Write 3 short paragraphs for Telegram (plain text only, under 180 words total):
1. Start with BUY / WATCH / SKIP in caps then one sentence why
2. 2-3 bullet points (• character) on key signals
3. One sentence on the main risk or what would make you exit`,
      }],
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) throw new Error(`Groq ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || "Analysis unavailable.";
}

// ─── PAPER TRADING ───────────────────────────────────────────────────────────

function openTrade(token) {
  if (Object.keys(state.openTrades).length >= MAX_OPEN_TRADES) return null;
  if (state.openTrades[token.mint]) return null;
  const trade = {
    mint:          token.mint,
    symbol:        token.symbol,
    name:          token.name,
    entryMcap:     token.mcapUSD,
    entryBonding:  token.bondingPct,
    currentMcap:   token.mcapUSD,
    peakMcap:      token.mcapUSD,
    solAmount:     state.config.tradeAmount,
    entryTime:     Date.now(),
    score:         token.score,
    lastAlertStep: 0,
    migrated:      false,
  };
  state.openTrades[token.mint] = trade;
  state.stats.totalTrades++;
  saveState();
  return trade;
}

function closeTrade(mint, exitMcap, reason = "manual") {
  const trade = state.openTrades[mint];
  if (!trade) return null;
  const { pnlSOL, pnlUSD, pnlPct } = calcPnL(trade, exitMcap);
  const closed = {
    ...trade, exitMcap,
    exitTime:   Date.now(),
    durationMs: Date.now() - trade.entryTime,
    pnlSOL, pnlUSD, pnlPct, reason,
  };
  state.closedTrades.unshift(closed);
  delete state.openTrades[mint];
  saveState();
  return closed;
}

function calcPnL(trade, currentMcap) {
  const mult   = currentMcap / trade.entryMcap;
  const pnlSOL = parseFloat(((mult - 1) * trade.solAmount).toFixed(4));
  const pnlUSD = parseFloat((pnlSOL * SOL_PRICE_USD).toFixed(2));
  const pnlPct = parseFloat(((mult - 1) * 100).toFixed(1));
  return { pnlSOL, pnlUSD, pnlPct, mult };
}

function portfolioSummary() {
  const open       = Object.values(state.openTrades);
  const realized   = state.closedTrades.reduce((s, t) => s + (t.pnlSOL || 0), 0);
  const unrealized = open.reduce((s, t) => s + calcPnL(t, t.currentMcap).pnlSOL, 0);
  const wins       = state.closedTrades.filter(t => t.pnlPct > 0).length;
  const winRate    = state.closedTrades.length
    ? Math.round((wins / state.closedTrades.length) * 100) : 0;
  return {
    realized:    parseFloat(realized.toFixed(4)),
    unrealized:  parseFloat(unrealized.toFixed(4)),
    total:       parseFloat((realized + unrealized).toFixed(4)),
    openCount:   open.length,
    closedCount: state.closedTrades.length,
    winRate,
  };
}

// ─── FORMATTERS ──────────────────────────────────────────────────────────────

function fmtUSD(n) {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}
function fmtAge(s) {
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
function bondingBar(pct) {
  const f = Math.min(20, Math.round(pct / 5));
  return `[${"█".repeat(f)}${"░".repeat(20 - f)}] ${pct}%`;
}
function pnlEmoji(pct) {
  if (pct >= 200) return "🚀🚀";
  if (pct >= 100) return "🚀";
  if (pct >= 50)  return "🟢";
  if (pct >= 10)  return "📈";
  if (pct >= 0)   return "➡️";
  if (pct >= -25) return "📉";
  return "🔴";
}

// ─── TELEGRAM MESSAGES ───────────────────────────────────────────────────────

async function sendTokenAlert(token, analysis) {
  const emoji   = { BUY: "🟢", WATCH: "🟡", SKIP: "🔴" }[token.verdict] || "⚪";
  const socials = [
    token.hasTwitter  && "🐦 TW",
    token.hasTelegram && "💬 TG",
    token.hasWebsite  && "🌐 Web",
  ].filter(Boolean).join("  ") || "no socials";
  const trade     = state.openTrades[token.mint];
  const paperLine = trade ? `📝 Paper bought ${trade.solAmount} SOL @ ${fmtUSD(token.mcapUSD)}` : null;

  const lines = [
    `${emoji} *${token.verdict}* — Score: ${token.score}/100`,
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
    ``,
    `[View on pump.fun](https://pump.fun/${token.mint})`,
    `\`${token.mint}\``,
  ].filter(l => l !== null);

  await bot.telegram.sendMessage(CHAT_ID, lines.join("\n"), {
    parse_mode: "Markdown", disable_web_page_preview: true,
  });
  state.stats.alertsSent++;
}

async function sendPnLAlert(trade, pnlPct, pnlSOL, currentMcap, isMigration = false) {
  const sign   = pnlPct >= 0 ? "+" : "";
  const usdAbs = Math.abs(pnlSOL * SOL_PRICE_USD).toFixed(2);
  const header = isMigration
    ? `🎓 *GRADUATED* — $${trade.symbol} hit Raydium!`
    : `${pnlEmoji(pnlPct)} *P&L UPDATE* — $${trade.symbol}`;
  await bot.telegram.sendMessage(CHAT_ID, [
    header, `━━━━━━━━━━━━━━━━━━━━`,
    `${sign}${pnlPct}%  |  ${sign}${pnlSOL.toFixed(4)} SOL  |  ${pnlPct >= 0 ? "+" : "-"}$${usdAbs}`,
    `Entry: ${fmtUSD(trade.entryMcap)}  →  Now: ${fmtUSD(currentMcap)}`,
    `Peak: ${fmtUSD(trade.peakMcap)}  |  Held: ${fmtDuration(Date.now() - trade.entryTime)}`,
    `\`${trade.mint}\``,
  ].join("\n"), { parse_mode: "Markdown" });
}

async function sendCloseAlert(trade) {
  const sign = trade.pnlPct >= 0 ? "+" : "";
  await bot.telegram.sendMessage(CHAT_ID, [
    `${pnlEmoji(trade.pnlPct)} *CLOSED* — $${trade.symbol}`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `${sign}${trade.pnlPct}%  |  ${sign}${trade.pnlSOL.toFixed(4)} SOL  |  ${sign}$${Math.abs(trade.pnlUSD).toFixed(2)}`,
    `Entry: ${fmtUSD(trade.entryMcap)}  |  Exit: ${fmtUSD(trade.exitMcap)}`,
    `Duration: ${fmtDuration(trade.durationMs)}  |  Reason: ${trade.reason}`,
  ].join("\n"), { parse_mode: "Markdown" });
}

// ─── TOKEN HANDLER ────────────────────────────────────────────────────────────

async function handleMint(mint) {
  if (!mint)                                 return;
  if (state.seenMints.includes(mint))        return;

  state.seenMints.push(mint);
  state.stats.tokensReceived++;
  state.stats.lastEventAt = Date.now();

  if (state.config.paused) return;

  // Fetch full metadata from pump.fun (single targeted request)
  const coin = await fetchTokenMeta(mint);

  // Build token object — fall back to mint-only if fetch failed
  const tokenData = coin || { mint, symbol: "???", name: "Unknown" };
  if (coin?.complete) return; // already graduated

  const token = scoreToken(tokenData);

  const shouldAlert =
    (token.verdict === "BUY"   && token.score >= state.config.minScore) ||
    (token.verdict === "WATCH" && state.config.alertWatch);

  if (!shouldAlert) {
    console.log(`[chain] SKIP $${token.symbol} score=${token.score}`);
    saveState();
    return;
  }

  console.log(`[chain] ${token.verdict} $${token.symbol} score=${token.score}`);

  if (state.config.paperTrading && token.verdict === "BUY") openTrade(token);

  analyzeToken(token)
    .then(analysis => sendTokenAlert(token, analysis))
    .catch(e => console.error("[alert]", e.message));

  saveState();
}

// ─── SOLANA WEBSOCKET ────────────────────────────────────────────────────────
// Subscribe to logs for pump.fun program ID.
// Every time the program is invoked with "Instruction: Create" we have a new token.

let wsReconnectTimer = null;

function connectSolanaWS() {
  console.log(`[ws] Connecting to Solana RPC${HELIUS_KEY ? " (Helius)" : " (public)"}...`);

  const ws = new WebSocket(RPC_WS);

  ws.on("open", () => {
    console.log("[ws] ✅ Connected — subscribing to pump.fun program logs");
    state.stats.wsConnected = true;

    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id:      1,
      method:  "logsSubscribe",
      params: [
        { mentions: [PUMP_PROGRAM_ID] },
        { commitment: "confirmed" },
      ],
    }));

    bot.telegram.sendMessage(CHAT_ID,
      `🟢 *Solana WS connected*\nWatching pump.fun program on-chain — real-time token detection`,
      { parse_mode: "Markdown" }
    ).catch(() => {});
  });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Subscription confirmation
    if (msg.id === 1 && msg.result !== undefined) {
      console.log(`[ws] Subscribed — sub ID ${msg.result}`);
      return;
    }

    const value = msg?.params?.result?.value;
    if (!value) return;

    const logs = value.logs || [];
    const sig  = value.signature;

    // Only care about successful "Create" instructions — new token creation
    if (value.err !== null)                       return;
    if (!logs.some(l => l.includes("Instruction: Create"))) return;
    if (!sig)                                     return;

    console.log(`[ws] New token creation detected — sig ${sig.slice(0, 16)}...`);

    // Get mint from transaction, then handle it
    getMintFromSignature(sig)
      .then(mint => { if (mint) handleMint(mint); })
      .catch(e => console.error("[ws] getMint failed:", e.message));
  });

  ws.on("close", (code, reason) => {
    state.stats.wsConnected = false;
    console.warn(`[ws] Disconnected — code ${code}. Reconnecting in ${RECONNECT_DELAY / 1000}s...`);
    bot.telegram.sendMessage(CHAT_ID,
      `🟡 *Solana WS disconnected* — reconnecting in ${RECONNECT_DELAY / 1000}s`,
      { parse_mode: "Markdown" }
    ).catch(() => {});
    wsReconnectTimer = setTimeout(connectSolanaWS, RECONNECT_DELAY);
  });

  ws.on("error", (err) => {
    console.error("[ws] Error:", err.message);
    state.stats.wsConnected = false;
    // close handler will trigger reconnect
  });

  // Keep-alive ping every 20s so the connection doesn't time out
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 999, method: "getHealth" }));
    } else {
      clearInterval(pingInterval);
    }
  }, 20_000);

  return ws;
}

// ─── PRICE UPDATE LOOP ───────────────────────────────────────────────────────

async function updatePrices() {
  const mints = Object.keys(state.openTrades);
  if (!mints.length) return;

  for (const mint of mints) {
    const trade = state.openTrades[mint];
    if (!trade) continue;

    const data = await fetchTokenMeta(mint);
    if (!data) continue;

    const currentMcap = data.usd_market_cap || trade.currentMcap;
    const isMigrated  = !!data.complete;

    trade.currentMcap = currentMcap;
    if (currentMcap > trade.peakMcap) trade.peakMcap = currentMcap;

    const { pnlPct, pnlSOL } = calcPnL(trade, currentMcap);
    const step = Math.floor(Math.abs(pnlPct) / PNL_ALERT_STEP) * Math.sign(pnlPct);

    if (step !== 0 && step !== trade.lastAlertStep) {
      trade.lastAlertStep = step;
      await sendPnLAlert(trade, pnlPct, pnlSOL, currentMcap).catch(() => {});
    }

    if (isMigrated && !trade.migrated) {
      trade.migrated = true;
      await sendPnLAlert(trade, pnlPct, pnlSOL, currentMcap, true).catch(() => {});
      const closed = closeTrade(mint, currentMcap, "graduated");
      if (closed) await sendCloseAlert(closed).catch(() => {});
    }
  }
  saveState();
}

// ─── TELEGRAM COMMANDS ───────────────────────────────────────────────────────

bot.command("start", ctx => ctx.reply([
  "🟠 *pump.fun Scanner Bot*",
  "━━━━━━━━━━━━━━━━━━━━",
  "Watching the Solana blockchain directly for new tokens.",
  "",
  "*Commands:*",
  "/status        — health, stats & portfolio summary",
  "/portfolio     — open paper trades with live P&L",
  "/trades        — last 10 closed trades",
  "/close <CA>    — manually close a paper trade",
  "/setscore <n>  — min score to alert (default: 65)",
  "/setamount <n> — SOL per paper trade (default: 0.1)",
  "/watchalerts on|off — alert on WATCH tokens too",
  "/pause / /resume",
  "/reset         — clear all trades & stats",
].join("\n"), { parse_mode: "Markdown" }));

bot.command("status", async ctx => {
  const pf      = portfolioSummary();
  const uptime  = fmtDuration(Date.now() - state.stats.startedAt);
  const lastEvt = state.stats.lastEventAt
    ? `${Math.round((Date.now() - state.stats.lastEventAt) / 1000)}s ago` : "none yet";
  await ctx.reply([
    `${state.config.paused ? "⏸ Paused" : "🟢 Running"} — pump.fun Scanner`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `🔌 Solana WS: ${state.stats.wsConnected ? "✅ Connected" : "🔴 Disconnected"}`,
    `📡 RPC: ${HELIUS_KEY ? "Helius (enhanced)" : "Public mainnet"}`,
    `⏱ Uptime: ${uptime}  |  Last token: ${lastEvt}`,
    `🔍 Tokens detected: ${state.stats.tokensReceived}`,
    `📣 Alerts sent: ${state.stats.alertsSent}`,
    `📊 Min score: ${state.config.minScore}  |  Trade: ${state.config.tradeAmount} SOL`,
    ``,
    `💼 *Portfolio:*`,
    `  Open: ${pf.openCount}  |  Closed: ${pf.closedCount}`,
    `  Unrealized: ${pf.unrealized >= 0 ? "+" : ""}${pf.unrealized} SOL`,
    `  Realized:   ${pf.realized  >= 0 ? "+" : ""}${pf.realized} SOL`,
    `  *Total P&L: ${pf.total >= 0 ? "+" : ""}${pf.total} SOL*`,
    `  Win rate: ${pf.winRate}%`,
  ].join("\n"), { parse_mode: "Markdown" });
});

bot.command("portfolio", async ctx => {
  const open = Object.values(state.openTrades);
  if (!open.length) { await ctx.reply("No open paper trades."); return; }
  const lines = ["📂 *Open Trades*", "━━━━━━━━━━━━━━━━━━━━"];
  for (const trade of open) {
    const { pnlPct, pnlSOL } = calcPnL(trade, trade.currentMcap);
    const sign = pnlPct >= 0 ? "+" : "";
    lines.push(
      `${pnlEmoji(pnlPct)} *$${trade.symbol}*  ${sign}${pnlPct}%  (${sign}${pnlSOL.toFixed(4)} SOL)`,
      `   ${fmtUSD(trade.entryMcap)} → ${fmtUSD(trade.currentMcap)}  |  Peak: ${fmtUSD(trade.peakMcap)}`,
      `   Held: ${fmtDuration(Date.now() - trade.entryTime)}  |  \`${trade.mint.slice(0, 12)}...\``,
    );
  }
  const pf = portfolioSummary();
  lines.push("━━━━━━━━━━━━━━━━━━━━",
    `Unrealized: ${pf.unrealized >= 0 ? "+" : ""}${pf.unrealized} SOL`,
    `*Total P&L: ${pf.total >= 0 ? "+" : ""}${pf.total} SOL*`);
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
});

bot.command("trades", async ctx => {
  const recent = state.closedTrades.slice(0, 10);
  if (!recent.length) { await ctx.reply("No closed trades yet."); return; }
  const lines = ["📋 *Last 10 Closed Trades*", "━━━━━━━━━━━━━━━━━━━━"];
  for (const t of recent) {
    const sign = t.pnlPct >= 0 ? "+" : "";
    lines.push(`${pnlEmoji(t.pnlPct)} *$${t.symbol}*  ${sign}${t.pnlPct}% (${sign}${t.pnlSOL.toFixed(4)} SOL) — ${t.reason}`);
  }
  const pf = portfolioSummary();
  lines.push("━━━━━━━━━━━━━━━━━━━━", `Win rate: ${pf.winRate}% over ${pf.closedCount} trades`);
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
});

bot.command("close", async ctx => {
  const mint = ctx.message.text.split(" ")[1]?.trim();
  if (!mint) { await ctx.reply("Usage: /close <contract_address>"); return; }
  if (!state.openTrades[mint]) { await ctx.reply("Trade not found."); return; }
  const data     = await fetchTokenMeta(mint);
  const exitMcap = data?.usd_market_cap || state.openTrades[mint].currentMcap;
  const closed   = closeTrade(mint, exitMcap, "manual");
  await sendCloseAlert(closed);
});

bot.command("setscore", async ctx => {
  const val = parseInt(ctx.message.text.split(" ")[1]);
  if (isNaN(val) || val < 0 || val > 100) { await ctx.reply("Usage: /setscore <0-100>"); return; }
  state.config.minScore = val;
  saveState();
  await ctx.reply(`✅ Min score set to ${val}`);
});

bot.command("setamount", async ctx => {
  const val = parseFloat(ctx.message.text.split(" ")[1]);
  if (isNaN(val) || val <= 0) { await ctx.reply("Usage: /setamount <SOL e.g. 0.5>"); return; }
  state.config.tradeAmount = val;
  saveState();
  await ctx.reply(`✅ Paper trade size set to ${val} SOL`);
});

bot.command("watchalerts", async ctx => {
  const val = ctx.message.text.split(" ")[1]?.toLowerCase();
  if (val !== "on" && val !== "off") { await ctx.reply("Usage: /watchalerts on|off"); return; }
  state.config.alertWatch = val === "on";
  saveState();
  await ctx.reply(`✅ WATCH alerts ${state.config.alertWatch ? "enabled" : "disabled"}`);
});

bot.command("pause",  async ctx => { state.config.paused = true;  saveState(); await ctx.reply("⏸ Paused."); });
bot.command("resume", async ctx => { state.config.paused = false; saveState(); await ctx.reply("▶️ Resumed."); });

bot.command("reset", async ctx => {
  state.openTrades = {};
  state.closedTrades = [];
  state.stats = { tokensReceived: 0, alertsSent: 0, totalTrades: 0, startedAt: Date.now(), wsConnected: false, lastEventAt: null };
  saveState();
  await ctx.reply("🔄 Cleared.");
});

// ─── BOOT ─────────────────────────────────────────────────────────────────────

loadState();

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  const pf = portfolioSummary();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status:      "running",
    wsConnected: state.stats.wsConnected,
    received:    state.stats.tokensReceived,
    alerts:      state.stats.alertsSent,
    openTrades:  pf.openCount,
    totalPnlSOL: pf.total,
    uptime:      Math.floor((Date.now() - state.stats.startedAt) / 1000) + "s",
  }));
}).listen(PORT, () => console.log(`✅ Health check on port ${PORT}`));

bot.launch();
console.log("✅ Telegram bot online");

bot.telegram.sendMessage(CHAT_ID,
  `🟠 *pump.fun Scanner starting...*\nConnecting to Solana blockchain · Min score: ${state.config.minScore}`,
  { parse_mode: "Markdown" }
).catch(() => {});

connectSolanaWS();
setInterval(updatePrices, PRICE_INTERVAL_MS);

process.once("SIGINT",  () => { saveState(); bot.stop("SIGINT");  });
process.once("SIGTERM", () => { saveState(); bot.stop("SIGTERM"); });
