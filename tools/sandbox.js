// Serwer testowy: podaje appkę z GAS_URL -> /gas, a /gas obsługuje PRAWDZIWY Kod.gs uruchomiony
// na atrapie Arkusza w pamięci. Maile nie wychodzą — trafiają do /__mail (z linkami do PIN-u),
// a Gemini API jest zastąpione atrapą (odpowiedź z pliku podanego jako 3. argument albo pusta).
// Nic nie dotyka prawdziwego Arkusza ani Gemini.
// Użycie: node tools/sandbox.js index.html Kod.gs [atrapa-odczytu.json] [port]
const http = require('http'), fs = require('fs'), vm = require('vm'), crypto = require('crypto');
const [htmlFile, kodFile, parseFile, portArg] = process.argv.slice(2);
const port = Number(portArg || 4280);

function mkSheet(headers) {
  const rows = headers ? [headers.slice()] : [];
  return {
    rows,
    appendRow: r => { rows.push(r.slice()); },
    getDataRange: () => ({ getValues: () => rows.map(r => r.slice()) }),
    getRange: (row, col, nr = 1, nc = 1) => ({
      setValue: v => { rows[row - 1][col - 1] = v; },
      setValues: vs => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) rows[row - 1 + i][col - 1 + j] = vs[i][j]; }
    }),
    deleteRow: n => { rows.splice(n - 1, 1); }
  };
}
const sheets = {};
const props = {};
const mails = [];
const aiCalls = [];
const drive = []; // atrapa Dysku: {id, name, parent, type, size}
function mkFolder(name, parent) {
  const id = 'fld' + drive.length; drive.push({ id, name, parent, folder: true });
  const f = {
    getId: () => id, getUrl: () => 'https://drive.example/' + id, isTrashed: () => false,
    createFolder: n => mkFolder(n, id),
    getFoldersByName: n => { const list = drive.filter(x => x.folder && x.parent === id && x.name === n).map(x => x.obj); let i = 0; return { hasNext: () => i < list.length, next: () => list[i++] }; },
    createFile: blob => { const fid = 'file' + drive.length; drive.push({ id: fid, name: blob.name, parent: id, type: blob.type, size: blob.bytes.length }); return { getId: () => fid }; }
  };
  drive[drive.length - 1].obj = f; return f;
}
const OWNER = 'wlasciciel@example.com';
const sb = {
  console,
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = mkSheet(null)) }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; } }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ text: t, setMimeType() { return this; } }) },
  Session: { getEffectiveUser: () => ({ getEmail: () => OWNER }) },
  MailApp: {
    sendEmail: m => { if (/zly-adres/.test(m.to)) throw new Error('Invalid email'); mails.push(m); },
    getRemainingDailyQuota: () => 100
  },
  DriveApp: {
    createFolder: n => mkFolder(n, 'root'),
    getFolderById: id => { const x = drive.find(d => d.id === id && d.folder); if (!x) throw new Error('not found'); return x.obj; }
  },
  UrlFetchApp: {
    fetch: (url, opt) => {
      if (!opt.payload) return { getResponseCode: () => (/zly/.test(opt.headers['x-goog-api-key']) ? 400 : 200), getContentText: () => '{}' };
      const req = JSON.parse(opt.payload);
      const parts = req.contents[0].parts;
      aiCalls.push({ url, headers: opt.headers, config: req.generationConfig, parts: parts.map(x => x.text != null ? 'text' : x.inline_data.mime_type), prompt: parts[0].text });
      const parsed = parseFile ? fs.readFileSync(parseFile, 'utf8') : '{"shop":"","place":"","date":"","time":"","total":0,"pay":"","items":[],"warnings":[]}';
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: parsed }] } }], usageMetadata: {} }) };
    }
  },
  Utilities: {
    getUuid: () => crypto.randomUUID(),
    newBlob: (bytes, type, name) => ({ bytes, type, name }),
    base64Decode: s => Array.from(Buffer.from(s, 'base64')),
    computeHmacSha256Signature: (msg, key) => Array.from(crypto.createHmac('sha256', key).update(msg).digest()).map(b => (b > 127 ? b - 256 : b)),
    base64Encode: bytes => Buffer.from(bytes.map(b => b & 255)).toString('base64'),
    computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(s, 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
    DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 },
    formatDate: d => d.toISOString().replace('T', ' ').slice(0, 19)
  }
};
vm.createContext(sb);
// Limit „jeden mail z linkiem na minutę” skrócony do 2 s, żeby testy nie czekały.
vm.runInContext(fs.readFileSync(kodFile, 'utf8').replace('const LINK_MIN_GAP_MS = 60 * 1000;', 'const LINK_MIN_GAP_MS = 2000;'), sb);

http.createServer((req, res) => {
  const json = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url.startsWith('/gas')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const out = req.method === 'POST' ? sb.doPost({ postData: { contents: body } }).text : sb.doGet({ parameter: {} }).text;
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(out);
      } catch (e) { res.writeHead(500); res.end(String(e && e.stack || e)); }
    });
    return;
  }
  if (req.url === '/__mail') return json(mails.map(m => ({ to: m.to, subject: m.subject, link: (m.body.match(/\?pin=([0-9a-f]+)/) || [])[1] })));
  if (req.url === '/__ai') return json(aiCalls);
  if (req.url === '/__sheets') return json(Object.fromEntries(Object.entries(sheets).map(([k, v]) => [k, v.rows])));
  if (req.url === '/__drive') return json(drive.map(({ obj, ...x }) => x));
  if (req.url === '/__props') return json(Object.keys(props));
  let html = fs.readFileSync(htmlFile, 'utf8');
  const n = (html.match(/const GAS_URL = '[^']*';/g) || []).length;
  if (n !== 1) { res.writeHead(500); return res.end('GAS_URL x' + n); }
  html = html.replace(/const GAS_URL = '[^']*';/, "const GAS_URL = '/gas';");
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}).listen(port, () => console.log(`sandbox: http://localhost:${port}/  (backend = Kod.gs w pamięci, maile: /__mail)`));
