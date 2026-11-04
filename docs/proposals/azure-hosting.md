# Request: Azure hosting for the COD website

This request is for an Azure Static Web App to host the site at
`cod.unocha.org`, a private storage account for the open geodata it shows, and
an Azure Front Door Standard profile that serves that geodata to visitors, all
in an OCHA Azure subscription.

## What the app is

The site covers Common Operational Datasets (CODs). It has guidance, standards,
a status dashboard and tools for cleaning and checking the data. Everything
runs in the user's browser: there is no server, database, user account or
personal data, and files that users load into the tools stay on their machine.

Maps and examples read open geodata that anyone may view and download. Visitors
get it through Front Door, so the storage account never allows anonymous access
or account keys.

## 1. Static Web App

| Item          | Request                                                                                                                    | Why                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Plan          | Standard                                                                                                                   | Comes with an SLA. The site (about 100 MB) fits well within the 500 MB limit.        |
| Custom domain | `cod.unocha.org`, which currently redirects to the COD Global Information Dashboard page on Confluence, pointed to the app | A stable OCHA address                                                                |
| Deployment    | The app's deployment token, stored as a GitHub secret                                                                      | The site publishes from GitHub automatically, so nobody needs an Azure role to do it |
| Previews      | Preview environments (included in Standard)                                                                                | Changes can be checked on a preview link before they go live                         |

## 2. Private storage account for geodata

| Item             | Request                                                                                                                                       | Why                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Account          | A dedicated account in West Europe, Hot tier, LRS, holding only the site's geodata (about 40 GB today, planned at 100 GB to allow for growth) | Turning off account keys and adding CORS apply to the whole account, so other apps aren't affected                           |
| Anonymous access | Off on the account and the container. Every read is authenticated through Entra ID                                                            | Meets the tenant policy against anonymous blob access                                                                        |
| Account keys     | "Allow storage account key access" off                                                                                                        | Every upload is tied to a named Entra identity                                                                               |
| CORS             | Allow GET and HEAD from any origin (`*`), including the `Range` header and exposing `Content-Range`, `Content-Length` and `ETag`              | Browsers read only the parts of large files they need, and the same cached response works on the live site and preview links |
| Upload           | Storage Blob Data Contributor on that container only, for two named maintainers, PIM-eligible if the tenant uses PIM                          | Maintainers can add, replace and remove geodata but can't change settings                                                    |

## 3. Front Door Standard

| Item        | Request                                                                                                                                                                          | Why                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Profile     | One Front Door Standard profile and endpoint on `data.cod.unocha.org`, with the storage account's blob endpoint as its origin (no Private Link)                                  | Visitors' browsers load the geodata without signing in, while the storage stays private |
| Read access | A system-assigned managed identity for origin authentication, with Storage Blob Data Reader on that container only (granted before the identity is attached to the origin group) | Front Door can only read that container                                                 |
| Caching     | On, with a cache duration of 1 hour                                                                                                                                              | Repeat reads come from Front Door's cache, and replaced files show up within an hour    |
| Rate limit  | A WAF custom rule that limits requests per IP address                                                                                                                            | Slows scrapers and misconfigured bots                                                   |

The request does not include Owner or Contributor on the storage account, the
Front Door profile or the resource group, account keys, or the right to give
roles to others.

## How data gets updated

Maintainers upload new or changed geodata from their own machines with Azure's
command-line tools, signed in with their own Azure accounts, so their upload
credentials aren't stored anywhere.

## Cost

West Europe and Front Door Zone 1 (Europe and North America) list prices from
the Azure Retail Prices API, November 2026:

| Item                            | Price                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| Static Web App, Standard        | $9 a month, with 100 GB of bandwidth a month per subscription included, then $0.20 per GB |
| Front Door Standard             | $35 a month, including WAF custom rules                                                   |
| Front Door data to visitors     | $0.083 per GB for the first 10 TB a month                                                 |
| Front Door requests             | $0.009 per 10,000 requests                                                                |
| Storage                         | About $2 a month for 100 GB, at $0.0196 per GB                                            |
| Data from storage to Front Door | Free                                                                                      |

The fixed cost is about $46 a month, and bandwidth and data transfer add to it
as traffic grows. The scenarios assume about 15 MB of site bandwidth, 10 MB of
geodata and 200 geodata requests per visit, rounded up:

| Scenario   | Traffic in a month                                                      | Monthly    | Yearly                             |
| ---------- | ----------------------------------------------------------------------- | ---------- | ---------------------------------- |
| Average    | About 1,000 visits                                                      | $50        | $600                               |
| Busy       | About 10,000 visits (150 GB site, 100 GB geodata)                       | $70 to $90 | $840 to $1,080                     |
| Worst case | A misconfigured bot downloading all 40 GB of geodata every day (1.2 TB) | About $150 | About $1,800 if it lasted all year |

The busy range depends on whether other apps in the subscription already use
the Static Web App's free 100 GB allowance. An Azure budget alert at $100 a
month would catch unusual traffic early.
