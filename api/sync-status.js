const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/sync_settings?id=eq.1&select=sync_enabled,last_sync`, {
      headers: {
        'apikey': SUPABASE_ANON,
        'Authorization': `Bearer ${SUPABASE_ANON}`,
      }
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}`);
    const rows = await r.json();
    return res.status(200).json(rows[0] || { sync_enabled: true, last_sync: null });
  } catch(e) {
    return res.status(200).json({ sync_enabled: true, last_sync: null });
  }
}
