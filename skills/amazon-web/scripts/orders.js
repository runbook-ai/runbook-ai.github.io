// Amazon product search, order history, date-range filtering, and receipt helpers.
// Runs on any www.amazon.com tab.

function cleanClone(node) {
  const clone = node.cloneNode(true);
  clone.querySelectorAll('script, style, noscript, svg').forEach(el => el.remove());
  return clone;
}

function cleanParsedDoc(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, noscript, svg').forEach(el => el.remove());
  return doc;
}

function assertSignedIn(doc, url) {
  const title = (doc.title || '').toLowerCase();
  if (title.includes('sign-in') || title.includes('sign in') || doc.querySelector('form[name="signIn"]')) {
    throw new Error(`GET ${url} redirected to Amazon Sign-In -- is this tab logged in to www.amazon.com?`);
  }
}

function parseDateMs(input) {
  if (!input) return null;
  const s = String(input).trim();
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])).getTime();
  }
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) {
    return new Date(Number(us[3]), Number(us[1]) - 1, Number(us[2])).getTime();
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function inDateRange(dateStr, startMs, endMs) {
  if (startMs === null && endMs === null) return true;
  const ms = parseDateMs(dateStr);
  if (ms === null) return false;
  if (startMs !== null && ms < startMs) return false;
  if (endMs !== null && ms > endMs) return false;
  return true;
}

function estimateDeliveryDays(deliveryText) {
  if (!deliveryText) return null;
  const s = deliveryText.toLowerCase();
  if (/\b(overnight|today)\b/.test(s)) return 0;
  if (/\btomorrow\b/.test(s)) return 1;
  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const m = deliveryText.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})\b/i);
  if (m) {
    let candidate = new Date(`${m[1]} ${m[2]}, ${now.getFullYear()}`);
    if (candidate.getTime() < todayMidnight - 30 * 86400000) {
      candidate = new Date(`${m[1]} ${m[2]}, ${now.getFullYear() + 1}`);
    }
    return Math.max(0, Math.round((candidate.getTime() - todayMidnight) / 86400000));
  }
  return null;
}

/** Search Amazon products on /s?k= with optional price, rating, and delivery speed filters. -> {query, page, count, products: [{asin, title, price, priceNum, rating, reviewCount, delivery, deliveryDays, prime, sponsored, url}]} */
async function searchProducts({ query, page = 1, minPrice = null, maxPrice = null, minRating = null, maxDeliveryDays = null, excludeSponsored = false } = {}) {
  if (!query) throw new Error('searchProducts requires { query }');
  const url = `https://www.amazon.com/s?k=${encodeURIComponent(query)}&page=${page}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  const doc = cleanParsedDoc(await res.text());

  const products = [];
  const seen = new Set();
  const cards = doc.querySelectorAll('[data-component-type="s-search-result"][data-asin]');
  for (const card of cards) {
    const asin = (card.getAttribute('data-asin') || '').trim();
    if (!asin || seen.has(asin)) continue;
    seen.add(asin);

    const h2Parts = [...card.querySelectorAll('h2')]
      .map(h => h.textContent.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const title = h2Parts.join(' - ');
    if (!title) continue;

    const text = card.textContent.replace(/\s+/g, ' ').trim();
    const ariaLabels = [...card.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label') || '');

    const priceStr =
      card.querySelector('.a-price:not([data-a-strike]) .a-offscreen')?.textContent?.trim() ||
      (text.match(/Price,\s*product page\s*(\$[0-9,]+\.\d{2})/i) || [])[1] ||
      (text.match(/(\$[0-9,]+\.\d{2})/) || [])[1] ||
      null;
    const priceNum = priceStr ? parseFloat(priceStr.replace(/[^0-9.]/g, '')) : null;

    const ratingLabel = ariaLabels.find(l => /out of 5 stars/i.test(l)) || '';
    const ratingMatch = ratingLabel.match(/(\d+(?:\.\d+)?)\s*out of 5 stars/i) || text.match(/(\d\.\d)\s*out of 5 stars/i);
    const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

    const reviewLabel = ariaLabels.find(l => /^\d[\d,]*\s+ratings?$/i.test(l.trim())) || '';
    const reviewMatch =
      reviewLabel.match(/([\d,]+)\s+ratings?/i) ||
      text.match(/out of 5 stars\s*\(?([\d,]+)\)?/i);
    const reviewCount = reviewMatch ? Number(reviewMatch[1].replace(/,/g, '')) : null;

    const delivMatch = text.match(
      /((?:FREE|Fastest)\s+delivery\s+(?:Overnight(?:\s+\d+\s*[AP]M\s*-\s*\d+\s*[AP]M)?|Today(?:\s+\d+\s*[AP]M\s*-\s*\d+\s*[AP]M)?|Tomorrow(?:,\s*[A-Za-z]+\s+\d{1,2})?|[A-Za-z]+,\s*[A-Za-z]+\s+\d{1,2}|[A-Za-z]+\s+\d{1,2}\s*-\s*\d{1,2}))/i
    );
    const delivery = delivMatch ? delivMatch[1].trim() : null;
    const deliveryDays = estimateDeliveryDays(delivery);

    const prime = ariaLabels.some(l => /^prime$/i.test(l.trim())) || /\bFREE delivery\b/i.test(delivery || '');
    const sponsored = ariaLabels.some(l => /sponsored/i.test(l)) || /^Sponsored/i.test(text);

    if (excludeSponsored && sponsored) continue;
    if (minPrice !== null && (priceNum === null || priceNum < minPrice)) continue;
    if (maxPrice !== null && (priceNum === null || priceNum > maxPrice)) continue;
    if (minRating !== null && (rating === null || rating < minRating)) continue;
    if (maxDeliveryDays !== null && (deliveryDays === null || deliveryDays > maxDeliveryDays)) continue;

    products.push({
      asin,
      title,
      price: priceStr,
      priceNum,
      rating,
      reviewCount,
      delivery,
      deliveryDays,
      prime,
      sponsored,
      url: `https://www.amazon.com/dp/${asin}`,
    });
  }

  return { query, page, count: products.length, products };
}

