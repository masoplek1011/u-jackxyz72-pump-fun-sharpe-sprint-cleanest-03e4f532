[![Pump.fun Sharpe Sprint](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/masoplek1011/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/masoplek1011/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Cleanest Paper Bot — Pump.fun Sharpe Sprint

A deterministic, rule-based paper-trading bot for the
[Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
competition on [make.fun](https://make.fun). One program, `main.ts`, runs on
Node 22 with stdlib only. It trades paper money on a 6-hour pump.fun replay;
places go by hourly Sharpe ratio, not wildest PnL — so this bot aims for
steady small wins, short holds, and no moonshot chasing.

## How it works

The bot speaks the `agent-fun/replay/v2` protocol: it reads a `hello`, then
one `batch` per slot, and answers every batch with one `reply` echoing that
batch's `seq` and carrying that slot's `orders`. Every decision uses only
events already received in this run — no future-peeking. Prices are exact
`BigInt` rationals from virtual reserves
(`virtual_sol_reserves / virtual_token_reserves`); every comparison is done
by cross-multiplication, never floats. No clock, no randomness, no
environment, no network, no file I/O.

Most new pump.fun mints die in a single-slot dump, so the bot never buys the
pump itself. It watches the ratio `real_sol_reserves / virtual_sol_reserves`
and only enters after the move has proved it can hold:

- **Lane E45 (profit engine):** when the ratio first crosses **0.45**, wait
  **120 slots**, then enter only if the price held at **>= 95%** of the
  crossing price, buy volume was **>= 2x** sell volume over the wait, and at
  least **5 trades** happened since the crossing. Size **0.20 SOL**
  (capped at 90 bps of real reserves, under the 100 bps per-reply cap).
  Exit **+10% take-profit / -6% stop-loss / 600 slots** max hold.
- **Lane E20 (filler):** same confirmation after a **0.20** ratio crossing,
  size **0.05 SOL**, same exits. It spreads round trips over more distinct
  mints so the 20-mint guardrail stays in reach.

## Guards

- Max **5** open positions (from `hello`), at most one buy per mint per
  batch, at most 16 orders per batch.
- Per-mint cooldown after an exit: **120 slots** after a win, **600 slots**
  after a loss.
- Drawdown guard on marked equity: buy sizes halve past **20%** drawdown,
  no new buys past **35%** (exits only).
- **1 SOL** cash reserve is always kept.
- Buy slippage **300 bps**, sell slippage **500 bps** so exits execute.
- Orders resolve 2 slots after the batch they were decided on; buys are
  sized against decision-time real reserves.

## Dev-window results (kit grader, `grade-local --driver process`)

See the submission notes for the exact numbers from the local grading run.
On the dev window the E45 lane alone won 76.9% of its round trips; the
combined two-lane bot is tuned for a positive net PnL with low drawdown
rather than maximum PnL. No number in this README is a promise about the
final 6-hour window — the dev window is one small sample.

## Run locally

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot <this repo> --driver process
```

## License

MIT — see [LICENSE](LICENSE).
