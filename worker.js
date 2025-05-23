export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const asn = url.searchParams.get("asn");
      if (!asn || !/^AS\d+$/.test(asn)) {
        return new Response("Missing or invalid ?asn=ASxxxx parameter", { status: 400 });
      }

      await syncASN(env, asn);
      return new Response("Sync complete", { status: 200 });
    } catch (err) {
      console.error("[ERROR]", err);
      return new Response(`Sync failed: ${err.message}`, { status: 500 });
    }
  },
};

async function syncASN(env, asn) {
  // Validate ASN format
  if (!/^AS\d+$/.test(asn)) {
    throw new Error("Invalid ASN format");
  }
  const table = asn; // Try asn.toUpperCase() or asn.toLowerCase() if case sensitivity is an issue

  // Verify database and environment variables
  if (!env.DB) throw new Error("Database not initialized");
  if (!env.ACCOUNT_ID || !env.LIST_ID || !env.API_EMAIL || !env.API_KEY) {
    throw new Error("Missing Cloudflare API credentials");
  }
  console.log(`[CONFIG] Using LIST_ID: ${env.LIST_ID}, ACCOUNT_ID: ${env.ACCOUNT_ID}`);

  // Retrieve last sync time
  const lastRunRow = await env.DB.prepare(`SELECT last_run FROM sync_state WHERE asn = ?`).bind(asn).first();
  const lastRun = lastRunRow?.last_run;
  console.log(`[DB] Last sync time for ${asn}: ${lastRun || "none"}`);

  // Fetch desired and existing prefixes
  const desired = await fetchDesiredPrefixes(env.DB, table);
  const existing = await fetchCurrentGatewayList(env);

  // Validate and deduplicate prefixes
  const validDesired = [...new Set(desired.filter(prefix => isValidCIDR(prefix)))];
  if (validDesired.length !== desired.length) {
    console.warn(`[WARN] Skipped ${desired.length - validDesired.length} invalid or duplicate prefixes`);
  }
  if (validDesired.length === 0 && desired.length > 0) {
    throw new Error("No valid prefixes after filtering; check prefix format");
  }

  // Log sample prefixes
  if (validDesired.length > 0) {
    console.log(`[DEBUG] Sample desired prefixes: ${validDesired.slice(0, 5).join(", ")}`);
  }

  // Compute prefixes to add/remove
  const desiredSet = new Set(validDesired);
  const existingSet = new Set(existing);
  const toAdd = validDesired.filter(prefix => !existingSet.has(prefix));
  const toRemove = existing.filter(prefix => !desiredSet.has(prefix));

  console.log(`[SYNC] ${asn}: ${validDesired.length} desired, ${existing.length} existing, ${toAdd.length} to add, ${toRemove.length} to remove`);

  // Log sample toAdd/toRemove prefixes
  if (toAdd.length > 0) console.log(`[DEBUG] Sample toAdd prefixes: ${toAdd.slice(0, 5).join(", ")}`);
  if (toRemove.length > 0) console.log(`[DEBUG] Sample toRemove prefixes: ${toRemove.slice(0, 5).join(", ")}`);

  // Update Gateway list in batches
  const batchSize = 50;
  await updateGatewayListBatched(env, toAdd, toRemove, batchSize);

  // Test API connectivity
  if (toAdd.length > 0) {
    console.log(`[TEST] Attempting to add single prefix to verify API`);
    await testGatewayListUpdate(env, toAdd[0]);
  } else {
    console.log(`[TEST] No prefixes to add, skipping test PATCH`);
  }

  // Update database with deduplicated prefixes
  await updateSyncedPrefixes(env.DB, table, validDesired);
  await recordSyncTime(env.DB, asn);

  console.log(`[SYNC] ${asn}: Completed (Added ${toAdd.length}, Removed ${toRemove.length})`);
}

// Basic CIDR validation (IPv4/IPv6)
function isValidCIDR(prefix) {
  try {
    const regex = /^(?:(?:[0-9]{1,3}\.){3}[0-9]{1,3}\/[0-9]{1,2}|(?:[0-9a-fA-F:]+)\/[0-9]{1,3})$/;
    return regex.test(prefix);
  } catch {
    return false;
  }
}

