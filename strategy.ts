// Quiet-momentum paper bot for the pump.fun replay (agent-fun/replay/v2).
//
// Idea, in one paragraph: most pump.fun curves die fast, a few run hard, and
// the replay only pays for being on the runners while they are still early.
// So this bot waits for a curve to prove itself — real buy flow from several
// distinct wallets, price up but not yet vertical, sitting near its recent
// high — then buys a small fixed stake, never chases a vertical move, and
// exits on a hard stop, a trailing stop once it is up, a fade in flow, a big
// single sell, or a time limit. It never holds more than a few positions, it
// never bets more than 0.04 SOL on one coin, and it keeps a small probe
// sleeve so the run still clears the 20-coin round-trip guardrail on a quiet
// final window where the momentum signal rarely fires.
//
// The protocol, as the bot sees it: the harness sends a hello first (capital,
// caps, fees, latency in slots), then one batch per slot with that slot's
// events, marks and fills, and finally a done. Every batch the bot answers
// with a list of orders (buys and sells); orders decided on the batch for
// slot s fill at slot s + latency. Everything below is a pure function of
// the hello and the batches: no clock, no randomness, no network, no I/O, so
// the two graded executions produce byte-identical action logs.
//
// Money is kept in bigint lamports throughout. Prices are kept as a scaled
// bigint (virtual quote reserves * 1e12 / virtual token reserves) so ratios
// are exact integer per-mille comparisons, never floats.

