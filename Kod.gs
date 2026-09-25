// Wydatki domowe — backend (Apps Script Web App podpięty do Arkusza).
//
// Wszystko idzie przez POST {action, token, ...} z Content-Type text/plain (bez preflightu CORS).
// Konta: login (skrót) + 6-cyfrowy PIN. PIN-u nigdy nie zapisujemy — tylko HMAC(PIN; pepper+sól),
// pepper leży we właściwościach skryptu. PIN ustawia sam właściciel konta przez jednorazowy link
// wysłany mailem (zaproszenie od admina albo „Nie pamiętam PIN-u”). Tokeny sesji i linków są
// zapisywane tylko jako SHA-256.
//
// Dane: jeden wiersz = jeden paragon (zakładka Receipts, kolumna json). Dane są wspólne dla
// całego domu — każdy zalogowany widzi i edytuje wszystkie paragony; zapisujemy, kto dodał/zmienił.
//
// Odczyt paragonu: akcja parse wysyła zdjęcia/PDF do Gemini API (klucz w GEMINI_API_KEY we
// właściwościach skryptu — admin wpisuje go w appce, nigdy nie trafia do repo ani do przeglądarki).
// Wzorzec wywołania ten sam co w Paliwo-PF (działa u Szefa na płatnym koncie Google).

const APP_URL = 'https://heatcoolfulawkawro-ui.github.io/wydatki-domowe/';
const APP_NAME = 'Wydatki domowe';
const TZ = 'Europe/Warsaw';

const USERS_SHEET = 'Users';
const USERS_HEADERS = ['id', 'name', 'role', 'email', 'salt', 'hash', 'fails', 'lockUntil', 'active', 'lockCount', 'createdAt'];
const SESSIONS_SHEET = 'Sessions';
const SESSIONS_HEADERS = ['tokenHash', 'userId', 'expires', 'createdAt'];
const LINKS_SHEET = 'Links';
const LINKS_HEADERS = ['tokenHash', 'userId', 'purpose', 'expires', 'used', 'createdAt'];
const RECEIPTS_SHEET = 'Receipts';
const RECEIPTS_HEADERS = ['id', 'date', 'shop', 'total', 'json', 'addedBy', 'createdAt', 'updatedBy', 'updatedAt', 'deleted'];
const AUDIT_SHEET = 'Audit';
const AUDIT_HEADERS = ['time', 'actor', 'action', 'target', 'detail'];

const SESSION_TTL_MS = 60 * 24 * 3600 * 1000;
const LINK_TTL_MS = 48 * 3600 * 1000;
const LINK_MIN_GAP_MS = 60 * 1000; // najwyżej jeden mail z linkiem na minutę na konto
const MAX_FAILS = 5;
const LOCK_BASE_MS = 5 * 60 * 1000;
const LOCK_MAX_MS = 24 * 3600 * 1000;
const MAX_RECEIPT_CHARS = 100000;

// "gemini-flash-latest" to ruchomy alias Google na aktualny model flash; reszta to zapasowe nazwy.
// Model, który ostatnio zadziałał, jest zapamiętywany we właściwości GEMINI_MODEL_OK.
const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-3.6-flash'];
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';
const MAX_PARSE_FILES = 8;
const MAX_PARSE_B64 = 20 * 1024 * 1024;

// ---------- wejścia ----------

function doGet() {
  // Ping (światełko połączenia): 200 z pustą treścią. Danych przez GET nie wydajemy.
  return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  let b;
  try {
    b = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut_({ ok: false, error: 'bad' });
  }
  if (!b || typeof b.action !== 'string') return jsonOut_({ ok: false, error: 'bad' });
  // Odczyt paragonu trwa kilkadziesiąt sekund — nie trzyma blokady zapisu.
  if (b.action === 'parse') {
    try {
      return jsonOut_(parseEntry_(b));
    } catch (err) {
      console.error(err && err.stack || err);
      return jsonOut_({ ok: false, error: 'server' });
    }
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return jsonOut_(dispatch_(b));
  } catch (err) {
    console.error(err && err.stack || err);
    return jsonOut_({ ok: false, error: 'server' });
  } finally {
    lock.releaseLock();
  }
}