async function fetchDesiredPrefixes(DB, table) {
  try {
    const query = `SELECT prefix FROM ${table} WHERE active = 1`;
    console.log(`[DB] Executing query: ${query}`);
    const stmt = DB.prepare(query);
    const { results, success, error, meta } = await stmt.all();

    if (!success) {
      throw new Error(`Query failed: ${error || "unknown error"}`);
    }
    if (!results) {
      throw new Error("No results returned from query");
    }

    console.log(`[DB] Fetched ${results.length} prefixes from ${table}`);
    if (results.length === 0) {
      // Check table existence and schema
      const tableCheck = await DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).bind(table).first();
      if (!tableCheck) {
        throw new Error(`Table ${table} does not exist in the database`);
      }
      // Check sample data
      const sample = await DB.prepare(`SELECT prefix, active FROM ${table} LIMIT 5`).all();
      console.log(`[DB] Sample data from ${table}: ${JSON.stringify(sample.results)}`);
      // Check active values
      const activeCheck = await DB.prepare(`SELECT active, COUNT(*) as count FROM ${table} GROUP BY active`).all();
      console.log(`[DB] Active values in ${table}: ${JSON.stringify(activeCheck.results)}`);
      throw new Error(`No prefixes found in ${table} with active = 1`);
    }

    return results.map(row => row.prefix);
  } catch (err) {
    throw new Error(`Failed to fetch desired prefixes from ${table}: ${err.message}`);
  }
}

async function fetchCurrentGatewayList(env) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/gateway/lists/${env.LIST_ID}`;
  const headers = {
    "X-Auth-Email": env.API_EMAIL,
    "X-Auth-Key": env.API_KEY,
    "Content-Type": "application/json",
  };

  try {
    console.log("[API CALL] GET", url);
    const res = await fetch(url, { method: "GET", headers });
    console.log(`[API RESPONSE] GET status: ${res.status}`);
    const text = await res.text();
    console.log(`[API RESPONSE TEXT] GET: ${text}`);

    if (!res.ok) {
      throw new Error(`API request failed with status ${res.status}: ${text}`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error(`Failed to parse API response: ${text}`);
    }

    if (!data.success || !data.result || !data.result.items) {
      console.warn("[API WARN] No items in Gateway list response");
      return [];
    }
    console.log(`[API] Fetched ${data.result.items.length} prefixes from Gateway list`);
    return data.result.items.map(item => item.value);
  } catch (err) {
    throw new Error(`Failed to fetch Gateway list: ${err.message}`);
  }
}

async function updateGatewayListBatched(env, toAdd, toRemove, batchSize) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/gateway/lists/${env.LIST_ID}`;
  const headers = {
    "X-Auth-Email": env.API_EMAIL,
    "X-Auth-Key": env.API_KEY,
    "Content-Type": "application/json",
  };

  // Split into batches
  const addBatches = [];
  for (let i = 0; i < toAdd.length; i += batchSize) {
    addBatches.push(toAdd.slice(i, i + batchSize));
  }
  const removeBatches = [];
  for (let i = 0; i < toRemove.length; i += batchSize) {
    removeBatches.push(toRemove.slice(i, i + batchSize));
  }

  console.log(`[API] Processing ${addBatches.length} append batches, ${removeBatches.length} remove batches`);

  // Process append batches
  for (let i = 0; i < addBatches.length; i++) {
    const batch = addBatches[i];
    const payload = { append: batch.map(p => ({ value: p })) };
    await updateGatewayListSingle(env, url, headers, payload, `Append batch ${i + 1}/${addBatches.length}`);
  }

  // Process remove batches
  for (let i = 0; i < removeBatches.length; i++) {
    const batch = removeBatches[i];
    const payload = { remove: batch.map(p => ({ value: p })) };
    await updateGatewayListSingle(env, url, headers, payload, `Remove batch ${i + 1}/${removeBatches.length}`);
  }
}

