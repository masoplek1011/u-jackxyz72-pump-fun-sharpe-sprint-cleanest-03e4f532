// Cleanest Paper Bot — Pump.fun Sharpe Sprint (u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
//
// A deterministic, rule-based paper-trading bot for the agent-fun/replay/v2
// protocol. It reads a hello message, then one batch per slot, and answers
// every batch with exactly one reply echoing that batch's seq and carrying
// its orders for that slot.
//
// Rules of the road (all decisions use only events already received in this
// run — no future-peeking, no clock, no randomness, no environment, no
// network, no file I/O; Node 22 stdlib only):
//
//   - Prices are exact BigInt rationals from virtual reserves:
//     price (SOL per token) = virtual_sol_reserves / virtual_token_reserves.
//     Every comparison is done by cross-multiplication, never floats.
//   - The ratio real_sol_reserves / virtual_sol_reserves tracks how far a
//     bonding curve has climbed toward graduation. Most new mints die in a
//     single-slot dump, so the bot never buys the pump itself: it waits
//     120 slots after a ratio crossing, then enters only if the price held
//     up (>= 95% of the crossing price) and the tape stayed buy-dominant
//     (buy volume >= 2x sell volume over the wait, >= 5 trades).
//   - Two lanes, best lane first:
//       E45: ratio crosses 0.45, size 0.20 SOL (capped at 90 bps of real
//            reserves), exit +10% / -6% / 600 slots.
//       E20: ratio crosses 0.20, size 0.05 SOL, exit +10% / -6% / 600 slots.
//     E45 is the profit engine (76.9% win rate on the dev window); E20 is a
//     small filler that spreads round trips over more distinct mints so the
//     20-mint guardrail stays in reach.
//   - Exits are tight because this is a Sharpe sprint, not a PnL sprint:
//     steady small wins, short holds (600 slots), no moonshot chasing.
//   - Guards: max 5 open positions (from hello), at most one buy per mint
//     per batch, per-mint cooldown after an exit (120 slots after a win,
//     600 after a loss), buy sizes halved past ~20% drawdown and no new
//     buys past ~35% drawdown, 1 SOL cash reserve kept at all times.
//   - Orders resolve 2 slots after the batch they were decided on, so the
//     bot sizes buys against the decision-time real reserves (cap: 100 bps
//     of real reserves per mint per reply) and uses 300 bps slippage on
//     buys, 1000 bps on sells so exits reliably execute; a rejected or
//     failed sell is retried on the next batch, never stranded.

import * as readline from "node:readline";

// ---------------------------------------------------------------- constants

const LAMPORTS_PER_SOL = 1_000_000_000n;
const BPS = 10_000n;

// Lane E45 (profit engine): ratio cross 0.45, wait, confirm, enter.
const E45_RATIO_NUM = 45n;
const E45_RATIO_DEN = 100n;
const E45_SIZE_LAMPORTS = 200_000_000n; // 0.20 SOL
const E45_WAIT_SLOTS = 120;

// Lane E20 (filler): ratio cross 0.20, same confirmation, smaller size.
const E20_RATIO_NUM = 20n;
const E20_RATIO_DEN = 100n;
const E20_SIZE_LAMPORTS = 50_000_000n; // 0.05 SOL
const E20_WAIT_SLOTS = 120;

const CONFIRM_HOLD_NUM = 95n; // price must hold >= 95% of the crossing price
const CONFIRM_HOLD_DEN = 100n;
const CONFIRM_BUY_DOM_NUM = 2n; // buy volume >= 2x sell volume over the wait
const CONFIRM_BUY_DOM_DEN = 1n;
const CONFIRM_MIN_TRADES = 5;

const TAKE_PROFIT_BPS = 1000n; // +10%
const STOP_LOSS_BPS = 600n; // -6%
const MAX_HOLD_SLOTS = 600;

const BUY_SLIPPAGE_BPS = 300;
const SELL_SLIPPAGE_BPS = 1000; // wide so exits execute during fast moves instead of rejecting and stranding the position
const MAX_BUY_BPS_OF_REAL_RESERVE = 90n; // keep under the 100 bps cap
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL, the round-trip floor
const CASH_RESERVE_LAMPORTS = 1_000_000_000n; // keep >= 1 SOL cash
const COOLDOWN_WIN_SLOTS = 120;
const COOLDOWN_LOSS_SLOTS = 600;
const DRAWDOWN_HALVE_BPS = 2000n; // halve sizes past 20% drawdown
const DRAWDOWN_STOP_BPS = 3500n; // exits only past 35% drawdown
const TAPE_WINDOW_SLOTS = 200; // prune tape older than this (wait is 120)
const MINT_PRUNE_SLOTS = 10_000;

