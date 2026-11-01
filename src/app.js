require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const { Pool } = require('pg');
const QRCode = require('qrcode');

const app = express();
const port = process.env.PORT || 3000;

// spajanje na postgre bazu
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// konfiguracija za tokene
const { auth, requiredScopes } = require('express-oauth2-jwt-bearer');
const checkJwt = auth({
  audience: process.env.AUTH0_AUDIENCE,
  issuerBaseURL: process.env.AUTH0_ISSUER_BASE_URL,
});

// middleware za citanje JSON
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// test pocetna ruta
app.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.send(`Server radi uspjesno! Trenutno vrijeme u bazi: ${result.rows[0].now}`);
  } catch (err) {
    console.error("DETALJNA GRESKA:", err);
    res.status(500).send('Greska kod spajanja na bazu podataka.');
  }
});

// pokretanje servera
app.listen(port, () => {
  console.log(`Server je pokrenut na http://localhost:${port}`);
});

async function createTable() {
  const query = `
    CREATE TABLE IF NOT EXISTS passes (
      id UUID PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      document VARCHAR(255) NOT NULL,
      issued_at TIMESTAMP NOT NULL,
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

app.get('/passes/:id', checkJwt, requiredScopes('read:passes'), async (req, res) => {   // s middlewareom za provjeru tokena i scopea
    const passId = req.params.id;

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
  const name = req.body.name;
  const doc = req.body.document;

  if (!name || !doc || name.trim() === '' || doc.trim() === '') {
    return res.status(400).send('Nedostaju ime ili dokument.');
  }

  const newId = uuidv4();
  const time = new Date().toISOString();
  const status = 'ACTIVE';

  await pool.query(
    'INSERT INTO passes (id, name, document, issued_at, status) VALUES ($1, $2, $3, $4, $5)',
    [newId, name, doc, time, status]
  );
  
  // dinamicki dohvat url
  const passUrl = `${req.protocol}://${req.get('host')}/passes/${newId}`;
  
  // generiranje qr koda kao Base64 url
  const qrCodeDataUrl = await QRCode.toDataURL(passUrl);

  // location zaglavlje
  res.setHeader('Location', `/passes/${newId}`);
  res.setHeader('Access-Control-Expose-Headers', 'Location');

  // vracanje json-a s podacima i qr kodom
  res.status(201).json({
    id: newId,
    name: name,
    document: doc,
    issuedAt: time,
    status: status,
    qrCode: qrCodeDataUrl // Ovdje se nalazi QR kod spreman za prikaz u pregledniku ili aplikaciji
  });
});