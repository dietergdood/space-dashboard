# Space Stocks Dashboard · RKLB & ASTS

Live-Kurs-Dashboard für Rocket Lab (RKLB) und AST SpaceMobile (ASTS).

## Features
- Live-Kurse via Yahoo Finance (auto-refresh 60s)
- Portfolio-Rechner mit G/V, Bull/Bear/Konsens-Szenarien
- Tages-Forecast (ATR-basiert)
- Claude AI News-Update mit Web-Search (eigener API-Key)

## Deploy auf Vercel

### Option 1: Vercel CLI
```bash
npm i -g vercel
vercel
```

### Option 2: GitHub + Vercel
1. Repo auf GitHub pushen
2. vercel.com → "Import Project" → GitHub Repo wählen
3. Deploy klicken — fertig!

## Projektstruktur
```
/api/quote.js        ← Serverless proxy für Yahoo Finance
/public/index.html   ← Dashboard
/vercel.json         ← Routing-Config
```

## Hinweise
- Kein API-Key nötig für Live-Kurse
- Für Claude AI News: eigenen Anthropic API-Key eingeben (console.anthropic.com)
- Kein Anlageberatung
