require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = Number(process.env.PORT) || 4000;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '15mb' }));

let currentMongoUri = (process.env.MONGODB_URI || '').trim();
let currentDbName = (process.env.MONGODB_DB_NAME || 'klinikapp_db').trim();
const API_SECRET = (process.env.KLINIKAPP_API_SECRET || '').trim();

let mongoClient = null;
let mongoConnected = false;
let memoryFallbackState = null;

// ====================================================================
// DAXİLİ YERLİ VERİLƏNLƏR BAZASI (Xarici MongoDB tələb olunmur!)
// ====================================================================
const DATA_DIR = path.resolve(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'klinikapp_state.json');

try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (fs.existsSync(DATA_FILE)) {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      memoryFallbackState = parsed;
      console.log('[Daxili Baza] Əvvəlki məlumatlar yerli bazadan (data/klinikapp_state.json) uğurla bərpa edildi.');
    }
  }
} catch (e) {
  console.warn('[Daxili Baza] Yerli fayl bərpa xətası:', e.message);
}

function saveStateToDisk(state) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Daxili Baza] Fayla yazma xətası:', err.message);
  }
}

// ====================================================================
// Könüllü xarici MongoDB bağlantısı (əgər gələcəkdə istifadə edilsə)
// ====================================================================
async function connectMongo(uri, dbName) {
  if (!uri || uri.includes('username:password')) {
    mongoConnected = false;
    return false;
  }
  try {
    if (mongoClient) {
      await mongoClient.close().catch(() => {});
    }
    mongoClient = new MongoClient(uri);
    await mongoClient.connect();
    await mongoClient.db(dbName).command({ ping: 1 });
    mongoConnected = true;
    currentMongoUri = uri;
    currentDbName = dbName;
    console.log('[MongoDB] Xarici MongoDB uğurla qoşuldu:', dbName);
    return true;
  } catch (err) {
    console.error('[MongoDB] Qoşulma xətası:', err.message);
    mongoConnected = false;
    return false;
  }
}

function requireSecret(req, res, next) {
  if (!API_SECRET) return next();
  const provided = req.headers['x-klinikapp-secret'];
  if (provided !== API_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized secret key' });
  }
  return next();
}

app.get('/api/health', async (_req, res) => {
  res.json({
    ok: true,
    service: 'Klinikapp Cloud Server',
    storageMode: mongoConnected ? 'external_mongodb' : 'internal_embedded_db',
    mongoConnected,
    hasSavedState: Boolean(memoryFallbackState),
    updatedAt: memoryFallbackState?.updatedAt || 0
  });
});

app.post('/api/config/mongo', requireSecret, async (req, res) => {
  const { uri, dbName } = req.body || {};
  if (!uri || typeof uri !== 'string') {
    return res.status(400).json({ ok: false, error: 'MongoDB URI tələb olunur.' });
  }
  const ok = await connectMongo(uri.trim(), (dbName || currentDbName || 'klinikapp_db').trim());
  res.json({ ok, mongoConnected, dbName: currentDbName });
});

app.get('/api/sync/state', requireSecret, async (_req, res) => {
  try {
    if (mongoConnected && mongoClient) {
      const col = mongoClient.db(currentDbName).collection('klinikapp_state');
      const doc = await col.findOne({ _id: 'global_state' });
      if (doc) {
        return res.json({
          hospitals: doc.hospitals,
          medicines: doc.medicines,
          shortcuts: doc.shortcuts,
          updatedAt: doc.updatedAt
        });
      }
    }
    if (memoryFallbackState) {
      return res.json(memoryFallbackState);
    }
    return res.json({ empty: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/sync/state', requireSecret, async (req, res) => {
  try {
    const { hospitals, medicines, shortcuts, updatedAt } = req.body || {};
    if (!Array.isArray(hospitals) || !Array.isArray(medicines) || !Array.isArray(shortcuts)) {
      return res.status(400).json({ ok: false, error: 'Yanlış sinxronizasiya formatı' });
    }
    const ts = typeof updatedAt === 'number' ? updatedAt : Date.now();
    const payload = { hospitals, medicines, shortcuts, updatedAt: ts };

    if (!memoryFallbackState || ts >= memoryFallbackState.updatedAt) {
      memoryFallbackState = payload;
      // Dərhal daxili yerli fayl bazasına yazılır
      saveStateToDisk(payload);
    }

    if (mongoConnected && mongoClient) {
      const col = mongoClient.db(currentDbName).collection('klinikapp_state');
      await col.updateOne(
        { _id: 'global_state' },
        { $set: { hospitals, medicines, shortcuts, updatedAt: ts } },
        { upsert: true }
      );
    }

    return res.json({
      ok: true,
      updatedAt: ts,
      storageMode: mongoConnected ? 'external_mongodb' : 'internal_embedded_db'
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[Klinikapp Server] İşə düşdü: http://0.0.0.0:${PORT}`);
  console.log(`[Daxili Baza] Daxili yerli baza aktivdir: ${DATA_FILE}`);
  if (currentMongoUri) {
    await connectMongo(currentMongoUri, currentDbName);
  }
});