function fail_(code, extra) {
  return Object.assign({ ok: false, error: code }, extra || {});
}

function dispatch_(b) {
  const action = b.action;
  switch (action) {
    case 'status': return { ok: true, setup: readUsers_().length === 0 };
    case 'bootstrap': return bootstrap_(b);
    case 'login': return login_(b);
    case 'requestLink': return requestLink_(b);
    case 'checkLink': return checkLink_(b);
    case 'setPinByLink': return setPinByLink_(b);
  }
  const auth = authenticate_(b.token);
  if (!auth) return fail_('auth');
  const user = auth.user;
  switch (action) {
    case 'me': return { ok: true, user: pub_(user), hasKey: !!getApiKey_() };
    case 'logout': revokeSessions_(user.id, auth.tokenHash); return { ok: true };
    case 'changePin': return changePin_(user, b);
    case 'list': return listReceipts_();
    case 'save': return saveReceipt_(user, b);
    case 'delete': return deleteReceipt_(user, b);
  }
  if (action.indexOf('admin.') !== 0) return fail_('bad');
  if (user.role !== 'admin') return fail_('forbidden');
  const res = adminAction_(user, action, b);
  if (res.ok && action !== 'admin.list') audit_(user.id, action, b);
  return res;
}

function adminAction_(admin, action, b) {
  switch (action) {
    case 'admin.list': return { ok: true, users: readUsers_().map(adminView_), hasKey: !!getApiKey_() };
    case 'admin.createUser': return adminCreateUser_(b);
    case 'admin.sendLink': return adminSendLink_(b);
    case 'admin.setEmail': return adminSetEmail_(b);
    case 'admin.setActive': return adminSetActive_(admin, b);
    case 'admin.unlock': return adminUnlock_(b);
    case 'admin.setApiKey': return adminSetApiKey_(b);
    case 'admin.import': return adminImport_(admin, b);
  }
  return fail_('bad');
}

// ---------- konta ----------

// Pierwsze uruchomienie (pusta tabela Users): tworzy konto admina i wysyła link do ustawienia
// PIN-u WYŁĄCZNIE na adres właściciela skryptu — obcy, który zna adres /exec, nic nie zyska.
function bootstrap_(b) {
  if (readUsers_().length) return fail_('exists');
  const id = validId_(b.id);
  const name = cleanName_(b.name);
  if (!id || !name) return fail_('bad');
  const email = ownerEmail_();
  if (!email) return fail_('noemail');
  createUser_(id, name, 'admin', email);
  const u = findUser_(id);
  sendLink_(u, 'invite');
  audit_(id, 'bootstrap', { id: id });
  return { ok: true, sentTo: maskEmail_(email) };
}

function login_(b) {
  const id = validId_(b.user);
  const pin = validPin_(b.pin);
  if (!id || !pin) return fail_('bad');
  const u = findUser_(id);
  if (!u || !u.active || !u.hash) return fail_('bad');
  const now = Date.now();
  if (u.lockUntil > now) return fail_('locked', { retryMs: u.lockUntil - now });
  if (!safeEqual_(hashPin_(pin, u.salt), u.hash)) {
    u.fails += 1;
    if (u.fails >= MAX_FAILS) {
      u.lockCount += 1;
      u.lockUntil = now + Math.min(LOCK_BASE_MS * Math.pow(2, u.lockCount - 1), LOCK_MAX_MS);
      u.fails = 0;
    }
    saveUser_(u);
    return u.lockUntil > now ? fail_('locked', { retryMs: u.lockUntil - now }) : fail_('bad');
  }
  u.fails = 0;
  u.lockCount = 0;
  u.lockUntil = 0;
  saveUser_(u);
  return newSession_(u);
}

