// ─────────────────────────────────────────────────────────────────────────────
// pump.fun Telegram Scanner Bot — Paper Trading Edition
// Stack:   Node.js · Telegraf · Groq API (free)
// Deploy:  Railway — set env vars below, push to GitHub, done.
//
// ENV VARS REQUIRED:
//   TELEGRAM_BOT_TOKEN  — from @BotFather
//   TELEGRAM_CHAT_ID    — from @userinfobot
//   GROQ_API_KEY        — from console.groq.com (free)
// ─────────────────────────────────────────────────────────────────────────────

import { Telegraf } from "telegraf";
import fs           from "fs";

// ─── VALIDATE ENV ────────────────────────────────────────────────────────────

for (const key of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "GROQ_API_KEY"]) {
  if (!process.env[key]) { console.error(`❌ Missing env var: ${key}`); process.exit(1); }
}

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID    = process.env.TELEGRAM_CHAT_ID;
const GROQ_KEY   = process.env.GROQ_API_KEY;
const STATE_FILE = "./state.json";

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const GRADUATION_SOL    = 42;       // SOL to fill bonding curve → ~$34K mcap
const SOL_PRICE_USD     = 175;      // Rough SOL/USD — swap for live feed if desired
const SCAN_INTERVAL_MS  = 5_000;    // Poll pump.fun every 5 seconds
const PRICE_INTERVAL_MS = 15_000;   // Refresh open trade prices every 15s
const TOKEN_MAX_AGE_S   = 5 * 60;   // Ignore tokens older than 5 min at discovery
const MAX_OPEN_TRADES   = 20;       // Cap on simultaneous paper positions
const PNL_ALERT_STEP    = 25;       // Alert every ±25% move on open trades

// Rate-limit backoff settings
const BACKOFF_BASE_MS   = 10_000;   // Start at 10s after first 429
const BACKOFF_MAX_MS    = 5 * 60_000; // Cap backoff at 5 minutes

// ─── STATE ───────────────────────────────────────────────────────────────────

let state = {
  config: {
    minScore:     65,    // Min score to trigger BUY alert + paper trade
    tradeAmount:  0.1,   // SOL per paper trade
    paused:       false,
    paperTrading: true,
    alertWatch:   false, // Also alert on WATCH-scored tokens (no paper buy)
  },
  seenMints:    [],      // Ring buffer of processed mints (dedup)
  openTrades:   {},      // mint → trade object
  closedTrades: [],      // Completed trades, newest first
  stats: {
    tokensScanned: 0,
    alertsSent:    0,
    totalTrades:   0,
    startedAt:     Date.now(),
  },
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      state = {
        ...state,
        ...saved,
        config: { ...state.config, ...(saved.config || {}) },
        stats:  { ...state.stats,  ...(saved.stats  || {}) },
      };
      console.log(`[state] Loaded — open: ${Object.keys(state.openTrades).length}, closed: ${state.closedTrades.length}`);
    }
  } catch (e) { console.error("[state] Load failed:", e.message); }
}

function saveState() {
  // Trim ring buffer so it doesn't grow unboundedly
  if (state.seenMints.length > 2000) state.seenMints = state.seenMints.slice(-1000);
  if (state.closedTrades.length > 500) state.closedTrades.length = 500;
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { console.error("[state] Save failed:", e.message); }
}

// ─── CLIENTS ─────────────────────────────────────────────────────────────────

const bot = new Telegraf(BOT_TOKEN);

// ─── RATE-LIMITED FETCH ──────────────────────────────────────────────────────
// Automatic exponential backoff on 429 or network errors.

