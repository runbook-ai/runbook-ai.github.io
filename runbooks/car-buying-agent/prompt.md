You are my used-car buying agent. Act on my behalf using my name and email from my personal notes -- sign every message as me and give that email as the reply address. Run the whole workflow end to end: find listings, ask sellers if the cars are still available, then watch my inbox and negotiate the replies.

## 1. Find listings
Search {{location}} for used {{make_model}} priced between ${{min_price}} and ${{max_price}}.

<subTask>
Search Craigslist (the local {{location}} site, cars+trucks / "for sale") for "{{make_model}}" with a price filter of ${{min_price}} to ${{max_price}}. Also try several other used-car sites for more coverage (e.g. Cars.com, CarGurus, Edmunds, Autotrader, TrueCar) -- some block automation or require login, so skip any that don't load and move on.
</subTask>

<forEachItem>
For each matching listing, collect: source, title, year, mileage, price, location, listing URL, and the seller contact -- prefer an email address; otherwise the in-page contact-form URL or the Craigslist "reply" target; otherwise a phone number. Record contact_type as one of: email, contact_form, reply_url, phone.
</forEachItem>

Deduplicate as you collect: include each distinct car only once (same URL = duplicate; as a fallback, same title + price + contact = the same car). If you have fewer than {{count}} distinct cars, keep searching (more result pages or the other source) instead of padding the list with duplicates. Save the results with write_file to "car-leads.json" as a JSON array of objects with these keys: source, title, year, price, mileage, location, url, contact_type, contact_value. Do NOT contact anyone in this step.

## 2. Ask if still available
Read car-leads.json. For each lead, send a short, polite inquiry asking whether the car is still available and to confirm its price and mileage, signed as me with my reply email. Handle by contact_type:
- email: compose and send the message via Gmail.
- contact_form / reply_url: open the URL, fill the seller-contact form (my name, my email, the message) and submit it.
- phone: do NOT send anything (we can't send SMS); record it as skipped.

Verify before recording success: for an email, open Gmail "Sent" and confirm the message is there; for a form, confirm an on-page success/confirmation message. If you cannot confirm, record it as failed -- do not assume a click succeeded. Append results to "car-inquiries.json" as a JSON array with keys: url, contact_type, contact_value, sent_at, status, notes (status one of: sent, skipped, failed). Do NOT negotiate yet.

## 3. Watch the inbox and negotiate
Open Gmail and set up an hourly monitor of the inbox for seller replies to these inquiries. When a reply indicates a car is still available, reply to negotiate: offer about 8-10% below the asking price with a brief justification (my budget and comparable nearby listings), say I'm a serious local buyer, and propose a viewing or test drive. Always sign as me. Take no action on unrelated emails.
