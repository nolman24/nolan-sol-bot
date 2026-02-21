// ─────────────────────────────────────────────────────────────────────────────
// pump.fun Telegram Scanner Bot — Paper Trading Edition
// Stack:   Node.js · Telegraf · socket.io-client · Groq API (free)
// Deploy:  Railway — set env vars, push to GitHub, done.
//
// ENV VARS REQUIRED:
//   TELEGRAM_BOT_TOKEN  — from @BotFather
//   TELEGRAM_CHAT_ID    — from @userinfobot
//   GROQ_API_KEY        — from console.groq.com (free)
//
// WHY WEBSOCKET INSTEAD OF REST:
//   pump.fun's REST API is behind Cloudflare which blocks datacenter IPs.
//   Their WebSocket feed (used by the pump.fun website itself) is not blocked
//   and delivers new token events in real time — no polling needed at all.
// ─────────────────────────────────────────────────────────────────────────────

import { Telegraf }  from "telegraf";
import { io }        from "socket.io-client";
import http          from "http";
import fs            from "fs";

// ─── VALIDATE ENV ────────────────────────────────────────────────────────────

for (const key of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "GROQ_API_KEY"]) {
  if (!process.env[key]) { console.error(`❌ Missing env var: ${key}`); process.exit(1); }
}

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID    = process.env.TELEGRAM_CHAT_ID;
const GROQ_KEY   = process.env.GROQ_API_KEY;
const STATE_FILE = "./state.json";

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const GRADUATION_SOL    = 42;        // SOL to fill bonding curve → ~$34K mcap
const SOL_PRICE_USD     = 175;       // Rough SOL/USD
const PRICE_INTERVAL_MS = 30_000;    // Refresh open trade prices every 30s
const MAX_OPEN_TRADES   = 20;        // Cap on simultaneous paper positions
const PNL_ALERT_STEP    = 25;        // Alert every ±25% move on open trades
const WS_RECONNECT_MS   = 5_000;     // Reconnect delay if WebSocket drops

// ─── STATE ───────────────────────────────────────────────────────────────────

