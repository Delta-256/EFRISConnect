# Goods/Services Configurator

URA EFRIS-aligned commodity configuration for Manager.io.

Developed with support from [The Tukei Hope Initiative](https://tukeihopeinitiative.org/).

## Project structure

```
goods-services-configurator/
├── backend/
│   ├── data/
│   │   ├── goods_tree.json     (58 segments, 148,000+ commodities)
│   │   └── units.json          (350 URA package units of measure)
│   ├── server.js               (Express API)
│   └── package.json
├── frontend/
│   └── index.html              (Full UI — calls backend API)
├── package.json
├── Procfile
└── railway.toml
```

## Local development

```bash
cd backend
npm install
node server.js
# App runs at http://localhost:3000
```

## Deploy to Railway

1. Push this repo to GitHub
2. In Railway → New Project → Deploy from GitHub repo → select this repo
3. Railway auto-detects Node.js via `package.json` and runs `node backend/server.js`
4. Under Settings → Networking → Generate Domain
5. Use that URL as the endpoint in Manager.io → Settings → Custom Buttons

## Manager.io setup

1. Settings → Custom Buttons → New Custom Button
2. Label: `Goods/Services Configurator`
3. Endpoint: your Railway URL
4. Placements: `/inventory-items`, `/non-inventory-items`, `/inventory-item-form`, `/non-inventory-item-form`
