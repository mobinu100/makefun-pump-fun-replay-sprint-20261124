// Pump.fun Replay Sprint — paper bot entry.
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and
// the protocol shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for
// byte in vendor/. See strategy.ts for the full idea: patient momentum
// entries (hello, then one batch per slot, orders back each batch), tight
// exits, and a small probe sleeve for the 20-coin guardrail.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

await runBot(createStrategy());