let state = {
  config: {
    minScore:     65,
    tradeAmount:  0.1,
    paused:       false,
    paperTrading: true,
    alertWatch:   false,
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

// ─── TELEGRAM CLIENT ─────────────────────────────────────────────────────────

const bot = new Telegraf(BOT_TOKEN);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── PRICE FETCH (for open trade updates only) ────────────────────────────────
// We only use HTTP for refreshing prices on open trades — much lower request
// volume than scanning, so Cloudflare rarely triggers on these.

async function fetchTokenPrice(mint) {
  try {
    const res = await fetch(`https://frontend-api.pump.fun/coins/${mint}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept":     "application/json",
        "Referer":    "https://pump.fun/",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

// ─── SCORING ENGINE ──────────────────────────────────────────────────────────
// The WebSocket `newCoinCreated` event sends the full coin object —
// same fields as the REST API.

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
    mint:         coin.mint,
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
    verdict:      score >= 68 ? "BUY" : score >= 45 ? "WATCH" : "SKIP",
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

  if (!res.ok) throw new Error(`Groq API ${res.status}`);
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
  const filled = Math.min(20, Math.round(pct / 5));
  return `[${"█".repeat(filled)}${"░".repeat(20 - filled)}] ${pct}%`;
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

  const trade    = state.openTrades[token.mint];
  const paperLine = trade
    ? `📝 Paper bought ${trade.solAmount} SOL @ ${fmtUSD(token.mcapUSD)}` : null;

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
    header,
    `━━━━━━━━━━━━━━━━━━━━`,
    `${sign}${pnlPct}%  |  ${sign}${pnlSOL.toFixed(4)} SOL  |  ${pnlPct >= 0 ? "+" : "-"}$${usdAbs}`,
    ``,
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
// Called by the WebSocket listener each time a new coin event arrives.

async function handleNewCoin(coin) {
  if (!coin?.mint)                           return;
  if (coin.complete)                         return; // already migrated
  if (state.seenMints.includes(coin.mint))   return; // duplicate

  state.seenMints.push(coin.mint);
  state.stats.tokensReceived++;
  state.stats.lastEventAt = Date.now();

  if (state.config.paused) return;

  const token = scoreToken(coin);

  const shouldAlert =
    (token.verdict === "BUY"   && token.score >= state.config.minScore) ||
    (token.verdict === "WATCH" && state.config.alertWatch);

  if (!shouldAlert) {
    console.log(`[ws] SKIP $${token.symbol} score=${token.score}`);
    return;
  }

  console.log(`[ws] ${token.verdict} $${token.symbol} score=${token.score} sol=${token.solInCurve}`);

  if (state.config.paperTrading && token.verdict === "BUY") {
    openTrade(token);
  }

  analyzeToken(token)
    .then(analysis => sendTokenAlert(token, analysis))
    .catch(e => console.error("[alert] Failed:", e.message));

  saveState();
}

// ─── WEBSOCKET CONNECTION ─────────────────────────────────────────────────────
// pump.fun uses Socket.IO. The `newCoinCreated` event fires for every new token.
// The connection auto-reconnects if it drops.

function connectWebSocket() {
  console.log("[ws] Connecting to pump.fun WebSocket...");

  const socket = io("https://frontend-api.pump.fun", {
    transports:         ["websocket"],
    reconnection:       true,
    reconnectionDelay:  WS_RECONNECT_MS,
    reconnectionDelayMax: 30_000,
    extraHeaders: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Origin":     "https://pump.fun",
      "Referer":    "https://pump.fun/",
    },
  });

  socket.on("connect", () => {
    console.log("[ws] ✅ Connected to pump.fun");
    state.stats.wsConnected = true;
    bot.telegram.sendMessage(CHAT_ID,
      `🟢 *WebSocket connected* — receiving live token feed`,
      { parse_mode: "Markdown" }
    ).catch(() => {});
  });

  // This is the key event — fires the instant a new token is created
  socket.on("newCoinCreated", (coin) => {
    handleNewCoin(coin).catch(e => console.error("[handler] Error:", e.message));
  });

  socket.on("disconnect", (reason) => {
    console.warn("[ws] Disconnected:", reason);
    state.stats.wsConnected = false;
    bot.telegram.sendMessage(CHAT_ID,
      `🟡 *WebSocket disconnected* (${reason}) — reconnecting...`,
      { parse_mode: "Markdown" }
    ).catch(() => {});
  });

  socket.on("connect_error", (err) => {
    console.error("[ws] Connection error:", err.message);
    state.stats.wsConnected = false;
  });

  return socket;
}

// ─── PRICE UPDATE LOOP ───────────────────────────────────────────────────────

async function updatePrices() {
  const mints = Object.keys(state.openTrades);
  if (!mints.length) return;

  for (const mint of mints) {
    const trade = state.openTrades[mint];
    if (!trade) continue;

    const data = await fetchTokenPrice(mint);
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
  "Listening for new tokens via WebSocket — zero polling, real-time.",
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
  const pf     = portfolioSummary();
  const uptime = fmtDuration(Date.now() - state.stats.startedAt);
  const lastEvt = state.stats.lastEventAt
    ? `${Math.round((Date.now() - state.stats.lastEventAt) / 1000)}s ago`
    : "none yet";

  await ctx.reply([
    `${state.config.paused ? "⏸ Paused" : "🟢 Running"} — pump.fun Scanner`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `🔌 WebSocket: ${state.stats.wsConnected ? "✅ Connected" : "🔴 Disconnected"}`,
    `⏱ Uptime: ${uptime}  |  Last token: ${lastEvt}`,
    `🔍 Tokens received: ${state.stats.tokensReceived}`,
    `📣 Alerts sent: ${state.stats.alertsSent}`,
    `📊 Min score: ${state.config.minScore}  |  Trade size: ${state.config.tradeAmount} SOL`,
    `👀 Watch alerts: ${state.config.alertWatch ? "ON" : "OFF"}`,
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
  lines.push(
    "━━━━━━━━━━━━━━━━━━━━",
    `Unrealized: ${pf.unrealized >= 0 ? "+" : ""}${pf.unrealized} SOL`,
    `Realized:   ${pf.realized  >= 0 ? "+" : ""}${pf.realized} SOL`,
    `*Total P&L: ${pf.total >= 0 ? "+" : ""}${pf.total} SOL*`,
  );
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
  const data     = await fetchTokenPrice(mint);
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

bot.command("pause",  async ctx => { state.config.paused = true;  saveState(); await ctx.reply("⏸ Scanner paused."); });
bot.command("resume", async ctx => { state.config.paused = false; saveState(); await ctx.reply("▶️ Scanner resumed."); });

bot.command("reset", async ctx => {
  state.openTrades = {};
  state.closedTrades = [];
  state.stats = { tokensReceived: 0, alertsSent: 0, totalTrades: 0, startedAt: Date.now(), wsConnected: false, lastEventAt: null };
  saveState();
  await ctx.reply("🔄 All trades and stats cleared.");
});

// ─── BOOT ─────────────────────────────────────────────────────────────────────

loadState();

// Health check server — required by Railway to keep the process alive
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  const pf = portfolioSummary();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status:      "running",
    wsConnected: state.stats.wsConnected,
    paused:      state.config.paused,
    received:    state.stats.tokensReceived,
    alerts:      state.stats.alertsSent,
    openTrades:  pf.openCount,
    totalPnlSOL: pf.total,
    uptime:      Math.floor((Date.now() - state.stats.startedAt) / 1000) + "s",
  }));
}).listen(PORT, () => console.log(`✅ Health check server on port ${PORT}`));

bot.launch();
console.log("✅ Telegram bot online");

bot.telegram.sendMessage(CHAT_ID,
  `🟠 *pump.fun Scanner starting...*\nConnecting via WebSocket · Min score: ${state.config.minScore} · Paper trading: ON`,
  { parse_mode: "Markdown" }
).catch(() => {});

// Connect WebSocket — this replaces the polling loop entirely
connectWebSocket();

// Price refresh for open trades only
setInterval(updatePrices, PRICE_INTERVAL_MS);

process.once("SIGINT",  () => { saveState(); bot.stop("SIGINT");  });
process.once("SIGTERM", () => { saveState(); bot.stop("SIGTERM"); });
