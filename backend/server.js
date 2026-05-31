const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const DATA_DIR = path.join(__dirname, 'data');
let TREE = {};
let UNITS = [];

try {
  TREE = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'goods_tree.json'), 'utf8'));
  console.log(`Loaded goods tree: ${Object.keys(TREE).length} segments`);
} catch (e) { console.error('Failed to load goods_tree.json:', e.message); }

try {
  UNITS = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'units.json'), 'utf8'));
  console.log(`Loaded units: ${UNITS.length} entries`);
} catch (e) { console.error('Failed to load units.json:', e.message); }

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', segments: Object.keys(TREE).length, units: UNITS.length, uptime: process.uptime() });
});

app.get('/api/segments', (req, res) => {
  const { q } = req.query;
  let segs = Object.entries(TREE).map(([code, seg]) => ({ code, name: seg.n }));
  if (q && q.length >= 2) {
    const ql = q.toLowerCase();
    segs = segs.filter(s => s.name.toLowerCase().includes(ql) || s.code.includes(ql));
  }
  res.json(segs);
});

app.get('/api/segments/:segCode/families', (req, res) => {
  const seg = TREE[req.params.segCode];
  if (!seg) return res.status(404).json({ error: 'Segment not found' });
  res.json(Object.entries(seg.f).map(([code, fam]) => ({ code, name: fam.n })));
});

app.get('/api/segments/:segCode/families/:famCode/classes', (req, res) => {
  const seg = TREE[req.params.segCode];
  if (!seg) return res.status(404).json({ error: 'Segment not found' });
  const fam = seg.f[req.params.famCode];
  if (!fam) return res.status(404).json({ error: 'Family not found' });
  res.json(Object.entries(fam.c).map(([code, cls]) => ({ code, name: cls.n })));
});

app.get('/api/segments/:segCode/families/:famCode/classes/:clsCode/commodities', (req, res) => {
  const seg = TREE[req.params.segCode];
  if (!seg) return res.status(404).json({ error: 'Segment not found' });
  const fam = seg.f[req.params.famCode];
  if (!fam) return res.status(404).json({ error: 'Family not found' });
  const cls = fam.c[req.params.clsCode];
  if (!cls) return res.status(404).json({ error: 'Class not found' });
  res.json(Object.entries(cls.d).map(([code, com]) => ({ code, name: com.n, isService: com.s })));
});

app.get('/api/units', (req, res) => res.json(UNITS));

app.get('/api/commodity/:code', (req, res) => {
  const target = req.params.code.padStart(8, '0');
  for (const [sc, seg] of Object.entries(TREE)) {
    for (const [fc, fam] of Object.entries(seg.f)) {
      for (const [cc, cls] of Object.entries(fam.c)) {
        if (cls.d[target]) {
          return res.json({ commodityCode: target, commodityName: cls.d[target].n, isService: cls.d[target].s,
            classCode: cc, className: cls.n, familyCode: fc, familyName: fam.n, segmentCode: sc, segmentName: seg.n });
        }
      }
    }
  }
  res.status(404).json({ error: 'Commodity not found' });
});

const FRONTEND = path.join(__dirname, '..', 'frontend');
app.use(express.static(FRONTEND));
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) res.sendFile(path.join(FRONTEND, 'index.html'));
});

app.listen(PORT, () => console.log(`Goods/Services Configurator running on port ${PORT}`));
