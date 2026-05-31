const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { section, ticker, history } = req.query;
  if (!section) return res.status(400).json({ error: 'section required' });

  try {
    const headers = {
      'apikey': SUPABASE_ANON,
      'Authorization': `Bearer ${SUPABASE_ANON}`,
    };

    if (history === '1') {
      // Return last 30 entries for history view
      let url = `${SUPABASE_URL}/rest/v1/ki_cache?section=eq.${section}&order=updated_at.desc&limit=30`;
      if (ticker) url += `&ticker=eq.${ticker}`;
      const r = await fetch(url, { headers });
      if (!r.ok) throw new Error(`Supabase ${r.status}`);
      const rows = await r.json();
      return res.status(200).json({
        data: rows[0]?.data || null,
        updated_at: rows[0]?.updated_at || null,
        history: rows.map(r => ({ data: r.data, updated_at: r.updated_at }))
      });
    }

    // Default: latest single entry
    let url = `${SUPABASE_URL}/rest/v1/ki_cache?section=eq.${section}&order=updated_at.desc&limit=1`;
    if (ticker) url += `&ticker=eq.${ticker}`;

    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`Supabase ${r.status}`);
    const rows = await r.json();
    if (!rows.length) return res.status(200).json({ data: null });

    return res.status(200).json({
      data: rows[0].data,
      updated_at: rows[0].updated_at
    });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
