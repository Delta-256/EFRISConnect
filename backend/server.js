process.on('uncaughtException', err => { console.error('UNCAUGHT:', err); process.exit(1); });
process.on('unhandledRejection', err => { console.error('UNHANDLED:', err); process.exit(1); });
console.log('Starting server, PORT=', process.env.PORT);

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const DATA_DIR = path.join(__dirname, 'data');

let TREE = null;
let UNITS = null;

function getTree() {
  if (!TREE) {
    console.log('Loading goods_tree.json...');
    TREE = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'goods_tree.json'), 'utf8'));
    console.log(`Loaded: ${Object.keys(TREE).length} segments`);
  }
  return TREE;
}

function getUnits() {
  if (!UNITS) {
    UNITS = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'units.json'), 'utf8'));
  }
  return UNITS;
}

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
    res.json(Object.entries(cls.d).map(([code, com]) => ({ code, name: com.n, isService: com.s })));
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
          if (cls.d[target]) {
            return res.json({ commodityCode: target, commodityName: cls.d[target].n,
              isService: cls.d[target].s, classCode: cc, className: cls.n,
              familyCode: fc, familyName: fam.n, segmentCode: sc, segmentName: seg.n });
          }
        }
      }
    }
    res.status(404).json({ error: 'Commodity not found' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

const FRONTEND = path.join(__dirname, '..', 'frontend');
app.use(express.static(FRONTEND));
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) res.sendFile(path.join(FRONTEND, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Goods/Services Configurator running on port ${PORT}`);
});