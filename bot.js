require("dotenv").config();
const WebSocket = require("ws");
const axios = require("axios");

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ===============================
   FETCH TOKEN METADATA (with retry)
================================ */

async function fetchTokenMeta(mint) {
  try {
    const res = await axios.get(
      `https://frontend-api.pump.fun/coins/${mint}`,
      { timeout: 4000 }
    );
    return res.data;
  } catch {
    return null;
  }
}

async function getCoinWithRetry(mint) {
  for (let i = 0; i < 6; i++) {
    const coin = await fetchTokenMeta(mint);
    if (coin) return coin;
    await sleep(5000);
  }
  return null;
}

/* ===============================
   WHALE DETECTION
================================ */

async function detectWhaleBuy(mint) {
  try {
    const url = `https://api.helius.xyz/v0/addresses/${mint}/transactions?api-key=${HELIUS_API_KEY}`;
    const res = await axios.get(url, { timeout: 6000 });

    let largestBuy = 0;

    for (const tx of res.data) {
      if (!tx.nativeTransfers) continue;

      for (const t of tx.nativeTransfers) {
        const sol = t.amount / 1e9;
        if (sol > largestBuy) largestBuy = sol;
      }
    }

    return largestBuy;
  } catch {
    return 0;
  }
}

/* ===============================
   SCORING ENGINE
================================ */

function calculateScore(coin, whaleSOL) {
  let score = 0;

  const solInCurve = coin.virtual_sol_reserves || 0;
  const replyCount = coin.reply_count || 0;
  const hasTwitter = !!coin.twitter;
  const hasTelegram = !!coin.telegram;
  const isKing = coin.king_of_the_hill_timestamp;
  const ageSeconds = Math.floor(
    (Date.now() - coin.created_timestamp) / 1000
  );

  const velocitySOL = solInCurve / Math.max(ageSeconds / 60, 1);

  /* ===== VELOCITY (MOST IMPORTANT) ===== */
  score += Math.min(40, velocitySOL * 20);

  /* ===== EARLY LIQUIDITY ===== */
  if (solInCurve > 1) score += 5;
  if (solInCurve > 3) score += 10;
  if (solInCurve > 8) score += 15;

  /* ===== ENGAGEMENT ===== */
  score += Math.min(20, replyCount * 0.5);

  /* ===== SOCIALS ===== */
  if (hasTwitter) score += 5;
  if (hasTelegram) score += 5;

  /* ===== KING OF HILL ===== */
  if (isKing) score += 10;

  /* ===== FRESHNESS ===== */
  if (ageSeconds < 60) score += 10;
  else if (ageSeconds < 180) score += 5;

  /* ===== WHALE DETECTION ===== */
  if (whaleSOL > 1) score += 5;
  if (whaleSOL > 3) score += 10;
  if (whaleSOL > 6) score += 20;
  if (whaleSOL > 10) score += 30;

  return Math.min(100, Math.round(score));
}

/* ===============================
   MAIN HANDLER
================================ */

async function handleMint(mint) {
  console.log(`[ws] New token detected: ${mint.slice(0,6)}...`);

  const coin = await getCoinWithRetry(mint);
  if (!coin) {
    console.log(`[meta] Metadata not found`);
    return;
  }

  if (coin.complete) return;

  console.log(`[meta] Loaded ${coin.symbol}`);

  const whaleSOL = await detectWhaleBuy(mint);
  console.log(`[whale] Largest buy: ${whaleSOL.toFixed(2)} SOL`);

  const score = calculateScore(coin, whaleSOL);

  if (score >= 70) {
    console.log(`🚀 BUY ${coin.symbol} SCORE=${score}`);
  } else if (score >= 45) {
    console.log(`👀 WATCH ${coin.symbol} SCORE=${score}`);
  } else {
    console.log(`❌ SKIP ${coin.symbol} SCORE=${score}`);
  }
}

/* ===============================
   WEBSOCKET LISTENER
================================ */

function start() {
  const ws = new WebSocket(
    `wss://atlas-mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  );

  ws.on("open", () => {
    console.log("Listening for new tokens...");
  });

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data?.params?.result?.value?.account?.data?.parsed?.info?.mint) {
        const mint =
          data.params.result.value.account.data.parsed.info.mint;

        await handleMint(mint);
      }
    } catch {}
  });

  ws.on("close", () => {
    console.log("WS closed — reconnecting...");
    setTimeout(start, 3000);
  });
}

start();