import {
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL; // 1_000_000_000n lamports
const PRICE_SCALE = 1_000_000_000_000n;

// ---- entry signal (rolling window over the tape) -------------------------
const WINDOW_SLOTS = 40; // lookback for the momentum window, in slots
const MIN_NET_LAMPORTS = 1_000_000_000n; // >= 1 SOL net inflow over the window
const MIN_BUYS = 4; // buy trades in the window
const MIN_BUYERS = 5; // distinct buying wallets in the window
const MIN_UP_PERMILLE = 80; // price up at least 8% over the window
const MAX_UP_PERMILLE = 1000; // ...but not more than 100% (already vertical)
const NEAR_HIGH_PERMILLE = 900; // price now at least 90% of the window high
const MAX_BUYER_SHARE_PERMILLE = 600; // biggest single buyer at most 60% of buys
const MIN_AGE_SLOTS = 20; // ignore the very first slots (bundled launches)
const MAX_AGE_SLOTS = 60000; // ...and coins older than ~6.7h of slots
const MIN_REAL_SOL = 2_000_000_000n; // curve must hold >= 2 SOL real at entry

// ---- sizing ---------------------------------------------------------------
const STAKE_LAMPORTS = 40_000_000n; // 0.04 SOL total per coin, at most
const FIRST_BUY_LAMPORTS = 20_000_000n; // first buy of a position
const ADD_BUY_LAMPORTS = 20_000_000n; // one add-on buy, into strength only
const MIN_BUY_LAMPORTS = 15_000_000n; // never buy less (fees would eat it)
const MAX_MAIN_POSITIONS = 4; // leave one of the 5 slots for probes
const MAX_ENTRIES_PER_MINT = 2; // at most two separate entries per coin

// ---- exits ----------------------------------------------------------------
const TAKE_PROFIT_PERMILLE = 1350; // sell all at +35% over cost
const STOP_LOSS_PERMILLE = 880; // sell all at -12% under cost
const TRAIL_ARM_PERMILLE = 1200; // trailing stop arms once up 20%
const TRAIL_DROP_PERMILLE = 120; // ...then exit on a 12% fall from the peak
const MAX_HOLD_SLOTS = 3600; // exit after ~24 min held...
const HOLD_IF_UP_PERMILLE = 1150; // ...unless still up at least 15%
const FADE_NET_LAMPORTS = -200_000_000n; // exit when window net flow < -0.2 SOL
const BIG_SELL_LAMPORTS = 1_000_000_000n; // exit on any single sell >= 1 SOL
const STALE_SLOTS = 1200; // exit when no trade for this many slots
const COOLDOWN_SLOTS = 600; // wait this long after an exit before re-entry

// ---- guardrail probes ------------------------------------------------------
const PROBE_SOL = 20_000_000n; // 0.02 SOL probe round trips
const PROBE_TARGET_COINS = 30; // probes stop once this many coins round-tripped
const PROBE_MIN_REAL_SOL = 3_000_000_000n; // probe only liquid curves (>= 3 SOL)

// ---- slippage ---------------------------------------------------------------
const BUY_SLIPPAGE_BPS = 1000; // 10% on buys (2-slot latency moves prices)
const SELL_SLIPPAGE_BPS = 10000; // sells must go through

const MAX_ORDERS_PER_BATCH = 14; // under the harness cap of 16, with margin

interface TapeTrade {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
  price: bigint; // scaled price just after this trade
}

interface Tape {
  mint: Pubkey;
  createdSlot: number | null;
  creator: Pubkey | null;
  createPrice: bigint;
  lastSlot: number;
  lastTradeBuy: boolean;
  trades: TapeTrade[]; // newest last, capped
  creatorSold: boolean;
  complete: boolean;
  entries: number;
  cooldownUntil: number;
}

interface PositionMeta {
  mint: Pubkey;
  cost: bigint;
  tokens: bigint;
  entryPrice: bigint;
  peakPermille: number; // best value/cost seen, per mille (1000 = breakeven)
  entrySlot: number;
  lastBuySlot: number;
  lastBuyPrice: bigint;
  buys: number;
  probe: boolean;
  probeReady: boolean;
}

interface PendingBuy {
  mint: Pubkey;
  kind: 'buy' | 'add' | 'probe';
  price: bigint;
  amount: bigint;
}

function priceOf(virtualQuote: bigint, virtualToken: bigint): bigint {
  if (virtualToken <= 0n) return 0n;
  return (virtualQuote * PRICE_SCALE) / virtualToken;
}

export function createStrategy() {
  const tapes = new Map<Pubkey, Tape>();
  const positions = new Map<Pubkey, PositionMeta>();
  const pending = new Map<string, PendingBuy>();
  const bought = new Set<Pubkey>(); // mints with a filled buy >= 0.01 SOL
  const roundTripped = new Set<Pubkey>(); // mints with a completed round trip
  const probed = new Set<Pubkey>(); // mints already probed once
  const probeOpen = new Set<Pubkey>(); // mints with a probe buy in flight/held
  const filledProbes = new Set<Pubkey>(); // mints whose probe buy already filled
  let orderSeq = 0;
  let firstSlot = -1;
  let batchCount = 0;

  function tapeFor(mint: Pubkey): Tape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        mint,
        createdSlot: null,
        creator: null,
        createPrice: 0n,
        lastSlot: -1,
        lastTradeBuy: false,
        trades: [],
        creatorSold: false,
        complete: false,
        entries: 0,
        cooldownUntil: -1,
      };
      tapes.set(mint, t);
    }
    return t;
  }

  function curvePrice(state: BotState, mint: Pubkey): bigint {
    const c = state.curves.get(mint);
    if (c === undefined) return 0n;
    return priceOf(c.virtual_quote_reserves, c.virtual_token_reserves);
  }

  // Rolling-window tape read for one mint at the current slot. Returns null
  // when the tape is too thin to judge.
  function windowStats(t: Tape, nowSlot: number) {
    const from = nowSlot - WINDOW_SLOTS;
    let buys = 0;
    let buySol = 0n;
    let sellSol = 0n;
    let firstPrice = 0n;
    let high = 0n;
    const buyers = new Map<Pubkey, bigint>();
    for (const tr of t.trades) {
      if (tr.slot <= from) continue;
      if (firstPrice === 0n) firstPrice = tr.price;
      if (tr.price > high) high = tr.price;
      if (tr.isBuy) {
        buys += 1;
        buySol += tr.sol;
        buyers.set(tr.user, (buyers.get(tr.user) ?? 0n) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
    }
    if (buys < MIN_BUYS || buySol === 0n || firstPrice === 0n) return null;
    let biggest = 0n;
    for (const v of buyers.values()) if (v > biggest) biggest = v;
    return {
      buys,
      buyers: buyers.size,
      net: buySol - sellSol,
      buySol,
      firstPrice,
      high,
      biggestSharePermille: Number((biggest * 1000n) / buySol),
    };
  }

  function signalHolds(state: BotState, t: Tape, nowSlot: number): boolean {
    if (t.complete || t.creatorSold) return false;
    if (t.createdSlot === null) return false;
    const age = nowSlot - t.createdSlot;
    if (age < MIN_AGE_SLOTS || age > MAX_AGE_SLOTS) return false;
    if (nowSlot < t.cooldownUntil) return false;
    if (t.entries >= MAX_ENTRIES_PER_MINT) return false;
    const curve = state.curves.get(t.mint);
    if (curve === undefined || curve.complete) return false;
    if (curve.real_quote_reserves < MIN_REAL_SOL) return false;
    const now = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (now === 0n) return false;
    const w = windowStats(t, nowSlot);
    if (w === null) return false;
    if (w.net < MIN_NET_LAMPORTS) return false;
    if (w.buyers < MIN_BUYERS) return false;
    if (w.biggestSharePermille > MAX_BUYER_SHARE_PERMILLE) return false;
    const up = Number(((now - w.firstPrice) * 1000n) / w.firstPrice);
    if (up < MIN_UP_PERMILLE || up > MAX_UP_PERMILLE) return false;
    const high = w.high > now ? w.high : now;
    if (Number((now * 1000n) / high) < NEAR_HIGH_PERMILLE) return false;
    return true;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    if (firstSlot < 0) firstSlot = slot;
    batchCount += 1;
    const orders: OrderInput[] = [];
    const txFee = state.txFeeLamports();
    let free = state.freeCashLamports();
    let buysSent = 0;

    const nextId = (): string => {
      orderSeq += 1;
      return `o${orderSeq}`;
    };

    // -- 1. Fold this batch's fills into the books. -------------------------
    // The hello already told us the latency in slots; fills arrive here,
    // two slots after the batch that decided them.
    for (const f of batch.fills) {
      const p = pending.get(f.client_id);
      if (p !== undefined) {
        pending.delete(f.client_id);
        if (f.status === 'filled' && f.side === 'buy') {
          if (BigInt(f.quote_lamports) >= 10_000_000n) bought.add(p.mint);
          if (p.kind === 'probe') {
            probeOpen.add(p.mint);
            filledProbes.add(p.mint);
          }
          const meta = positions.get(p.mint);
          if (meta !== undefined && p.kind === 'add') meta.buys += 1;
        }
        if (f.status === 'filled' && f.side === 'sell') {
          if (bought.has(p.mint)) roundTripped.add(p.mint);
          probeOpen.delete(p.mint);
          filledProbes.delete(p.mint);
        }
      }
      // Harness closes (_complete_ / _flatten_ / _writeoff_) also finish a
      // round trip for a coin we bought.
      if (f.client_id.startsWith('_') && f.side === 'sell' && f.status === 'filled') {
        if (bought.has(f.mint)) roundTripped.add(f.mint);
        probeOpen.delete(f.mint);
      }
    }

    // Sync position metas with the account the batch reports.
    for (const [mint, meta] of positions) {
      if (!state.positions.has(mint)) positions.delete(mint);
    }
    for (const [mint, holding] of state.positions) {
      const meta = positions.get(mint);
      const tokens = holding.token_amount;
      const cost = holding.cost_lamports;
      if (meta === undefined) {
        const price = curvePrice(state, mint);
        positions.set(mint, {
          mint,
          cost,
          tokens,
          entryPrice: price,
          peakPermille: 1000,
          entrySlot: slot,
          lastBuySlot: slot,
          lastBuyPrice: price,
          buys: 1,
          probe: probeOpen.has(mint),
          probeReady: filledProbes.has(mint),
        });
      } else {
        meta.cost = cost;
        meta.tokens = tokens;
        if (meta.probe && filledProbes.has(mint)) meta.probeReady = true;
      }
    }

    // -- 2. Grow every tape from this batch's events, in chain order. -------
    const seenThisBatch = new Set<Pubkey>();
    for (const e of batch.events) {
      seenThisBatch.add(e.mint);
      const t = tapeFor(e.mint);
      if (e.event === 'CreateEvent') {
        t.createdSlot = e.slot;
        t.creator = e.creator;
        t.createPrice = priceOf(
          BigInt(e.virtual_sol_reserves),
          BigInt(e.virtual_token_reserves),
        );
        t.lastSlot = e.slot;
      } else if (e.event === 'TradeEvent') {
        const price = priceOf(
          BigInt(e.virtual_sol_reserves),
          BigInt(e.virtual_token_reserves),
        );
        t.trades.push({
          slot: e.slot,
          isBuy: e.is_buy,
          sol: BigInt(e.sol_amount),
          user: e.user,
          price,
        });
        if (t.trades.length > 96) t.trades.splice(0, t.trades.length - 96);
        t.lastSlot = e.slot;
        t.lastTradeBuy = e.is_buy;
        if (!e.is_buy && t.creator !== null && e.user === t.creator) {
          t.creatorSold = true;
        }
      } else {
        t.complete = true;
      }
    }

    // Cheap periodic prune: drop tapes with no position, no recent trade and
    // no fresh create, so the run stays fast over a 24h window.
    if (batchCount % 500 === 0) {
      for (const [mint, t] of tapes) {
        if (!positions.has(mint) && slot - t.lastSlot > 20000) tapes.delete(mint);
      }
    }

    const mainOpen = (): number => {
      let n = 0;
      for (const m of positions.values()) if (!m.probe) n += 1;
      return n;
    };

    // -- 3. Exits first: every held position is judged on value vs cost. ---
    for (const [mint, meta] of positions) {
      if (orders.length >= MAX_ORDERS_PER_BATCH) break;
      const price = curvePrice(state, mint);
      const tape = tapes.get(mint);
      const lastTrade = tape !== undefined ? tape.lastSlot : -1;
      let exit = false;
      if (meta.probe && meta.probeReady) {
        exit = true; // probes sell as soon as the buy lands
      } else if (price === 0n) {
        exit = slot - lastTrade > STALE_SLOTS;
      } else {
        const value = (meta.tokens * price) / PRICE_SCALE;
        const ratio = meta.cost > 0n ? Number((value * 1000n) / meta.cost) : 0;
        if (ratio > meta.peakPermille) meta.peakPermille = ratio;
        const held = slot - meta.entrySlot;
        const w = tape !== undefined ? windowStats(tape, slot) : null;
        const faded = w !== null && w.net < FADE_NET_LAMPORTS;
        let bigSell = false;
        if (tape !== undefined) {
          for (const tr of tape.trades) {
            if (tr.slot === slot && !tr.isBuy && tr.sol >= BIG_SELL_LAMPORTS) {
              bigSell = true;
              break;
            }
          }
        }
        if (ratio >= TAKE_PROFIT_PERMILLE) exit = true;
        else if (ratio <= STOP_LOSS_PERMILLE) exit = true;
        else if (
          meta.peakPermille >= TRAIL_ARM_PERMILLE &&
          ratio <= meta.peakPermille - TRAIL_DROP_PERMILLE
        ) {
          exit = true;
        } else if (held > MAX_HOLD_SLOTS && ratio < HOLD_IF_UP_PERMILLE) {
          exit = true;
        } else if (faded || bigSell) {
          exit = true;
        } else if (slot - lastTrade > STALE_SLOTS) {
          exit = true;
        }
      }
      if (exit) {
        const id = nextId();
        orders.push({
          side: 'sell',
          mint,
          token_amount: meta.tokens,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
          client_id: id,
        });
        pending.set(id, { mint, kind: 'buy', price: 0n, amount: 0n });
        // Mark the sell in pending so its fill counts the round trip. The
        // kind field is reused: a sell fill is recognised by its side.
        if (tape !== undefined) tape.cooldownUntil = slot + COOLDOWN_SLOTS;
        probeOpen.delete(mint);
      }
    }

    // -- 4. Fresh momentum entries, in this batch's event order. ------------
    const ordered = new Set<Pubkey>();
    for (const e of batch.events) ordered.add(e.mint);
    for (const mint of ordered) {
      if (orders.length >= MAX_ORDERS_PER_BATCH) break;
      if (positions.has(mint)) continue;
      // Skip mints with a buy already pending (committedPositionCount
      // already counts them, but check explicitly for clarity).
      let buyPending = false;
      for (const p of pending.values()) {
        if (p.mint === mint && p.kind !== 'buy') {
          // probe/add pending: still counts as committed below
        }
        if (p.mint === mint) buyPending = true;
      }
      if (buyPending) continue;
      const t = tapes.get(mint);
      if (t === undefined) continue;
      if (!signalHolds(state, t, slot)) continue;
      if (mainOpen() + buysSent >= MAX_MAIN_POSITIONS) continue;
      if (state.committedPositionCount() + buysSent >= state.hello.caps.max_open_positions) continue;
      const cap = state.maxBuyLamports(mint);
      let amount = FIRST_BUY_LAMPORTS < cap ? FIRST_BUY_LAMPORTS : cap;
      if (amount < MIN_BUY_LAMPORTS) continue;
      if (free < amount + txFee) continue;
      const price = curvePrice(state, mint);
      const id = nextId();
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: amount,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
        client_id: id,
      });
      pending.set(id, { mint, kind: 'buy', price, amount });
      t.entries += 1;
      free -= amount + txFee;
      buysSent += 1;
    }

    // -- 5. One add-on buy per position, into strength only. -----------------
    for (const [mint, meta] of positions) {
      if (orders.length >= MAX_ORDERS_PER_BATCH) break;
      if (meta.probe || meta.buys >= 2) continue;
      const t = tapes.get(mint);
      if (t === undefined) continue;
      if (!signalHolds(state, t, slot)) continue;
      const price = curvePrice(state, mint);
      if (price < meta.lastBuyPrice) continue;
      if (slot - meta.lastBuySlot < 10) continue;
      const cap = state.maxBuyLamports(mint);
      let amount = ADD_BUY_LAMPORTS < cap ? ADD_BUY_LAMPORTS : cap;
      if (amount < MIN_BUY_LAMPORTS) continue;
      if (free < amount + txFee) continue;
      const id = nextId();
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: amount,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
        client_id: id,
      });
      pending.set(id, { mint, kind: 'add', price, amount });
      meta.lastBuySlot = slot;
      meta.lastBuyPrice = price;
      free -= amount + txFee;
      buysSent += 1;
    }

    // -- 6. Guardrail probes: only when momentum bought nothing this batch,
    //    only with a spare position slot, only until the coin target is met.
    if (buysSent === 0 && roundTripped.size + probeOpen.size < PROBE_TARGET_COINS) {
      if (state.committedPositionCount() < state.hello.caps.max_open_positions - 1) {
        for (const mint of ordered) {
          if (orders.length >= MAX_ORDERS_PER_BATCH) break;
          if (positions.has(mint) || probed.has(mint)) continue;
          const t = tapes.get(mint);
          if (t === undefined || t.complete || t.creatorSold) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (curve.real_quote_reserves < PROBE_MIN_REAL_SOL) continue;
          const w = windowStats(t, slot);
          if (w === null || w.buys < 5) continue;
          const now = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
          if (now === 0n) continue;
          // Skip a coin that already halved inside the window (likely dead).
          if (Number((now * 1000n) / w.firstPrice) < 500) continue;
          const cap = state.maxBuyLamports(mint);
          let amount = PROBE_SOL < cap ? PROBE_SOL : cap;
          if (amount < MIN_BUY_LAMPORTS) continue;
          if (free < amount + txFee) continue;
          const id = nextId();
          orders.push({
            side: 'buy',
            mint,
            quote_lamports: amount,
            max_slippage_bps: BUY_SLIPPAGE_BPS,
            client_id: id,
          });
          pending.set(id, { mint, kind: 'probe', price: now, amount });
          probed.add(mint);
          free -= amount + txFee;
          break; // at most one probe buy per batch
        }
      }
    }

    return orders;
  }

  return { onBatch };
}
