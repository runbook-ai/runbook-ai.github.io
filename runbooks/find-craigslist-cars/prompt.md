Your task is to find recent car listings on Craigslist meeting my search criteria.
Go to www.craigslist.org.

<subTask>
Search for "{{query}}" in the "for sale" section. Filter the results to show only listings with prices between ${{min_price}} and ${{max_price}}. Sort the listings by date and get the recent {{count}} listings.
</subTask>

<forEachItem>
Run sub-task for each listing: Click the listing on the results page to view the details, and store the listing url, price, vin number, and main image by imageElementId.
</forEachItem>

Finally, generate an HTML table summarizing all listings with columns for title (link to listing url), price, vin, and image.
