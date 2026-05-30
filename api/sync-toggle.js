const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (bool) required' });

  try {
    // Use PATCH to update existing row (id=1 always exists)
    const r = await fetch(`${SUPABASE_URL}/rest/v1/sync_settings?id=eq.1`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ sync_enabled: enabled })
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
    return res.status(200).json({ sync_enabled: enabled });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
