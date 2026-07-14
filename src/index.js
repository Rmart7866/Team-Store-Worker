/**
 * Team Stores index builder.
 *
 * Runs on a cron every 5 minutes. Walks every published collection, keeps the
 * ones with custom.team_store = true, and writes the compiled list to the
 * team-stores PAGE metafield (custom.team_stores, type json).
 *
 * Liquid reads that metafield and renders the list server-side. No visitor ever
 * waits on this, so the walk can take as long as it likes.
 *
 *   POST /rebuild   force an immediate rebuild (X-Rebuild-Key header)
 *   GET  /status    last build result, for debugging
 *
 * Secrets (npx wrangler secret put NAME):
 *   SHOPIFY_CLIENT_ID
 *   SHOPIFY_CLIENT_SECRET
 *   REBUILD_KEY
 *
 * App scopes: read_products, write_content
 */

const API_VERSION = '2026-07';
const PAGE_HANDLE = 'team-stores'; // the handle of your Shopify page
const NAMESPACE = 'custom';
const KEY = 'team_stores';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(rebuild(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/rebuild' && request.method === 'POST') {
      if (request.headers.get('X-Rebuild-Key') !== env.REBUILD_KEY) {
        return json({ error: 'unauthorized' }, 401);
      }
      try {
        const result = await rebuild(env);
        return json(result, 200);
      } catch (err) {
        return json({ error: String(err.message || err) }, 502);
      }
    }

    if (url.pathname === '/status' && request.method === 'GET') {
      const last = env.TEAM_STORES ? await env.TEAM_STORES.get('last-build', 'json') : null;
      return json(last || { error: 'no build recorded yet' }, 200);
    }

    return json({ error: 'not found' }, 404);
  }
};

/* -------------------------------------------------------------- rebuild */

async function rebuild(env) {
  const started = Date.now();
  const token = await getAdminToken(env);

  const { stores, scanned, pages } = await collectTeamStores(env, token);
  stores.sort((a, b) => a.t.localeCompare(b.t));

  const pageId = await getPageId(env, token);

  const payload = {
    updated: new Date().toISOString(),
    count: stores.length,
    stores
  };

  const body = JSON.stringify(payload);
  if (body.length > 120000) {
    throw new Error(`index is ${body.length} bytes, approaching the 128KB json metafield cap`);
  }

  await gql(
    env,
    token,
    `mutation Set($metafields: [MetafieldsSetInput!]!) {
       metafieldsSet(metafields: $metafields) {
         metafields { id updatedAt }
         userErrors { field message }
       }
     }`,
    {
      metafields: [
        { ownerId: pageId, namespace: NAMESPACE, key: KEY, type: 'json', value: body }
      ]
    }
  ).then((d) => {
    const errs = d.metafieldsSet.userErrors;
    if (errs.length) throw new Error(`metafieldsSet: ${JSON.stringify(errs)}`);
  });

  const result = {
    ok: true,
    updated: payload.updated,
    matched: stores.length,
    scanned,
    pages,
    bytes: body.length,
    ms: Date.now() - started
  };

  if (env.TEAM_STORES) {
    await env.TEAM_STORES.put('last-build', JSON.stringify(result));
  }

  console.log('[team-stores]', JSON.stringify(result));
  return result;
}

/* ------------------------------------------------------------- upstream */

async function collectTeamStores(env, token) {
  const QUERY = `
    query TeamStores($cursor: String) {
      collections(first: 250, after: $cursor, query: "published_status:published") {
        pageInfo { hasNextPage endCursor }
        nodes {
          handle
          title
          teamStore: metafield(namespace: "${NAMESPACE}", key: "team_store") { value }
        }
      }
    }`;

  const stores = [];
  let cursor = null;
  let hasNext = true;
  let scanned = 0;
  let pages = 0;

  while (hasNext && pages < 60) {
    const d = await gql(env, token, QUERY, { cursor });
    const conn = d.collections;
    pages++;

    for (const n of conn.nodes) {
      scanned++;
      if (n.teamStore && n.teamStore.value === 'true') {
        // Short keys keep the payload small. 128KB metafield cap.
        stores.push({ h: n.handle, t: n.title });
      }
    }

    hasNext = conn.pageInfo.hasNextPage;
    cursor = conn.pageInfo.endCursor;
  }

  return { stores, scanned, pages };
}

async function getPageId(env, token) {
  const d = await gql(
    env,
    token,
    `query FindPage($q: String!) {
       pages(first: 1, query: $q) { nodes { id handle title } }
     }`,
    { q: `handle:${PAGE_HANDLE}` }
  );

  const page = d.pages.nodes[0];
  if (!page) throw new Error(`no page found with handle "${PAGE_HANDLE}"`);
  return page.id;
}

/* --------------------------------------------------------------- client */

async function getAdminToken(env) {
  const r = await fetch(`https://${env.SHOP_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.SHOPIFY_CLIENT_ID,
      client_secret: env.SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials'
    })
  });
  if (!r.ok) throw new Error(`token exchange ${r.status}: ${await r.text()}`);
  return (await r.json()).access_token;
}

async function gql(env, token, query, variables = {}) {
  const r = await fetch(`https://${env.SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token
    },
    body: JSON.stringify({ query, variables })
  });

  if (!r.ok) throw new Error(`admin ${r.status}: ${await r.text()}`);
  const body = await r.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));

  const t = body.extensions && body.extensions.cost && body.extensions.cost.throttleStatus;
  if (t && t.currentlyAvailable < 300) {
    await new Promise((res) => setTimeout(res, 1500));
  }

  return body.data;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