function extractItems(root) {
  const items = [];
  const seen = new Set();
  for (const a of root.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]')) {
    const title = a.textContent.replace(/\s+/g, ' ').trim();
    if (!title || /^(view your item|buy it again|write a product review)$/i.test(title)) continue;
    const href = a.getAttribute('href') || a.href || '';
    const m = href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    const asin = m ? m[1] : null;
    const key = asin || title;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      title,
      asin,
      url: asin ? `https://www.amazon.com/dp/${asin}` : new URL(href, 'https://www.amazon.com').href,
    });
  }
  return items;
}

function parseOrderCardsFromDoc(doc) {
  const orders = [];
  const seen = new Set();
  const cards = doc.querySelectorAll('.order-card, .js-order-card');
  for (const rawCard of cards) {
    const card = cleanClone(rawCard);
    const slotId = rawCard.getAttribute('data-csa-c-slot-id') || '';
    const slotMatch = slotId.match(/([0-9]{3}-[0-9]{7}-[0-9]{7})/);
    let orderId = slotMatch ? slotMatch[1] : null;
    if (!orderId) {
      for (const a of card.querySelectorAll('a[href*="orderID="]')) {
        const href = a.getAttribute('href') || a.href || '';
        const m = href.match(/orderID=([0-9]{3}-[0-9]{7}-[0-9]{7})/);
        if (m) {
          orderId = m[1];
          break;
        }
      }
    }
    if (!orderId || seen.has(orderId)) continue;
    seen.add(orderId);

    const text = card.textContent.replace(/\s+/g, ' ').trim();
    const dateMatch =
      text.match(/Order placed\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})/i) ||
      text.match(/Ordered on\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})/i) ||
      text.match(/([A-Za-z]+\s+\d{1,2},\s+\d{4})/);
    const totalMatch =
      text.match(/Total\s*(\$[0-9,]+\.\d{2})/i) ||
      text.match(/(\$[0-9,]+\.\d{2})/);
    const statusMatch = text.match(
      /(Delivered\s+[A-Za-z]+(?:\s+\d{1,2})?|Arriving\s+(?:tomorrow|today|[A-Za-z]+(?:\s+\d{1,2})?)|Shipped|Ordered|Refunded|Cancelled)/i
    );

    orders.push({
      orderId,
      date: dateMatch ? dateMatch[1] : null,
      total: totalMatch ? totalMatch[1] : null,
      status: statusMatch ? statusMatch[1].trim() : null,
      items: extractItems(card),
      detailsUrl: `https://www.amazon.com/your-orders/order-details?orderID=${orderId}`,
      invoiceUrl: `https://www.amazon.com/gp/css/summary/print.html?orderID=${orderId}`,
    });
  }
  return orders;
}

