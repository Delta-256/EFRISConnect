'use strict';
const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;
const HTTPS_PORT = 5443;

app.use(cors({ origin:'*', methods:['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders:['Content-Type','Authorization','X-API-KEY'] }));
app.use(express.json());

// Load frontend HTML at startup — used as /extension and SPA
let EXTENSION_HTML = '';
try {
  EXTENSION_HTML = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
  console.log('Loaded frontend/index.html as EXTENSION_HTML');
} catch(e) {
  console.warn('Could not load frontend/index.html:', e.message);
}

const DATA_DIR = path.join(__dirname, 'data');
let TREE = null;
let UNITS = null;

function getTree() {
  if (!TREE) {
    console.log('Loading goods_tree.json...');
    TREE = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'goods_tree.json'), 'utf8'));
    console.log('Loaded: ' + Object.keys(TREE).length + ' segments');
  }
  return TREE;
}

function getUnits() {
  if (!UNITS) {
    try { UNITS = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'uom.json'), 'utf8')); }
    catch(e) { UNITS = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'units.json'), 'utf8')); }
  }
  return UNITS;
}

// ── HTTPS call to EFRIS ───────────────────────────────────────
function efrisCall(baseUrl, payload) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(payload);
    let parsed;
    try { parsed = new URL(baseUrl); } catch(e) { return reject(new Error('Bad EFRIS URL: ' + baseUrl)); }
    const opts = {
      hostname: parsed.hostname, port: parsed.port || 443,
      path: parsed.pathname + (parsed.search || ''), method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
      timeout: 30000
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('EFRIS timed out after 30s')); });
    req.write(bodyStr); req.end();
  });
}

// ── Call Manager.io ───────────────────────────────────────────
function managerCall(endpoint, token, method, docPath, body) {
  return new Promise((resolve, reject) => {
    const base = (endpoint || '').replace(/\/+$/, '');
    const cleanPath = docPath ? (docPath.startsWith('/') ? docPath : '/' + docPath) : '';
    const fullUrl = base + cleanPath;
    let parsed;
    try { parsed = new URL(fullUrl); } catch(e) { return reject(new Error('Bad Manager URL: ' + fullUrl)); }
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: parsed.hostname, port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''), method,
      headers: { 'X-API-KEY': token, 'Content-Type': 'application/json' },
      timeout: 20000,
      ...(isHttps ? { rejectUnauthorized: false } : {})
    };
    if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = lib.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (data) {
          try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
          catch(e) { resolve({ status: res.statusCode, data }); }
        } else { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Manager timed out')); });
    if (bodyStr) req.write(bodyStr); req.end();
  });
}

function normEp(ep) {
  ep = (ep || '').trim().replace(/\/+$/, '');
  if (ep.endsWith('/api4')) ep = ep.slice(0, -5) + '/api2';
  else if (ep.endsWith('/api')) ep = ep + '2';
  else if (!ep.endsWith('/api2')) ep = ep + '/api2';
  return ep;
}

function bareKey(k) { return String(k || '').split('?')[0].replace(/\/+$/, '').split('/').pop(); }

async function mgrTextCustomFields(ep, tk) {
  const byName = {}, byKey = {};
  try {
    const r = await managerCall(ep, tk, 'GET', '/text-custom-fields');
    const arr = (r.data && r.data.textCustomFields) || [];
    arr.forEach(f => { byName[f.name] = f.key; byKey[f.key] = f.name; });
  } catch (e) {}
  return { byName, byKey };
}