function newSession_(u) {
  purgeExpired_(SESSIONS_SHEET, SESSIONS_HEADERS, 2);
  const now = Date.now();
  const token = randomToken_();
  const expires = now + SESSION_TTL_MS;
  getSheet_(SESSIONS_SHEET, SESSIONS_HEADERS).appendRow([sha256Hex_(token), u.id, expires, now]);
  return { ok: true, token: token, expires: expires, user: pub_(u) };
}

// „Nie pamiętam PIN-u” / pierwsze logowanie. Odpowiedź jest zawsze taka sama (nie zdradza,
// czy konto istnieje i jaki ma adres), mail idzie tylko na adres zapisany przy koncie.
function requestLink_(b) {
  const id = validId_(b.user);
  const u = id ? findUser_(id) : null;
  if (u && u.active && u.email) {
    const last = lastLinkTime_(u.id);
    if (Date.now() - last > LINK_MIN_GAP_MS) sendLink_(u, u.hash ? 'reset' : 'invite');
  }
  return { ok: true };
}

function checkLink_(b) {
  const link = findLink_(b.link);
  if (!link) return fail_('link');
  const u = findUser_(link.userId);
  if (!u || !u.active) return fail_('link');
  return { ok: true, user: { id: u.id, name: u.name }, purpose: link.purpose };
}

function setPinByLink_(b) {
  const pin = validPin_(b.pin);
  if (!pin) return fail_('bad');
  const link = findLink_(b.link);
  if (!link) return fail_('link');
  const u = findUser_(link.userId);
  if (!u || !u.active) return fail_('link');
  getSheet_(LINKS_SHEET, LINKS_HEADERS).getRange(link.row, 5).setValue(true);
  setPin_(u, pin);
  audit_(u.id, 'setPinByLink', { id: u.id, purpose: link.purpose });
  return newSession_(findUser_(u.id));
}

function changePin_(user, b) {
  const oldPin = validPin_(b.oldPin);
  const newPin = validPin_(b.newPin);
  if (!oldPin || !newPin) return fail_('bad');
  const u = findUser_(user.id);
  if (!safeEqual_(hashPin_(oldPin, u.salt), u.hash)) return fail_('bad');
  setPin_(u, newPin);
  return newSession_(findUser_(u.id));
}

function adminCreateUser_(b) {
  const id = validId_(b.id);
  const name = cleanName_(b.name);
  const email = validEmail_(b.email);
  if (!id || !name || !email) return fail_('bad');
  if (findUser_(id)) return fail_('exists');
  createUser_(id, name, b.role === 'admin' ? 'admin' : 'user', email);
  const sent = trySendLink_(findUser_(id), 'invite');
  return { ok: true, sent: sent, users: readUsers_().map(adminView_) };
}

function adminSendLink_(b) {
  const u = findUser_(validId_(b.id));
  if (!u || !u.email) return fail_('bad');
  const sent = trySendLink_(u, u.hash ? 'reset' : 'invite');
  return { ok: true, sent: sent, users: readUsers_().map(adminView_) };
}

function adminSetEmail_(b) {
  const u = findUser_(validId_(b.id));
  const email = validEmail_(b.email);
  if (!u || !email) return fail_('bad');
  u.email = email;
  saveUser_(u);
  return { ok: true, users: readUsers_().map(adminView_) };
}

function adminSetActive_(admin, b) {
  const u = findUser_(validId_(b.id));
  if (!u || u.id === admin.id) return fail_('bad');
  u.active = b.active === true;
  saveUser_(u);
  if (!u.active) revokeSessions_(u.id, null);
  return { ok: true, users: readUsers_().map(adminView_) };
}

function adminUnlock_(b) {
  const u = findUser_(validId_(b.id));
  if (!u) return fail_('bad');
  u.fails = 0;
  u.lockCount = 0;
  u.lockUntil = 0;
  saveUser_(u);
  return { ok: true, users: readUsers_().map(adminView_) };
}

function adminSetApiKey_(b) {
  const key = String(b.key || '').trim();
  const props = PropertiesService.getScriptProperties();
  if (!key) {
    props.deleteProperty('GEMINI_API_KEY');
    return { ok: true, hasKey: false };
  }
  if (!/^AIza[0-9A-Za-z_\-]{30,60}$/.test(key)) return fail_('badkey');
  props.setProperty('GEMINI_API_KEY', key);
  props.deleteProperty('GEMINI_MODEL_OK');
  return { ok: true, hasKey: true };
}

