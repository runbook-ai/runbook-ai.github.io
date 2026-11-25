You are my price-drop watcher for "{{product}}". My target price is ${{target_price}}. Each run, compare prices, alert me if the price is at or below the target, and otherwise keep watching.

## 1. Compare prices
<forEachItem>
For each store in this list: {{stores}} -- go to the store's website, search for "{{product}}" and open the best-matching result: the exact product, new condition, sold by the store or a reputable seller. Skip refurbished, used and renewed items, accessories, and bundles that add extra items (a stand, case, adapter, gift card) -- the price must be for the product alone. Record: store, product title as listed, current price in USD (what I'd pay before tax; note any sale or coupon), shipping cost if shown, in stock (yes/no), and the product page URL. If the store blocks automation, shows a captcha, or has no matching product, record it as unavailable with the reason -- never guess a price.
</forEachItem>

Save the results with write_file to "prices.json" as a JSON array of objects with keys: store, title, price, shipping, in_stock, url, note, checked_at. Also append this run's prices to "price-history.json" (array of {checked_at, store, price}) so later runs can show the trend.

## 2. Alert if the price dropped
Find the lowest in-stock price in prices.json. If it is at or below ${{target_price}}, send the alert yourself in this run -- do not start a separate task for it:
1. In Gmail, compose and send a new email to {{email}} with the subject "Price drop: {{product}} is $<lowest price> at <store> (checked <today's date and time>)" and a short body: the lowest price and store with its product link, then one line per store with its price.
2. Then open Gmail's "Sent" folder and check that the email you just sent -- with exactly that subject, including the check time -- is there.

Say the alert was sent only after you have seen it in Sent; if you could not confirm it, report the alert as failed with the reason. If no in-stock price is at or below ${{target_price}}, send nothing.

## 3. Keep watching
If an alert was sent this run, stop here: do NOT schedule any more runs (and if this task is already recurring, end it now).
Only if no alert was sent: make this task recurring -- run again every {{check_every_hours}} hours, at most 30 runs, ending once an alert has been sent. Each later run repeats steps 1 and 2 and compares with price-history.json.

Finally -- always, including when an alert was sent -- return an HTML table (as an HTML result, not plain text) with columns Store, Price, Shipping, In stock and Product (title linked to the product page), followed by one line comparing the lowest price with the ${{target_price}} target, and one status line: either "Alert emailed to {{email}}; watching stopped." or "No alert yet; next check in {{check_every_hours}} hours." (or "Alert failed: <reason>" if sending failed).
