---
name: amazon-web
description: Searching Amazon products (with price, ratings/reviews, and delivery speed filtering) and listing, filtering by date range, or searching Amazon order history and receipts on www.amazon.com.
license: MIT
metadata:
  runbookai:
    agent: worker
    sites: ["www.amazon.com", "*.amazon.com"]
    autoload: true
    tags: [site, shopping, amazon, products, orders, receipts]
    tested: 2026-11-15
---

## Searching Amazon products (`/s?k=`)

Amazon's product search endpoint (`GET https://www.amazon.com/s?k=<query>&page=<page>`) returns server-rendered `[data-component-type="s-search-result"][data-asin]` cards directly via `fetch()` + `DOMParser` from any `www.amazon.com` tab (delivering personalized Prime delivery dates when signed in):

- `await skills.amazonWeb.searchProducts({ query: '6s lipo battery', page: 1, maxDeliveryDays: 2 })`
  - `query`: product search string.
  - `page`: 1-based page number (`1`, `2`, ...).
  - Optional filters:
    - `minPrice`, `maxPrice`: numeric dollar bounds.
    - `minRating`: minimum star rating (e.g. `4.0`).
    - `maxDeliveryDays`: maximum days until delivery (`0` = Today/Overnight, `1` = Tomorrow, `2` = within 2 days, etc.).
    - `excludeSponsored`: `true` to exclude sponsored ads.
  - Returns `{ query, page, count, products: [{ asin, title, price, priceNum, rating, reviewCount, delivery, deliveryDays, prime, sponsored, url }] }`.
  - Example ("find 6S battery over 4000mAh with delivery in 2 days"):
    Call `await skills.amazonWeb.searchProducts({ query: '6S lipo battery', maxDeliveryDays: 2 })` and filter `products` in JS for capacity `> 4000` mAh in `p.title` (e.g. `/(\d{4,5})\s*mAh/i`).

## Listing orders by preset filter or date range (`/your-orders/orders`)

From any signed-in `www.amazon.com` tab, call `skills.amazonWeb.getOrders`:

- **Single page by preset filter**:
  `await skills.amazonWeb.getOrders({ filter: 'months-3', page: 0 })`
  - `filter`: `'months-3'` (default, past 3 months), `'last30'`, `'year-YYYY'` (e.g. `'year-2026'`), `'open'`, or `'digital'`.
  - `page`: 0-based page index (`0`, `1`, `2`, ...; 10 orders per page via `startIndex = page * 10`).

- **Filter by date range (`startDate` / `endDate`)**:
  `await skills.amazonWeb.getOrders({ startDate: '2026-05-01', endDate: '2026-06-30', maxPages: 5 })`
  - `startDate`, `endDate`: inclusive date strings (`'YYYY-MM-DD'`, `'MM/DD/YYYY'`, or `'Month DD, YYYY'`). Either bound may be omitted.
  - Automatically selects the matching `year-YYYY` filter(s) when `filter` is omitted, paginates newest-first up to `maxPages` per filter, stops early once orders are older than `startDate`, and returns only orders within `[startDate, endDate]`.
  - Returns `{ filter, page, startDate, endDate, count, orders: [{ orderId, date, total, status, items: [{ title, asin, url }], detailsUrl, invoiceUrl }] }`.

## Searching orders by keyword and optional date range (`/your-orders/search`)

Amazon's order keyword search endpoint (`GET https://www.amazon.com/your-orders/search?search=<query>&page=<page>`) returns server-rendered HTML without Siege CSD encryption, so it can be fetched directly with `fetch()` + `DOMParser` from any `www.amazon.com` tab:

- `await skills.amazonWeb.searchOrders({ query: '6S Lipo Battery', startDate: '2026-05-01', endDate: '2026-09-15' })`
  - `query`: keyword string to search.
  - `startDate`, `endDate`: optional inclusive date bounds (`'YYYY-MM-DD'`, `'MM/DD/YYYY'`, or `'Month DD, YYYY'`). When provided, paginates up to `maxPages` (default `3`), stops early once results are older than `startDate`, and filters results to `[startDate, endDate]`.
  - Returns `{ query, page, startDate, endDate, count, orders: [{ orderId, date, items: [{ title, asin, url }], detailsUrl, invoiceUrl }] }`.

## Reading a single order's details / receipt

- `await skills.amazonWeb.getOrderDetails({ orderId: '111-1234567-1234567' })`
  - Loads `/gp/css/summary/print.html?orderID=<orderId>` (or `/your-orders/order-details?orderID=<orderId>`) and extracts `{ orderId, date, total, items, detailsUrl, invoiceUrl, summaryText }`.

## What does NOT work

- **`fetch('/your-orders/orders')` + `DOMParser` for full order details**: Amazon wraps each `.order-card`'s inner HTML in client-side `Siege:Csd` decryption scripts. In an inert `DOMParser` document those scripts do not run, so `querySelectorAll('a[href*="orderID="]')` returns `0` matches (only the outer `<div class="order-card" data-csa-c-slot-id="amzn1.yourorders.order-card.<ORDER_ID>">` shell exists in raw HTML). Always read `/your-orders/orders` from the live `document` or let `skills.amazonWeb.getOrders` hydrate it via a hidden same-origin iframe.
- **Reading `doc.body.innerText` / `textContent` without stripping `<script>` and `<style>`**: Amazon embeds 100+ KB of inline `csa`/`uex`/`Siege` scripts inside `<body class="a-m-us">`. Always remove `script, style, noscript, svg` on cloned nodes before reading text.