function loadHydratedDocViaIframe(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;';
    let done = false;
    const cleanup = () => {
      done = true;
      try { iframe.remove(); } catch {}
    };
    const timer = setTimeout(() => {
      if (done) return;
      const doc = iframe.contentDocument;
      const cloned = doc && doc.documentElement ? doc.documentElement.cloneNode(true) : null;
      cleanup();
      if (cloned) resolve(cloned);
      else reject(new Error(`Timed out loading ${url}`));
    }, timeoutMs);

    iframe.onload = async () => {
      try {
        const doc = iframe.contentDocument;
        if (!doc || !doc.location || doc.location.href === 'about:blank') return;
        const start = Date.now();
        while (Date.now() - start < 5000) {
          if (doc.querySelectorAll('.order-card a[href*="orderID="], a[href*="/dp/"]').length > 0) break;
          await new Promise(r => setTimeout(r, 150));
        }
        clearTimeout(timer);
        const cloned = doc.documentElement.cloneNode(true);
        cleanup();
        resolve(cloned);
      } catch (err) {
        clearTimeout(timer);
        cleanup();
        reject(err);
      }
    };
    document.body.appendChild(iframe);
    iframe.src = url;
  });
}

async function fetchOrdersSinglePage(filter, page) {
  const params = new URLSearchParams(location.search);
  const currentFilter = params.get('timeFilter') || params.get('orderFilter') || 'months-3';
  const currentStartIndex = Number(params.get('startIndex') || 0);
  const currentPage = params.has('page') ? Number(params.get('page')) : Math.floor(currentStartIndex / 10);
  const onOrdersPage = /\/(your-orders\/orders|gp\/your-account\/order-history|gp\/css\/order-history)/.test(location.pathname);

  if (onOrdersPage && currentFilter === filter && currentPage === page) {
    const liveOrders = parseOrderCardsFromDoc(document);
    if (liveOrders.length > 0 && liveOrders.some(o => o.items.length > 0 || o.total)) {
      return liveOrders;
    }
  }

  const startIndex = page * 10;
  const query = page > 0
    ? `timeFilter=${encodeURIComponent(filter)}&startIndex=${startIndex}`
    : `timeFilter=${encodeURIComponent(filter)}`;
  const url = `https://www.amazon.com/your-orders/orders?${query}`;
  const hydratedRoot = await loadHydratedDocViaIframe(url);
  return parseOrderCardsFromDoc(hydratedRoot);
}

/** List Amazon orders by preset filter ('months-3', 'last30', 'year-YYYY', 'open', 'digital') or inclusive {startDate, endDate} range ('YYYY-MM-DD'). -> {filter, page, startDate, endDate, count, orders: [{orderId, date, total, status, items, detailsUrl, invoiceUrl}]} */
async function getOrders({ filter, page = 0, startDate = null, endDate = null, maxPages = 5 } = {}) {
  const startMs = parseDateMs(startDate);
  const endMs = parseDateMs(endDate);

  if (startMs === null && endMs === null) {
    const activeFilter = filter || 'months-3';
    const orders = await fetchOrdersSinglePage(activeFilter, page);
    return { filter: activeFilter, page, startDate: null, endDate: null, count: orders.length, orders };
  }

  const matched = [];
  const seen = new Set();

  if (!filter && page === 0) {
    const liveOrders = parseOrderCardsFromDoc(document);
    if (liveOrders.length > 0) {
      let oldestLiveMs = null;
      for (const o of liveOrders) {
        const ms = parseDateMs(o.date);
        if (ms !== null && (oldestLiveMs === null || ms < oldestLiveMs)) {
          oldestLiveMs = ms;
        }
        if (inDateRange(o.date, startMs, endMs) && !seen.has(o.orderId)) {
          seen.add(o.orderId);
          matched.push(o);
        }
      }
      if (startMs !== null && oldestLiveMs !== null && oldestLiveMs <= startMs) {
        return {
          filter: 'live',
          page: 0,
          startDate,
          endDate,
          count: matched.length,
          orders: matched,
        };
      }
    }
  }

  let filtersToScan = [];
  if (filter) {
    filtersToScan = [filter];
  } else {
    const nowYear = new Date().getFullYear();
    const sYear = startMs !== null ? new Date(startMs).getFullYear() : nowYear;
    const eYear = endMs !== null ? new Date(endMs).getFullYear() : nowYear;
    for (let y = eYear; y >= sYear; y--) {
      filtersToScan.push(`year-${y}`);
    }
  }

  for (const f of filtersToScan) {
    for (let p = page; p < page + maxPages; p++) {
      const pageOrders = await fetchOrdersSinglePage(f, p);
      if (pageOrders.length === 0) break;

      let reachedOlderThanStart = false;
      for (const o of pageOrders) {
        if (seen.has(o.orderId)) continue;
        const ms = parseDateMs(o.date);
        if (startMs !== null && ms !== null && ms < startMs) {
          reachedOlderThanStart = true;
          continue;
        }
        if (inDateRange(o.date, startMs, endMs)) {
          seen.add(o.orderId);
          matched.push(o);
        }
      }
      if (reachedOlderThanStart || pageOrders.length < 10) break;
    }
  }

  return {
    filter: filtersToScan.join(','),
    page,
    startDate,
    endDate,
    count: matched.length,
    orders: matched,
  };
}

