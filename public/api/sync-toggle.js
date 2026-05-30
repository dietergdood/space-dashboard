// Toggle auto-sync on/off
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (bool) required' });

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/sync_settings`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({ id: 1, sync_enabled: enabled })
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}`);
    return res.status(200).json({ sync_enabled: enabled });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
