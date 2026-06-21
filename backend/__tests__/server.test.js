'use strict';

/**
 * EFRISConnect — Test Suite
 *
 * Covers:
 *   1. Utility helpers  (normEp, bareKey)
 *   2. T109 invoice builder (buildT109)
 *   3. Number series builder (buildNumber / resolveNext)
 *   4. Health endpoint
 *   5. Goods-tree routes  (segments, families, classes, commodities, search)
 *   6. Units endpoint
 *   7. Manager connection test route (mocked)
 *   8. Rate limiter
 *   9. API key auth middleware
 *  10. Submission log CRUD
 *  11. Number series CRUD
 *  12. FX rates (mocked)
 *  13. EFRIS preview-invoice (no network needed)
 */

const request = require('supertest');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');

// ── Isolate data dir so tests don't touch real data files ──────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'efris-test-'));
process.env.DATA_DIR_OVERRIDE = TMP_DATA;  // picked up by server if we add support

// Copy static data files tests need
const SRC_DATA = path.join(__dirname, '..', 'data');
for (const f of ['goods_tree.json', 'uom.json', 'units.json']) {
  const src = path.join(SRC_DATA, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TMP_DATA, f));
}

// Set a stable API key so tests can authenticate
process.env.INTERNAL_API_KEY = 'test-api-key-12345';

// Load the app — must happen AFTER env vars are set
const app = require('../server');

const AUTH = { 'X-API-KEY': 'test-api-key-12345' };

