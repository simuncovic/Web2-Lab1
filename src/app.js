require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const { Pool } = require('pg');
const QRCode = require('qrcode');
const { auth: oidcAuth, requiresAuth } = require('express-openid-connect');

const app = express();
const port = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const css = `<style>h1{text-align:center;color:#008B8B} body{font-family:sans-serif;margin:2rem;background:#FFE4E1} button{padding:6px 12px;border:none;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer} form[action$="/delete"] button{background:#dc2626}</style>`;app.set('trust proxy', 1);

// 1. oidc konfiguracija i middleware
const oidcConfig = {
  authRequired: false,
  auth0Logout: true,
  baseURL: BASE_URL,
  issuerBaseURL: process.env.AUTH0_ISSUER_BASE_URL,
  clientID: process.env.OIDC_CLIENT_ID,
  clientSecret: process.env.OIDC_CLIENT_SECRET,
  secret: process.env.SESSION_SECRET,
};

app.use(oidcAuth(oidcConfig));

// spajanje na postgre bazu
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// konfiguracija za tokene (M2M)
const { auth, requiredScopes } = require('express-oauth2-jwt-bearer');
const checkJwt = auth({
  audience: process.env.AUTH0_AUDIENCE,
  issuerBaseURL: process.env.AUTH0_ISSUER_BASE_URL,
});

// middleware za citanje jsona
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Kreiranje tablice u bazi
async function createTable() {
  const query = `
    CREATE TABLE IF NOT EXISTS passes (
      id UUID PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      document VARCHAR(255) NOT NULL,
      issued_at TIMESTAMPTZ NOT NULL,
      status VARCHAR(50) NOT NULL
    );
  `;
  try {
    await pool.query(query);
    console.log("Tablica 'passes' je uspjesno kreirana ili vec postoji.");
  } catch (err) {
    console.error("Greska kod kreiranja tablice:", err);
  }
}
createTable();