async function normalizeInvoice(ep, tk, key) {
  const formR = await managerCall(ep, tk, 'GET', '/sales-invoice-form/' + key);
  if (formR.status !== 200) return { _error: 'Manager returned HTTP ' + formR.status, _status: formR.status };
  const form = formR.data || {};
  let disp = {};
  try {
    const l = (await managerCall(ep, tk, 'GET', '/sales-invoices/' + key)).data;
    disp = (l && l.salesInvoices && l.salesInvoices[0]) || {};
  } catch (e) {}
  const cf = await mgrTextCustomFields(ep, tk);
  const strs = (form.CustomFields2 && form.CustomFields2.Strings) || {};
  const cfVals = {};
  Object.keys(strs).forEach(k => { cfVals[cf.byKey[k] || k] = strs[k]; });
  let custName = disp.customer || '';
  if (form.Customer) {
    try { const c = (await managerCall(ep, tk, 'GET', '/customer-form/' + form.Customer)).data; if (c && c.Name) custName = c.Name; } catch (e) {}
  }
  const lines = [];
  for (const l of (form.Lines || [])) {
    let itemName = (l.LineDescription || '').split('\n')[0] || 'Service', code = '', unit = 'Each';
    if (l.Item) {
      let it = null;
      try { it = (await managerCall(ep, tk, 'GET', '/non-inventory-item-form/' + l.Item)).data; } catch (e) {}
      if (!it || it.error) { try { it = (await managerCall(ep, tk, 'GET', '/inventory-item-form/' + l.Item)).data; } catch (e) {} }
      if (it && !it.error) { itemName = it.Name || itemName; code = it.Code || ''; unit = it.UnitName || unit; }
    }
    let rate = 0, taxName = '';
    if (l.TaxCode) {
      try { const tc = (await managerCall(ep, tk, 'GET', '/tax-code-form/' + l.TaxCode)).data; if (tc) { rate = (tc.Rates && tc.Rates[0]) || 0; taxName = tc.Name || ''; } } catch (e) {}
    }
    const qty = parseFloat(l.Qty || 1), price = parseFloat(l.SalesUnitPrice || 0);
    const lineTotal = qty * price, taxAmount = lineTotal * (rate / 100);
    lines.push({ ItemName: itemName, ItemCode: code, Qty: qty, UnitPrice: price, LineTotal: lineTotal,
      TaxAmount: taxAmount, TaxRate: rate, TaxName: taxName, Unit: unit,
      EFRISCategoryId: '', EFRISCategoryName: '' });
  }
  const totalTax = lines.reduce((s, l) => s + l.TaxAmount, 0);
  const total = (disp.invoiceAmount && disp.invoiceAmount.value) || lines.reduce((s, l) => s + l.LineTotal, 0);
  const currency = (disp.invoiceAmount && disp.invoiceAmount.currency) || 'UGX';
  return {
    Reference: form.Reference || disp.reference || '',
    IssueDate: (form.IssueDate || '').slice(0, 10) || disp.issueDate || '',
    Customer: { Name: custName, Address: '', TIN: '' },
    CustomerName: custName, Currency: currency,
    ExchangeRate: form.ExchangeRate || 1, Total: total,
    AmountExcludingTax: total - totalTax, TaxAmount: totalTax,
    Notes: form.Description || '', Lines: lines, CustomFields: cfVals, Key: key
  };
}

// ── RSA/AES crypto ────────────────────────────────────────────
const EFRIS_PRIVATE_KEY_PATHS = process.env.EFRIS_PRIVATE_KEY
  ? [process.env.EFRIS_PRIVATE_KEY]
  : ['F:\\EFRIS_Keys\\efris_private_v2.pem', 'F:\\EFRIS_Keys\\efris_private.pem'];

function loadPem(p) { try { return fs.readFileSync(p, 'utf8'); } catch(e) { return null; } }

