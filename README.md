# Space Stocks Dashboard · RKLB · ASTS · SPCX

Live-Dashboard für Rocket Lab (RKLB), AST SpaceMobile (ASTS) und SpaceX (SPCX, IPO ausstehend) mit KI-Analysen, News und Portfolio-Tracking.

🌐 **Live:** https://space-stocks.vercel.app

---

## Features

### Live-Kursdaten (Yahoo Finance · alle 15s)
- Aktueller Kurs, Tagestief/Tageshoch, Eröffnung
- Handelsvolumen, 52-Wochen-Range, Marktkapitalisierung
- Pre/Post-Market Preise
- Range-Chart mit 7 Zeiträumen (1T · 5T · 1M · 6M · YTD · 1J · 5J)

### KI-Analysen (Claude · täglich 13:00 Uhr Zürich)
- **Empfehlung** — KAUFEN / HALTEN / VERKAUFEN mit Begründung
- **Kursziele & Szenarien** — Bull/Base/Bear + 5-Jahres-Forecast
- **Social Media Sentiment** — Reddit, X, StockTwits, Telegram, FB/IG
- **Nachrichten** — Top News aus 80+ Quellen
- **Sektor-Kontext** — Konkurrenz, SpaceX, Blue Origin, Starlink
- **Insider-Trades** — SEC Form 4 Käufe & Verkäufe
- **US Gov Aufträge** — Golden Dome, SDA, NASA, Space Force
- **Börsenlexikon** — Fachbegriffe automatisch aktualisiert

### Portfolio
- Transaktionen erfassen (Käufe & Verkäufe)
- Unrealisierter G/V, Portfolio-Wert
- CHF/USD Toggle mit Live-Wechselkurs
- CSV-Export

### Weitere Features
- **Dark Mode** — in Einstellungen aktivierbar
- **Earnings Calendar** — nächste Quartalszahlen
- **Historische Empfehlungen** — Verlauf KAUFEN/HALTEN/VERKAUFEN
- **Push-Notifications** — bei neuen KI-Daten
- **PWA** — als App auf Homescreen installierbar
- **Error Alerting** — Cron-Fehler werden geloggt

---

## Technischer Stack

| Komponente | Technologie |
|--|--|
| Frontend | Vanilla HTML/CSS/JS, Chart.js |
| Backend | Vercel Serverless Functions |
| KI | Anthropic Claude Sonnet/Haiku + Web-Search |
| Datenbank | Supabase (PostgreSQL) |
| Kursdaten | Yahoo Finance API |
| Hosting | Vercel |

---

## Projektstruktur

```
space-dashboard/
├── public/
│   ├── index.html          ← Dashboard (Single-Page-App)
│   ├── supabase.js         ← Supabase Client (lokal)
│   ├── chart.min.js        ← Chart.js (lokal)
│   ├── rklb-logo.png       ← Rocket Lab Logo
│   ├── asts-logo.png       ← AST SpaceMobile Logo
│   ├── spacex-logo.svg     ← SpaceX Logo
│   ├── icon-192.png        ← PWA Icon
│   ├── icon-512.png        ← PWA Icon
│   ├── apple-touch-icon.png← iOS Icon
│   └── manifest.json       ← PWA Manifest
├── api/
│   ├── cron.js             ← KI-Analyse (täglich via Vercel Cron)
│   ├── quote.js            ← Yahoo Finance Proxy
│   ├── history.js          ← Kursverlauf API
│   ├── ki-data.js          ← Supabase Cache API
│   ├── sync-status.js      ← Sync Status
│   └── sync-toggle.js      ← Sync Toggle
├── vercel.json             ← Routing + Cron-Konfiguration
└── package.json            ← Node.js Config (type: module)
```

---

## Setup & Deploy

### 1. Voraussetzungen
- Vercel Account (Pro empfohlen für lange Cron-Laufzeiten)
- Supabase Account (kostenlos)
- Anthropic API Key (console.anthropic.com)

### 2. Supabase Tabelle erstellen
```sql
CREATE TABLE ki_cache (
  id bigserial PRIMARY KEY,
  ticker text,
  section text NOT NULL,
  data jsonb,
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX ON ki_cache(section, ticker, updated_at DESC);
```

### 3. Umgebungsvariablen in Vercel
```
ANTHROPIC_API_KEY=sk-ant-...
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_KEY=eyJ...
```

### 4. Deploy
```bash
git push origin main
# Vercel deployed automatisch
```

---

## Cron-Jobs

| Job | Zeitplan | Was läuft |
|--|--|--|
| `scope=rklb` | Mo–Fr 13:00 | Rec + News + Scenarios + Sector + Gov + CTX |
| `scope=asts` | Mo–Fr 13:00 | Rec + News + Scenarios + Sector + Gov + CTX |
| `scope=spcx` | Di+Fr 13:00 | News + Sector + Gov + CTX |
| `scope=global` | Mo+Do 13:00 | Börsenlexikon |
| `scope=rklb_news` | Sa+So 13:00 | Nur News |
| `scope=asts_news` | Sa+So 13:00 | Nur News |
| `scope=all_fast` | Manuell | Rec + News + Scenarios (alle Ticker) |
| `scope=all_slow` | Manuell | Sector + Gov + CTX + Insider + Glossar |

**Kosten:** ~$18/Monat (Anthropic API)

---

## Quellenübersicht (80+ Quellen)

**Offizielle:** rocketlabusa.com, ast-science.com, spacex.com, SEC EDGAR  
**Finanzmedien:** Reuters, Bloomberg, CNBC, WSJ, Financial Times  
**Börsenportale:** Yahoo Finance, Seeking Alpha, TipRanks, Zacks, Finviz  
**Analysten:** Goldman Sachs, Morgan Stanley, JPMorgan, Needham, Canaccord  
**Space-Medien:** SpaceNews, NASASpaceFlight, Via Satellite, Payload Space  
**Behörden:** FAA, FCC, NASA, Space Force, SDA, ESA, JAXA  
**Social:** Reddit, X/Twitter, StockTwits, Telegram, Facebook, Instagram, YouTube  

---

## Hinweise
- **Kein Anlageberatung** — KI-Analysen sind informativ, keine professionelle Beratung
- Kursdaten werden alle 15 Sekunden aktualisiert
- KI-Daten täglich um 13:00 Uhr Zürich (11:00 UTC)
- SpaceX Tab wird nach IPO mit Live-Kursen erweitert
