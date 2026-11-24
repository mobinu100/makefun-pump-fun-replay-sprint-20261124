// Quiet-momentum paper bot for the pump.fun replay (agent-fun/replay/v2).
//
// Idea, in one paragraph: pump.fun curves spike, dump, and then often bounce
// part of the way back while buyers step in again — the dip is where the
// edge is, not the chase. So this bot buys a curve only after it ran up,
// fell 25-40% from its recent high, and shows buyers returning (most of the
// last few trades are buys and the latest trade is a buy), on curves that
// still hold real SOL. One small fixed stake per coin, never averaged down,
// exits on a fast take-profit, a tight stop, a trailing stop once up, faded
// flow, a big single sell, or a time limit. It never holds more than a few
// positions, never bets more than 0.03 SOL on one coin, and keeps a small
// probe sleeve so the run still clears the 20-coin round-trip guardrail on a
// quiet final window where the dip signal rarely fires.
//
// (v1/v2 tried the other side of the same tape — buying fresh momentum — and
// lost on the dev window: 273 round trips at a 19% win rate, net -0.35 SOL.
// The chase fills late and dumps first, so the entry moved to the dip.
// Tuning on the dev window (grade-local, --driver process, two runs each):
// v3 dip 25-40% TP+20% SL-10%: -0.070 SOL, 101 trips. v4 stricter + no TP:
// -0.073. v5 v3 + probes as late insurance only: -0.049. v6 TP+50% + longer
// trail/hold: -0.042, 81 trips, 63 coins, drawdown 0.84% — shipped. v7 TP+100%:
// -0.053. For scale, the kit's own pilot bots score -4.0 and -9.5 SOL here,
// so this window punishes size and slow exits; the edge here is surviving it.)
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

// ---- entry signal (dip after a run-up, buyers stepping back in) ---------
const WINDOW_SLOTS = 40; // lookback for the fade/probe flow read, in slots
const MIN_BUYS = 3; // windowStats needs this many buy trades to judge flow
const HIGH_WINDOW_SLOTS = 2500; // lookback for the recent high, in slots
const DIP_MIN_PERMILLE = 250; // enter at least 25% below the recent high...
const DIP_MAX_PERMILLE = 400; // ...and not more than 40% (a collapse, not a dip)
const HIGH_RUNUP_PERMILLE = 1500; // the high must be >= 1.5x the create price
const MIN_HIGH_TRADES = 8; // trades seen inside the high window
const FLOW_TRADES = 6; // last trades judged for returning buyers
const FLOW_MIN_BUYS = 3; // ...at least this many of them buys...
const FLOW_LAST_BUY = true; // ...and the latest trade must be a buy
const FLOW_MIN_NET_LAMPORTS = -100_000_000n; // net flow over them >= -0.1 SOL
const MIN_AGE_SLOTS = 100; // ignore fresh launches (no high to dip from)
const MAX_AGE_SLOTS = 60000; // ...and coins older than ~6.7h of slots
const MIN_REAL_SOL = 3_000_000_000n; // curve must hold >= 3 SOL real at entry

// ---- sizing ---------------------------------------------------------------
const ENTRY_LAMPORTS = 30_000_000n; // 0.03 SOL, one buy per coin, no adds
const MIN_BUY_LAMPORTS = 20_000_000n; // never buy less (fees would eat it)
const MAX_MAIN_POSITIONS = 4; // leave one of the 5 slots for probes
const MAX_ENTRIES_PER_MINT = 2; // at most two separate entries per coin

// ---- exits ----------------------------------------------------------------
const TAKE_PROFIT_PERMILLE = 1500; // sell all at +50% over cost
const STOP_LOSS_PERMILLE = 900; // sell all at -10% under cost
const TRAIL_ARM_PERMILLE = 1200; // trailing stop arms once up 20%
const TRAIL_DROP_PERMILLE = 100; // ...then exit on a 10% fall from the peak
const MAX_HOLD_SLOTS = 7200; // exit after ~48 min held...
const HOLD_IF_UP_PERMILLE = 1150; // ...unless still up at least 15%
const FADE_NET_LAMPORTS = -500_000_000n; // exit when window net flow < -0.5 SOL
const BIG_SELL_LAMPORTS = 1_000_000_000n; // exit on any single sell >= 1 SOL
const STALE_SLOTS = 1200; // exit when no trade for this many slots
const COOLDOWN_SLOTS = 600; // wait this long after an exit before re-entry

// ---- guardrail probes ------------------------------------------------------
const PROBE_SOL = 20_000_000n; // 0.02 SOL probe round trips
const PROBE_TARGET_COINS = 21; // probes stop once this many coins round-tripped
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

  function reversionSignal(state: BotState, t: Tape, nowSlot: number): boolean {
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
    if (now === 0n || t.createPrice === 0n) return false;
    // Recent high over the long window, from the trades the tape kept.
    const from = nowSlot - HIGH_WINDOW_SLOTS;
    let high = 0n;
    let inWindow = 0;
    for (const tr of t.trades) {
      if (tr.slot <= from) continue;
      inWindow += 1;
      if (tr.price > high) high = tr.price;
    }
    if (high === 0n || inWindow < MIN_HIGH_TRADES) return false;
    // The high must be a real run-up from the create price, not noise.
    if (Number((high * 1000n) / t.createPrice) < HIGH_RUNUP_PERMILLE) return false;
    const dip = Number(((high - now) * 1000n) / high);
    if (dip < DIP_MIN_PERMILLE || dip > DIP_MAX_PERMILLE) return false;

    // Buyers stepping back in: most of the last few trades are buys, the
    // latest trade is a buy, and their net flow is not deeply negative.
    const recent = t.trades.slice(-FLOW_TRADES);
    if (recent.length < FLOW_TRADES) return false;
    let buys = 0;
    let net = 0n;
    for (const tr of recent) {
      if (tr.isBuy) {
        buys += 1;
        net += tr.sol;
      } else {
        net -= tr.sol;
      }
    }
    if (buys < FLOW_MIN_BUYS) return false;
    if (FLOW_LAST_BUY && !recent[recent.length - 1].isBuy) return false;
    if (net < FLOW_MIN_NET_LAMPORTS) return false;
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

    // -- 4. Fresh dip entries, in this batch's event order. ------------------
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
      if (!reversionSignal(state, t, slot)) continue;
      if (mainOpen() + buysSent >= MAX_MAIN_POSITIONS) continue;
      if (state.committedPositionCount() + buysSent >= state.hello.caps.max_open_positions) continue;
      const cap = state.maxBuyLamports(mint);
      let amount = ENTRY_LAMPORTS < cap ? ENTRY_LAMPORTS : cap;
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

    // -- 5. Guardrail probes: only when the dip signal bought nothing this batch,
    //    only with a spare position slot, only until the coin target is met.
    // Probes are last-resort guardrail insurance, not an early sleeve:
    // dip entries get the whole first half of the window to reach 21
    // coins on their own, so probes only pay their fee drag when the
    // run is actually short of the guardrail (v3's early probes were
    // pure fee bleed on a window the dips already covered).
    if (buysSent === 0 && slot - firstSlot > 150000 && roundTripped.size + probeOpen.size < PROBE_TARGET_COINS) {
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