// ---------- linki mailowe ----------

function trySendLink_(u, purpose) {
  try {
    sendLink_(u, purpose);
    return true;
  } catch (err) {
    console.error(err && err.stack || err);
    return false;
  }
}

function sendLink_(u, purpose) {
  const token = randomToken_();
  const now = Date.now();
  purgeExpired_(LINKS_SHEET, LINKS_HEADERS, 3);
  getSheet_(LINKS_SHEET, LINKS_HEADERS).appendRow([sha256Hex_(token), u.id, purpose, now + LINK_TTL_MS, false, now]);
  const url = APP_URL + '?pin=' + token;
  const first = purpose === 'invite';
  const subject = APP_NAME + (first ? ' — ustaw swój PIN' : ' — nowy PIN');
  const lines = [
    'Cześć ' + u.name + ',',
    '',
    first ? 'Masz konto w appce ' + APP_NAME + '. Twój login: ' + u.id + '.'
          : 'Ktoś (pewnie Ty) poprosił o ustawienie nowego PIN-u do appki ' + APP_NAME + '. Login: ' + u.id + '.',
    'Otwórz link i ustaw 6-cyfrowy PIN:',
    url,
    '',
    'Link działa 48 godzin i tylko raz.',
    first ? '' : 'Jeśli to nie Ty — zignoruj tę wiadomość, stary PIN dalej działa.'
  ];
  const html = '<p>Cześć ' + esc_(u.name) + ',</p><p>' +
    (first ? 'Masz konto w appce <b>' + APP_NAME + '</b>. Twój login: <b>' + esc_(u.id) + '</b>.'
           : 'Ktoś (pewnie Ty) poprosił o ustawienie nowego PIN-u do appki <b>' + APP_NAME + '</b>. Login: <b>' + esc_(u.id) + '</b>.') +
    '</p><p><a href="' + url + '" style="display:inline-block;background:#e8a33d;color:#20140a;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:bold">Ustaw PIN</a></p>' +
    '<p style="color:#666;font-size:13px">Link działa 48 godzin i tylko raz.' + (first ? '' : ' Jeśli to nie Ty — zignoruj tę wiadomość, stary PIN dalej działa.') + '</p>';
  MailApp.sendEmail({ to: u.email, subject: subject, body: lines.join('\n'), htmlBody: html, name: APP_NAME });
}

function findLink_(token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) return null;
  const h = sha256Hex_(token);
  const rows = getSheet_(LINKS_SHEET, LINKS_HEADERS).getDataRange().getValues();
  const now = Date.now();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] !== h) continue;
    if (rows[i][4] === true || rows[i][4] === 'TRUE' || Number(rows[i][3]) < now) return null;
    return { row: i + 1, userId: String(rows[i][1]), purpose: String(rows[i][2]) };
  }
  return null;
}

function lastLinkTime_(userId) {
  const rows = getSheet_(LINKS_SHEET, LINKS_HEADERS).getDataRange().getValues();
  let last = 0;
  for (let i = 1; i < rows.length; i++) if (String(rows[i][1]) === userId) last = Math.max(last, Number(rows[i][5]) || 0);
  return last;
}

// ---------- paragony ----------

function listReceipts_() {
  const rows = getSheet_(RECEIPTS_SHEET, RECEIPTS_HEADERS).getDataRange().getValues();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0] || r[9] === true || r[9] === 'TRUE') continue;
    try {
      out.push(JSON.parse(r[4]));
    } catch (err) {
      console.error('Uszkodzony wiersz paragonu ' + r[0]);
    }
  }
  return { ok: true, receipts: out };
}

function findReceiptRow_(id) {
  const rows = getSheet_(RECEIPTS_SHEET, RECEIPTS_HEADERS).getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) if (String(rows[i][0]) === id) return { row: i + 1, values: rows[i] };
  return null;
}

