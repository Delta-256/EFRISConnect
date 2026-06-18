'use strict';
const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const zlib   = require('zlib');
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

// Cache tax code list per endpoint to avoid repeated fetches
const _taxCodeCache = {};
async function mgrTaxCodeGuid(ep, tk, vatType) {
  const cacheKey = ep + '_taxcodes';
  if (!_taxCodeCache[cacheKey]) {
    try {
      const r = await managerCall(ep, tk, 'GET', '/tax-codes');
      _taxCodeCache[cacheKey] = (r.data && r.data.taxCodes) || [];
    } catch(e) { _taxCodeCache[cacheKey] = []; }
  }
  const codes = _taxCodeCache[cacheKey];
  // Match by VAT type: Standard=18%, Zero=0%, Exempt
  const query = vatType === 'Exempt' ? 'exempt'
    : vatType === 'Zero' ? ['zero', '0%', 'zero rated', 'zero-rated']
    : ['18%', 'standard', 'vat']; // Standard
  const q = Array.isArray(query) ? query : [query];
  const match = codes.find(c => {
    const nm = (c.name || c.Name || '').toLowerCase();
    return q.some(term => nm.includes(term));
  });
  return match ? (match.key || match.Key) : null;
}

async function normalizeInvoice(ep, tk, key) {
  // A document key belongs to either a sales invoice or a receipt. Probe invoice
  // first, fall back to receipt. (Non-VAT businesses often record cash sales as
  // Manager "Receipts".)
  let form = null, docType = 'invoice', formBase = '/sales-invoice-form', listBase = '/sales-invoices', listProp = 'salesInvoices';
  let formR = await managerCall(ep, tk, 'GET', '/sales-invoice-form/' + key);
  if (formR.status === 200 && formR.data && !formR.data.error && (formR.data.Lines || formR.data.Reference || formR.data.IssueDate)) {
    form = formR.data;
  } else {
    // Try receipt
    const rcptR = await managerCall(ep, tk, 'GET', '/receipt-form/' + key);
    if (rcptR.status === 200 && rcptR.data && !rcptR.data.error) {
      form = rcptR.data; docType = 'receipt'; formBase = '/receipt-form'; listBase = '/receipts'; listProp = 'receipts';
      console.log(`   Loaded Manager RECEIPT ${key} — fields: ${Object.keys(form).join(', ')}`);
    }
  }
  if (!form) return { _error: 'Manager returned HTTP ' + formR.status + ' (not found as invoice or receipt)', _status: formR.status };
  let disp = {};
  try {
    const l = (await managerCall(ep, tk, 'GET', listBase + '/' + key)).data;
    disp = (l && l[listProp] && l[listProp][0]) || {};
  } catch (e) {}
  const cf = await mgrTextCustomFields(ep, tk);
  const strs = (form.CustomFields2 && form.CustomFields2.Strings) || {};
  const cfVals = {};
  Object.keys(strs).forEach(k => { cfVals[cf.byKey[k] || k] = strs[k]; });
  let custName = disp.customer || disp.payer || '';
  const contactKey = form.PaidBy || form.Customer || form.Payer || form.Contact;
  if (contactKey) {
    try { const c = (await managerCall(ep, tk, 'GET', '/customer-form/' + contactKey)).data; if (c && c.Name) custName = c.Name; } catch (e) {}
  }
  const lines = [];
  for (const l of (form.Lines || [])) {
    let itemName = (l.LineDescription || l.Description || '').split('\n')[0] || 'Service', code = '', unit = 'Each';
    if (l.Item) {
      let it = null;
      try { it = (await managerCall(ep, tk, 'GET', '/non-inventory-item-form/' + l.Item)).data; } catch (e) {}
      if (!it || it.error) { try { it = (await managerCall(ep, tk, 'GET', '/inventory-item-form/' + l.Item)).data; } catch (e) {} }
      if (it && !it.error) {
        itemName = it.Name || it.ItemName || itemName;
        code = it.Code || it.code || '';
        unit = it.UnitName || unit;
        console.log(`   Line item resolved: name="${itemName}" code="${code}" (Manager Code field)`);
      } else {
        console.log(`   Line item ${l.Item}: could not resolve from Manager (no code)`);
      }
    }
    let rate = 0, taxName = '';
    if (l.TaxCode) {
      try { const tc = (await managerCall(ep, tk, 'GET', '/tax-code-form/' + l.TaxCode)).data; if (tc) { rate = (tc.Rates && tc.Rates[0]) || 0; taxName = tc.Name || ''; } } catch (e) {}
    }
    const qty = parseFloat(l.Qty || l.Quantity || 1) || 1;
    const price = parseFloat(l.SalesUnitPrice || l.UnitPrice || l.Amount || 0) || 0;
    const lineTotal = qty * price, taxAmount = lineTotal * (rate / 100);
    lines.push({ ItemName: itemName, ItemCode: code, Qty: qty, UnitPrice: price, LineTotal: lineTotal,
      TaxAmount: taxAmount, TaxRate: rate, TaxName: taxName, Unit: unit,
      EFRISCategoryId: '', EFRISCategoryName: '' });
  }
  const totalTax = lines.reduce((s, l) => s + l.TaxAmount, 0);
  const total = (disp.invoiceAmount && disp.invoiceAmount.value) || (disp.amount && disp.amount.value) || lines.reduce((s, l) => s + l.LineTotal, 0);
  const currency = (disp.invoiceAmount && disp.invoiceAmount.currency) || (disp.amount && disp.amount.currency) || 'UGX';
  return {
    DocType: docType,
    Reference: form.Reference || disp.reference || '',
    IssueDate: (form.IssueDate || form.Date || '').slice(0, 10) || disp.issueDate || disp.date || '',
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
// AES-decrypt to raw bytes, then gunzip if the payload is gzip-compressed.
// NOTE: some EFRIS responses (e.g. the T115 dictionary) are gzip+base64 with
// NO AES layer at all, so check for the gzip magic on the raw base64-decoded
// buffer BEFORE attempting AES (which would throw "wrong final block length").
function aesDecryptMaybeGzip(b64, keyBytes) {
  const rawBuf = Buffer.from(b64, 'base64');
  const isGzip = b => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
  if (isGzip(rawBuf)) return zlib.gunzipSync(rawBuf).toString('utf8');
  const d = crypto.createDecipheriv(aesAlgo(keyBytes), keyBytes, null);
  const buf = Buffer.concat([d.update(rawBuf), d.final()]);
  if (isGzip(buf)) return zlib.gunzipSync(buf).toString('utf8');
  return buf.toString('utf8');
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

// ── EFRIS data dictionary (T115) — used to resolve currency codes ──
// T130's `currency` field wants the EFRIS internal currency code, NOT the ISO
// string ("UGX" is rejected with rc:680). We fetch the dictionary once, cache it
// on the session, and map ISO → EFRIS code.
// Brute-force decoder: EFRIS signals encryption/compression in the response's
// dataDescription, but it varies by interface. Try every combination and keep
// whichever yields valid JSON.
function efrisDecodeJson(b64, keyBytes) {
  const rawBuf = Buffer.from(b64, 'base64');
  const okJson = s => {
    if (!s || s.length < 2) return null;
    try { JSON.parse(s); return s; } catch(_) {}
    // Tolerate trailing bytes: trim to the last closing brace/bracket and retry.
    const cut = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
    if (cut > 0) { const t = s.slice(0, cut + 1); try { JSON.parse(t); return t; } catch(_) {} }
    return null;
  };
  // EFRIS gzip streams (Java GZIPOutputStream) are often not cleanly terminated,
  // so Node's gunzip needs Z_SYNC_FLUSH to avoid "unexpected end of file".
  const Z = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
  const aesDec = buf => {
    const d = crypto.createDecipheriv(aesAlgo(keyBytes), keyBytes, null);
    return Buffer.concat([d.update(buf), d.final()]);
  };
  const attempts = [];
  attempts.push(() => zlib.gunzipSync(rawBuf, Z).toString('utf8'));              // gzip(json)
  attempts.push(() => aesDec(zlib.gunzipSync(rawBuf, Z)).toString('utf8'));      // gzip(AES(json)) ← EFRIS dictionary
  attempts.push(() => zlib.inflateSync(rawBuf, Z).toString('utf8'));            // zlib deflate
  attempts.push(() => zlib.inflateRawSync(rawBuf, Z).toString('utf8'));         // raw deflate
  attempts.push(() => rawBuf.toString('utf8'));                                  // plain
  attempts.push(() => aesDec(rawBuf).toString('utf8'));                          // AES(json)
  attempts.push(() => zlib.gunzipSync(aesDec(rawBuf), Z).toString('utf8'));      // AES(gzip(json))
  for (const fn of attempts) {
    try { const s = okJson(fn()); if (s) return s; } catch(_) {}
  }
  return null;
}

const _dictCache = {};
async function getEfrisDictionary(tin, deviceNo, session, eu) {
  const key = tin + '_' + deviceNo;
  if (_dictCache[key]) return _dictCache[key];
  try {
    const t115 = await efrisCall(eu, efrisEnvEnc('T115', {}, tin, deviceNo, session.aesKey, session.privatePem));
    const rc = t115.data && t115.data.returnStateInfo ? t115.data.returnStateInfo.returnCode : null;
    const rm = t115.data && t115.data.returnStateInfo ? t115.data.returnStateInfo.returnMessage : '';
    console.log(`   T115 outer rc: ${rc} — ${rm}`);
    if (t115.data && t115.data.data) {
      // Log how EFRIS says the response is encoded + the raw byte signature
      console.log(`   T115 dataDescription: ${JSON.stringify(t115.data.data.dataDescription || {})}`);
      if (t115.data.data.content) {
        const sig = Buffer.from(t115.data.data.content, 'base64').slice(0, 6).toString('hex');
        console.log(`   T115 content byte signature (hex): ${sig}`);
        const raw = efrisDecodeJson(t115.data.data.content, session.aesKey);
        if (raw) {
          const dict = JSON.parse(raw);
          console.log(`   T115 dictionary loaded — top-level keys: ${Object.keys(dict).join(', ')}`);
          _dictCache[key] = dict;
          return dict;
        }
        console.log(`   (T115 content could not be decoded to JSON by any method)`);
      }
    }
  } catch(e) { console.log(`   (T115 dictionary fetch failed: ${e.message})`); }
  return null;
}

// Resolve an ISO currency (e.g. "UGX") to the EFRIS currency code expected by T130.
async function resolveEfrisCurrency(isoCode, tin, deviceNo, session, eu) {
  const iso = (isoCode || 'UGX').trim().toUpperCase();
  const dict = await getEfrisDictionary(tin, deviceNo, session, eu);
  if (!dict) return iso; // fallback to ISO if dictionary unavailable
  // Log currency-like sections so the exact format is visible in server logs.
  for (const [section, val] of Object.entries(dict)) {
    if (Array.isArray(val) && /rate|curr/i.test(section)) {
      console.log(`   T115 section "${section}" sample: ${JSON.stringify(val.slice(0, 2))}`);
    }
  }
  // Search every array for an entry matching this ISO code (exact value match first,
  // then substring within any field), and return its internal code.
  const pickCode = row => row.currencyCode || row.code || row.value || row.id || row.key;
  let exact = null, partial = null;
  for (const [section, val] of Object.entries(dict)) {
    if (!Array.isArray(val)) continue;
    for (const row of val) {
      if (!row || typeof row !== 'object') continue;
      const vals = Object.values(row).map(x => String(x).toUpperCase());
      if (vals.includes(iso)) { exact = exact || { section, code: pickCode(row), row }; }
      else if (!partial && vals.some(v => v.includes(iso))) { partial = { section, code: pickCode(row), row }; }
    }
  }
  const hit = exact || partial;
  if (hit) {
    console.log(`   Currency "${iso}" → EFRIS code "${hit.code}" (section: ${hit.section}, ${exact?'exact':'partial'} match)`);
    return String(hit.code);
  }
  console.log(`   Currency "${iso}" not found in T115 dictionary — sending ISO as-is`);
  return iso;
}

// Return the list of valid EFRIS measure units from the T115 dictionary.
// The authoritative source is the "rateUnit" section (value=code, name=label) —
// we do NOT hardcode this so it always matches what the taxpayer's EFRIS accepts.
async function getEfrisMeasureUnits(tin, deviceNo, session, eu) {
  const dict = await getEfrisDictionary(tin, deviceNo, session, eu);
  if (!dict) return [];
  // The units live in a section keyed by something like "rateUnit". Be tolerant:
  // pick the array whose rows have short {value} codes and a descriptive name.
  const candidates = ['rateUnit', 'measureUnit', 'unit', 'goodsUnit'];
  let list = null;
  for (const k of candidates) { if (Array.isArray(dict[k])) { list = dict[k]; break; } }
  if (!list) {
    // Fallback: any section whose rows look like {value, name} unit entries
    for (const v of Object.values(dict)) {
      if (Array.isArray(v) && v.length && v[0] && v[0].value && v[0].name && String(v[0].value).length <= 4) { list = v; break; }
    }
  }
  if (!list) return [];
  return list.map(r => ({ code: String(r.value || r.code || ''), name: String(r.name || r.description || '') }))
             .filter(u => u.code);
}

// Is a given unit code valid per the EFRIS dictionary?
async function isValidEfrisUnit(code, tin, deviceNo, session, eu) {
  if (!code) return false;
  const units = await getEfrisMeasureUnits(tin, deviceNo, session, eu);
  if (!units.length) return null; // unknown — dictionary unavailable
  const c = String(code).trim().toUpperCase();
  return units.some(u => u.code.toUpperCase() === c);
}

function buildT109(invoice, cfg) {
  const vat = !!cfg.vatRegistered;
  const isRefund = !!(invoice.IsRefund || invoice.isRefund);
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
    // Non-VAT-registered taxpayer: issues e-receipts (invoiceKind=2).
    // Per EFRIS developer docs taxRule field: OOS = Out of Scope (correct for
    // non-VAT businesses). catCode '05' = OOS in taxCategoryCode (01=Standard,
    // 02=Zero, 03=Exempt, 04=Deemed, 05=OOS). Codes 03/04 are rejected on
    // e-receipts with URA 3087 "Exempt/Deemed not allowed for receipt".
    else { taxRate = '-'; tax = '0'; vatFlag = '2'; catCode = '05'; }
    // taxRule per developer.efris.dev: STANDARD | EXEMPT | ZERORATED | OOS | DIM
    let taxRule;
    if (!vat) taxRule = 'OOS';
    else if (catCode === '01') taxRule = 'STANDARD';
    else if (catCode === '02') taxRule = 'ZERORATED';
    else taxRule = 'EXEMPT';
    return {
      item: String(l.ItemName || l.Description || 'Service').slice(0, 100),
      itemCode: String(l.ItemCode || l.Code || ('ITEM' + (i + 1))).slice(0, 50),
      qty: String(qty), unitOfMeasure: l.EFRISUnitOfMeasure || cfg.defaultUnitOfMeasure || '101',
      unitPrice: r2(unitPrice), total: r2(total), taxRate, taxRule, tax: String(tax),
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

  // ── Buyer details — supports B2C, B2B, B2G, Foreign ──────────────────────
  // buyerType: '0'=Taxpayer(B2B/B2G with TIN), '1'=Citizen(B2C), '2'=Foreigner
  const custType = String(invoice.CustomerType || 'b2c').toLowerCase();
  const hasTin = !!(invoice.CustomerTIN && String(invoice.CustomerTIN).trim());
  let buyerType, buyerTin, buyerPassportNum, buyerCitizenship, buyerLegalName, buyerBusinessName, buyerAddress;
  if (custType === 'b2b') {
    buyerType = '0'; buyerTin = String(invoice.CustomerTIN || ''); buyerPassportNum = '';
    buyerCitizenship = ''; buyerLegalName = invoice.CustomerName || '';
    buyerBusinessName = invoice.CustomerName || ''; buyerAddress = invoice.CustomerAddress || '';
  } else if (custType === 'b2g') {
    buyerType = '0'; buyerTin = String(invoice.CustomerTIN || ''); buyerPassportNum = '';
    buyerCitizenship = ''; buyerLegalName = invoice.CustomerName || 'Government Entity';
    buyerBusinessName = invoice.CustomerDept || invoice.CustomerName || 'Government';
    buyerAddress = invoice.CustomerAddress || '';
  } else if (custType === 'foreign') {
    buyerType = '2'; buyerTin = ''; buyerPassportNum = String(invoice.PassportNum || '');
    buyerCitizenship = String(invoice.Nationality || '');
    buyerLegalName = invoice.CustomerName || 'Foreign Visitor';
    buyerBusinessName = invoice.CustomerName || ''; buyerAddress = invoice.CustomerAddress || '';
  } else {
    // B2C default — walk-in local customer
    buyerType = '1'; buyerTin = ''; buyerPassportNum = '';
    buyerCitizenship = ''; buyerLegalName = invoice.CustomerName || 'Walk-in Customer';
    buyerBusinessName = invoice.CustomerName || ''; buyerAddress = '';
  }

  // Non-VAT e-receipts (invoiceKind=2): no tax categories apply — omit taxDetails
  // entirely. The taxRule='OOS' on each goodsDetails line carries the designation.
  const taxDetails = vat
    ? [{ taxCategoryCode: catCode, netAmount: r2(net), taxRate: (goodsDetails[0] ? goodsDetails[0].taxRate : (anyVat ? '0.18' : '0')), taxAmount: r2(taxAmount), grossAmount: r2(gross) }]
    : [];
  return {
    sellerDetails: { tin: cfg.tin, ninBrn: cfg.brn || '', legalName: cfg.businessName || cfg.tradeName || '', businessName: cfg.tradeName || cfg.businessName || '', address: cfg.businessAddress || 'Uganda', mobilePhone: cfg.phone || '', linePhone: '', emailAddress: cfg.email || '', placeOfBusiness: cfg.businessAddress || 'Uganda', referenceNo: (isRefund ? 'CN-' : '') + (invoice.Reference || '') },
    basicInformation: { invoiceNo: '', antifakeCode: '', deviceNo: cfg.deviceNo, issuedDate, operator: cfg.businessName || cfg.tradeName || 'system', currency: invoice.Currency || 'UGX', oriInvoiceId: invoice.OriginalFDN || '', invoiceType: '1', invoiceKind: vat ? '1' : '2', dataSource: '103', invoiceIndustryCode: '101', isBatch: '0', isRefund: isRefund ? '1' : '0' },
    buyerDetails: { buyerTin, buyerNinBrn: '', buyerPassportNum, buyerLegalName, buyerBusinessName, buyerAddress, buyerEmail: invoice.CustomerEmail || '', buyerMobilePhone: invoice.CustomerPhone || '', buyerLinePhone: '', buyerPlaceOfBusi: invoice.CustomerDept || '', buyerType, buyerCitizenship, buyerSector: '', buyerReferenceNo: '' },
    goodsDetails,
    taxDetails,
    summary: { netAmount: r2(net), taxAmount: r2(taxAmount), grossAmount: r2(gross), itemCount: String(goodsDetails.length), modeCode: '1', remarks: invoice.Notes || '', qrCode: '' },
    payWay: (invoice.PayWays && invoice.PayWays.length)
      ? invoice.PayWays.map((pw, i) => ({ paymentMode: String(pw.mode || '101'), paymentAmount: r2(pw.amount || 0), orderNumber: String(i + 1) }))
      : [{ paymentMode: String(invoice.PaymentMode || '101'), paymentAmount: r2(gross), orderNumber: '1' }],
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

app.get('/api/commodity/search', (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase().trim();
    if (q.length < 2) return res.json([]);
    const tree = getTree();
    const results = [];
    for (const [sc, seg] of Object.entries(tree)) {
      for (const [fc, fam] of Object.entries(seg.f)) {
        for (const [cc, cls] of Object.entries(fam.c)) {
          if (!cls.d) continue;
          for (const [dc, com] of Object.entries(cls.d)) {
            const comName = typeof com === 'string' ? com : com.n;
            if (comName.toLowerCase().includes(q) || dc.includes(q)) {
              results.push({ commodityCode: dc, commodityName: comName,
                classCode: cc, className: cls.n, familyCode: fc, familyName: fam.n,
                segmentCode: sc, segmentName: seg.n });
              if (results.length >= 20) break;
            }
          }
          if (results.length >= 20) break;
        }
        if (results.length >= 20) break;
      }
      if (results.length >= 20) break;
    }
    res.json(results);
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
  const formBase = isService ? '/non-inventory-item-form' : '/inventory-item-form';

  try {
    // Look up custom field GUIDs. Accept several common names so renaming the
    // Manager custom fields (e.g. to "Commodity Code") keeps working.
    let comCodeFieldKey = null, catPathFieldKey = null;
    try {
      const cf = await mgrTextCustomFields(ep, accessToken);
      const find = (...names) => { for (const n of names) { if (cf.byName[n]) return cf.byName[n]; } return null; };
      comCodeFieldKey = find('EFRIS Commodity Code', 'Commodity Code', 'EFRIS Commodity', 'Commodity');
      catPathFieldKey = find('EFRIS Category Path', 'Segment / Class Grouping', 'EFRIS Segment / Class Grouping', 'EFRIS Segment', 'Category Path', 'Class Grouping');
    } catch(_) {}

    const catPath = [item.segment, item.family, item.cls].filter(Boolean).join(' >> ');
    const codeLower = (item.code || '').toLowerCase();
    const nameLower = (item.name || '').toLowerCase();

    // Step 1: Find existing item key by fetching the list
    console.log(`\n🔗 Syncing to Manager.io: ${ep} — ${item.code} ${item.name}`);
    const listR = await managerCall(ep, accessToken, 'GET', listPath, null);
    const existingList = (listR.status === 200 && listR.data && listR.data[listKey]) || [];
    const match = existingList.find(i => {
      const cd = (i.code || i.Code || '').toLowerCase();
      return codeLower && cd && cd === codeLower;
    }) || existingList.find(i => {
      const nm = (i.itemName || i.name || i.Name || '').toLowerCase();
      return nm === nameLower;
    });

    let r, action, existingKey = null;

    if (match) {
      // Step 2a: UPDATE — GET the full form, merge our fields, POST back to form endpoint
      existingKey = match.key || match.Key;
      console.log(`   Existing item (key ${existingKey}) — GET form → mutate → POST form`);
      const formR = await managerCall(ep, accessToken, 'GET', `${formBase}/${existingKey}`, null);
      if (formR.status !== 200) {
        return res.json({ success: false, error: `Could not fetch item form: HTTP ${formR.status}` });
      }
      // Merge our fields into the form (preserving all other Manager fields).
      // Non-inventory and inventory items use different field names in Manager API.
      const form = Object.assign({}, formR.data || {});
      console.log(`   Form fields available: ${Object.keys(form).join(', ')}`);
      const price = parseFloat(item.price) || 0;
      form.Code     = item.code;
      form.UnitName = item.uom;
      if (item.remarks) form.DefaultLineDescription = item.remarks;
      if (isService) {
        // Non-inventory items
        form.Name              = item.name;
        form.HasSalesUnitPrice = price > 0;
        form.SalesUnitPrice    = price;
      } else {
        // Inventory items — confirmed field names from GET form response
        form.ItemName                 = item.name;
        form.DefaultSalesUnitPrice    = price;
        form.HasDefaultSalesUnitPrice = price > 0;
        // Note: inventory items have no Code field in the form API
      }
      // Tax code — look up Manager tax code GUID matching the VAT designation
      if (item.vat) {
        try {
          const taxGuid = await mgrTaxCodeGuid(ep, accessToken, item.vat);
          if (taxGuid) { form.TaxCode = taxGuid; console.log(`   Tax code GUID → ${taxGuid} (${item.vat})`); }
          else { console.log(`   ⚠ No matching tax code found for VAT type: ${item.vat}`); }
        } catch(_) {}
      }
      // Merge custom fields — preserve existing, add/overwrite ours
      const cfStrings = Object.assign({}, (form.CustomFields2 && form.CustomFields2.Strings) || {});
      if (comCodeFieldKey && item.comCode) cfStrings[comCodeFieldKey] = item.comCode;
      if (catPathFieldKey && catPath)      cfStrings[catPathFieldKey] = catPath;
      if (Object.keys(cfStrings).length)   form.CustomFields2 = { Strings: cfStrings };
      if (item.whenSold) form.WhenSold = item.whenSold;
      if (item.whenPurchased) form.WhenPurchased = item.whenPurchased;
      if (item.division) form.Division = item.division;
      if (item.salesDivision) form.SalesDivision = item.salesDivision;
      if (!isService && item.costMethod != null && item.costMethod !== '') form.CostMethod = item.costMethod;
      r = await managerCall(ep, accessToken, 'POST', `${formBase}/${existingKey}`, form);
      action = 'updated';
      const written = Object.keys(cfStrings).length;
      console.log(`   Manager form POST: HTTP ${r.status}`);
      if (comCodeFieldKey) console.log(`   EFRIS Commodity Code → ${item.comCode}`);
      if (catPathFieldKey) console.log(`   EFRIS Category Path  → ${catPath}`);
      const ok = r.status >= 200 && r.status < 300;
      return res.json(ok
        ? { success: true, action, managerId: existingKey, comCodeWritten: !!(comCodeFieldKey && item.comCode), fieldsWritten: written }
        : { success: false, error: `Manager form POST returned HTTP ${r.status}: ${JSON.stringify(r.data||'').slice(0,200)}` });

    } else {
      // Step 2b: CREATE — use the form endpoint (POST without a key) for both
      // inventory and non-inventory items. POST to the list endpoint works for
      // non-inventory items but silently fails for inventory items in Manager v2.
      const createPath = isService ? '/non-inventory-item-form' : '/inventory-item-form';
      console.log(`   No existing item found — creating via POST ${createPath}`);
      const cfStrings = {};
      if (comCodeFieldKey && item.comCode) cfStrings[comCodeFieldKey] = item.comCode;
      if (catPathFieldKey && catPath)      cfStrings[catPathFieldKey] = catPath;
      const price = parseFloat(item.price) || 0;
      const payload = { Code: item.code, Name: item.name, UnitName: item.uom, DefaultLineDescription: item.remarks || '' };
      if (isService) {
        payload.HasDefaultLineDescription = !!(item.remarks);
        payload.HasSalesUnitPrice = price > 0;
        payload.HasDefaultSalesUnitPrice = price > 0;
        payload.SalesUnitPrice    = price;
        payload.DefaultSalesUnitPrice = price;
      } else {
        payload.ItemName                 = item.name;
        payload.DefaultSalesUnitPrice    = price;
        payload.HasDefaultSalesUnitPrice = price > 0;
      }
      // Tax code for create
      if (item.vat) {
        try { const tg = await mgrTaxCodeGuid(ep, accessToken, item.vat); if (tg) payload.TaxCode = tg; } catch(_) {}
      }
      if (item.whenSold) payload.WhenSold = item.whenSold;
      if (item.whenPurchased) payload.WhenPurchased = item.whenPurchased;
      if (item.division) payload.Division = item.division;
      if (item.salesDivision) payload.SalesDivision = item.salesDivision;
      if (!isService && item.costMethod != null && item.costMethod !== '') payload.CostMethod = item.costMethod;
      if (Object.keys(cfStrings).length) payload.CustomFields2 = { Strings: cfStrings };
      r = await managerCall(ep, accessToken, 'POST', createPath, payload);
      action = 'created';
      // Form endpoint on success redirects (302) or returns 200/201; fetch new key
      // by looking up the item by code in the list
      if ((r.status >= 200 && r.status < 400)) {
        try {
          const listR = await managerCall(ep, accessToken, 'GET', listPath, null);
          const arr = listR.data && listR.data[listKey];
          if (Array.isArray(arr)) {
            const created = arr.find(i => {
              const cd = (i.code || i.Code || '').toLowerCase();
              const nm = (i.itemName || i.name || i.Name || '').toLowerCase();
              return (codeLower && cd === codeLower) || nm === nameLower;
            });
            if (created) existingKey = created.key || created.Key;
          }
        } catch(_) {}
      }
      console.log(`   Manager POST: HTTP ${r.status} → key: ${existingKey||'unknown'}`);
      const ok = r.status >= 200 && r.status < 400;
      const written = Object.keys(cfStrings).length;
      return res.json(ok
        ? { success: true, action, managerId: existingKey || null, comCodeWritten: !!(comCodeFieldKey && item.comCode), fieldsWritten: written }
        : { success: false, error: `Manager returned HTTP ${r.status}: ${JSON.stringify(r.data||'').slice(0,200)}` });
    }
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
      key:            i.key || i.Key,
      code:           i.code || i.Code || '',
      name:           i.itemName || i.name || i.Name || '',
      unitName:       i.unitName || i.UnitName || '',
      salesUnitPrice: i.salesUnitPrice || i.SalesUnitPrice || 0,
      description:    i.description || i.Description || '',
      type
    }));
    res.json({ success: true, items: [...normalize(services,'Service'), ...normalize(goods,'Goods')] });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/api/manager/accounts', async (req, res) => {
  const ep = normEp(req.query.ep || '');
  const tk = req.query.tk || '';
  if (!ep || !tk) return res.status(400).json({ success: false, error: 'ep and tk required' });
  // Try several common Manager account-list endpoints
  const paths = ['/profit-and-loss-accounts', '/income-statement-accounts', '/balance-sheet-accounts', '/accounts', '/chart-of-accounts'];
  for (const path of paths) {
    try {
      const r = await managerCall(ep, tk, 'GET', path, null);
      if (r.status === 200 && r.data) {
        // Find the array inside the response object
        const arr = Array.isArray(r.data) ? r.data : Object.values(r.data).find(v => Array.isArray(v) && v.length && v[0].key);
        if (arr && arr.length) {
          const accounts = arr.map(a => ({ key: a.key || a.Key, name: a.name || a.Name || a.accountName || '' })).filter(a => a.key);
          console.log(`   Manager accounts from ${path}: ${accounts.length} items`);
          return res.json({ success: true, accounts });
        }
      }
    } catch(e) {}
  }
  res.json({ success: true, accounts: [] });
});

app.get('/api/manager/divisions', async (req, res) => {
  const ep = normEp(req.query.ep || '');
  const tk = req.query.tk || '';
  if (!ep || !tk) return res.status(400).json({ success: false, error: 'ep and tk required' });
  try {
    const r = await managerCall(ep, tk, 'GET', '/divisions', null);
    if (r.status === 200 && r.data) {
      const arr = Array.isArray(r.data) ? r.data : (r.data.divisions || []);
      const divisions = arr.map(d => ({ key: d.key || d.Key, name: d.name || d.Name || '' })).filter(d => d.key);
      return res.json({ success: true, divisions });
    }
    res.json({ success: true, divisions: [] });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/manager/inventory-adjust', async (req, res) => {
  const { managerEndpoint, accessToken, itemKey, qty, date, description } = req.body || {};
  if (!managerEndpoint || !accessToken || !itemKey) {
    return res.status(400).json({ success: false, error: 'managerEndpoint, accessToken and itemKey are required' });
  }
  const ep = normEp(managerEndpoint);
  const payload = {
    Date: date || new Date().toISOString().slice(0, 10),
    Description: description || 'Initial stock entry',
    Lines: [{ InventoryItem: itemKey, Qty: parseFloat(qty) || 0, UnitCost: 0 }]
  };
  // Manager's inventory adjustment document type varies — try paths in order
  const adjPaths = ['/inventory-write-up-form', '/inventory-quantity-adjustment-form', '/inventory-adjustment-form', '/inventory-write-ups-form'];
  try {
    let lastErr = '';
    for (const adjPath of adjPaths) {
      const r = await managerCall(ep, accessToken, 'POST', adjPath, payload);
      console.log(`   Inventory adjust ${adjPath}: HTTP ${r.status} for item ${itemKey} qty=${qty}`);
      if (r.status >= 200 && r.status < 400) return res.json({ success: true, path: adjPath });
      if (r.status !== 404) { lastErr = `HTTP ${r.status}: ${JSON.stringify(r.data||'').slice(0,200)}`; break; }
      lastErr = `HTTP 404 on ${adjPath}`;
    }
    res.json({ success: false, error: `Could not create inventory adjustment — ${lastErr}. Please set opening stock in Manager directly (Inventory → Write-ups).` });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Full details for a single Manager.io item (for import prefill)
app.get('/api/goods/manager-item-detail', async (req, res) => {
  const ep = normEp(req.query.ep || '');
  const tk = req.query.tk || '';
  const key = req.query.key || '';
  const type = req.query.type || 'Service';
  if (!ep || !tk || !key) return res.status(400).json({ success: false, error: 'ep, tk and key are required' });
  const itemPath = type === 'Goods' ? `/inventory-item-form/${key}` : `/non-inventory-item-form/${key}`;
  try {
    const r = await managerCall(ep, tk, 'GET', itemPath, null);
    if (r.status !== 200) return res.json({ success: false, error: `Manager returned HTTP ${r.status}` });
    const d = r.data || {};
    // Manager returns camelCase on GET; normalize both cases
    const cf2 = d.customFields2 || d.CustomFields2 || {};
    const cfStrings = cf2.strings || cf2.Strings || {};
    console.log(`   Detail for ${key}:`, JSON.stringify(d).slice(0, 300));
    res.json({ success: true, item: {
      key,
      code:                   d.code || d.Code || '',
      name:                   d.name || d.Name || d.itemName || '',
      unitName:               d.unitName || d.UnitName || '',
      salesUnitPrice:         d.salesUnitPrice || d.SalesUnitPrice || 0,
      hasSalesUnitPrice:      !!(d.hasSalesUnitPrice || d.HasSalesUnitPrice),
      description:            d.description || d.Description || '',
      defaultLineDescription: d.defaultLineDescription || d.DefaultLineDescription || '',
      customFieldStrings:     cfStrings,
      division:               d.division || d.Division || '',
      salesDivision:          d.salesDivision || d.SalesDivision || '',
      costMethod:             d.costMethod != null ? d.costMethod : (d.CostMethod != null ? d.CostMethod : ''),
      whenSold:               d.whenSold || d.WhenSold || '',
      whenPurchased:          d.whenPurchased || d.WhenPurchased || '',
    }});
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

// Live, valid EFRIS measure units for the taxpayer (from T115 dictionary).
// The frontend uses this to let the user pick a guaranteed-valid unit code.
app.post('/api/efris/measure-units', async (req, res) => {
  const { tin, deviceNo, efrisPassword, mode } = req.body || {};
  if (!tin || !deviceNo) return res.status(400).json({ success: false, error: 'tin and deviceNo are required' });
  const eu = mode === 'production'
    ? 'https://efrisws.ura.go.ug/ws/taapp/getInformation'
    : 'https://efristest.ura.go.ug/efrisws/ws/taapp/getInformation';
  try {
    const session = await getSession(tin, deviceNo, efrisPassword, eu);
    const units = await getEfrisMeasureUnits(tin, deviceNo, session, eu);
    res.json({ success: true, units });
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

    // Use pre-resolved efrisUom if provided (set in frontend from auto-detection)
    // Otherwise fall back to name lookup against uom.json
    let uomCode = 'UN';
    // Only use efrisUom if it looks like a code (no spaces, ≤5 chars)
    const rawEfrisUom = (item.efrisUom || '').trim();
    const efrisUomIsCode = rawEfrisUom && !rawEfrisUom.includes(' ') && rawEfrisUom.length <= 5;
    if (efrisUomIsCode) {
      uomCode = rawEfrisUom.toUpperCase();
      console.log(`   UOM: "${item.uom}" → EFRIS code "${uomCode}" (from item)`);
    } else {
      try {
        const units = getUnits();
        const match = units.find(u => u.name.toLowerCase() === (item.uom || '').toLowerCase());
        if (match) {
          uomCode = match.code;
        } else if (item.uom && item.uom.length <= 3) {
          uomCode = item.uom;
          console.log(`   ℹ UOM "${item.uom}" treated as custom EFRIS code`);
        } else {
          uomCode = 'UN';
          console.log(`   ⚠ UOM "${item.uom}" exceeds 3-byte EFRIS limit — using UN`);
        }
      } catch(_) {}
    }

    // VAT tax item — taxCategoryCode: '01'=standard(18%), '02'=zero-rated, '03'=exempt
    const vatCat = item.vat === 'Exempt' ? '03' : item.vat === 'Zero' ? '02' : '01';
    const taxRate = vatCat === '01' ? '0.18' : '0.00';

    // goodsTypeCode: '101'=Goods, '102'=Service (URA numeric codes)
    const goodsTypeCode = (item.type || 'Service') === 'Goods' ? '101' : '102';

    // T130 = Goods Registration (Add Product Code).
    // currency: EFRIS accepts ISO codes (USD, EUR, GBP…) for foreign-currency items.
    // UGX is the default base currency — omit the field entirely when pricing in UGX.
    // taxItems are for invoices (T109), not goods registration — exclude here.
    // currency is required by T130, but it wants the EFRIS dictionary code (not "UGX").
    // Resolve via the T115 data dictionary.
    const t130Currency = await resolveEfrisCurrency(item.cur || 'UGX', tin, deviceNo, session, eu);
    const t130Payload = {
      goodsCode:          item.code,
      goodsName:          item.name,
      goodsTypeCode,
      // Services (goodsTypeCode=102) must use measureUnit '102' — physical unit
      // codes are rejected with rc:2981 "default measure unit should be '102'"
      measureUnit:        goodsTypeCode === '102' ? '102' : uomCode,
      unitPrice:             String(parseFloat(item.price) || 0),
      currency:              t130Currency,
      commodityCategoryId:   item.comCode || '',
      commodityCategoryName: item.comName || '',
      haveExciseTax:         item.excise === 'Yes' ? '101' : '102',
      description:           item.remarks || '',
      stockPrewarning:       '0',
      pricingMode:           '1',
      havePieceUnit:         '102',
      pieceUnit:             '',
      packageScaledValue:    '',
      scaledValue:           '',
      discountTaxRate:       '',
    };

    console.log(`\n📦 Registering goods with EFRIS T130: ${item.code} — ${item.name}`);
    console.log(`   Payload: goodsCode=${t130Payload.goodsCode}, categoryId=${t130Payload.commodityCategoryId}, measureUnit=${uomCode}, price=${t130Payload.unitPrice}, currency=${t130Currency}, vatCat=${vatCat}, type=${goodsTypeCode}`);

    // T130 is a BATCH interface — payload must be an array even for a single item
    const t130 = await efrisCall(eu, efrisEnvEnc('T130', [t130Payload], tin, deviceNo, session.aesKey, session.privatePem));
    const outerRc = t130.data && t130.data.returnStateInfo ? t130.data.returnStateInfo.returnCode : null;
    const outerRm = t130.data && t130.data.returnStateInfo ? t130.data.returnStateInfo.returnMessage : '';
    console.log(`   T130 outer rc: ${outerRc} (${outerRm})`);

    // Decrypt per-item results from response content
    let itemRc = outerRc, itemRm = outerRm;
    if (t130.data && t130.data.data && t130.data.data.content) {
      try {
        const raw = aesDecryptStr(t130.data.data.content, session.aesKey);
        const results = JSON.parse(raw);
        const r0 = Array.isArray(results) ? results[0] : results;
        if (r0) {
          itemRc = r0.returnCode || r0.returnStateInfo?.returnCode || outerRc;
          itemRm = r0.returnMessage || r0.returnStateInfo?.returnMessage || outerRm;
          console.log(`   T130 item rc: ${itemRc} — ${itemRm}`);
        }
      } catch(e) { console.log(`   (could not decrypt T130 item response: ${e.message})`); }
    }

    // rc:00 = success; rc:602 = already exists (treat as success — item is registered)
    const ok = itemRc === '00' || itemRc === '602';
    const alreadyExists = itemRc === '602';
    if (ok) {
      console.log(alreadyExists ? `   ✓ Item already registered in EFRIS` : `   ✅ Registered successfully`);
    } else {
      console.log(`   ❌ T130 failed: ${itemRc} — ${itemRm}`);
    }
    // For an invalid measure unit, attach a few valid options to guide the user.
    let unitProblem = false, validUnits = [];
    if (!ok && (itemRc === '2235' || itemRc === '2234' || /measureunit/i.test(itemRm || ''))) {
      unitProblem = true;
      try { validUnits = await getEfrisMeasureUnits(tin, deviceNo, session, eu); } catch(_) {}
    }
    res.json({ success: ok, returnCode: itemRc, returnMessage: itemRm, alreadyExists,
      unitProblem, sentUnit: uomCode, validUnits,
      error: ok ? undefined : `EFRIS T130: ${itemRc} — ${itemRm}` });
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
    // Guard: a receipt that clears an invoice has no goods lines — EFRIS can't
    // process it. The original invoice should be submitted instead.
    const lines = invoice.Lines || [];
    if (lines.length === 0) {
      return res.json({ success: false, error: 'This document has no line items. If this is a payment receipt that clears an invoice, submit the original sales invoice to EFRIS instead.' });
    }
    // Warn if any line is falling back to the auto-generated ITEM code (means the
    // Manager item has no EFRIS product code set, and EFRIS will reject it as rc:41).
    const t109data = buildT109(invoice, config);
    const missingCodes = t109data.goodsDetails.filter(g => /^ITEM\d+$/.test(g.itemCode));
    if (missingCodes.length) {
      console.log(`   ⚠ T109: ${missingCodes.length} line(s) have auto-generated itemCode (no EFRIS product code on Manager item): ${missingCodes.map(g=>g.item).join(', ')}`);
    }
    t109data.goodsDetails.forEach(g => console.log(`   T109 line: item="${g.item}" itemCode="${g.itemCode}" taxRule="${g.taxRule}"`));
    const session = await getSession(config.tin, config.deviceNo, config.efrisPassword, eu);
    if (!session.aesKey) throw new Error('No AES key available to encrypt T109');
    const t109 = await efrisCall(eu, efrisEnvEnc('T109', t109data, config.tin, config.deviceNo, session.aesKey, session.privatePem));
    const rc = t109.data && t109.data.returnStateInfo ? t109.data.returnStateInfo.returnCode : null;
    const rm = t109.data && t109.data.returnStateInfo ? t109.data.returnStateInfo.returnMessage : '';
    let contentStr = null;
    if (t109.data && t109.data.data && t109.data.data.content) {
      try { contentStr = aesDecryptStr(t109.data.data.content, session.aesKey); }
      catch(e) { try { contentStr = Buffer.from(t109.data.data.content, 'base64').toString('utf8'); } catch(_) {} }
    }
    let fdn = null, qrCode = null, antifakeCode = null;
    try {
      if (contentStr) {
        const d = JSON.parse(contentStr);
        console.log(`   T109 response content keys: ${Object.keys(d).join(', ')}`);
        console.log(`   T109 basicInformation: ${JSON.stringify(d.basicInformation || {})}`);
        const bi = d.basicInformation || {};
        fdn = d.fdn || d.fiscalDocumentNumber || bi.invoiceNo || bi.fdn;
        antifakeCode = d.antiFakeCode || d.antifakeCode || bi.antifakeCode || bi.antiFakeCode;
        const issuedDate = bi.issuedDate || bi.issueDate || d.issuedDate || '';
        const deviceNo = bi.deviceNo || bi.deviceNumber || d.deviceNo || config.deviceNo || '';
        qrCode = d.qrCode || d.qrCodeBase64 || bi.qrCode;
        // Store antifakeCode as the QR content — Manager's "QR Code" type field
        // renders whatever text is stored as a QR image on printed documents.
        // A plain numeric string (no URL special chars) renders reliably.
        if (!qrCode && antifakeCode) qrCode = antifakeCode;
        console.log(`   T109 result — FDN: ${fdn}, antifakeCode: ${antifakeCode}, deviceNo: ${deviceNo}, issuedDate: ${issuedDate}, qrCode: ${qrCode}`);
      }
    } catch(e) { console.log(`   T109 content parse error: ${e.message}`); }
    const ok = rc === '00' || !!fdn;
    res.json(ok
      ? { success: true, fdn, qrCode, antifakeCode, deviceNo: config.deviceNo, issuedDate: new Date().toISOString(), returnCode: rc, returnMessage: rm }
      : { success: false, error: 'URA ' + rc + ': ' + rm, returnCode: rc });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/efris/verify-tin', async (req, res) => {
  const { buyerTin, config } = req.body || {};
  if (!buyerTin || !config || !config.tin) return res.status(400).json({ success: false, error: 'buyerTin and config required' });
  const eu = config.mode === 'production'
    ? 'https://efrisws.ura.go.ug/ws/taapp/getInformation'
    : 'https://efristest.ura.go.ug/efrisws/ws/taapp/getInformation';
  try {
    const session = await getSession(config.tin, config.deviceNo, config.efrisPassword, eu);
    // T119: taxpayer query — look up a TIN to verify it exists and get details
    const t119 = await efrisCall(eu, efrisEnvEnc('T119', { tin: buyerTin, ninBrn: '', queryType: '1' }, config.tin, config.deviceNo, session.aesKey, session.privatePem));
    const rc = t119.data && t119.data.returnStateInfo ? t119.data.returnStateInfo.returnCode : null;
    const rm = t119.data && t119.data.returnStateInfo ? t119.data.returnStateInfo.returnMessage : '';
    let info = null;
    if (t119.data && t119.data.data && t119.data.data.content) {
      try {
        const s = aesDecryptStr(t119.data.data.content, session.aesKey);
        info = JSON.parse(s);
        console.log('[T119 taxpayer fields]', JSON.stringify(info));
      } catch(e) {}
    }
    const ok = rc === '00';
    // Extract taxpayer name from whichever field EFRIS returns (varies by API version)
    let taxpayerName = '';
    if (info) {
      taxpayerName = info.taxpayerName || info.taxpayerLegalName || info.legalName
        || info.entityName || info.taxPayerName || info.businessName || info.name || '';
    }
    res.json(ok
      ? { success: true, tin: buyerTin, taxpayer: info, taxpayerName, returnCode: rc }
      : { success: false, error: 'URA ' + rc + ': ' + rm, returnCode: rc });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/efris/preview-invoice', async (req, res) => {
  const { invoice, config } = req.body || {};
  if (!invoice || !config) return res.status(400).json({ success: false, error: 'invoice and config required' });
  try {
    const t109data = buildT109(invoice, config);
    res.json({ success: true, payload: t109data });
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
    // Write back to whichever document this key belongs to (invoice or receipt)
    let formBase = '/sales-invoice-form';
    let getR = await managerCall(ep, accessToken, 'GET', '/sales-invoice-form/' + key, null);
    if (getR.status !== 200 || (getR.data && getR.data.error)) {
      const rcptR = await managerCall(ep, accessToken, 'GET', '/receipt-form/' + key, null);
      if (rcptR.status === 200 && rcptR.data && !rcptR.data.error) { getR = rcptR; formBase = '/receipt-form'; }
    }
    if (getR.status !== 200) return res.json({ success: false, error: 'Manager GET returned ' + getR.status, hint: 'Token rejected or document key not found' });
    const form = getR.data;
    const cf = await mgrTextCustomFields(ep, accessToken);
    form.CustomFields2 = form.CustomFields2 || {};
    form.CustomFields2.Strings = form.CustomFields2.Strings || {};
    const setCFAny = (names, val) => { for (const n of names) { const k = cf.byName[n]; if (k && val != null && val !== '') { form.CustomFields2.Strings[k] = String(val); break; } } };
    setCFAny(['Fiscal Document Number', 'EFRIS FDN'], efrisData.fdn);
    setCFAny(['Verification Code', 'EFRIS Antifake Code'], efrisData.antifakeCode);
    // QR Code field: store antifake code — Manager "QR Code" type renders it as QR image on printed docs
    setCFAny(['QR Code', 'EFRIS QR Code URL', 'EFRIS QR Code'], efrisData.qrCode || efrisData.antifakeCode);
    setCFAny(['EFRIS Device Number', 'Device Number'], efrisData.deviceNo);
    setCFAny(['EFRIS Issued Time', 'Issued Time'], efrisData.issuedDate ? new Date(efrisData.issuedDate).toLocaleString('en-UG', { timeZone: 'Africa/Kampala' }) : '');
    setCFAny(['Status', 'EFRIS Status'], 'Submitted');
    setCFAny(['Submission Date', 'EFRIS Submission Date'], new Date().toISOString().slice(0,10));
    const postR = await managerCall(ep, accessToken, 'POST', formBase + '/' + key, form);
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
    const list = ((r.data && r.data.salesInvoices) || []).map(i => ({ key: i.key, reference: i.reference, customer: i.customer, amount: (i.invoiceAmount && i.invoiceAmount.value) || 0, currency: (i.invoiceAmount && i.invoiceAmount.currency) || '', date: i.issueDate, status: i.status, docType: 'invoice' }));
    // Also include receipts (non-VAT cash sales). Tolerate absence / different shape.
    try {
      const rr = await managerCall(ep, tk, 'GET', '/receipts', null);
      const rcpts = (rr.status === 200 && rr.data && (rr.data.receipts || rr.data.receiptsAndPayments)) || [];
      rcpts.forEach(i => list.push({ key: i.key, reference: i.reference || i.payee || '(receipt)', customer: i.payer || i.customer || i.contact || '', amount: (i.amount && i.amount.value) || i.amount || 0, currency: (i.amount && i.amount.currency) || '', date: i.date || i.issueDate, status: i.status, docType: 'receipt' }));
    } catch(_) {}
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
