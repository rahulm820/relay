# Demo app — known bug

Tiny checkout page whose **Pay now** button fails with HTTP 500. This is the
complaint the Relay demo is built around: a client messages the Telegram bot
"my checkout fails with 500 when I tap Pay now", Relay turns it into a P1 bug
ticket, syncs a GitHub issue, opens a Switch room, and (with code-aware on)
drafts a fix for human approval.

## Run

```bash
node server.js        # http://localhost:4000/checkout
# click Pay now (or: curl -X POST http://localhost:4000/pay) → 500 "cart total missing"
```

## The bug (exact)

`server.js`: `const cart = { amount: 42, ... }` but `charge()` reads
`cart.total`. `total` is `undefined`, so `charge` throws and the route returns
500. Fix: rename `amount` → `total` (one line).

## Demo complaint (copy/paste to the bot)

> Hi, my checkout fails with an error 500 when I tap Pay now. You can reach me
> at jane.doe@example.com