let backoffUntil = 0;
let backoffDelay = BACKOFF_BASE_MS;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function safeFetch(url, opts = {}) {
  const now = Date.now();
  if (now < backoffUntil) {
    const wait = backoffUntil - now;
    console.log(`[fetch] Backoff active — waiting ${Math.round(wait / 1000)}s`);
    await sleep(wait);
  }

  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(10_000) });

  if (res.status === 429) {
    backoffDelay  = Math.min(backoffDelay * 2, BACKOFF_MAX_MS);
    backoffUntil  = Date.now() + backoffDelay;
    console.warn(`[fetch] 429 — backing off ${Math.round(backoffDelay / 1000)}s`);
    throw new Error("rate_limited");
  }

  // Successful — slowly recover backoff window
  if (backoffDelay > BACKOFF_BASE_MS) backoffDelay = Math.max(BACKOFF_BASE_MS, backoffDelay / 2);

  return res;
}

// ─── PUMP.FUN API ─────────────────────────────────────────────────────────────
// Cloudflare blocks plain server requests — these headers make us look like
// a real Chrome browser visiting pump.fun, which passes the CF check.

const BROWSER_HEADERS = {
  "Accept":                    "application/json, text/plain, */*",
  "Accept-Language":           "en-US,en;q=0.9",
  "Accept-Encoding":           "gzip, deflate, br",
  "User-Agent":                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Referer":                   "https://pump.fun/",
  "Origin":                    "https://pump.fun",
  "sec-ch-ua":                 '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  "sec-ch-ua-mobile":          "?0",
  "sec-ch-ua-platform":        '"Windows"',
  "sec-fetch-dest":            "empty",
  "sec-fetch-mode":            "cors",
  "sec-fetch-site":            "same-site",
  "Connection":                "keep-alive",
};

async function fetchNewTokens() {
  const res = await safeFetch(
    "https://frontend-api.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false",
    { headers: BROWSER_HEADERS }
  );
  if (!res.ok) throw new Error(`pump.fun API ${res.status}`);
  return res.json();
}

