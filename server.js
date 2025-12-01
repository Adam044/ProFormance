// backend/server.js
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: __dirname + '/.env' });

// Enable global keep-alive to avoid socket disconnects
require('http').globalAgent.keepAlive = true;
require('https').globalAgent.keepAlive = true;

const app = express();
const PORT = process.env.PORT || 3003;

app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json());
function resolveProjectPaths() {
    const candidatesViews = [
        path.join(process.cwd(), 'Frontend', 'views'),
        path.join(process.cwd(), '..', 'Frontend', 'views'),
        path.join(__dirname, '..', 'Frontend', 'views'),
        path.join(__dirname, '..', '..', 'Frontend', 'views')
    ];
    const candidatesImages = [
        path.join(process.cwd(), 'images'),
        path.join(process.cwd(), '..', 'images'),
        path.join(__dirname, '..', 'images'),
        path.join(__dirname, '..', '..', 'images')
    ];
    let viewsDir = candidatesViews.find(p => fs.existsSync(path.join(p, 'index.html')));
    let imagesDir = candidatesImages.find(p => fs.existsSync(p));
    if (!viewsDir) viewsDir = candidatesViews[0];
    if (!imagesDir) imagesDir = candidatesImages[0];
    return { viewsDir, imagesDir };
}
const { viewsDir: VIEWS_DIR, imagesDir: IMAGES_DIR } = resolveProjectPaths();

app.use(express.static(VIEWS_DIR));
app.use('/images', express.static(IMAGES_DIR));

// --- DATABASE CONNECTION ---
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
    console.warn('DATABASE_URL not set. Please configure Backend/.env');
}

let pool;
let db;

// Stable Supabase PgBouncer (transaction pooler) settings
function buildPool(cs) {
    return new Pool({
        connectionString: cs,
        ssl: { require: true, rejectUnauthorized: false },
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        allowExitOnIdle: true,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000,
    });
}

function isTransient(err) {
    const m = String(err && err.message || '');
    const c = String(err && err.code || '');
    return (
        m.includes('Connection terminated') ||
        m.includes('timeout') ||
        m.includes('ECONNRESET') ||
        m.includes('socket hang up') ||
        c === 'ETIMEDOUT'
    );
}
function makeDb(getPool) {
    return {
        async query(text, params) {
            let p = getPool();
            if (!p) {
                pool = await ensurePool();
                p = getPool();
                if (!p) throw new Error('service_unavailable');
            }
            try {
                return await p.query(text, params);
            } catch (err) {
                if (isTransient(err)) {
                    try { await p.end(); } catch (_) {}
                    pool = await ensurePool();
                    if (!pool) throw err;
                    return await getPool().query(text, params);
                }
                throw err;
            }
        }
    };
}

// Auto-retry DB connection
async function ensurePool() {
    if (!DATABASE_URL) return null;
    let lastErr = null;
    for (let i = 1; i <= 5; i++) {
        const p = buildPool(DATABASE_URL);
        try {
            await p.query("SELECT 1");
            console.log("Connected to database (attempt " + i + ")");
            return p;
        } catch (err) {
            lastErr = err;
            console.warn("DB connect failed (attempt " + i + "):", err.message);
            const delay = Math.min(2000 * i, 8000);
            await new Promise(r => setTimeout(r, delay));
            try { await p.end(); } catch (_) {}
        }
    }
    console.error("All DB connection attempts failed.");
    if (lastErr) console.error(lastErr);
    return null;
}

async function initDb() {
    if (!pool) return;

    await db.query(`
        CREATE TABLE IF NOT EXISTS clients (
            id UUID PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT UNIQUE,
            phone TEXT,
            gender TEXT,
            dob DATE,
            access_code TEXT,
            primary_issue TEXT,
            status TEXT,
            active BOOLEAN DEFAULT TRUE,
            visit_mode TEXT,
            athletic BOOLEAN,
            athletic_type TEXT,
            athletic_position TEXT,
            occupation TEXT,
            medication TEXT,
            medication_note TEXT,
            prev_injury_location TEXT,
            prev_injury_year INT,
            prev_injury_note TEXT,
            training_load_days INT,
            sudden_load_changes TEXT,
            sleep_hours INT,
            last_updated TIMESTAMPTZ,
            next_session TIMESTAMPTZ,
            body_map JSONB DEFAULT '{}'::jsonb
        );
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS sessions (
            id UUID PRIMARY KEY,
            client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
            date TIMESTAMPTZ,
            title TEXT,
            note TEXT,
            type TEXT,
            progress INT,
            payment_status TEXT,
            currency TEXT,
            payment_type TEXT,
            amount NUMERIC,
            body_map JSONB DEFAULT '{}'::jsonb
        );
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS auth_tokens (
            id UUID PRIMARY KEY,
            user_id UUID REFERENCES clients(id) ON DELETE CASCADE,
            role TEXT,
            token_hash TEXT UNIQUE NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            revoked BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS payments (
            id UUID PRIMARY KEY,
            client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
            session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
            date TIMESTAMPTZ DEFAULT NOW(),
            amount NUMERIC NOT NULL,
            currency TEXT,
            status TEXT,
            method TEXT,
            reference TEXT,
            note TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );
    `);
}

const ADMIN = {
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
    name: process.env.ADMIN_NAME || 'Admin',
    role: 'admin'
};

// --- ROUTES ---
const createAuthRoutes = require('./routes/auth');
const createClientRoutes = require('./routes/clients');
const createSessionRoutes = require('./routes/sessions');
const createPaymentRoutes = require('./routes/payments');