async function updateGatewayListSingle(env, url, headers, payload, batchLabel) {
  if (!payload.append && !payload.remove) {
    console.log(`[SKIP] ${batchLabel}: No changes`);
    return;
  }

  try {
    console.log(`[API CALL] PATCH ${batchLabel}`, url);
    console.log(`[BODY] ${batchLabel}`, JSON.stringify(payload, null, 2));
    const res = await fetch(url, {
      method: "PATCH",
      headers,
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    console.log(`[PATCH RESPONSE TEXT] ${batchLabel}`, text);
    console.log(`[API RESPONSE] PATCH ${batchLabel} status: ${res.status}`);

    if (!res.ok) {
      if (res.status === 429) {
        console.warn(`[RETRY] ${batchLabel}: Rate limit hit, retrying after delay`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        return updateGatewayListSingle(env, url, headers, payload, batchLabel);
      }
      throw new Error(`API request failed with status ${res.status}: ${text}`);
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new Error(`Failed to parse API response: ${text}`);
    }

    if (!json.success) {
      throw new Error(`Update failed: ${JSON.stringify(json.errors || json)}`);
    }
    console.log(`[API] Successfully updated ${batchLabel}`);
    return json.result;
  } catch (err) {
    console.error(`[ERROR] Failed to update Gateway list (${batchLabel}): ${err.message}`);
    throw err;
  }
}

async function testGatewayListUpdate(env, prefix) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/gateway/lists/${env.LIST_ID}`;
  const headers = {
    "X-Auth-Email": env.API_EMAIL,
    "X-Auth-Key": env.API_KEY,
    "Content-Type": "application/json",
  };
  const payload = { append: [{ value: prefix }] };

  try {
    console.log("[API CALL] TEST PATCH", url);
    console.log("[BODY] TEST PATCH", JSON.stringify(payload, null, 2));
    const res = await fetch(url, {
      method: "PATCH",
      headers,
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    console.log("[PATCH RESPONSE TEXT] TEST PATCH", text);
    console.log(`[API RESPONSE] TEST PATCH status: ${res.status}`);

    if (!res.ok) {
      throw new Error(`Test API request failed with status ${res.status}: ${text}`);
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new Error(`Failed to parse test API response: ${text}`);
    }

    if (!json.success) {
      throw new Error(`Test update failed: ${JSON.stringify(json.errors || json)}`);
    }
    console.log("[API] Test PATCH successful");
  } catch (err) {
    console.error(`[ERROR] Test PATCH failed: ${err.message}`);
    throw err;
  }
}

async function updateSyncedPrefixes(DB, table, prefixes) {
  try {
    // Delete existing entries
    const deleteResult = await DB.prepare(`DELETE FROM synced_prefixes WHERE asn = ?`).bind(table).run();
    console.log(`[DB] Deleted ${deleteResult.meta.changes} rows from synced_prefixes for ${table}`);

    if (prefixes.length === 0) {
      console.log(`[DB] No prefixes to insert for ${table}`);
      return;
    }

    // Batch insert with INSERT OR IGNORE
    const batchSize = 100;
    for (let i = 0; i < prefixes.length; i += batchSize) {
      const batch = prefixes.slice(i, i + batchSize);
      const statements = batch.map(prefix =>
        DB.prepare(`INSERT OR IGNORE INTO synced_prefixes (asn, prefix) VALUES (?, ?)`)
          .bind(table, prefix)
      );
      const results = await DB.batch(statements);
      const inserted = results.reduce((sum, r) => sum + (r.meta.changes || 0), 0);
      console.log(`[DB] Inserted ${inserted} prefixes in batch ${i / batchSize + 1} for ${table}`);
    }
  } catch (err) {
    throw new Error(`Failed to update synced prefixes for ${table}: ${err.message}`);
  }
}

async function recordSyncTime(DB, asn) {
  try {
    const now = new Date().toISOString();
    await DB.prepare(
      `INSERT INTO sync_state (asn, last_run)
       VALUES (?, ?)
       ON CONFLICT(asn) DO UPDATE SET last_run = excluded.last_run`
    ).bind(asn, now).run();
  } catch (err) {
    throw new Error(`Failed to record sync time for ${asn}: ${err.message}`);
  }
}