async function fetchSearchSinglePage(query, page) {
  const url = `https://www.amazon.com/your-orders/search?search=${encodeURIComponent(query)}&page=${page}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  const doc = cleanParsedDoc(await res.text());
  assertSignedIn(doc, url);

  const byOrder = new Map();
  for (const a of doc.querySelectorAll('a[href*="orderID="]')) {
    const href = a.getAttribute('href') || a.href || '';
    const m = href.match(/orderID=([0-9]{3}-[0-9]{7}-[0-9]{7})/);
    if (!m) continue;
    const orderId = m[1];
    const row =
      a.closest('.a-section, .a-box-group, .order-card, .js-order-card') ||
      a.parentElement?.parentElement?.parentElement ||
      doc.body;
    const text = row.textContent.replace(/\s+/g, ' ').trim();
    const dateMatch =
      text.match(/Ordered on\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i) ||
      text.match(/Order placed\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);

    if (!byOrder.has(orderId)) {
      byOrder.set(orderId, {
        orderId,
        date: dateMatch ? dateMatch[1] : null,
        items: [],
        detailsUrl: `https://www.amazon.com/your-orders/order-details?orderID=${orderId}`,
        invoiceUrl: `https://www.amazon.com/gp/css/summary/print.html?orderID=${orderId}`,
      });
    }
    const entry = byOrder.get(orderId);
    if (!entry.date && dateMatch) entry.date = dateMatch[1];
    for (const item of extractItems(row)) {
      if (!entry.items.some(x => (x.asin && x.asin === item.asin) || x.title === item.title)) {
        entry.items.push(item);
      }
    }
  }
  return [...byOrder.values()];
}

/** Search Amazon orders by keyword query with optional inclusive {startDate, endDate} range ('YYYY-MM-DD'). -> {query, page, startDate, endDate, count, orders: [{orderId, date, items, detailsUrl, invoiceUrl}]} */
async function searchOrders({ query, page = 0, startDate = null, endDate = null, maxPages = 3 } = {}) {
  if (!query) throw new Error('searchOrders requires { query }');
  const startMs = parseDateMs(startDate);
  const endMs = parseDateMs(endDate);

  if (startMs === null && endMs === null) {
    const orders = await fetchSearchSinglePage(query, page);
    return { query, page, startDate: null, endDate: null, count: orders.length, orders };
  }

  const matched = [];
  const seen = new Set();
  for (let p = page; p < page + maxPages; p++) {
    const pageOrders = await fetchSearchSinglePage(query, p);
    if (pageOrders.length === 0) break;

    let reachedOlderThanStart = false;
    for (const o of pageOrders) {
      if (seen.has(o.orderId)) continue;
      const ms = parseDateMs(o.date);
      if (startMs !== null && ms !== null && ms < startMs) {
        reachedOlderThanStart = true;
        continue;
      }
      if (inDateRange(o.date, startMs, endMs)) {
        seen.add(o.orderId);
        matched.push(o);
      }
    }
    if (reachedOlderThanStart || pageOrders.length < 10) break;
  }

  return {
    query,
    page,
    startDate,
    endDate,
    count: matched.length,
    orders: matched,
  };
}

/** Fetch printable receipt/details for a single orderId. -> {orderId, date, total, items, detailsUrl, invoiceUrl, summaryText} */
async function getOrderDetails({ orderId } = {}) {
  if (!orderId) throw new Error('getOrderDetails requires { orderId }');
  const invoiceUrl = `https://www.amazon.com/gp/css/summary/print.html?orderID=${encodeURIComponent(orderId)}`;
  const detailsUrl = `https://www.amazon.com/your-orders/order-details?orderID=${encodeURIComponent(orderId)}`;
  const root = await loadHydratedDocViaIframe(invoiceUrl, 6000);
  const cleaned = cleanClone(root);
  const text = cleaned.textContent.replace(/\s+/g, ' ').trim();

  const dateMatch =
    text.match(/Order Placed:\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})/i) ||
    text.match(/Order placed\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})/i) ||
    text.match(/Ordered on\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
  const totalMatch =
    text.match(/Grand Total:\s*(\$[0-9,]+\.\d{2})/i) ||
    text.match(/Order Total:\s*(\$[0-9,]+\.\d{2})/i) ||
    text.match(/Total for this Order:\s*(\$[0-9,]+\.\d{2})/i) ||
    text.match(/Total\s*(\$[0-9,]+\.\d{2})/i);

  return {
    orderId,
    date: dateMatch ? dateMatch[1] : null,
    total: totalMatch ? totalMatch[1] : null,
    items: extractItems(cleaned),
    detailsUrl,
    invoiceUrl,
    summaryText: text.slice(0, 2500),
  };
}
