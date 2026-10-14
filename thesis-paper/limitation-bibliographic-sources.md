# Limitation: Bibliographic Sources and Journal Indexing

*Companion note to Chapter III, "Limitations of the Method", item 9.*

## Statement

Re:Search searches the open scholarly web only. Its web-search and PDF-discovery features use **OpenAlex, Crossref, arXiv, DOAJ, Semantic Scholar and Unpaywall** (the backend calls the first three plus DOAJ for search; Semantic Scholar and Unpaywall serve PDF discovery). It does **not** query **Scopus** or **Web of Science**, because both need credentials and a licence. As a result:

- the system cannot restrict results to Scopus- or Web of Science-indexed journals;
- coverage of paywalled literature that only the licensed indexes expose is partial;
- OpenAlex and Crossref cannot say whether a journal is indexed in Scopus or Web of Science, so that status cannot be inferred from them either. OpenAlex can say whether a journal is in DOAJ.

## Source options considered

| Source | Access | Notes |
|---|---|---|
| DOAJ | Free, public API, no key | Searches articles and journals in vetted open-access journals. Easy to add, and good for a "reputable open-access" filter. |
| Scopus (Elsevier) | Free API key from the Elsevier developer portal | Rate-limited and tied to terms of use. Full abstracts and some fields usually need an institutional token, so the university's access matters. |
| Web of Science | Paid Clarivate subscription | The Starter API has a small free tier with limited fields. Real use needs an institutional licence. |
| Europe PMC / PubMed | Free | Strong for biomedicine. Europe PMC also links full text. |
| CORE | Free key | Large open-access full-text aggregator. Useful for finding PDFs. |
| DBLP | Free | Computer-science bibliographies. |

## Reputability filtering without a licence

For a "reputable journals only" filter the options are DOAJ membership, journal quartiles from SCImago (a free downloadable list, not an API), or a check against the Scopus source list, which Scopus publishes as a free spreadsheet.

## Future work

1. Add Scopus search if the institution provides an API key or institutional token.
2. Add the SCImago quartile list as a reputability badge on results.
3. Add Europe PMC, CORE and DBLP as further open sources where the subject area calls for them.