// rute
app.get('/', async (req, res) => {
  try {
    const totalResult = await pool.query('SELECT COUNT(*) FROM passes');
    const activeResult = await pool.query("SELECT COUNT(*) FROM passes WHERE status = 'ACTIVE'");
    
    const totalPasses = totalResult.rows[0].count;
    const activePasses = activeResult.rows[0].count;

    const isLogged = req.oidc.isAuthenticated();

    res.send(`
      ${css}
      <h1>Digitalne Propusnice - Pocetna</h1>
      <p>Ukupno propusnica u bazi: ${totalPasses}</p>
      <p>Broj aktivnih propusnica: ${activePasses}</p>
      <hr>
      ${isLogged 
        ? `<p>Prijavljeni ste kao: ${esc(req.oidc.user.email || req.oidc.user.name || '')}</p>
           <a href="/logout">Odjava</a> | <a href="/dashboard">Upravljanje propusnicama</a>` 
        : `<a href="/login">Prijava (Login)</a>`
      }
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send('Greška na serveru.');
  }
});

app.get('/dashboard', requiresAuth(), async (req, res) => {
  try {
    const passes = await pool.query('SELECT * FROM passes ORDER BY issued_at DESC');
    
    let html = `${css}<h1>Upravljanje propusnicama</h1><a href="/">Natrag na početnu</a><br><br>`;
    html += `<table border="1"><tr><th>ID</th><th>Ime</th><th>Dokument</th><th>Izdana</th><th>Status</th><th>QR</th><th>Akcija</th></tr>`;    
    passes.rows.forEach(p => {
      html += `<tr>
        <td>${esc(p.id)}</td>
        <td>${esc(p.name)}</td>
        <td>${esc(p.document)}</td>
        <td>${new Date(p.issued_at).toISOString()}</td>
        <td>${esc(p.status)}</td>
        <td><a href="/info/${esc(p.id)}" target="_blank"><img src="/passes/${esc(p.id)}/qr" width="100"></a></td>
        <td>
          <form action="/passes/${esc(p.id)}/cancel" method="POST" style="display:inline;"><button type="submit">Poništi</button></form>
          <form action="/passes/${esc(p.id)}/delete" method="POST" style="display:inline;"><button type="submit">Obriši</button></form>
        </td>
      </tr>`;
    });
    html += `</table>`;
    
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send('greska kod dohvacanja propusnica.');
  }
});

app.get('/passes/:id/qr', requiresAuth(), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).send('Propusnica ne postoji.');
  const png = await QRCode.toBuffer(`${BASE_URL}/info/${req.params.id}`);
  res.type('image/png').send(png);
});

app.get('/info/:id', async (req, res) => {
  const passId = req.params.id;

  if (!UUID_RE.test(passId))
    return res.status(404).send('Propusnica ne postoji.');

  try {
    const rezultat = await pool.query('SELECT * FROM passes WHERE id = $1', [passId]);

    if (rezultat.rows.length === 0)
      return res.status(404).send('Propusnica ne postoji.');

    const p = rezultat.rows[0];
    res.send(`
      ${css}
      <h1>Propusnica</h1>
      <p>Status: <b>${esc(p.status)}</b></p>
      <p>Ime i prezime: ${esc(p.name)}</p>
      <p>Dokument: ${esc(p.document)}</p>
      <p>Izdana: ${new Date(p.issued_at).toISOString()}</p>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send('Greška na serveru.');
  }
});

app.get('/passes/:id', checkJwt, requiredScopes('read:passes'), async (req, res) => {
    const passId = req.params.id;

    if (!UUID_RE.test(passId))
        return res.status(404).send('propusnica nije pronadena');

    try {
        const rezultat = await pool.query('SELECT * FROM passes WHERE id = $1', [passId]);

        if (rezultat.rows.length === 0)
            return res.status(404).send('propusnica nije pronadena');

        res.json({
            "id": rezultat.rows[0].id,
            "name": rezultat.rows[0].name,
            "document": rezultat.rows[0].document,
            "issuedAt": rezultat.rows[0].issued_at,
            "status": rezultat.rows[0].status
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('greska na serveru');
    }
});

app.post('/passes', checkJwt, requiredScopes('create:passes'), async (req, res) => {
  try {
    const { name, document: doc } = req.body || {};

    if (typeof name !== 'string' || typeof doc !== 'string' || !name.trim() || !doc.trim()) {
      return res.status(400).send('Nedostaju ime ili dokument.');
    }

    const newId = uuidv4();
    const time = new Date();
    const status = 'ACTIVE';

    await pool.query(
      'INSERT INTO passes (id, name, document, issued_at, status) VALUES ($1, $2, $3, $4, $5)',
      [newId, name.trim(), doc.trim(), time, status]
    );

    const qrCodeBuffer = await QRCode.toBuffer(`${BASE_URL}/info/${newId}`);

    res.status(201)
      .set({
        'Content-Type': 'image/png',
        'Location': `${BASE_URL}/passes/${newId}`,
        'Access-Control-Expose-Headers': 'Location'
      })
      .send(qrCodeBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).send('Greška na serveru.');
  }
});

app.post('/passes/:id/cancel', requiresAuth(), async (req, res) => {
  try {
    if (UUID_RE.test(req.params.id)) {
      await pool.query("UPDATE passes SET status = 'CANCELLED' WHERE id = $1", [req.params.id]);
    }
    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.status(500).send('greska kod ponistavanja propusnice.');
  }
});

app.post('/passes/:id/delete', requiresAuth(), async (req, res) => {
  try {
    if (UUID_RE.test(req.params.id)) {
      await pool.query('DELETE FROM passes WHERE id = $1', [req.params.id]);
    }
    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.status(500).send('greska kod brisanja propusnice.');
  }
});

// pokretanje servera
app.listen(port, () => {
  console.log(`Server je pokrenut na http://localhost:${port}`);
});