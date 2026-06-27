# EFRISConnect

URA EFRIS receipting, invoicing and goods/services configuration for Manager.io — built for Ugandan businesses.

Developed with support from [The Tukei Hope Initiative](https://tukeihopeinitiative.org/).

## Project structure

```
efrisconnect/
├── backend/
│   ├── data/
│   │   ├── goods_tree.json     (58 segments, 148,000+ commodities)
│   │   └── units.json          (350 URA package units of measure)
│   ├── server.js               (Express API)
│   └── package.json
├── frontend/
│   ├── index.html              (Full UI — calls backend API)
│   └── receipt.html            (Printable receipt / invoice page)
├── backend/Dockerfile          (Azure Container Instances deployment)
└── .github/workflows/          (CI/CD — builds and pushes to Azure ACR)
```

## Local development

```bash
cd backend
npm install
node server.js
# App runs at http://localhost:3000
```

## Deploy to Azure

1. Push this repo to GitHub
2. GitHub Actions builds the Docker image and pushes to Azure Container Registry
3. Azure Container Instances runs the image at `https://goods.twoservants.com`
4. Set `EFRIS_PRIVATE_KEY_B64` as a GitHub secret (base64 of your URA PEM file).
   The workflow also needs `ACR_USERNAME`, `ACR_PASSWORD` and `AZURE_CREDENTIALS`.

## Manager.io setup

1. Settings → Custom Buttons → New Custom Button
2. Label: `EFRISConnect`
3. Endpoint: `https://goods.twoservants.com`
4. Placements: `/sales-invoices`, `/receipts`, `/inventory-items`, `/non-inventory-items`, `/inventory-item-form`, `/non-inventory-item-form`, `/receipt-form`, `/sales-invoice-form`
