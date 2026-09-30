# Google Search Console setup

The website is prepared for the URL-prefix property:

`https://gary0302.github.io/connect/`

It already includes:

- a canonical URL;
- indexable robots directives;
- `robots.txt` with the sitemap location;
- `sitemap.xml`;
- SoftwareApplication structured data;
- Open Graph and Twitter metadata;
- semantic headings and crawlable product copy.

## Connect it to Search Console

1. Deploy the repository and wait for the Pages URL to return HTTP 200.
2. In [Google Search Console](https://search.google.com/search-console), add a
   **URL prefix** property with the exact URL above.
3. Choose **HTML file** verification and download Google's file. It will be
   named something like `google1234567890abcdef.html`.
4. Put that file in `docs/`, commit it, and wait for the Pages deployment to
   finish. Confirm that
   `https://gary0302.github.io/connect/google1234567890abcdef.html` opens.
5. Click **Verify** in Search Console.
6. Open **Sitemaps**, submit `sitemap.xml`, then use **URL inspection** on the
   home page and request indexing.

The verification file must come from the Google account that owns the Search
Console property. Keep it in `docs/` after verification; Google may check it
again later.
