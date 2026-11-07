// Demo app with a KNOWN BUG (see README.md in this folder).
// Run: node server.js  →  http://localhost:4000/checkout → HTTP 500 on POST /pay
// The bug: charge() reads cart.total but the cart object uses `amount`, so total is
// undefined and the (mock) payment gateway throws. The fix is one line: amount → total.
import { createServer } from "node:http";

const cart = { amount: 42, currency: "USD" }; // BUG: should be `total: 42`

function charge(c) {
  if (!c.total) throw new Error("cart total missing");
  return { id: `ch_${Math.random().toString(36).slice(2)}`, amount: c.total };
}

createServer((req, res) => {
  if (req.method === "GET" && req.url === "/checkout") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<h1>Checkout</h1><button onclick="fetch('/pay',{method:'POST'}).then(r=>r.text()).then(t=>document.body.innerHTML=t)">Pay now</button>`);
  } else if (req.method === "POST" && req.url === "/pay") {
    try {
      const c = charge(cart);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`paid ${c.amount} ${cart.currency} (${c.id})`);
    } catch {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("Internal Server Error: cart total missing");
    }
  } else {
    res.writeHead(404); res.end("not found");
  }
}).listen(4000, () => console.log("demo-app on http://localhost:4000/checkout"));
