# Cloudflare Worker: ASN Prefix Sync

This Cloudflare Worker synchronizes IP prefixes (IPv4/IPv6 CIDR) from a D1 database table (e.g., `AS14593`) to a Cloudflare Gateway list. It fetches prefixes associated with a specified Autonomous System Number (ASN), compares them with the current Gateway list, and updates the list using the Cloudflare API. The Worker is designed to handle large datasets (e.g., 1,400+ prefixes) efficiently with batch processing.

## Features

- **Database Integration**: Queries a D1 database to fetch active prefixes for a given ASN.
- **Cloudflare API**: Uses `PATCH` requests to append or remove prefixes from a Gateway list.
- **Batching**: Processes prefixes in batches (50 for API, 100 for database) to handle large datasets.
- **Error Handling**: Robust logging and error reporting for database and API operations.
- **Validation**: Ensures prefixes are valid CIDR formats and deduplicates entries.
- **Incremental Sync**: Supports filtering by last sync time (optional, currently disabled).

## Prerequisites

- **Cloudflare Account**: With access to Workers, D1, and Gateway.
- **Wrangler CLI**: For deploying the Worker (`npm install -g wrangler`).
- **D1 Database**: Containing tables:
  - `<ASN>` (e.g., `AS14593`): Columns `prefix` (TEXT), `active` (INTEGER), `last_seen_at` (TEXT).
  - `sync_state`: Columns `asn` (TEXT), `last_run` (TEXT).
  - `synced_prefixes`: Columns `asn` (TEXT), `prefix` (TEXT), with a `UNIQUE` constraint on `(asn, prefix)`.
- **Cloudflare API Credentials**: API key and email for Gateway list access.

## Setup

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/your-username/your-repo.git
   cd your-repo

Install Dependencies:
Ensure wrangler is installed:
bash

npm install -g wrangler

Configure Environment Variables:
Edit wrangler.toml or set variables in the Cloudflare dashboard:
toml

name = "asn-prefix-sync"
compatibility_date = "2025-05-23"

[[d1_databases]]
binding = "DB"
database_name = "your-d1-database"
database_id = "your-d1-database-id"

Add environment variables:
ACCOUNT_ID: Your Cloudflare account ID.

LIST_ID: The Gateway list ID.

API_EMAIL: Your Cloudflare API email.

API_KEY: Your Cloudflare API key.

Verify Database Schema:
Ensure the AS14593 table exists:
sql

CREATE TABLE AS14593 (
  prefix TEXT,
  active INTEGER,
  last_seen_at TEXT
);

Populate with prefixes (e.g., 1.1.1.0/24).

Create sync_state and synced_prefixes:
sql

CREATE TABLE sync_state (
  asn TEXT PRIMARY KEY,
  last_run TEXT
);
CREATE TABLE synced_prefixes (
  asn TEXT,
  prefix TEXT,
  PRIMARY KEY (asn, prefix)
);

Deploy the Worker:
Deploy using Wrangler:
bash

wrangler deploy

Usage
Invoke the Worker:
Send a GET request with the asn query parameter:

https://your-worker.workers.dev/?asn=AS14593

Response:
Sync complete (HTTP 200): Success.

Sync failed: <error> (HTTP 500): Failure, check logs.

Missing or invalid ?asn=ASxxxx parameter (HTTP 400): Invalid ASN.

Monitor Logs:
View logs in the Cloudflare dashboard or via Wrangler:
bash

wrangler tail

Key logs:
[DB] Fetched X prefixes from AS14593: Number of prefixes fetched.

[SYNC] AS14593: X desired, Y existing, Z to add, W to remove: Sync details.

[API] Processing X append batches, Y remove batches: API batch counts.

[DB] Inserted X prefixes in batch Y for AS14593: Database updates.

How It Works
Fetch Prefixes:
Queries the D1 database for active prefixes (active = 1) from the specified ASN table (e.g., AS14593).

Deduplicates and validates prefixes as CIDR formats.

Compare with Gateway List:
Fetches the current Gateway list via the Cloudflare API.

Computes prefixes to append (desired - existing) and remove (existing - desired).

Update Gateway List:
Sends PATCH requests in batches of 50 prefixes using { append: [...] } and { remove: [...] }.

Update Database:
Deletes existing entries for the ASN in synced_prefixes.

Inserts synced prefixes in batches of 100.

Records the sync timestamp in sync_state.

Troubleshooting
No Prefixes Fetched:
Check the AS14593 table:
sql

SELECT COUNT(*), active FROM AS14593 GROUP BY active;

If active is not 1, update:
sql

UPDATE AS14593 SET active = 1;

Verify table name:
sql

SELECT name FROM sqlite_master WHERE type='table' AND name='AS14593';

Gateway List Not Updated:
Check [PATCH RESPONSE TEXT] logs for API errors (e.g., 401, 429).

Verify LIST_ID:
bash

curl -X GET "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/gateway/lists" \
  -H "X-Auth-Email: $API_EMAIL" \
  -H "X-Auth-Key: $API_KEY" \
  -H "Content-Type: application/json"

Test a PATCH request:
bash

curl -X PATCH "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/gateway/lists/$LIST_ID" \
  -H "X-Auth-Email: $API_EMAIL" \
  -H "X-Auth-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"append":[{"value":"1.1.1.0/24"}]}'

Database Errors:
For UNIQUE constraint failed in synced_prefixes, ensure prefixes are deduplicated (handled by the code).

Check D1 binding in the Worker dashboard.

Performance Issues:
For large lists (>1,000 prefixes), ensure the Worker is on an Unbound plan to avoid CPU limits.

Adjust batch sizes in worker.js (batchSize for API, database).

Contributing
Contributions are welcome! Please:
Fork the repository.

Create a feature branch (git checkout -b feature/your-feature).

Commit changes (git commit -m "Add your feature").

Push to the branch (git push origin feature/your-feature).

Open a pull request.

License
This project is licensed under the MIT License. See the LICENSE file for details.
Acknowledgments
Built with Cloudflare Workers and D1.

Thanks to the xAI team for support via Grok.

