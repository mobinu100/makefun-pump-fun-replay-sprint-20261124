# makefun-pump-fun-replay-sprint-20261124

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/mobinu100/makefun-pump-fun-replay-sprint-20261124/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/mobinu100/makefun-pump-fun-replay-sprint-20261124/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper trading bot for the Pump.fun Replay Sprint on make.fun: it trades 10 SOL of paper money on a replay of recorded pump.fun bonding-curve activity, ranked by net PnL. Nothing is traded for real.

## Strategy

Patient momentum, tight exits, tiny stakes. A curve becomes a buy only once it proves itself: at least 0.5 SOL of net inflow over the last 40 slots, at least 3 buys from at least 4 distinct wallets, price up 5–120% inside the window and sitting within 10% of its window high, with no single buyer over 60% of the flow and the creator not sold. Stakes are 0.02 SOL first, one 0.02 SOL add into strength, at most 0.04 SOL per coin and 4 momentum positions open. Every position exits on +60% take-profit, −20% stop, a trailing stop once up 30%, faded flow, a single sell of 1 SOL or more, staleness, or a time limit. A small probe sleeve (0.02 SOL round trips on liquid curves) keeps the run above the 20-coin guardrail on quiet windows. Fully deterministic: every decision is a pure function of the hello and the batches, no clock, no randomness, no network.

## Run it

```sh
node main.ts
```

The grader runs `node /bot/main.ts` with this directory mounted at /bot. The protocol shim is the kit's `sdk/ts/makefun-bot.ts`, vendored byte for byte in `vendor/`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=8qvwkc7x&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