function cleanReceipt_(r) {
  if (!r || typeof r !== 'object') return null;
  const id = String(r.id || '');
  if (!/^[A-Za-z0-9_\-]{6,64}$/.test(id)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.date || ''))) return null;
  if (!Array.isArray(r.items) || r.items.length > 400) return null;
  if (typeof r.total !== 'number' || !isFinite(r.total)) return null;
  const json = JSON.stringify(r);
  if (json.length > MAX_RECEIPT_CHARS) return null;
  return r;
}

function saveReceipt_(user, b) {
  const r = cleanReceipt_(b.receipt);
  if (!r) return fail_('bad');
  const sheet = getSheet_(RECEIPTS_SHEET, RECEIPTS_HEADERS);
  const now = Date.now();
  const found = findReceiptRow_(r.id);
  if (found) {
    const old = found.values;
    if (old[9] === true || old[9] === 'TRUE') return fail_('deleted');
    // Ochrona przed nadpisaniem cudzej, nowszej zmiany (np. dwa telefony offline).
    if (b.baseUpdatedAt != null && Number(old[8]) > Number(b.baseUpdatedAt)) return fail_('conflict', { current: JSON.parse(old[4]) });
    r.addedBy = String(old[5]);
    r.createdAt = Number(old[6]);
    r.updatedBy = user.id;
    r.updatedAt = now;
    sheet.getRange(found.row, 1, 1, RECEIPTS_HEADERS.length).setValues([[r.id, r.date, String(r.shop || ''), r.total, JSON.stringify(r), r.addedBy, r.createdAt, user.id, now, false]]);
  } else {
    r.addedBy = user.id;
    r.createdAt = now;
    r.updatedBy = user.id;
    r.updatedAt = now;
    sheet.appendRow([r.id, r.date, String(r.shop || ''), r.total, JSON.stringify(r), user.id, now, user.id, now, false]);
  }
  return { ok: true, receipt: r };
}

function deleteReceipt_(user, b) {
  const found = findReceiptRow_(String(b.id || ''));
  if (!found) return { ok: true };
  // Nie kasujemy wiersza — tylko oznaczamy (da się odzyskać z Arkusza).
  const sheet = getSheet_(RECEIPTS_SHEET, RECEIPTS_HEADERS);
  sheet.getRange(found.row, 8, 1, 3).setValues([[user.id, Date.now(), true]]);
  audit_(user.id, 'delete', { id: b.id, shop: found.values[2], date: found.values[1], total: found.values[3] });
  return { ok: true };
}

function adminImport_(admin, b) {
  if (!Array.isArray(b.receipts) || b.receipts.length > 500) return fail_('bad');
  let added = 0, skipped = 0;
  b.receipts.forEach(function (x) {
    const r = cleanReceipt_(x);
    if (!r || findReceiptRow_(r.id)) { skipped++; return; }
    saveReceipt_(admin, { receipt: r });
    added++;
  });
  return { ok: true, added: added, skipped: skipped };
}

// ---------- odczyt paragonu przez Gemini ----------