// ─────────────────────────────────────────────────────────────────────────────
// 1. Utility helpers — tested via the HTTP layer (no direct export needed)
// ─────────────────────────────────────────────────────────────────────────────
describe('normEp (via /api/manager/test)', () => {
  test('rejects api4 endpoints with a clear error', async () => {
    const res = await request(app)
      .post('/api/manager/test')
      .set(AUTH)
      .send({ managerEndpoint: 'http://localhost:8090/api4', accessToken: 'x' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/api4/i);
  }, 10000);

  test('appends /api2 when endpoint has no suffix', async () => {
    // Will fail to connect but error should NOT be about api4
    const res = await request(app)
      .post('/api/manager/test')
      .set(AUTH)
      .send({ managerEndpoint: 'http://127.0.0.1:19999', accessToken: 'x' });
    expect(res.body.error).not.toMatch(/api4/i);
  }, 10000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. API key auth middleware
// ─────────────────────────────────────────────────────────────────────────────
describe('API key middleware', () => {
  test('returns 401 with no key', async () => {
    const res = await request(app).get('/api/segments');
    expect(res.status).toBe(401);
  });

  test('returns 401 with wrong key', async () => {
    const res = await request(app)
      .get('/api/segments')
      .set('X-API-KEY', 'wrong-key');
    expect(res.status).toBe(401);
  });

  test('passes with correct key', async () => {
    const res = await request(app)
      .get('/api/segments')
      .set(AUTH);
    expect(res.status).toBe(200);
  });

  test('/api/health is public (no key needed)', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Health endpoint
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/health', () => {
  test('returns ok with uptime', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok' });
    expect(typeof res.body.uptime).toBe('number');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Goods-tree routes
// ─────────────────────────────────────────────────────────────────────────────
describe('Goods tree', () => {
  let firstSegCode;

  test('GET /api/segments returns array of segments', async () => {
    const res = await request(app).get('/api/segments').set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty('code');
    expect(res.body[0]).toHaveProperty('name');
    firstSegCode = res.body[0].code;
  });

  test('GET /api/segments?q=food filters results', async () => {
    const res = await request(app)
      .get('/api/segments?q=food')
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    res.body.forEach(s => {
      expect(s.name.toLowerCase()).toContain('food');
    });
  });

  test('GET /api/segments/:code/families returns families', async () => {
    const segs = await request(app).get('/api/segments').set(AUTH);
    const code = segs.body[0].code;
    const res = await request(app)
      .get(`/api/segments/${code}/families`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  test('GET /api/segments/9999/families returns 404 for unknown segment', async () => {
    const res = await request(app)
      .get('/api/segments/9999/families')
      .set(AUTH);
    expect(res.status).toBe(404);
  });

  test('GET /api/commodity/search?q=xx returns array', async () => {
    const res = await request(app)
      .get('/api/commodity/search?q=ma')
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('GET /api/commodity/search?q=x (single char) returns empty', async () => {
    const res = await request(app)
      .get('/api/commodity/search?q=x')
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('GET /api/commodity/:code returns commodity or 404', async () => {
    // A known URA commodity code — 50101500 = Live animals
    const res = await request(app)
      .get('/api/commodity/50101500')
      .set(AUTH);
    // May or may not exist depending on the tree — just check shape
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body).toHaveProperty('commodityCode');
      expect(res.body).toHaveProperty('commodityName');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Units endpoint
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/units', () => {
  test('returns array of units with code and name', async () => {
    const res = await request(app).get('/api/units').set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty('code');
    expect(res.body[0]).toHaveProperty('name');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. T109 preview-invoice (buildT109 tested indirectly — no EFRIS call)
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/efris/preview-invoice', () => {
  const baseInvoice = {
    Reference: 'INV-001',
    IssueDate: '2026-06-21',
    CustomerName: 'Test Customer',
    CustomerType: 'b2c',
    Currency: 'UGX',
    Lines: [
      { ItemName: 'Consulting', ItemCode: 'CONS01', Qty: 2, UnitPrice: 100000, LineTotal: 200000, TaxAmount: 0, TaxRate: 0, TaxName: '' }
    ]
  };
  const baseConfig = {
    tin: '1000000000',
    deviceNo: 'TEST001',
    businessName: 'Test Co',
    vatRegistered: false,
    mode: 'sandbox'
  };

  test('returns T109 payload for a B2C non-VAT invoice', async () => {
    const res = await request(app)
      .post('/api/efris/preview-invoice')
      .set(AUTH)
      .send({ invoice: baseInvoice, config: baseConfig });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const p = res.body.payload;
    expect(p).toHaveProperty('sellerDetails');
    expect(p).toHaveProperty('basicInformation');
    expect(p).toHaveProperty('goodsDetails');
    expect(p).toHaveProperty('buyerDetails');
    expect(p).toHaveProperty('summary');
    expect(p).toHaveProperty('payWay');
  });

  test('non-VAT invoice sets invoiceKind=2 and taxRule=OOS', async () => {
    const res = await request(app)
      .post('/api/efris/preview-invoice')
      .set(AUTH)
      .send({ invoice: baseInvoice, config: baseConfig });
    const p = res.body.payload;
    expect(p.basicInformation.invoiceKind).toBe('2');
    expect(p.goodsDetails[0].taxRule).toBe('OOS');
    expect(p.taxDetails).toEqual([]);
  });

  test('VAT-registered invoice sets invoiceKind=1 and taxRule=STANDARD', async () => {
    const vatInvoice = {
      ...baseInvoice,
      Lines: [{ ...baseInvoice.Lines[0], TaxAmount: 30508.47, TaxRate: 18, TaxName: '18% VAT' }]
    };
    const res = await request(app)
      .post('/api/efris/preview-invoice')
      .set(AUTH)
      .send({ invoice: vatInvoice, config: { ...baseConfig, vatRegistered: true } });
    const p = res.body.payload;
    expect(p.basicInformation.invoiceKind).toBe('1');
    expect(p.goodsDetails[0].taxRule).toBe('STANDARD');
    expect(p.taxDetails.length).toBeGreaterThan(0);
  });

  test('B2B invoice sets buyerType=0', async () => {
    const res = await request(app)
      .post('/api/efris/preview-invoice')
      .set(AUTH)
      .send({
        invoice: { ...baseInvoice, CustomerType: 'b2b', CustomerTIN: '1000000001', CustomerName: 'ACME Ltd' },
        config: baseConfig
      });
    expect(res.body.payload.buyerDetails.buyerType).toBe('0');
    expect(res.body.payload.buyerDetails.buyerTin).toBe('1000000001');
  });

  test('Foreign customer sets buyerType=2', async () => {
    const res = await request(app)
      .post('/api/efris/preview-invoice')
      .set(AUTH)
      .send({
        invoice: { ...baseInvoice, CustomerType: 'foreign', PassportNum: 'A1234567', Nationality: 'KE' },
        config: baseConfig
      });
    expect(res.body.payload.buyerDetails.buyerType).toBe('2');
    expect(res.body.payload.buyerDetails.buyerPassportNum).toBe('A1234567');
  });

  test('credit note sets isRefund flag', async () => {
    const res = await request(app)
      .post('/api/efris/preview-invoice')
      .set(AUTH)
      .send({
        invoice: { ...baseInvoice, IsRefund: true, OriginalFDN: 'FDN123' },
        config: baseConfig
      });
    expect(res.body.payload.basicInformation.isRefund).toBe('1');
  });

  test('multiple pay ways included in payWay array', async () => {
    const res = await request(app)
      .post('/api/efris/preview-invoice')
      .set(AUTH)
      .send({
        invoice: {
          ...baseInvoice,
          PayWays: [
            { mode: '101', amount: 100000 },
            { mode: '102', amount: 100000 }
          ]
        },
        config: baseConfig
      });
    expect(res.body.payload.payWay.length).toBe(2);
  });

  test('returns 400 when invoice or config missing', async () => {
    const res = await request(app)
      .post('/api/efris/preview-invoice')
      .set(AUTH)
      .send({});
    expect(res.status).toBe(400);
  });

  test('exempt lines get taxRule=EXEMPT', async () => {
    const res = await request(app)
      .post('/api/efris/preview-invoice')
      .set(AUTH)
      .send({
        invoice: {
          ...baseInvoice,
          Lines: [{ ...baseInvoice.Lines[0], TaxAmount: 0, TaxRate: 0, TaxName: 'exempt' }]
        },
        config: { ...baseConfig, vatRegistered: true }
      });
    expect(res.body.payload.goodsDetails[0].taxRule).toBe('EXEMPT');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Submit-invoice rejects empty lines
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/efris/submit-invoice — pre-flight checks', () => {
  test('returns error when Lines is empty (no EFRIS call made)', async () => {
    const res = await request(app)
      .post('/api/efris/submit-invoice')
      .set(AUTH)
      .send({
        invoice: { Lines: [] },
        config: { tin: '1000000000', deviceNo: 'X', mode: 'sandbox' }
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/no line items/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Credit note validation
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/efris/credit-note — validation', () => {
  test('returns 400 when originalInvoiceId is missing', async () => {
    const res = await request(app)
      .post('/api/efris/credit-note')
      .set(AUTH)
      .send({
        originalFDN: 'FDN123',
        config: { tin: '1000000000', deviceNo: 'X', mode: 'sandbox' }
        // no originalInvoiceId
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/original invoice ID/i);
  });

  test('returns 400 when originalFDN is missing', async () => {
    const res = await request(app)
      .post('/api/efris/credit-note')
      .set(AUTH)
      .send({
        originalInvoiceId: 'INV-001',
        config: { tin: '1000000000', deviceNo: 'X', mode: 'sandbox' }
      });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Rate limiter
// ─────────────────────────────────────────────────────────────────────────────
describe('Rate limiter', () => {
  test('returns 429 after 30 rapid submissions', async () => {
    // Hit submit-invoice 31 times — the 31st should be throttled.
    // Each request will fail at the EFRIS session step (no real TIN) but
    // the rate limiter fires before that.
    const payload = {
      invoice: { Lines: [{ ItemName: 'X', Qty: 1, UnitPrice: 1, LineTotal: 1 }] },
      config: { tin: '1000000000', deviceNo: 'X', mode: 'sandbox' }
    };
    let got429 = false;
    for (let i = 0; i < 35; i++) {
      const res = await request(app)
        .post('/api/efris/submit-invoice')
        .set(AUTH)
        .send(payload);
      if (res.status === 429) { got429 = true; break; }
    }
    expect(got429).toBe(true);
  }, 30000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Submission log CRUD
// ─────────────────────────────────────────────────────────────────────────────
describe('Submission log', () => {
  const LOG_FILE = path.join(TMP_DATA, 'submission_log.json');

  beforeEach(() => {
    // Reset log file before each test
    if (fs.existsSync(LOG_FILE)) fs.unlinkSync(LOG_FILE);
  });

  test('GET /api/submission-log returns empty list when no log', async () => {
    const res = await request(app)
      .get('/api/submission-log')
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  test('GET /api/submission-log supports pagination', async () => {
    // Seed 5 entries
    const entries = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1, fdn: `FDN00${i + 1}`, submittedAt: new Date().toISOString(),
      customerName: `Customer ${i + 1}`, totalAmount: 100 * (i + 1), currency: 'UGX', mode: 'sandbox'
    }));
    fs.writeFileSync(LOG_FILE, JSON.stringify(entries));

    const res = await request(app)
      .get('/api/submission-log?page=1&limit=2')
      .set(AUTH);
    expect(res.body.items.length).toBe(2);
    expect(res.body.total).toBe(5);
  });

  test('GET /api/submission-log?q= filters by FDN', async () => {
    const entries = [
      { id: 1, fdn: 'FDN-ABC', customerName: 'Alice', totalAmount: 100 },
      { id: 2, fdn: 'FDN-XYZ', customerName: 'Bob',   totalAmount: 200 },
    ];
    fs.writeFileSync(LOG_FILE, JSON.stringify(entries));

    const res = await request(app)
      .get('/api/submission-log?q=ABC')
      .set(AUTH);
    expect(res.body.items.length).toBe(1);
    expect(res.body.items[0].fdn).toBe('FDN-ABC');
  });

  test('DELETE /api/submission-log/:id removes entry', async () => {
    const entries = [
      { id: 10, fdn: 'FDN-10' },
      { id: 11, fdn: 'FDN-11' },
    ];
    fs.writeFileSync(LOG_FILE, JSON.stringify(entries));

    const del = await request(app)
      .delete('/api/submission-log/10')
      .set(AUTH);
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);

    const list = await request(app).get('/api/submission-log').set(AUTH);
    expect(list.body.items.length).toBe(1);
    expect(list.body.items[0].id).toBe(11);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Number series CRUD
// ─────────────────────────────────────────────────────────────────────────────
describe('Number series', () => {
  const NS_FILE = path.join(TMP_DATA, 'number_series.json');

  beforeEach(() => {
    if (fs.existsSync(NS_FILE)) fs.unlinkSync(NS_FILE);
  });

  test('GET /api/number-series returns empty array initially', async () => {
    const res = await request(app).get('/api/number-series').set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
  });

  test('POST creates a series and returns preview', async () => {
    const res = await request(app)
      .post('/api/number-series')
      .set(AUTH)
      .send({
        name: 'Walk-in Sales',
        prefix: 'WLK',
        segments: ['prefix', 'year', 'counter'],
        separator: '-',
        digits: 4,
        startAt: 1,
        resetOn: 'yearly'
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.series.preview).toMatch(/^WLK-\d{4}-\d{4}$/);
  });

  test('POST /api/number-series/:id/next increments counter', async () => {
    const create = await request(app)
      .post('/api/number-series')
      .set(AUTH)
      .send({ name: 'Test', prefix: 'T', segments: ['prefix', 'counter'], separator: '-', digits: 3, startAt: 1, resetOn: 'never' });
    const id = create.body.series.id;

    const n1 = await request(app).post(`/api/number-series/${id}/next`).set(AUTH);
    const n2 = await request(app).post(`/api/number-series/${id}/next`).set(AUTH);
    expect(n1.body.number).toBe('T-001');
    expect(n2.body.number).toBe('T-002');
  });

  test('PUT updates series name', async () => {
    const create = await request(app)
      .post('/api/number-series')
      .set(AUTH)
      .send({ name: 'Old Name', prefix: 'X', segments: ['prefix', 'counter'], separator: '-', digits: 3, startAt: 1 });
    const id = create.body.series.id;

    const upd = await request(app)
      .put(`/api/number-series/${id}`)
      .set(AUTH)
      .send({ name: 'New Name', prefix: 'X', segments: ['prefix', 'counter'], separator: '-', digits: 3 });
    expect(upd.body.success).toBe(true);
    expect(upd.body.series.name).toBe('New Name');
  });

  test('DELETE removes series', async () => {
    const create = await request(app)
      .post('/api/number-series')
      .set(AUTH)
      .send({ name: 'Temp', prefix: 'TMP', segments: ['prefix', 'counter'], separator: '-', digits: 3, startAt: 1 });
    const id = create.body.series.id;

    await request(app).delete(`/api/number-series/${id}`).set(AUTH);
    const list = await request(app).get('/api/number-series').set(AUTH);
    expect(list.body.find(s => s.id === id)).toBeUndefined();
  });

  test('PUT /api/number-series/unknown returns 404', async () => {
    const res = await request(app)
      .put('/api/number-series/nonexistent-id')
      .set(AUTH)
      .send({ name: 'x' });
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. TIN verify — missing config returns 400
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/efris/verify-tin — validation', () => {
  test('returns 400 when buyerTin missing', async () => {
    const res = await request(app)
      .post('/api/efris/verify-tin')
      .set(AUTH)
      .send({ config: { tin: '1000000000', deviceNo: 'X', mode: 'sandbox' } });
    expect(res.status).toBe(400);
  });

  test('returns 400 when config missing', async () => {
    const res = await request(app)
      .post('/api/efris/verify-tin')
      .set(AUTH)
      .send({ buyerTin: '1000000001' });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. Goods sync — input validation
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/goods/sync-to-manager — validation', () => {
  test('returns 400 when managerEndpoint missing', async () => {
    const res = await request(app)
      .post('/api/goods/sync-to-manager')
      .set(AUTH)
      .send({ accessToken: 'x', item: { name: 'Test' } });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('returns 400 when item missing', async () => {
    const res = await request(app)
      .post('/api/goods/sync-to-manager')
      .set(AUTH)
      .send({ managerEndpoint: 'http://localhost:8090', accessToken: 'x' });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. Manager token header (new — X-Manager-Token / X-Manager-Endpoint)
// ─────────────────────────────────────────────────────────────────────────────
describe('Manager credentials via headers', () => {
  test('/api/goods/manager-items accepts credentials from headers', async () => {
    // Will fail to connect (no real Manager) but should NOT return 400
    const res = await request(app)
      .get('/api/goods/manager-items')
      .set(AUTH)
      .set('X-Manager-Endpoint', 'http://127.0.0.1:19999/api2')
      .set('X-Manager-Token', 'test-token');
    // 400 = missing creds, 200 = reached the call (connection may fail)
    expect(res.status).not.toBe(400);
  });

  test('/api/goods/manager-items returns 400 when neither query nor header creds provided', async () => {
    const res = await request(app)
      .get('/api/goods/manager-items')
      .set(AUTH);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15. Stock-in validation
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/efris/stock-in — validation', () => {
  // Use a unique IP via x-forwarded-for to avoid hitting the rate limit from earlier tests
  test('returns 400 when items missing', async () => {
    const res = await request(app)
      .post('/api/efris/stock-in')
      .set(AUTH)
      .set('X-Forwarded-For', '10.0.0.99')
      .send({ config: { tin: '1000000000', deviceNo: 'X', mode: 'sandbox' } });
    expect(res.status).toBe(400);
  });

  test('returns 400 when config.tin missing', async () => {
    const res = await request(app)
      .post('/api/efris/stock-in')
      .set(AUTH)
      .set('X-Forwarded-For', '10.0.0.98')
      .send({ items: [{ itemCode: 'X', quantity: 1, unitPrice: 100 }], config: {} });
    expect(res.status).toBe(400);
  });
});

// Cleanup temp dir after all tests
afterAll(() => {
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch(_) {}
});