function resolveAesKey(passwordDes) {
  const enc = Buffer.from(passwordDes, 'base64');
  const C = crypto.constants;
  const paddings = [
    { name: 'PKCS1',       opt: { padding: C.RSA_PKCS1_PADDING } },
    { name: 'OAEP-SHA1',   opt: { padding: C.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' } },
    { name: 'OAEP-SHA256', opt: { padding: C.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' } },
  ];
  const tried = [];
  for (const p of EFRIS_PRIVATE_KEY_PATHS) {
    const pem = loadPem(p);
    if (!pem) { tried.push(path.basename(p) + ': file not found'); continue; }
    for (const pad of paddings) {
      try {
        const dec = crypto.privateDecrypt({ key: pem, ...pad.opt }, enc);
        const b64 = Buffer.from(dec.toString('utf8').trim(), 'base64');
        if ([16,24,32].includes(b64.length)) return { key: b64, pem, path: p, variant: pad.name + '+base64' };
        if ([16,24,32].includes(dec.length)) return { key: dec, pem, path: p, variant: pad.name + '+raw' };
        tried.push(path.basename(p) + '/' + pad.name + ': raw ' + dec.length + 'b b64 ' + b64.length + 'b');
      } catch(e) { tried.push(path.basename(p) + '/' + pad.name + ': ' + (e.message||'').slice(0,30)); }
    }
  }
  throw new Error('Could not derive a valid AES key from T104. Tried — ' + tried.join('  |  '));
}

function aesAlgo(keyBytes) {
  return keyBytes.length === 32 ? 'aes-256-ecb' : keyBytes.length === 24 ? 'aes-192-ecb' : 'aes-128-ecb';
}
function aesEncryptB64(plain, keyBytes) {
  const c = crypto.createCipheriv(aesAlgo(keyBytes), keyBytes, null);
  return c.update(plain, 'utf8', 'base64') + c.final('base64');
}
function aesDecryptStr(b64, keyBytes) {
  const d = crypto.createDecipheriv(aesAlgo(keyBytes), keyBytes, null);
  return d.update(b64, 'base64', 'utf8') + d.final('utf8');
}
function signSha1(content, privatePem) {
  return crypto.createSign('RSA-SHA1').update(content, 'utf8').sign(privatePem, 'base64');
}

function efrisEnvEnc(code, payloadObj, tin, deviceNo, aesKeyBytes, privatePem) {
  const json = typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj);
  const contentB64 = aesEncryptB64(json, aesKeyBytes);
  const signature = signSha1(contentB64, privatePem);
  const env = efrisEnv(code, '', tin, deviceNo);
  env.data.content = contentB64;
  env.data.signature = signature;
  env.data.dataDescription = { codeType: '1', encryptCode: '2', zipCode: '0' };
  return env;
}

function efrisEnv(code, content, tin, deviceNo) {
  const cs = typeof content === 'string' ? content : JSON.stringify(content);
  return {
    data: { content: Buffer.from(cs).toString('base64'), signature: null, dataDescription: { codeType:'0', encryptCode:'1', zipCode:'0' } },
    globalInfo: {
      appId:'AP04', version:'1.1.20191201', dataExchangeId: Date.now().toString(),
      interfaceCode: code, requestCode:'TP',
      requestTime: new Date().toISOString().replace('T',' ').slice(0,19),
      responseCode:'TA', userName: tin, deviceMAC:'B47720524540',
      deviceNo, tin, brn:'', taxpayerID:'1',
      longitude:'32.6290', latitude:'0.3476', agentType:'0',
      extendField: { responsePaddingInfo:'0' }
    },
    returnStateInfo: { returnCode:'', returnMessage:'' }
  };
}

// ── Session cache ─────────────────────────────────────────────
const sessions = {};

async function getSession(tin, deviceNo, password, efrisBaseUrl) {
  const key = tin + '_' + deviceNo;
  const now = Date.now();
  if (sessions[key] && (now - sessions[key].ts) < 1800000) {
    console.log('   Reusing cached session');
    return sessions[key];
  }
  const snip = d => (typeof d === 'string' ? d : JSON.stringify(d) || '').slice(0, 400);
  const rcOf = r => r && r.data && r.data.returnStateInfo ? r.data.returnStateInfo.returnCode : undefined;
  const rmOf = r => r && r.data && r.data.returnStateInfo ? r.data.returnStateInfo.returnMessage : '';
  console.log('   New session for TIN: ' + tin);
  const t101 = await efrisCall(efrisBaseUrl, efrisEnv('T101', '', tin, deviceNo));
  if (t101.status !== 200) throw new Error('URA T101 failed: HTTP ' + t101.status + '. ' + snip(t101.data).slice(0,160));
  const t104 = await efrisCall(efrisBaseUrl, efrisEnv('T104', '', tin, deviceNo));
  let symKeyEnc = null, aesKey = null, privatePem = null;
  try { const c = JSON.parse(Buffer.from(t104.data.data.content, 'base64').toString()); symKeyEnc = c.passowrdDes || c.passwordDes; } catch(e) {}
  try { if (symKeyEnc) { const r = resolveAesKey(symKeyEnc); aesKey = r.key; privatePem = r.pem; } } catch(e) { console.log('   AES key error: ' + e.message); }
  const t103 = await efrisCall(efrisBaseUrl, efrisEnv('T103', '', tin, deviceNo));
  const session = { symKeyEnc, aesKey, privatePem, ts: now };
  if (aesKey) sessions[key] = session;
  if (rcOf(t103) && rcOf(t103) !== '00') {
    throw new Error('EFRIS login (T103) failed (' + rcOf(t103) + '): ' + rmOf(t103));
  }
  return session;
}

// ── Build T109 ────────────────────────────────────────────────
function buildT109(invoice, cfg) {
  const vat = !!cfg.vatRegistered;
  const r2 = n => (Math.round((parseFloat(n) || 0) * 100) / 100).toFixed(2);
  const lines = invoice.Lines || [];
  const goodsDetails = lines.map((l, i) => {
    const qty = parseFloat(l.Qty || 1) || 1;
    const unitPrice = parseFloat(l.UnitPrice || 0) || 0;
    const total = parseFloat(l.LineTotal || (unitPrice * qty)) || 0;
    const taxName = String(l.TaxName || l.TaxCode || invoice.TaxName || '').toLowerCase();
    const lineTax = parseFloat(l.TaxAmount || 0) || 0;
    let taxRate, tax, vatFlag, catCode;
    if (vat && lineTax > 0) { taxRate = '0.18'; tax = r2(total - total / 1.18); vatFlag = '1'; catCode = '01'; }
    else if (vat && /exempt/.test(taxName)) { taxRate = '-'; tax = '0'; vatFlag = '1'; catCode = '03'; }
    else if (vat && /zero/.test(taxName)) { taxRate = '0'; tax = '0'; vatFlag = '1'; catCode = '02'; }
    else if (vat) { taxRate = '-'; tax = '0'; vatFlag = '1'; catCode = '03'; }
    else { taxRate = '0'; tax = '0'; vatFlag = '1'; catCode = '02'; }
    return {
      item: String(l.ItemName || l.Description || 'Service').slice(0, 100),
      itemCode: String(l.ItemCode || l.Code || ('ITEM' + (i + 1))).slice(0, 50),
      qty: String(qty), unitOfMeasure: l.EFRISUnitOfMeasure || cfg.defaultUnitOfMeasure || '101',
      unitPrice: r2(unitPrice), total: r2(total), taxRate, tax: String(tax),
      discountTotal: '', discountTaxRate: '', orderNumber: String(i),
      discountFlag: '2', deemedFlag: '2', exciseFlag: '2',
      categoryId: '', categoryName: '',
      goodsCategoryId: l.EFRISCommodityCode || cfg.defaultCommodityCode || '',
      goodsCategoryName: l.EFRISCommodityName || cfg.defaultCommodityName || '',
      vatApplicableFlag: vatFlag, _catCode: catCode
    };
  });
  const gross = parseFloat(invoice.Total || 0) || goodsDetails.reduce((s, g) => s + parseFloat(g.total), 0);
  const taxAmount = goodsDetails.reduce((s, g) => s + (parseFloat(g.tax) || 0), 0);
  const net = gross - taxAmount;
  const anyVat = goodsDetails.some(g => g.taxRate === '0.18');
  const catCode = goodsDetails[0] ? goodsDetails[0]._catCode : (anyVat ? '01' : '03');
  goodsDetails.forEach(g => delete g._catCode);
  const now = new Date();
  const d = invoice.IssueDate ? new Date(invoice.IssueDate) : now;
  const p = n => String(n).padStart(2, '0');
  const issuedDate = p(d.getDate()) + '/' + p(d.getMonth()+1) + '/' + d.getFullYear() + ' ' + p(now.getHours()) + ':' + p(now.getMinutes()) + ':' + p(now.getSeconds());
  const hasTin = !!(invoice.CustomerTIN && String(invoice.CustomerTIN).trim());
  return {
    sellerDetails: { tin: cfg.tin, ninBrn: cfg.brn || '', legalName: cfg.businessName || cfg.tradeName || '', businessName: cfg.tradeName || cfg.businessName || '', address: cfg.businessAddress || 'Uganda', mobilePhone: cfg.phone || '', linePhone: '', emailAddress: cfg.email || '', placeOfBusiness: cfg.businessAddress || 'Uganda', referenceNo: invoice.Reference || '' },
    basicInformation: { invoiceNo: '', antifakeCode: '', deviceNo: cfg.deviceNo, issuedDate, operator: cfg.businessName || cfg.tradeName || 'system', currency: invoice.Currency || 'UGX', oriInvoiceId: '', invoiceType: '1', invoiceKind: vat ? '1' : '2', dataSource: '103', invoiceIndustryCode: '101', isBatch: '0' },
    buyerDetails: { buyerTin: hasTin ? String(invoice.CustomerTIN) : '', buyerNinBrn: '', buyerPassportNum: '', buyerLegalName: invoice.CustomerName || 'Walk-in Customer', buyerBusinessName: invoice.CustomerName || '', buyerAddress: invoice.CustomerAddress || '', buyerEmail: '', buyerMobilePhone: '', buyerLinePhone: '', buyerPlaceOfBusi: '', buyerType: hasTin ? '0' : '1', buyerCitizenship: '', buyerSector: '', buyerReferenceNo: '' },
    goodsDetails,
    taxDetails: [{ taxCategoryCode: catCode, netAmount: r2(net), taxRate: (goodsDetails[0] ? goodsDetails[0].taxRate : (anyVat ? '0.18' : '0')), taxAmount: r2(taxAmount), grossAmount: r2(gross) }],
    summary: { netAmount: r2(net), taxAmount: r2(taxAmount), grossAmount: r2(gross), itemCount: String(goodsDetails.length), modeCode: '1', remarks: invoice.Notes || '', qrCode: '' },
    payWay: [{ paymentMode: '101', paymentAmount: r2(gross), orderNumber: '1' }],
    extend: {}
  };
}

// ══════════════════════════════════════════════════════════════
//  GOODS TREE ROUTES (existing)
// ══════════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/api/segments', (req, res) => {
  try {
    const { q } = req.query;
    let segs = Object.entries(getTree()).map(([code, seg]) => ({ code, name: seg.n }));
    if (q && q.length >= 2) {
      const ql = q.toLowerCase();
      segs = segs.filter(s => s.name.toLowerCase().includes(ql) || s.code.includes(ql));
    }
    res.json(segs);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/segments/:segCode/families', (req, res) => {
  try {
    const seg = getTree()[req.params.segCode];
    if (!seg) return res.status(404).json({ error: 'Segment not found' });
    res.json(Object.entries(seg.f).map(([code, fam]) => ({ code, name: fam.n })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/segments/:segCode/families/:famCode/classes', (req, res) => {
  try {
    const seg = getTree()[req.params.segCode];
    if (!seg) return res.status(404).json({ error: 'Segment not found' });
    const fam = seg.f[req.params.famCode];
    if (!fam) return res.status(404).json({ error: 'Family not found' });
    res.json(Object.entries(fam.c).map(([code, cls]) => ({ code, name: cls.n })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/segments/:segCode/families/:famCode/classes/:clsCode/commodities', (req, res) => {
  try {
    const seg = getTree()[req.params.segCode];
    if (!seg) return res.status(404).json({ error: 'Segment not found' });
    const fam = seg.f[req.params.famCode];
    if (!fam) return res.status(404).json({ error: 'Family not found' });
    const cls = fam.c[req.params.clsCode];
    if (!cls) return res.status(404).json({ error: 'Class not found' });
    res.json(Object.entries(cls.d).map(([code, com]) => {
      if (typeof com === 'string') return { code, name: com };
      return { code, name: com.n, isService: com.s };
    }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/units', (req, res) => {
  try { res.json(getUnits()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/commodity/:code', (req, res) => {
  try {
    const target = req.params.code.padStart(8, '0');
    const tree = getTree();
    for (const [sc, seg] of Object.entries(tree)) {
      for (const [fc, fam] of Object.entries(seg.f)) {
        for (const [cc, cls] of Object.entries(fam.c)) {
          if (cls.d && cls.d[target]) {
            const com = cls.d[target];
            return res.json({ commodityCode: target, commodityName: typeof com === 'string' ? com : com.n,
              classCode: cc, className: cls.n, familyCode: fc, familyName: fam.n, segmentCode: sc, segmentName: seg.n });
          }
        }
      }
    }
    res.status(404).json({ error: 'Commodity not found' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  GOODS SYNC ROUTES (new)
// ══════════════════════════════════════════════════════════════

app.post('/api/goods/sync-to-manager', async (req, res) => {
  const { managerEndpoint, accessToken, item } = req.body || {};
  if (!managerEndpoint || !accessToken || !item) {
    return res.status(400).json({ success: false, error: 'managerEndpoint, accessToken and item are required' });
  }
  const ep = normEp(managerEndpoint);
  const isService = (item.type || 'Service') !== 'Goods';
  const listPath = isService ? '/non-inventory-items' : '/inventory-items';
  const listKey  = isService ? 'nonInventoryItems' : 'inventoryItems';

  const payload = {
    Code:           item.code,
    Name:           item.name,
    SalesUnitPrice: parseFloat(item.price) || 0,
    UnitName:       item.uom,
    Description:    item.remarks || ''
  };

  try {
    // 1. Fetch existing items to check for duplicate by Code
    let existingKey = null;
    try {
      const listR = await managerCall(ep, accessToken, 'GET', listPath, null);
      if (listR.status === 200 && listR.data && Array.isArray(listR.data[listKey])) {
        const match = listR.data[listKey].find(i =>
          (i.code || i.Code || '').toLowerCase() === (item.code || '').toLowerCase()
        );
        if (match) existingKey = match.key || match.Key;
      }
    } catch(_) {}

    let r, action;
    if (existingKey) {
      // 2a. Item exists — PUT to update
      console.log(`\n🔗 Updating in Manager.io: PUT ${ep}${listPath}/${existingKey} — ${item.code} ${item.name}`);
      r = await managerCall(ep, accessToken, 'PUT', `${listPath}/${existingKey}`, payload);
      action = 'updated';
    } else {
      // 2b. New item — POST to create
      console.log(`\n🔗 Creating in Manager.io: POST ${ep}${listPath} — ${item.code} ${item.name}`);
      r = await managerCall(ep, accessToken, 'POST', listPath, payload);
      action = 'created';
    }
    console.log(`   Manager response: HTTP ${r.status}`, JSON.stringify(r.data || '').slice(0, 200));

    // Manager returns 200 for both create and update; a 4xx means a real error
    const ok = r.status >= 200 && r.status < 300;
    const managerId = ok ? (existingKey || (r.data && (r.data.Key || r.data.key || r.data.id)) || null) : null;
    res.json(ok
      ? { success: true, action, managerId }
      : { success: false, error: `Manager returned HTTP ${r.status}` });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/goods/manager-items', async (req, res) => {
  const ep = normEp(req.query.ep || '');
  const tk = req.query.tk || '';
  if (!ep || !tk) return res.status(400).json({ success: false, error: 'ep and tk required' });
  try {
    const [niR, invR] = await Promise.all([
      managerCall(ep, tk, 'GET', '/non-inventory-items', null),
      managerCall(ep, tk, 'GET', '/inventory-items', null)
    ]);
    const services = (niR.status === 200 && niR.data && niR.data.nonInventoryItems) || [];
    const goods    = (invR.status === 200 && invR.data && invR.data.inventoryItems) || [];
    const normalize = (arr, type) => arr.map(i => ({
      key:      i.key || i.Key,
      code:     i.code || i.Code || '',
      name:     i.itemName || i.name || i.Name || '',
      unitName: i.unitName || i.UnitName || '',
      type
    }));
    res.json({ success: true, items: [...normalize(services,'Service'), ...normalize(goods,'Goods')] });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/efris/register-goods', async (req, res) => {
  const { tin, deviceNo, efrisPassword, mode, item } = req.body || {};
  if (!tin || !deviceNo || !item) {
    return res.status(400).json({ success: false, error: 'tin, deviceNo and item are required' });
  }
  const eu = mode === 'production'
    ? 'https://efrisws.ura.go.ug/ws/taapp/getInformation'
    : 'https://efristest.ura.go.ug/efrisws/ws/taapp/getInformation';
  try {
    const session = await getSession(tin, deviceNo, efrisPassword, eu);
    if (!session.aesKey) throw new Error('No AES key available — check private key path');

    // Resolve UOM text → URA code (e.g. "Per Person" → "PP").
    // Fall back to the raw text if not found (URA rejects unknown codes, but at least the error is clear).
    let uomCode = item.uom || 'UN';
    try {
      const units = getUnits();
      const match = units.find(u => u.name.toLowerCase() === (item.uom || '').toLowerCase());
      if (match) uomCode = match.code;
    } catch(_) {}

    // VAT tax item — taxCategoryCode: '01'=standard(18%), '02'=zero-rated, '03'=exempt
    const vatCat = item.vat === 'Exempt' ? '03' : item.vat === 'Zero' ? '02' : '01';
    const taxRate = vatCat === '01' ? '0.18' : '0.00';

    // T127 = UploadGoods (goods registration). Field names are URA-specific.
    // goodsTypeCode is NOT sent — URA derives type from goodsCategoryId.
    const t127Payload = {
      goodsCode:         item.code,
      goodsName:         item.name,
      measureUnit:       uomCode,
      currency:          item.cur || 'UGX',
      unitPrice:         String(parseFloat(item.price) || 0),
      goodsCategoryId:   item.comCode || '',
      goodsCategoryName: item.comName || '',
      haveExciseTax:     item.excise === 'Yes' ? '101' : '102',  // 101=yes, 102=no
      description:       item.remarks || '',
      stockPrewarning:   0,
      pricingMode:       1,
      havePieceUnit:     '102',
      pieceUnit:         '',
      packageScaledValue: 1,
      scaledValue:       1,
      discountTaxRate:   '',
      taxItems: [{
        taxCategoryCode: vatCat,
        taxRateCode:     '1',
        taxRate:         taxRate,
        taxAmount:       '',
        taxAmountUsd:    ''
      }]
    };

    console.log(`\n📦 Registering goods with EFRIS T127: ${item.code} — ${item.name}`);
    const t127 = await efrisCall(eu, efrisEnvEnc('T127', t127Payload, tin, deviceNo, session.aesKey, session.privatePem));
    const rc = t127.data && t127.data.returnStateInfo ? t127.data.returnStateInfo.returnCode : null;
    const rm = t127.data && t127.data.returnStateInfo ? t127.data.returnStateInfo.returnMessage : '';
    console.log(`   T127 rc: ${rc} (${rm})`);
    const ok = rc === '00';
    res.json({ success: ok, returnCode: rc, returnMessage: rm,
      error: ok ? undefined : `EFRIS T127: ${rc} — ${rm}` });
  } catch(e) {
    console.log(`   ❌ register-goods error: ${e.message}`);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  EFRIS API ROUTES
// ══════════════════════════════════════════════════════════════

app.post('/api/efris/test-connection', async (req, res) => {
  const b = req.body || {};
  const url = b.mode === 'production'
    ? 'https://efrisws.ura.go.ug/ws/taapp/getInformation'
    : 'https://efristest.ura.go.ug/efrisws/ws/taapp/getInformation';
  try {
    delete sessions[(b.tin||'') + '_' + (b.deviceNo||'')];
    await getSession(b.tin, b.deviceNo, b.password, url);
    res.json({ success: true, message: 'Connected to URA EFRIS ' + (b.mode === 'production' ? 'Production' : 'Sandbox') });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/efris/submit-invoice', async (req, res) => {
  const { invoice, config } = req.body || {};
  if (!invoice || !config || !config.tin) {
    return res.status(400).json({ success: false, error: 'Missing invoice or config.tin' });
  }
  const eu = config.mode === 'production'
    ? 'https://efrisws.ura.go.ug/ws/taapp/getInformation'
    : 'https://efristest.ura.go.ug/efrisws/ws/taapp/getInformation';
  try {
    const session = await getSession(config.tin, config.deviceNo, config.efrisPassword, eu);
    if (!session.aesKey) throw new Error('No AES key available to encrypt T109');
    const t109 = await efrisCall(eu, efrisEnvEnc('T109', buildT109(invoice, config), config.tin, config.deviceNo, session.aesKey, session.privatePem));
    const rc = t109.data && t109.data.returnStateInfo ? t109.data.returnStateInfo.returnCode : null;
    const rm = t109.data && t109.data.returnStateInfo ? t109.data.returnStateInfo.returnMessage : '';
    let contentStr = null;
    if (t109.data && t109.data.data && t109.data.data.content) {
      try { contentStr = aesDecryptStr(t109.data.data.content, session.aesKey); }
      catch(e) { try { contentStr = Buffer.from(t109.data.data.content, 'base64').toString('utf8'); } catch(_) {} }
    }
    let fdn = null, qrCode = null, antifakeCode = null;
    try { if (contentStr) { const d = JSON.parse(contentStr); const bi = d.basicInformation || {}; fdn = d.fdn || d.fiscalDocumentNumber || bi.invoiceNo || bi.fdn; qrCode = d.qrCode || d.qrCodeBase64 || bi.qrCode; antifakeCode = d.antiFakeCode || d.antifakeCode || bi.antifakeCode; } } catch(e) {}
    const ok = rc === '00' || !!fdn;
    res.json(ok
      ? { success: true, fdn, qrCode, antifakeCode, returnCode: rc, returnMessage: rm }
      : { success: false, error: 'URA ' + rc + ': ' + rm, returnCode: rc });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/efris/save-to-manager', async (req, res) => {
  const { managerEndpoint, accessToken, documentKey, efrisData } = req.body || {};
  if (!managerEndpoint || !accessToken || !documentKey) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }
  const ep = normEp(managerEndpoint);
  const key = bareKey(documentKey);
  try {
    const getR = await managerCall(ep, accessToken, 'GET', '/sales-invoice-form/' + key, null);
    if (getR.status !== 200) return res.json({ success: false, error: 'Manager GET returned ' + getR.status, hint: 'Token rejected or invoice key not found' });
    const form = getR.data;
    const cf = await mgrTextCustomFields(ep, accessToken);
    form.CustomFields2 = form.CustomFields2 || {};
    form.CustomFields2.Strings = form.CustomFields2.Strings || {};
    const setCF = (name, val) => { const k = cf.byName[name]; if (k && val != null && val !== '') form.CustomFields2.Strings[k] = String(val); };
    setCF('EFRIS FDN', efrisData.fdn);
    setCF('EFRIS Antifake Code', efrisData.antifakeCode);
    setCF('EFRIS QR Code URL', efrisData.qrCode);
    setCF('EFRIS Status', 'Submitted');
    setCF('EFRIS Submission Date', new Date().toISOString().slice(0,10));
    const postR = await managerCall(ep, accessToken, 'POST', '/sales-invoice-form/' + key, form);
    const ok = postR.status === 200 || postR.status === 201 || postR.status === 204;
    res.json(ok ? { success: true } : { success: false, error: 'Manager POST returned ' + postR.status, fdn: efrisData.fdn });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/manager/invoice', async (req, res) => {
  const ep = normEp(req.query.ep || '');
  const tk = req.query.tk || '';
  const key = bareKey(req.query.key || '');
  if (!ep || !tk || !key) return res.status(400).json({ success: false, error: 'ep, tk and key are required' });
  try {
    const inv = await normalizeInvoice(ep, tk, key);
    res.json(inv._error
      ? { success: false, error: inv._error, hint: inv._status === 401 ? 'Token rejected' : 'Check endpoint and key' }
      : { success: true, data: inv });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/api/manager/invoices', async (req, res) => {
  const ep = normEp(req.query.ep || '');
  const tk = req.query.tk || '';
  if (!ep || !tk) return res.status(400).json({ success: false, error: 'ep and tk are required' });
  try {
    const r = await managerCall(ep, tk, 'GET', '/sales-invoices', null);
    if (r.status !== 200) return res.json({ success: false, error: 'Manager returned HTTP ' + r.status, hint: r.status === 401 ? 'Token rejected' : 'Check endpoint URL' });
    const list = ((r.data && r.data.salesInvoices) || []).map(i => ({ key: i.key, reference: i.reference, customer: i.customer, amount: (i.invoiceAmount && i.invoiceAmount.value) || 0, currency: (i.invoiceAmount && i.invoiceAmount.currency) || '', date: i.issueDate, status: i.status }));
    res.json({ success: true, business: (r.data && r.data.business && r.data.business.name) || '', invoices: list });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/manager/test', async (req, res) => {
  const ep = normEp((req.body || {}).managerEndpoint || '');
  const tk = ((req.body || {}).accessToken || '').trim();
  try {
    const r = await managerCall(ep, tk, 'GET', '/sales-invoices', null);
    if (r.status === 200) {
      const biz = (r.data && r.data.business && r.data.business.name) || '?';
      const n = r.data && r.data.totalRecords;
      res.json({ success: true, message: 'Connected  Business: ' + biz + (n != null ? '  (' + n + ' invoices)' : ''), endpoint: ep });
    } else if (r.status === 401) {
      res.json({ success: false, error: 'HTTP 401 — access token rejected by Manager.', hint: 'Regenerate token in Manager → Settings → Access Tokens' });
    } else {
      res.json({ success: false, error: 'Manager returned HTTP ' + r.status, hint: 'Confirm Manager is running at localhost:8090. Endpoint tried: ' + ep });
    }
  } catch(e) {
    res.json({ success: false, error: e.message, hint: e.message.includes('ECONNREFUSED') ? 'Manager is not running.' : 'Check your Manager URL' });
  }
});

// ══════════════════════════════════════════════════════════════
//  /extension ROUTE — serve EXTENSION_HTML
// ══════════════════════════════════════════════════════════════
app.get('/extension', (req, res) => {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(EXTENSION_HTML);
});

// ── Static files and SPA fallback ────────────────────────────
const FRONTEND = path.join(__dirname, '..', 'frontend');
app.use(express.static(FRONTEND));
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/') && req.path !== '/extension') {
    res.sendFile(path.join(FRONTEND, 'index.html'));
  }
});

// ══════════════════════════════════════════════════════════════
//  HTTPS via openssl child_process
// ══════════════════════════════════════════════════════════════
let httpsServer = null;

function tryStartHTTPS() {
  try {
    const { execSync } = require('child_process');
    const os = require('os');
    try {
      execSync('openssl version', { stdio: 'ignore' });
      const tmpDir = os.tmpdir();
      const keyFile  = path.join(tmpDir, 'efris_key.pem');
      const certFile = path.join(tmpDir, 'efris_cert.pem');
      execSync('openssl req -x509 -newkey rsa:2048 -keyout "' + keyFile + '" -out "' + certFile + '" -days 365 -nodes -subj "/CN=localhost" -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"', { stdio: 'ignore' });
      const sslOptions = { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile), rejectUnauthorized: false };
      httpsServer = https.createServer(sslOptions, app);
      httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
        console.log('HTTPS running at https://localhost:' + HTTPS_PORT + '/extension');
      });
      httpsServer.on('error', e => { console.log('HTTPS startup error: ' + e.message); });
    } catch(opensslErr) {
      console.log('openssl not found — HTTPS not available. Use Cloudflare Tunnel for HTTPS.');
    }
  } catch(e) {
    console.log('Could not start HTTPS: ' + e.message);
  }
}

// ── Start HTTP server ─────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('=======================================================');
  console.log('Uganda EFRIS Connect + Goods Configurator');
  console.log('Tukei Hope Initiative | EMC/CBO/025');
  console.log('=======================================================');
  console.log('HTTP running on port ' + PORT);
  console.log('Extension URL: http://localhost:' + PORT + '/extension');
  tryStartHTTPS();
});