function parseEntry_(b) {
  const auth = authenticate_(b.token);
  if (!auth) return fail_('auth');
  const key = getApiKey_();
  if (!key) return fail_('nokey');
  const files = Array.isArray(b.files) ? b.files : [];
  if (!files.length || files.length > MAX_PARSE_FILES) return fail_('bad');
  let size = 0;
  const parts = [{ text: parsePrompt_(b.categories, b.hints, files.length) }];
  for (let i = 0; i < files.length; i++) {
    const f = files[i] || {};
    const data = String(f.data || '');
    size += data.length;
    if (!data || size > MAX_PARSE_B64 || /[^A-Za-z0-9+/=]/.test(data)) return fail_('bad');
    if (f.type !== 'application/pdf' && f.type !== 'image/jpeg' && f.type !== 'image/png') return fail_('bad');
    parts.push({ inline_data: { mime_type: f.type, data: data } });
  }
  const payload = JSON.stringify({
    contents: [{ parts: parts }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 32768 }
  });
  const props = PropertiesService.getScriptProperties();
  const models = GEMINI_MODELS.slice();
  const cached = props.getProperty('GEMINI_MODEL_OK');
  if (cached) {
    const k = models.indexOf(cached);
    if (k >= 0) models.splice(k, 1);
    models.unshift(cached);
  }
  let lastError = 'nieznany błąd';
  for (let i = 0; i < models.length; i++) {
    let res;
    try {
      res = UrlFetchApp.fetch(GEMINI_URL + models[i] + ':generateContent', {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-goog-api-key': key },
        payload: payload,
        muteHttpExceptions: true
      });
    } catch (err) {
      lastError = models[i] + ': ' + err.message;
      continue;
    }
    const status = res.getResponseCode();
    let body;
    try {
      body = JSON.parse(res.getContentText());
    } catch (err) {
      lastError = models[i] + ': HTTP ' + status;
      continue;
    }
    if (status !== 200) {
      lastError = models[i] + ': ' + (body.error ? body.error.message : 'HTTP ' + status);
      console.error('Gemini ' + lastError);
      // Zły klucz / brak uprawnień / limit — inny model nic nie pomoże.
      if ((status === 400 && /API key/i.test(lastError)) || status === 401 || status === 403 || status === 429) break;
      continue;
    }
    props.setProperty('GEMINI_MODEL_OK', models[i]);
    const cand = body.candidates && body.candidates[0];
    if (!cand || !cand.content) return fail_('ai', { detail: 'brak odpowiedzi' + (body.promptFeedback ? ' (' + body.promptFeedback.blockReason + ')' : '') });
    if (cand.finishReason === 'MAX_TOKENS') return fail_('ai', { detail: 'paragon za długi — podziel go na dwie części' });
    const text = (cand.content.parts || []).filter(function (p) { return p.text && !p.thought; }).map(function (p) { return p.text; }).join('')
      .replace(/^\s*```(?:json)?\s*/, '').replace(/\s*```\s*$/, '');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return fail_('ai', { detail: 'odpowiedź nie jest JSON-em' });
    }
    if (!parsed || !Array.isArray(parsed.items)) return fail_('ai', { detail: 'brak listy pozycji' });
    return { ok: true, receipt: parsed, model: models[i], usage: body.usageMetadata || null };
  }
  return fail_('ai', { detail: lastError.slice(0, 300) });
}

