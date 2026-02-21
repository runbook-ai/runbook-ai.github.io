Your task is to find recent car listings on Craigslist meeting my search criteria.

<subTask>
Go to www.craigslist.org, and search for "Honda Civic" in the "for sale" section. Filter the results to show only listings with prices between $8000 and $10000. Sort the listings by date and get the last 3 days' results. Cap at 5 listings.
</subTask>

<forEachItem>
Run sub-task for each listing: Click the listing on the results page to view the details, and store the listing url, price, vin number, and image by imageElementId.
</forEachItem>

Finally, generate an HTML table summarizing all listings with columns for title (link to listing url), price, vin, and image (link to image url).