'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'finanzas.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

/* ---------- Base de datos (SQLite) ---------- */
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL CHECK (tipo IN ('ingreso','gasto')),
    concepto TEXT NOT NULL,
    monto REAL NOT NULL CHECK (monto > 0),
    categoria TEXT NOT NULL,
    fecha TEXT NOT NULL,
    nota TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_records_user ON records(user_id);
`);
const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  insertUser: db.prepare('INSERT INTO users (email, salt, hash) VALUES (?, ?, ?)'),
  insertSession: db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)'),
  sessionUser: db.prepare('SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  list: db.prepare('SELECT id, tipo, concepto, monto, categoria, fecha, nota FROM records WHERE user_id = ? ORDER BY fecha DESC, id DESC'),
  one: db.prepare('SELECT id, tipo, concepto, monto, categoria, fecha, nota FROM records WHERE id = ? AND user_id = ?'),
  insert: db.prepare('INSERT INTO records (user_id, tipo, concepto, monto, categoria, fecha, nota) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  update: db.prepare('UPDATE records SET tipo = ?, concepto = ?, monto = ?, categoria = ?, fecha = ?, nota = ? WHERE id = ? AND user_id = ?'),
  remove: db.prepare('DELETE FROM records WHERE id = ? AND user_id = ?')
};

/* ---------- Utilidades ---------- */
const hashPassword = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 100_000) { reject(new HttpError(413, 'Solicitud demasiado grande.')); req.destroy(); } });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new HttpError(400, 'JSON inválido.')); }
    });
    req.on('error', reject);
  });
}

function auth(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  const user = m && q.sessionUser.get(m[1]);
  if (!user) throw new HttpError(401, 'Sesión no válida. Inicia sesión de nuevo.');
  return { ...user, token: m[1] };
}

function cleanRecord(b) {
  const r = {
    tipo: b.tipo,
    concepto: String(b.concepto ?? '').trim().slice(0, 60),
    monto: Number(b.monto),
    categoria: String(b.categoria ?? '').trim().slice(0, 40),
    fecha: String(b.fecha ?? ''),
    nota: String(b.nota ?? '').trim().slice(0, 120)
  };
  if (!['ingreso', 'gasto'].includes(r.tipo)) throw new HttpError(400, 'El tipo debe ser ingreso o gasto.');
  if (!r.concepto) throw new HttpError(400, 'Escribe un concepto.');
  if (!Number.isFinite(r.monto) || r.monto <= 0) throw new HttpError(400, 'El monto debe ser mayor a 0.');
  if (!r.categoria) throw new HttpError(400, 'Elige una categoría.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.fecha)) throw new HttpError(400, 'Fecha no válida.');
  return r;
}

function newSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  q.insertSession.run(token, userId);
  return token;
}

/* ---------- API ---------- */
async function api(req, res, url) {
  const { method } = req;
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const route = parts[1], id = parts[2] ? Number(parts[2]) : null;

  if (route === 'register' && method === 'POST') {
    const { email = '', password = '' } = await readBody(req);
    const mail = String(email).trim().toLowerCase();
    if (!EMAIL_RE.test(mail)) throw new HttpError(400, 'Escribe un correo válido.');
    if (String(password).length < 6) throw new HttpError(400, 'La contraseña debe tener al menos 6 caracteres.');
    if (q.userByEmail.get(mail)) throw new HttpError(409, 'Ese correo ya está registrado.');
    const salt = crypto.randomBytes(16).toString('hex');
    const { lastInsertRowid } = q.insertUser.run(mail, salt, hashPassword(password, salt));
    return send(res, 201, { token: newSession(Number(lastInsertRowid)), email: mail });
  }

  if (route === 'login' && method === 'POST') {
    const { email = '', password = '' } = await readBody(req);
    const mail = String(email).trim().toLowerCase();
    const u = q.userByEmail.get(mail);
    const ok = u && crypto.timingSafeEqual(Buffer.from(u.hash, 'hex'), Buffer.from(hashPassword(String(password), u.salt), 'hex'));
    if (!ok) throw new HttpError(401, 'Correo o contraseña incorrectos.');
    return send(res, 200, { token: newSession(u.id), email: u.email });
  }

  const me = auth(req);

  if (route === 'me' && method === 'GET') return send(res, 200, { email: me.email });
  if (route === 'logout' && method === 'POST') { q.deleteSession.run(me.token); return send(res, 200, { ok: true }); }

  if (route === 'records') {
    if (!id && method === 'GET') return send(res, 200, q.list.all(me.id));
    if (!id && method === 'POST') {
      const r = cleanRecord(await readBody(req));
      const { lastInsertRowid } = q.insert.run(me.id, r.tipo, r.concepto, r.monto, r.categoria, r.fecha, r.nota);
      return send(res, 201, q.one.get(Number(lastInsertRowid), me.id));
    }
    if (id) {
      const found = q.one.get(id, me.id);
      if (!found) throw new HttpError(404, 'Registro no encontrado.');
      if (method === 'GET') return send(res, 200, found);
      if (method === 'PUT') {
        const r = cleanRecord(await readBody(req));
        q.update.run(r.tipo, r.concepto, r.monto, r.categoria, r.fecha, r.nota, id, me.id);
        return send(res, 200, q.one.get(id, me.id));
      }
      if (method === 'DELETE') { q.remove.run(id, me.id); return send(res, 200, { ok: true }); }
    }
  }
  throw new HttpError(404, 'Ruta no encontrada.');
}

/* ---------- Archivos estáticos y servidor ---------- */
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.ico': 'image/x-icon' };

function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('No encontrado');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Error interno del servidor.' });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`Mis Finanzas escuchando en el puerto ${PORT} (BD: ${DB_PATH})`));
process.on('SIGTERM', () => { server.close(() => { db.close(); process.exit(0); }); });
