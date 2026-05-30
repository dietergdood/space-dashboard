// Read KI data from Supabase cache
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const { section, ticker } = req.query;
  if (!section) return res.status(400).json({ error: 'section required' });

  try {
    let url = `${SUPABASE_URL}/rest/v1/ki_cache?section=eq.${section}&order=updated_at.desc&limit=1`;
    if (ticker) url += `&ticker=eq.${ticker}`;

    const r = await fetch(url, {
      headers: {
        'apikey': SUPABASE_ANON,
        'Authorization': `Bearer ${SUPABASE_ANON}`,
      }
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}`);
    const rows = await r.json();
    if (!rows.length) return res.status(404).json({ error: 'No data yet' });
    
    return res.status(200).json({ 
      data: rows[0].data, 
      updated_at: rows[0].updated_at 
    });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