function parsePrompt_(categories, hints, nFiles) {
  const cats = Array.isArray(categories) ? categories.map(String).slice(0, 40) : [];
  const hintList = Array.isArray(hints) ? hints.map(String).slice(0, 300) : [];
  return [
    'To jest polski paragon ze sklepu (zdjęcie, zrzut ekranu z aplikacji sklepu albo PDF).',
    nFiles > 1 ? 'Paragon jest podzielony na ' + nFiles + ' kolejnych fragmentów, które mogą na siebie lekko nachodzić — nie dubluj pozycji z zakładek. Uwaga: dwie identyczne linie jedna pod drugą to zwykle dwa osobne zakupy, a nie zakładka.' : '',
    'Zwróć WYŁĄCZNIE obiekt JSON dokładnie w tym kształcie (liczby z kropką, bez jednostek):',
    '{"shop": "", "place": "", "date": "RRRR-MM-DD", "time": "GG:MM", "total": 0, "pay": "", "warnings": [""], "items": [{"n": "", "q": 1, "u": "szt", "p": 0, "v": 0, "d": 0, "c": "", "g": "", "s": 0, "su": "", "note": ""}]}',
    'Znaczenie pól:',
    '- shop: nazwa sieci (np. "Lidl", "Biedronka", "Auchan"), place: miasto i ulica sklepu, date: YYYY-MM-DD, time: HH:MM,',
    '- total: kwota faktycznie do zapłaty (ostatnie "Razem"/"Suma PLN" po kaucjach i zwrotach), pay: forma płatności krótko.',
    '- items: KAŻDA linia towaru po kolei, jak na paragonie:',
    '  n = nazwa dokładnie jak na paragonie; q = ilość (sztuki albo kg dla towaru na wagę); u = "kg" dla towaru na wagę, inaczej "szt";',
    '  p = cena jednostkowa; v = wartość linii PRZED rabatem; d = suma rabatów/kuponów tej linii jako liczba dodatnia (0 gdy brak);',
    '  c = kategoria — dokładnie jedna z listy: ' + cats.join(' | ') + ';',
    '  g = krótka ogólna nazwa produktu do porównań między sklepami, po polsku, bez marki gdy to zwykły produkt (np. "Mleko 2%", "Masło 82%", "Filet z piersi kurczaka", "Banany", "Twarożek Grani 200 g");',
    '  s = gramatura/objętość JEDNEJ sztuki w kg albo litrach, gdy wynika z nazwy (np. 200g → 0.2, 0,5l → 0.5), inaczej 0; su = "kg", "l" albo "" (pusty, gdy s = 0);',
    '  note = krótka uwaga po polsku tylko gdy coś jest niepewne (nieczytelne, nie wiesz co to za produkt), inaczej "".',
    '- Kaucje za butelki/puszki (także zwrot kaucji — wtedy v ujemne) wpisz jako osobne pozycje z kategorią "Kaucja".',
    '- Rabat/kupon/"Lidl Plus"/"Rabat grupowy" pod pozycją NIE jest osobną pozycją — dolicz go do d pozycji nad nim.',
    '- Suma (v - d) wszystkich pozycji powinna się równać total. Jeśli nie wychodzi — sprawdź jeszcze raz i opisz różnicę w warnings.',
    '- Pomiń podsumowania VAT (PTU), numery kas, reklamy, reszty.',
    hintList.length ? 'Tak rozpoznawaliśmy te produkty wcześniej (nazwa z paragonu → kategoria / produkt) — trzymaj się tego, jeśli pasuje:\n' + hintList.join('\n') : ''
  ].filter(function (s) { return s; }).join('\n');
}

function getApiKey_() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || '';
}

// ---------- użytkownicy, sesje, pomocnicze ----------

function adminView_(u) {
  return {
    id: u.id, name: u.name, role: u.role, email: u.email, active: u.active,
    hasPin: !!u.hash, locked: u.lockUntil > Date.now(), lockUntil: u.lockUntil
  };
}

function pub_(u) {
  return { id: u.id, name: u.name, role: u.role };
}

function validId_(v) {
  const s = String(v || '').trim().toUpperCase();
  return /^[A-Z]{1,6}$/.test(s) ? s : null;
}

function validPin_(v) {
  const s = String(v || '');
  return /^\d{6}$/.test(s) ? s : null;
}

function validEmail_(v) {
  const s = String(v || '').trim();
  return /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[A-Za-z]{2,24}$/.test(s) ? s : null;
}

function cleanName_(v) {
  const s = String(v || '').replace(/[<>"]/g, '').trim();
  return s && s.length <= 40 ? s : null;
}

function ownerEmail_() {
  try {
    return Session.getEffectiveUser().getEmail() || '';
  } catch (err) {
    return '';
  }
}

function maskEmail_(e) {
  const at = e.indexOf('@');
  return at > 1 ? e[0] + '•••' + e.slice(at - 1) : e;
}

function esc_(s) {
  return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
}

function randomToken_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

function getPepper_() {
  const props = PropertiesService.getScriptProperties();
  let p = props.getProperty('PEPPER');
  if (!p) {
    p = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('PEPPER', p);
  }
  return p;
}

function hashPin_(pin, salt) {
  return Utilities.base64Encode(Utilities.computeHmacSha256Signature(pin, getPepper_() + ':' + salt));
}

function sha256Hex_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function getSheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
  }
  return sheet;
}