async function fetchTokenData(mint) {
  try {
    const res = await safeFetch(
      `https://frontend-api.pump.fun/coins/${mint}`,
      { headers: BROWSER_HEADERS }
    );
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

// ─── SCORING ENGINE ──────────────────────────────────────────────────────────

function scoreToken(coin) {
  const solInCurve   = (coin.virtual_sol_reserves  || 0) / 1e9;
  const bondingPct   = parseFloat(Math.min(99, (solInCurve / GRADUATION_SOL) * 100).toFixed(1));
  const mcapUSD      = coin.usd_market_cap || 0;
  const ageSeconds   = Math.floor((Date.now() - coin.created_timestamp) / 1000);
  const replyCount   = coin.reply_count || 0;
  const hasTwitter   = !!coin.twitter;
  const hasTelegram  = !!coin.telegram;
  const hasWebsite   = !!coin.website;
  const isKingOfHill = !!coin.is_currently_king_of_the_hill;
  const ageMinutes   = Math.max(0.1, ageSeconds / 60);
  const velocitySOL  = parseFloat((solInCurve / ageMinutes).toFixed(3));

  let score = 0;

  // Velocity: the #1 signal of organic interest on pump.fun
  score += Math.min(28, velocitySOL * 6);

  // Socials — team put real effort in
  if (hasTwitter)   score += 8;
  if (hasTelegram)  score += 6;
  if (hasWebsite)   score += 4;

  // Community engagement on pump.fun
  score += Math.min(12, (replyCount / 25) * 12);

  // King of the Hill = currently most active token
  if (isKingOfHill) score += 8;

  // Ultra-early entry bonus
  if      (ageSeconds < 60)  score += 14;
  else if (ageSeconds < 120) score += 10;
  else if (ageSeconds < 300) score += 5;

  // SOL raised — real money = real confidence
  if (solInCurve > 5)  score += 5;
  if (solInCurve > 15) score += 5;
  if (solInCurve > 28) score += 4;

  score = Math.max(0, Math.min(100, Math.round(score)));
  const verdict = score >= 68 ? "BUY" : score >= 45 ? "WATCH" : "SKIP";

  return {
    mint:          coin.mint,
    symbol:        (coin.symbol      || "???").toUpperCase(),
    name:          coin.name         || "Unknown",
    description:   coin.description  || "",
    imageUri:      coin.image_uri    || null,
    solInCurve:    parseFloat(solInCurve.toFixed(3)),
    bondingPct,
    mcapUSD,
    velocitySOL,
    ageSeconds,
    replyCount,
    hasTwitter, hasTelegram, hasWebsite,
    isKingOfHill,
    complete:      !!coin.complete,
    twitter:       coin.twitter  || null,
    telegram:      coin.telegram || null,
    website:       coin.website  || null,
    score,
    verdict,
  };
}

// ─── GROQ ANALYSIS ───────────────────────────────────────────────────────────

async function analyzeToken(token) {
  const socials = [
    token.hasTwitter  && "Twitter",
    token.hasTelegram && "Telegram",
    token.hasWebsite  && "Website",
  ].filter(Boolean).join(", ") || "none";

  const prompt = `You are a pump.fun trading expert. Tokens graduate at ~$34K mcap / ~42 SOL bonding curve.

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
3. One sentence on the main risk or what would make you exit`;

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${GROQ_KEY}`,
    },
    body: JSON.stringify({
      model:      "llama-3.3-70b-versatile",
      max_tokens: 350,
      temperature: 0.7,
      messages: [{ role: "user", content: prompt }],
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
    lastAlertStep: 0,   // tracks the last ±25% threshold we sent an alert for
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
    ...trade,
    exitMcap,
    exitTime:   Date.now(),
    durationMs: Date.now() - trade.entryTime,
    pnlSOL, pnlUSD, pnlPct,
    reason,
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
  const verdict  = token.verdict;
  const emoji    = { BUY: "🟢", WATCH: "🟡", SKIP: "🔴" }[verdict] || "⚪";
  const socials  = [
    token.hasTwitter  && "🐦 TW",
    token.hasTelegram && "💬 TG",
    token.hasWebsite  && "🌐 Web",
  ].filter(Boolean).join("  ") || "no socials";

  const trade    = state.openTrades[token.mint];
  const paperLine = trade
    ? `📝 Paper bought ${trade.solAmount} SOL @ ${fmtUSD(token.mcapUSD)}`
    : "";

  const lines = [
    `${emoji} *${verdict}* — Score: ${token.score}/100`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `*$${token.symbol}* — ${token.name}`,
    token.isKingOfHill ? "👑 King of the Hill" : null,
    ``,
    `⏱ Age: ${fmtAge(token.ageSeconds)}`,
    `📊 ${bondingBar(token.bondingPct)}`,
    `◎ ${token.solInCurve} SOL raised  |  MCap: ${fmtUSD(token.mcapUSD)}`,
    `⚡ ${token.velocitySOL} SOL/min  |  💬 ${token.replyCount} replies`,
    `🔗 ${socials}`,
    paperLine || null,
    ``,
    `🤖 *Claude:*`,
    analysis,
    ``,
    `[View on pump.fun](https://pump.fun/${token.mint})`,
    `\`${token.mint}\``,
  ].filter(l => l !== null);

  await bot.telegram.sendMessage(CHAT_ID, lines.join("\n"), {
    parse_mode:               "Markdown",
    disable_web_page_preview: true,
  });

  state.stats.alertsSent++;
}

async function sendPnLAlert(trade, pnlPct, pnlSOL, currentMcap, isMigration = false) {
  const emoji  = pnlEmoji(pnlPct);
  const sign   = pnlPct >= 0 ? "+" : "";
  const header = isMigration
    ? `🎓 *GRADUATED* — $${trade.symbol} hit Raydium!`
    : `${emoji} *P&L UPDATE* — $${trade.symbol}`;
  const usdAbs = Math.abs(pnlSOL * SOL_PRICE_USD).toFixed(2);

  const msg = [
    header,
    `━━━━━━━━━━━━━━━━━━━━`,
    `${sign}${pnlPct}%  |  ${sign}${pnlSOL.toFixed(4)} SOL  |  ${pnlPct >= 0 ? "+" : "-"}$${usdAbs}`,
    ``,
    `Entry: ${fmtUSD(trade.entryMcap)}  →  Now: ${fmtUSD(currentMcap)}`,
    `Peak:  ${fmtUSD(trade.peakMcap)}  |  Held: ${fmtDuration(Date.now() - trade.entryTime)}`,
    `\`${trade.mint}\``,
  ].join("\n");

  await bot.telegram.sendMessage(CHAT_ID, msg, { parse_mode: "Markdown" });
}

async function sendCloseAlert(trade) {
  const emoji = pnlEmoji(trade.pnlPct);
  const sign  = trade.pnlPct >= 0 ? "+" : "";

  const msg = [
    `${emoji} *CLOSED* — $${trade.symbol}`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `${sign}${trade.pnlPct}%  |  ${sign}${trade.pnlSOL.toFixed(4)} SOL  |  ${sign}$${Math.abs(trade.pnlUSD).toFixed(2)}`,
    ``,
    `Entry: ${fmtUSD(trade.entryMcap)}  |  Exit: ${fmtUSD(trade.exitMcap)}`,
    `Duration: ${fmtDuration(trade.durationMs)}  |  Reason: ${trade.reason}`,
  ].join("\n");

  await bot.telegram.sendMessage(CHAT_ID, msg, { parse_mode: "Markdown" });
}

// ─── MAIN SCAN LOOP ───────────────────────────────────────────────────────────

async function scan() {
  if (state.config.paused) return;

  let coins;
  try {
    coins = await fetchNewTokens();
  } catch (e) {
    if (e.message !== "rate_limited") console.error("[scan] Fetch error:", e.message);
    return; // skip tick, try again next interval
  }

  const now = Date.now();

  for (const coin of coins) {
    if (coin.complete)                         continue; // already migrated
    if (state.seenMints.includes(coin.mint))   continue; // already processed

    const ageSeconds = Math.floor((now - coin.created_timestamp) / 1000);
    if (ageSeconds > TOKEN_MAX_AGE_S)          continue; // too old

    state.seenMints.push(coin.mint);
    state.stats.tokensScanned++;

    const token = scoreToken(coin);

    const shouldAlert =
      (token.verdict === "BUY"   && token.score >= state.config.minScore) ||
      (token.verdict === "WATCH" && state.config.alertWatch);

    if (!shouldAlert) continue;

    console.log(`[scan] ${token.verdict} $${token.symbol} score=${token.score} sol=${token.solInCurve}`);

    // Open paper trade first so the alert includes the entry line
    if (state.config.paperTrading && token.verdict === "BUY") {
      openTrade(token);
    }

    // Fire-and-forget: get Claude analysis then send alert
    analyzeToken(token)
      .then(analysis => sendTokenAlert(token, analysis))
      .catch(e => console.error("[alert] Failed:", e.message));
  }

  saveState();
}

// ─── PRICE UPDATE LOOP ───────────────────────────────────────────────────────
// Fetches fresh mcap for every open paper trade and fires P&L alerts on moves.

async function updatePrices() {
  const mints = Object.keys(state.openTrades);
  if (mints.length === 0) return;

  for (const mint of mints) {
    const trade = state.openTrades[mint];
    if (!trade) continue;

    const data = await fetchTokenData(mint);
    if (!data) continue;

    const currentMcap = data.usd_market_cap || trade.currentMcap;
    const isMigrated  = !!data.complete;

    trade.currentMcap = currentMcap;
    if (currentMcap > trade.peakMcap) trade.peakMcap = currentMcap;

    const { pnlPct, pnlSOL } = calcPnL(trade, currentMcap);

    // Alert on each new ±25% threshold crossed (e.g. +25, +50, -25…)
    const step = Math.floor(Math.abs(pnlPct) / PNL_ALERT_STEP) * Math.sign(pnlPct);
    if (step !== 0 && step !== trade.lastAlertStep) {
      trade.lastAlertStep = step;
      await sendPnLAlert(trade, pnlPct, pnlSOL, currentMcap).catch(() => {});
    }

    // Auto-close when token graduates to Raydium
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
  "Scanning for brand-new pre-migration tokens every *5 seconds*.",
  "",
  "*Commands:*",
  "/status        — scanner health & live stats",
  "/portfolio     — all open paper trades with live P&L",
  "/trades        — last 10 closed trades",
  "/close <CA>    — manually close a paper trade",
  "/setscore <n>  — min score to alert (default: 65)",
  "/setamount <n> — SOL per paper trade (default: 0.1)",
  "/watchalerts on|off — also alert on WATCH tokens",
  "/pause / /resume",
  "/reset         — clear all trades & stats",
].join("\n"), { parse_mode: "Markdown" }));

bot.command("status", async ctx => {
  const pf     = portfolioSummary();
  const uptime = fmtDuration(Date.now() - state.stats.startedAt);
  const bkMsg  = backoffUntil > Date.now()
    ? `\n⚠️ Rate-limit backoff: ${Math.round((backoffUntil - Date.now()) / 1000)}s left` : "";

  await ctx.reply([
    `${state.config.paused ? "⏸ Paused" : "🟢 Running"} — pump.fun Scanner`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `⏱ Uptime: ${uptime}`,
    `🔍 Tokens scanned: ${state.stats.tokensScanned}`,
    `📣 Alerts sent: ${state.stats.alertsSent}`,
    `📊 Min score: ${state.config.minScore}  |  Trade size: ${state.config.tradeAmount} SOL`,
    `📝 Paper trading: ON  |  Watch alerts: ${state.config.alertWatch ? "ON" : "OFF"}`,
    ``,
    `💼 *Portfolio:*`,
    `  Open: ${pf.openCount}  |  Closed: ${pf.closedCount}`,
    `  Unrealized: ${pf.unrealized >= 0 ? "+" : ""}${pf.unrealized} SOL`,
    `  Realized:   ${pf.realized  >= 0 ? "+" : ""}${pf.realized} SOL`,
    `  *Total P&L: ${pf.total >= 0 ? "+" : ""}${pf.total} SOL*`,
    `  Win rate: ${pf.winRate}%`,
    bkMsg,
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
  if (!state.openTrades[mint]) { await ctx.reply("Trade not found. Check the CA."); return; }

  const data     = await fetchTokenData(mint);
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
  state.stats = { tokensScanned: 0, alertsSent: 0, totalTrades: 0, startedAt: Date.now() };
  saveState();
  await ctx.reply("🔄 All trades and stats cleared.");
});

// ─── BOOT ─────────────────────────────────────────────────────────────────────

loadState();

bot.launch();
console.log("✅ Telegram bot online");

bot.telegram.sendMessage(CHAT_ID,
  `🟠 *pump.fun Scanner online*\nPolling every *5s* · Min score: ${state.config.minScore} · Paper trading: ON\n\n/status for full info`,
  { parse_mode: "Markdown" }
).catch(() => {});

setInterval(scan, SCAN_INTERVAL_MS);
scan(); // immediate first run

setInterval(updatePrices, PRICE_INTERVAL_MS);

process.once("SIGINT",  () => { saveState(); bot.stop("SIGINT");  });
process.once("SIGTERM", () => { saveState(); bot.stop("SIGTERM"); });

console.log(`🔍 Scanning every ${SCAN_INTERVAL_MS / 1000}s — price updates every ${PRICE_INTERVAL_MS / 1000}s`);