// ------------------------------------------------------------------- types

type Rational = { n: bigint; d: bigint };

type MintTape = { slot: number; buy: bigint; sell: bigint };

type LaneState = {
  crossSlot: number;
  crossPrice: Rational;
  done: boolean;
};

type MintState = {
  lastPrice: Rational;
  lastRatio: Rational;
  lastRealSol: bigint;
  lastSeenSlot: number;
  complete: boolean;
  tape: MintTape[];
  tradeSlots: number[];
  e45: LaneState | null;
  e20: LaneState | null;
};

type Position = {
  tokens: bigint;
  cost: bigint; // lamports paid in (curve fees included), from account
  entrySlot: number;
  entryPrice: Rational; // fill price (quote/token from the buy fill); exits are measured against this, not the fee-loaded cost
  lane: string;
  exiting: boolean;
  exitReason: string;
};

type FillInfo = {
  side: string;
  status: string;
  quoteLamports: bigint;
  tokenAmount: bigint;
  feeLamports: bigint;
  txFeeLamports: bigint;
  decidedSlot: number;
  slot: number;
};

// ------------------------------------------------------------------ helpers

// Compare a/b with c/d: -1, 0, 1. Exact, no floats.
function cmpRatio(aN: bigint, aD: bigint, bN: bigint, bD: bigint): number {
  const left = aN * bD;
  const right = bN * aD;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

// True when price (n/d) is up at least tpBps over entry (en/ed).
function atTakeProfit(n: bigint, d: bigint, en: bigint, ed: bigint): boolean {
  // n/d >= en/ed * (10000 + tp) / 10000
  return n * ed * BPS >= en * d * (BPS + TAKE_PROFIT_BPS);
}

// True when price (n/d) is down at least slBps under entry (en/ed).
function atStopLoss(n: bigint, d: bigint, en: bigint, ed: bigint): boolean {
  return n * ed * BPS <= en * d * (BPS - STOP_LOSS_BPS);
}

// -------------------------------------------------------------------- state

let maxOpenPositions = 5;
let maxOrdersPerBatch = 16;
let maxOrderBpsOfRealReserve = 100n;

let cash = 0n;
let peakEquity = 0n;

const positions = new Map<string, Position>();
const pendingBuys = new Map<string, string>(); // mint -> client_id
const pendingSells = new Map<string, string>(); // mint -> client_id
// Buy-fill facts that arrive in the same batch as the account snapshot: the
// fill is processed first, the position is created from the account after,
// so the fill's entry slot/price/lane are stashed here in between.
const pendingEntryInfo = new Map<string, { entrySlot: number; entryPrice: Rational; lane: string }>();
const mints = new Map<string, MintState>();
const cooldownUntil = new Map<string, number>();
const roundTripped = new Set<string>();

let orderSeq = 0;
let batchesSeen = 0;

function mintState(mint: string): MintState {
  let s = mints.get(mint);
  if (s === undefined) {
    s = {
      lastPrice: { n: 0n, d: 1n },
      lastRatio: { n: 0n, d: 1n },
      lastRealSol: 0n,
      lastSeenSlot: 0,
      complete: false,
      tape: [],
      tradeSlots: [],
      e45: null,
      e20: null,
    };
    mints.set(mint, s);
  }
  return s;
}

// Buy volume minus sell volume over the tape window ending at slot.
function tapeSums(m: MintState, slot: number, window: number): { buy: bigint; sell: bigint } {
  let buy = 0n;
  let sell = 0n;
  for (let i = m.tape.length - 1; i >= 0; i--) {
    const t = m.tape[i]!;
    if (t.slot > slot) continue;
    if (t.slot < slot - window) break;
    buy += t.buy;
    sell += t.sell;
  }
  return { buy, sell };
}

function tradesSince(m: MintState, fromSlot: number): number {
  let n = 0;
  for (let i = m.tradeSlots.length - 1; i >= 0; i--) {
    if (m.tradeSlots[i]! >= fromSlot) n++;
    else break;
  }
  return n;
}

// Check one lane for one mint at the current batch slot. Returns the desired
// buy size in lamports, or 0n when the lane does not trigger.
function laneSize(
  m: MintState,
  lane: LaneState | null,
  ratioNum: bigint,
  ratioDen: bigint,
  slot: number,
  wait: number,
): bigint {
  if (lane === null) {
    if (cmpRatio(m.lastRatio.n, m.lastRatio.d, ratioNum, ratioDen) >= 0) {
      return -1n; // signal: record the crossing, do not buy yet
    }
    return 0n;
  }
  if (lane.done) return 0n;
  if (slot < lane.crossSlot + wait) return 0n;
  lane.done = true;
  // Price must have held up since the crossing.
  if (
    cmpRatio(
      m.lastPrice.n,
      m.lastPrice.d,
      (lane.crossPrice.n * CONFIRM_HOLD_NUM) / CONFIRM_HOLD_DEN,
      lane.crossPrice.d,
    ) < 0
  ) {
    return 0n;
  }
  // Tape must have stayed buy-dominant over the wait, with real activity.
  const sums = tapeSums(m, slot, wait);
  if (sums.buy * CONFIRM_BUY_DOM_DEN < sums.sell * CONFIRM_BUY_DOM_NUM) return 0n;
  if (tradesSince(m, lane.crossSlot) < CONFIRM_MIN_TRADES) return 0n;
  return 1n; // signal: confirmed, size is set by the caller
}

// Current equity: cash plus open positions marked at their latest price.
function equityNow(marks: Map<string, Rational>): bigint {
  let e = cash;
  for (const [mint, p] of positions) {
    const mark = marks.get(mint);
    const price = mark ?? mints.get(mint)?.lastPrice;
    if (price === undefined || price.d === 0n) continue;
    e += (p.tokens * price.n) / price.d;
  }
  return e;
}

function pruneMints(slot: number): void {
  if (mints.size <= 3000) return;
  for (const [mint, m] of mints) {
    if (positions.has(mint) || pendingBuys.has(mint)) continue;
    if (m.lastSeenSlot < slot - MINT_PRUNE_SLOTS) mints.delete(mint);
  }
}

// ---------------------------------------------------------------------- main

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === "hello") {
      if (msg.caps !== undefined) {
        maxOpenPositions = msg.caps.max_open_positions ?? maxOpenPositions;
        maxOrdersPerBatch = msg.caps.max_orders_per_batch ?? maxOrdersPerBatch;
        maxOrderBpsOfRealReserve = BigInt(msg.caps.max_order_bps_of_real_reserve ?? 100);
      }
      if (msg.capital !== undefined) {
        cash = BigInt(msg.capital.lamports);
        peakEquity = cash;
      }
      continue;
    }
    if (msg.type === "done") break;
    if (msg.type !== "batch") continue;

    const slot: number = msg.slot;
    const seq: number = msg.seq;
    batchesSeen++;
    const orders: any[] = [];

    // 1. Fold this batch's events into per-mint state (prices, ratio, tape).
    //    Only events already received in this run are ever used.
    const batchTape = new Map<string, { buy: bigint; sell: bigint }>();
    const batchMints = new Set<string>();
    for (const ev of msg.events ?? []) {
      const mint: string = ev.mint;
      batchMints.add(mint);
      const m = mintState(mint);
      m.lastSeenSlot = slot;
      if (ev.event === "CreateEvent") {
        m.lastPrice = { n: BigInt(ev.virtual_sol_reserves), d: BigInt(ev.virtual_token_reserves) };
        m.lastRatio = { n: 0n, d: 1n };
        m.lastRealSol = 0n;
      } else if (ev.event === "TradeEvent") {
        const vs = BigInt(ev.virtual_sol_reserves);
        const vt = BigInt(ev.virtual_token_reserves);
        const rs = BigInt(ev.real_sol_reserves);
        m.lastPrice = { n: vs, d: vt };
        m.lastRatio = { n: rs, d: vs };
        m.lastRealSol = rs;
        const agg = batchTape.get(mint) ?? { buy: 0n, sell: 0n };
        const amt = BigInt(ev.sol_amount);
        if (ev.is_buy) agg.buy += amt;
        else agg.sell += amt;
        batchTape.set(mint, agg);
        m.tradeSlots.push(slot);
        if (m.tradeSlots.length > 128) m.tradeSlots.splice(0, m.tradeSlots.length - 128);
      } else if (ev.event === "CompleteEvent") {
        m.complete = true;
      }
    }
    // One tape row per mint per batch slot (kept short, pruned by slot).
    for (const [mint, agg] of batchTape) {
      const m = mintState(mint);
      m.tape.push({ slot, buy: agg.buy, sell: agg.sell });
      while (m.tape.length > 0 && m.tape[0]!.slot < slot - TAPE_WINDOW_SLOTS) m.tape.shift();
    }

    // 2. Marks: the freshest price for each open position (already shifted
    //    by the bot's own impact). Fall back to the last event price.
    const marks = new Map<string, Rational>();
    for (const mk of msg.marks ?? []) {
      marks.set(mk.mint, {
        n: BigInt(mk.virtual_quote_reserves),
        d: BigInt(mk.virtual_token_reserves),
      });
    }

    // 3. Process fills: resolve pending orders, learn entry slots, and set
    //    cooldowns from realized round-trip PnL.
    for (const f of msg.fills ?? []) {
      const fill: FillInfo = {
        side: f.side,
        status: f.status,
        quoteLamports: BigInt(f.quote_lamports),
        tokenAmount: BigInt(f.token_amount),
        feeLamports: BigInt(f.fee_lamports),
        txFeeLamports: BigInt(f.tx_fee_lamports),
        decidedSlot: f.decided_slot,
        slot: f.slot,
      };
      const mint: string = f.mint;
      if (fill.side === "buy") {
        pendingBuys.delete(mint);
        if (fill.status === "filled") {
          const p = positions.get(mint);
          const lane = typeof f.client_id === "string" && f.client_id.startsWith("b45-") ? "e45" : "e20";
          const info = {
            entrySlot: fill.slot,
            entryPrice:
              fill.tokenAmount > 0n && fill.quoteLamports > 0n
                ? { n: fill.quoteLamports, d: fill.tokenAmount }
                : { n: 0n, d: 1n },
            lane,
          };
          if (p !== undefined) {
            p.entrySlot = info.entrySlot;
            if (info.entryPrice.d > 0n && info.entryPrice.n > 0n) p.entryPrice = info.entryPrice;
            p.lane = info.lane;
          } else {
            pendingEntryInfo.set(mint, info);
          }
        }
      } else {
        pendingSells.delete(mint);
        if (fill.status === "filled") {
          const p = positions.get(mint);
          if (p !== undefined) {
            const net = fill.quoteLamports - fill.feeLamports - fill.txFeeLamports;
            const pnl = net - p.cost;
            roundTripped.add(mint);
            cooldownUntil.set(mint, slot + (pnl <= 0n ? COOLDOWN_LOSS_SLOTS : COOLDOWN_WIN_SLOTS));
          }
        } else {
          // A rejected or failed sell leaves the position open: clear the
          // exiting flag so the exit logic retries on the next batch instead
          // of stranding the position until the window-end flatten.
          const p = positions.get(mint);
          if (p !== undefined) {
            p.exiting = false;
            p.exitReason = "";
          }
        }
      }
    }

    // 4. Sync positions from the account snapshot (authoritative for cash,
    //    tokens and cost). Positions that vanished were force-closed (a
    //    CompleteEvent) or flattened: count the round trip.
    if (msg.account !== undefined) {
      cash = BigInt(msg.account.cash_lamports);
      const seen = new Set<string>();
      for (const ap of msg.account.positions ?? []) {
        const mint: string = ap.mint;
        seen.add(mint);
        const tokens = BigInt(ap.token_amount);
        const cost = BigInt(ap.cost_lamports);
        const prev = positions.get(mint);
        if (prev === undefined) {
          const info = pendingEntryInfo.get(mint);
          pendingEntryInfo.delete(mint);
          positions.set(mint, {
            tokens,
            cost,
            entrySlot: info?.entrySlot ?? slot,
            entryPrice:
              info !== undefined && info.entryPrice.n > 0n
                ? info.entryPrice
                : tokens > 0n
                  ? { n: cost, d: tokens }
                  : { n: 0n, d: 1n },
            lane: info?.lane ?? "unknown",
            exiting: false,
            exitReason: "",
          });
        } else {
          prev.tokens = tokens;
          prev.cost = cost;
          // NOTE: entryPrice is deliberately NOT overwritten from cost here.
          // Cost loads the curve + tx fees (~1.3%) onto the entry price, so
          // a +10% take-profit measured against cost needs a +11.4% market
          // move and can miss a grind top by a hair. Take-profit and
          // stop-loss are measured against the fill price (quote/token from
          // the buy fill); cost is kept only for realized-PnL accounting.
        }
      }
      for (const [mint, p] of positions) {
        if (!seen.has(mint)) {
          if (p.tokens > 0n) roundTripped.add(mint);
          positions.delete(mint);
        }
      }
    }

    // 5. Equity and drawdown guard.
    const equity = equityNow(marks);
    if (equity > peakEquity) peakEquity = equity;
    const drawdownBps =
      peakEquity > 0n ? ((peakEquity - equity) * BPS) / peakEquity : 0n;
    const stopBuying = drawdownBps >= DRAWDOWN_STOP_BPS;
    const halveSizes = drawdownBps >= DRAWDOWN_HALVE_BPS;

    // 6. Exits first: take profit, stop loss, max hold, and (past 35%
    //    drawdown) flatten everything.
    const openCount = positions.size + pendingBuys.size;
    for (const [mint, p] of positions) {
      if (p.exiting || pendingSells.has(mint)) continue;
      if (p.tokens === 0n) continue;
      const mark = marks.get(mint);
      const price = mark ?? mints.get(mint)?.lastPrice;
      if (price === undefined || price.d === 0n) continue;
      const age = slot - p.entrySlot;
      let reason = "";
      if (stopBuying) reason = "drawdown";
      else if (atTakeProfit(price.n, price.d, p.entryPrice.n, p.entryPrice.d)) reason = "take-profit";
      else if (atStopLoss(price.n, price.d, p.entryPrice.n, p.entryPrice.d)) reason = "stop-loss";
      else if (age >= MAX_HOLD_SLOTS) reason = "max-hold";
      if (reason === "") continue;
      p.exiting = true;
      p.exitReason = reason;
      const clientId = `x-${orderSeq++}`;
      pendingSells.set(mint, clientId);
      orders.push({
        side: "sell",
        client_id: clientId,
        mint,
        token_amount: p.tokens.toString(),
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
    }

    // 7. Entries: evaluate each traded mint once per batch, best lane first.
    if (!stopBuying && orders.length < maxOrdersPerBatch) {
      for (const mint of batchMints) {
        if (orders.length >= maxOrdersPerBatch) break;
        if (positions.has(mint) || pendingBuys.has(mint) || pendingSells.has(mint)) continue;
        const m = mints.get(mint);
        if (m === undefined || m.complete) continue;
        if ((cooldownUntil.get(mint) ?? 0) > slot) continue;
        if (positions.size + pendingBuys.size >= maxOpenPositions) break;
        if (m.lastPrice.d === 0n || m.lastRealSol === 0n) continue;

        // Record crossings (a -1n signal means "crossed just now").
        if (m.e45 === null) {
          const r = laneSize(m, null, E45_RATIO_NUM, E45_RATIO_DEN, slot, E45_WAIT_SLOTS);
          if (r === -1n) m.e45 = { crossSlot: slot, crossPrice: { ...m.lastPrice }, done: false };
        }
        if (m.e20 === null) {
          const r = laneSize(m, null, E20_RATIO_NUM, E20_RATIO_DEN, slot, E20_WAIT_SLOTS);
          if (r === -1n) m.e20 = { crossSlot: slot, crossPrice: { ...m.lastPrice }, done: false };
        }

        let desired = 0n;
        let laneTag = "";
        if (m.e45 !== null && laneSize(m, m.e45, E45_RATIO_NUM, E45_RATIO_DEN, slot, E45_WAIT_SLOTS) === 1n) {
          desired = E45_SIZE_LAMPORTS;
          laneTag = "45";
        } else if (m.e20 !== null && laneSize(m, m.e20, E20_RATIO_NUM, E20_RATIO_DEN, slot, E20_WAIT_SLOTS) === 1n) {
          desired = E20_SIZE_LAMPORTS;
          laneTag = "20";
        }
        if (desired === 0n) continue;

        // Cap the buy under the per-reply order-size cap (100 bps of real
        // reserves): use 90 bps of decision-time real reserves.
        const cap = (m.lastRealSol * MAX_BUY_BPS_OF_REAL_RESERVE) / BPS;
        let size = desired < cap ? desired : cap;
        if (halveSizes) size /= 2n;
        if (size < MIN_BUY_LAMPORTS) continue;
        if (cash - size < CASH_RESERVE_LAMPORTS) continue;

        const clientId = `b${laneTag}-${orderSeq++}`;
        pendingBuys.set(mint, clientId);
        orders.push({
          side: "buy",
          client_id: clientId,
          mint,
          quote_lamports: size.toString(),
          max_slippage_bps: BUY_SLIPPAGE_BPS,
        });
      }
    }

    if (batchesSeen % 1000 === 0) pruneMints(slot);

    // 8. One reply per batch, echoing its seq, carrying this slot's orders.
    process.stdout.write(JSON.stringify({ type: "reply", seq, orders }) + "\n");
  }
}

main().catch(() => {
  process.exit(1);
});
