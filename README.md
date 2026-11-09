# CX demo

A demo of Creator Exchange (CX), a play-money stock exchange where every creator is a company. Fans buy shares at the IPO, trade them on an order book and get part of the profit every quarter.

Try it: https://thejungjulian-del.github.io/cx/

## How the demo works

The real CX runs on a small Node server. This copy has no server. `demo-api.js` answers the pages' requests inside your browser, using the same exchange engine (`engine.js`) as the real app, and keeps your account, trades and the market in your browser's local storage. Nothing you type is sent anywhere. All money is play money, and "Reset demo" at the top of each page starts over.

The example creators and their prices are made up. CX Research and the channel valuer need the server, so this demo leaves them out. Nothing here is an offer of securities.

To run it locally, serve this folder (for example `python3 -m http.server 8000`) and open http://localhost:8000.

Made by Julian Jung. More projects: https://thejungjulian-del.github.io/portfolio/