const JWT_SECRET = process.env.JWT_SECRET || '';
const ACCESS_TOKEN_TTL = Number(process.env.ACCESS_TOKEN_TTL || 900);
const REFRESH_TOKEN_TTL = Number(process.env.REFRESH_TOKEN_TTL || 604800);

function b64urlJson(obj) {
    return Buffer.from(JSON.stringify(obj))
        .toString('base64')
        .replace(/=/g,'')
        .replace(/\+/g,'-')
        .replace(/\//g,'_');
}

function b64urlToObj(b64) {
    return JSON.parse(Buffer.from(
        b64.replace(/-/g,'+').replace(/_/g,'/'),
    'base64').toString());
}

function signJwt(payload, ttlSeconds) {
    if (!JWT_SECRET) return null;

    const header = { alg: "HS256", typ: "JWT" };
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const body = { ...payload, exp };

    const data = `${b64urlJson(header)}.${b64urlJson(body)}`;
    const sig = crypto.createHmac("sha256", JWT_SECRET)
        .update(data)
        .digest("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");

    return `${data}.${sig}`;
}

function verifyJwt(token) {
    try {
        if (!JWT_SECRET) return null;
        const parts = String(token).split(".");
        if (parts.length !== 3) return null;

        const [h, p, s] = parts;
        const data = `${h}.${p}`;

        const expected = crypto.createHmac("sha256", JWT_SECRET)
            .update(data)
            .digest("base64")
            .replace(/=/g, "")
            .replace(/\+/g, "-")
            .replace(/\//g, "_");

        if (expected !== s) return null;

        const payload = b64urlToObj(p);
        if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

        return payload;
    } catch {
        return null;
    }
}

function newRefreshToken() {
    return crypto.randomBytes(48)
        .toString("base64")
        .replace(/=/g,'')
        .replace(/\+/g,'-')
        .replace(/\//g,'_');
}

function hashToken(t) {
    return crypto.createHash("sha256").update(String(t)).digest("hex");
}

async function storeRefresh({ token, userId, role }) {
    const id = uuidv4();
    const expires = new Date(Date.now() + REFRESH_TOKEN_TTL * 1000);

    await db.query(
        `INSERT INTO auth_tokens (id, user_id, role, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
         [id, userId || null, role, hashToken(token), expires]
    );

    return { id, expires };
}

async function revokeRefresh(token) {
    await db.query(
        "UPDATE auth_tokens SET revoked = TRUE WHERE token_hash = $1",
        [hashToken(token)]
    );
}

async function validateRefresh(token) {
    const { rows } = await db.query(
        `SELECT user_id, role, expires_at, revoked
         FROM auth_tokens
         WHERE token_hash = $1`,
         [hashToken(token)]
    );

    if (!rows[0]) return null;
    const r = rows[0];

    if (r.revoked) return null;
    if (new Date(r.expires_at) <= new Date()) return null;

    return { userId: r.user_id, role: r.role };
}

function parseCookies(h) {
    const out = {};
    if (!h) return out;

    h.split(";").forEach(c => {
        const [k, ...v] = c.split("=");
        out[k.trim()] = decodeURIComponent(v.join("="));
    });

    return out;
}

function authMiddleware(req, res, next) {
    const a = req.headers.authorization || "";
    const tok = a.startsWith("Bearer ") ? a.slice(7) : "";
    const payload = tok ? verifyJwt(tok) : null;

    if (!payload) return res.status(401).json({ message: "Unauthorized" });

    req.user = payload;
    next();
}

function requireAdminForWrite(req, res, next) {
    if (req.method === "GET") return next();
    if (!req.user || req.user.role !== "admin")
        return res.status(403).json({ message: "Forbidden" });

    next();
}

// Static routes
app.get('/', (req, res) => {
    const p = path.join(VIEWS_DIR, 'index.html');
    if (!fs.existsSync(p)) return res.status(404).send('Not Found');
    res.sendFile(p);
});
app.get('/user', (req, res) => {
    res.sendFile(path.join(VIEWS_DIR, 'user_dashboard.html'));
});
app.get('/violet', (req, res) => {
    res.sendFile(path.join(VIEWS_DIR, 'violet_dashboard.html'));
});
app.get('/patient', (req, res) => {
    res.sendFile(path.join(VIEWS_DIR, 'patient.html'));
});
app.get('/insights', (req, res) => {
    res.sendFile(path.join(VIEWS_DIR, 'revenue_insights.html'));
});

// Boot the server
(async function boot() {
    try {
        db = makeDb(() => pool);
        const security = {
            signJwt,
            verifyJwt,
            newRefreshToken,
            storeRefresh,
            validateRefresh,
            revokeRefresh,
            parseCookies,
            ACCESS_TOKEN_TTL,
            REFRESH_TOKEN_TTL
        };

        app.use('/api/auth', createAuthRoutes(db, ADMIN, security));
        app.use('/api/clients', authMiddleware, requireAdminForWrite, createClientRoutes(db));
        app.use('/api/clients', authMiddleware, requireAdminForWrite, createSessionRoutes(db));
        app.use('/api/payments', authMiddleware, requireAdminForWrite, createPaymentRoutes(db));
        app.get('/api/health', (req, res) => {
            res.json({ connected: !!pool });
        });

        app.listen(PORT, () =>
            console.log(`API Server running on http://localhost:${PORT}`)
        );

        try {
            pool = await ensurePool();
            await initDb();
        } catch (_) {}
    } catch (err) {
        console.error('Failed to start server', err);
        app.listen(PORT, () =>
            console.log(`API Server running on http://localhost:${PORT}`)
        );
    }
})();