function readUsers_() {
  const rows = getSheet_(USERS_SHEET, USERS_HEADERS).getDataRange().getValues();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0]) continue;
    out.push({
      row: i + 1, id: String(r[0]), name: String(r[1]), role: String(r[2]), email: String(r[3] || ''),
      salt: String(r[4] || ''), hash: String(r[5] || ''), fails: Number(r[6]) || 0,
      lockUntil: Number(r[7]) || 0, active: r[8] === true || r[8] === 'TRUE',
      lockCount: Number(r[9]) || 0, createdAt: r[10]
    });
  }
  return out;
}

function findUser_(id) {
  if (!id) return null;
  const list = readUsers_();
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

function userRow_(u) {
  return [u.id, u.name, u.role, u.email, u.salt, u.hash, u.fails, u.lockUntil, u.active, u.lockCount, u.createdAt];
}

function saveUser_(u) {
  getSheet_(USERS_SHEET, USERS_HEADERS).getRange(u.row, 1, 1, USERS_HEADERS.length).setValues([userRow_(u)]);
}

// Konto powstaje bez PIN-u — PIN ustawia właściciel przez link z maila.
function createUser_(id, name, role, email) {
  getSheet_(USERS_SHEET, USERS_HEADERS).appendRow(userRow_({
    id: id, name: name, role: role, email: email, salt: '', hash: '', fails: 0,
    lockUntil: 0, active: true, lockCount: 0, createdAt: Date.now()
  }));
}

function setPin_(u, pin) {
  u.salt = Utilities.getUuid();
  u.hash = hashPin_(pin, u.salt);
  u.fails = 0;
  u.lockCount = 0;
  u.lockUntil = 0;
  saveUser_(u);
  revokeSessions_(u.id, null);
}

function authenticate_(token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) return null;
  const tokenHash = sha256Hex_(token);
  const rows = getSheet_(SESSIONS_SHEET, SESSIONS_HEADERS).getDataRange().getValues();
  const now = Date.now();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === tokenHash) {
      if (Number(rows[i][2]) < now) return null;
      const user = findUser_(String(rows[i][1]));
      if (!user || !user.active) return null;
      return { user: user, tokenHash: tokenHash };
    }
  }
  return null;
}

function revokeSessions_(userId, onlyHash) {
  const sheet = getSheet_(SESSIONS_SHEET, SESSIONS_HEADERS);
  const rows = sheet.getDataRange().getValues();
  for (let i = rows.length - 1; i >= 1; i--) {
    const match = onlyHash ? rows[i][0] === onlyHash : String(rows[i][1]) === userId;
    if (match) sheet.deleteRow(i + 1);
  }
}

// Usuwa wiersze, których termin ważności (kolumna expiresCol, liczona od 0) minął.
function purgeExpired_(name, headers, expiresCol) {
  const sheet = getSheet_(name, headers);
  const rows = sheet.getDataRange().getValues();
  const now = Date.now();
  for (let i = rows.length - 1; i >= 1; i--) {
    if (Number(rows[i][expiresCol]) < now) sheet.deleteRow(i + 1);
  }
}

function audit_(actor, action, b) {
  const detail = {};
  ['id', 'name', 'email', 'active', 'role', 'purpose', 'shop', 'date', 'total'].forEach(function (k) {
    if (b && b[k] !== undefined) detail[k] = b[k];
  });
  if (action === 'admin.setApiKey') detail.key = b && b.key ? 'ustawiony' : 'usunięty';
  if (action === 'admin.import' && b && Array.isArray(b.receipts)) detail.count = b.receipts.length;
  getSheet_(AUDIT_SHEET, AUDIT_HEADERS).appendRow([
    Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'), actor, action, String(detail.id || ''), JSON.stringify(detail)
  ]);
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Uruchom RAZ ręcznie w edytorze Apps Script (Uruchom → autoryzuj), żeby właściciel przyznał
// uprawnienia: Arkusz, wysyłanie maili, połączenia z Gemini API. Potem wdróż jako aplikację.
function autoryzuj() {
  getSheet_(USERS_SHEET, USERS_HEADERS);
  console.log('Właściciel: ' + ownerEmail_() + ', limit maili na dziś: ' + MailApp.getRemainingDailyQuota());
  UrlFetchApp.fetch(GEMINI_URL, { muteHttpExceptions: true });
}
