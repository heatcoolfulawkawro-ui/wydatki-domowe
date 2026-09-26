# Wydatki domowe — pamięć projektu

Domowa appka webowa do paragonów: wrzucasz zdjęcie / zrzut z aplikacji sklepu / PDF, Gemini
odczytuje pozycje, appka robi narastające zestawienie (miesiąc, kategorie, sklepy) i porównuje
ceny tych samych produktów między sklepami. Używają jej dwie osoby (Szef + żona), głównie na
iPhonie. Z użytkownikiem rozmawiaj po polsku („Szefie”); to inżynier, nie programista — tłumacz
krótko pojęcia przy pierwszym użyciu i rób sam wszystko, co nie wymaga jego logowania.
Wzorzec architektury i pułapki: skill `ra-ster-mini-app` (ten sam układ co karta-godzin).

## Gdzie co leży

- **Frontend**: `index.html` (jeden plik HTML+CSS+JS, bez frameworków i build stepu) → GitHub
  Pages: https://heatcoolfulawkawro-ui.github.io/wydatki-domowe/
- **Backend**: `Kod.gs` + `appsscript.json` → Apps Script podpięty do Arkusza „Wydatki domowe —
  dane”. Zakładki tworzą się same: `Users`, `Sessions`, `Links`, `Receipts`, `Audit`.
- **Web App URL** (stała `GAS_URL` w `index.html`) — po pierwszym wdrożeniu NIE MOŻE się zmienić.
- `.claspignore` — clasp wypycha tylko `Kod.gs` i `appsscript.json`.
- `tools/sandbox.js` — serwer testowy: prawdziwy `Kod.gs` na atrapie Arkusza, maile do `/__mail`,
  atrapa Gemini API (wywołania w `/__ai`). `node tools/sandbox.js index.html Kod.gs [atrapa-odczytu.json] [port]`
  (domyślnie port 4280; NIE 4190 — przeglądarki/`fetch` blokują ten port).

## Pierwsze wdrożenie (ZROBIONE 25.09.2026 — kroki 1–7; krok 8 robi Szef)

scriptId `1oqqal0qhfIvUrvbTBjofAv2UZZq_wZdVBB6dLYrZur_Wdw-bWmRgI9nF` (`.clasp.json` w repo — potrzebny w CI),
deploymentId `AKfycby-n1t8ehXtz9sNEByK-dZbObSAs39RKOovANpGIefLbs2-spAlx1iwdFb9CUK5fVZH`. Uwagi z wdrożenia:
`clasp create` nadpisał `appsscript.json` (America/New_York, bez `webapp`) — przywrócono nasz. HTTP 403
„Odmowa dostępu” z `/exec` = właściciel nie przyznał jeszcze uprawnień (`autoryzuj` → Zezwól do końca).

Do zrobienia na PC Szefa (tam są zalogowane `clasp` i `gh`), w tej kolejności:
1. `clasp create --type sheets --title "Wydatki domowe — dane" --rootDir .` w katalogu repo
   (tworzy Arkusz z podpiętym skryptem i `.clasp.json`; nie nadpisuj `Kod.gs` — jeśli clasp
   utworzy własny `Code.gs`/manifest, usuń duplikat i zostaw nasz `Kod.gs`).
   Potem `clasp push -f`.
2. Szef raz w edytorze Apps Script: uruchom funkcję `autoryzuj` → „Zezwól” (Arkusz, wysyłanie
   maili, połączenia zewnętrzne — ekran „Google hasn't verified this app” jest normalny:
   Advanced → Go to… → Allow).
3. `clasp deploy --description "v0.1"` → z wyniku weź deploymentId. Ustawienia Web App muszą
   być: „Wykonaj jako: Ja”, „Dostęp: Każdy” (w `appsscript.json`: `executeAs USER_DEPLOYING`,
   `access ANYONE_ANONYMOUS`). Po `clasp pull` sprawdź, że manifest ma sekcję `webapp`.
4. Wpisz ID do `GAS_URL` w `index.html` i do `GAS_DEPLOYMENT_ID` w
   `.github/workflows/deploy-gas.yml` (zamiast `USTAW_PO_PIERWSZYM_WDROZENIU`).
5. `gh secret set CLASPRC_JSON --repo heatcoolfulawkawro-ui/wydatki-domowe < ~/.clasprc.json`
   (w Bash; nigdy nie wyświetlaj treści tego pliku).
6. GitHub Pages: `gh api -X POST repos/heatcoolfulawkawro-ui/wydatki-domowe/pages -f "source[branch]=main" -f "source[path]=/"`
   (albo Settings → Pages → main / root). Sprawdź `gh api repos/heatcoolfulawkawro-ui/wydatki-domowe/pages`.
7. Push → `gh run watch` (Deployed … @N pod tym samym ID), `GET <GAS_URL>` → HTTP 200 z pustą treścią.
8. Szef otwiera appkę → ekran „Pierwsze uruchomienie” → konto admina PF → link do ustawienia PIN-u
   przychodzi na e-mail właściciela skryptu. Potem w Panelu admina: klucz Gemini (`AIza…` — ten sam co w Paliwo-PF,
   z Właściwości skryptu tamtego projektu albo z aistudio.google.com; konto płatne, nie trzeba doładowywać), konto żony (skrót + imię + e-mail → zaproszenie mailem),
   import pliku `paragony.json` (5 paragonów z września odczytanych na czacie 25.09.2026 — plik ma Szef,
   NIE ma go w repo).

## Wdrażanie — wszystko przez `git push` na `main`

- Frontend: push → Pages (~1 min); appka sama wykrywa nową wersję (HEAD + `last-modified`).
  Przy każdym wydaniu podbij `.vertag` i ustaw `.buildtag` (`DD.MM.RRRR GG:MM`, czas polski).
- Backend: push zmieniający `Kod.gs`/`appsscript.json` → `.github/workflows/deploy-gas.yml`
  (`clasp push -f` + `clasp deploy --deploymentId <istniejące>`). Nigdy bez `--deploymentId`.
  Dopóki nie ma ID i sekretu, workflow tylko wypisuje uwagę i kończy się sukcesem.

## Zasady przy zmianach

- Repo jest PUBLICZNE (darmowe Pages). Żadnych danych z paragonów, adresów e-mail, PIN-ów ani
  kluczy w repo. Klucz Gemini leży tylko we właściwościach skryptu (`GEMINI_API_KEY`), wpisuje
  go admin w appce; wysyłany w nagłówku `x-goog-api-key` (nie w adresie URL); nigdy nie trafia do przeglądarki.
- Przed widoczną zmianą UI pokaż makietę do akceptacji.
- Po każdej zmianie JS: `node <skill>/scripts/check-js.js index.html` i `node --check` na kopii `Kod.gs` jako `.js`.
- Testuj w `tools/sandbox.js`, nigdy na prawdziwym Arkuszu.
- POST do Apps Script zawsze `Content-Type: text/plain;charset=utf-8`.
- Przy wpisywaniu nie przebudowuj DOM-u (edytor paragonu odświeża tylko etykiety).
- NIE nazywaj klas CSS „reklamowo” (`ad-…`, `banner`, `promo`…) — blokery reklam je ukrywają.
- Na iOS: tylko natywne `<input type="file">` (przycisk „Dodaj paragon” to prawdziwy input w labelu).

## Format danych

- Zakładka `Receipts`: wiersz = paragon; kolumny `id, date, shop, total, json, addedBy, createdAt,
  updatedBy, updatedAt, deleted`. Usuwanie = `deleted=TRUE` (wiersz zostaje).
- JSON paragonu: `{id, shop, place, date:'RRRR-MM-DD', time, total (do zapłaty, z kaucjami), pay,
  source:'ai'|'manual'|'import', items:[{name, prod, cat, qty, unit:'szt'|'kg', price, gross
  (przed rabatem), disc (dodatni), net, size, sizeU:'kg'|'l'|'', ppu?, ppuU?, note?}], addedBy,
  createdAt, updatedBy, updatedAt}`. `net`, `ppu` liczy `calcItem` w appce.
- Kategorie (stała `CATS`): jedzenie = Mięso i wędliny, Ryby, Nabiał i jaja, Pieczywo, Warzywa i
  owoce, Produkty suche i bakalie, Przyprawy sosy i przetwory, Mrożonki, Dania gotowe, Słodycze lody
  i przekąski, Napoje, Alkohol; poza jedzeniem = Chemia i dom, Higiena i kosmetyki, Kwiaty i inne;
  `Kaucja` — nie jest wydatkiem (nie wchodzi do sum), ale wchodzi do sumy kontrolnej paragonu.
- `prod` = „produkt porównawczy” (np. „Twarożek Grani 200 g”, „Banany”) — po nim idzie porównanie
  cen między sklepami. Zmiana nazw kategorii/produktów = migracja istniejących danych.

## Funkcje (stan: 25.09.2026, v0.1 — wdrożona)

- Logowanie: skrót + PIN 6 cyfr, sesja 60 dni; PIN ustawia właściciel przez jednorazowy link z maila
  (48 h): zaproszenie od admina albo „Nie pamiętam PIN-u” (max 1 mail/min/konto, odpowiedź nie zdradza,
  czy konto istnieje). Blokada 5 błędów → 5 min, podwajana do 24 h. Pierwsze uruchomienie: konto admina,
  link idzie tylko na e-mail właściciela skryptu. Dane wspólne dla domu, zapis kto dodał/zmienił.
- Dodaj paragon: zdjęcia/zrzuty/PDF (kilka naraz) → długie zrzuty cięte na kawałki 760×1400 z zakładką →
  `parse` w Kod.gs → Gemini (`gemini-flash-latest`, zapasowo `gemini-3.6-flash`, `gemini-flash-lite-latest`; przy przeciążeniu 429/500/503 jedno ponowienie po 3 s, potem następny model; model, który zadziałał,
  zapamiętany w `GEMINI_MODEL_OK`; temperature 0, `responseMimeType: application/json`, kształt JSON
  opisany w prompcie — wzorzec z Paliwo-PF) → edytor do sprawdzenia. Szef wybrał Gemini zamiast Claude
  API (25.09.2026): ma już płatne konto Google i klucz. Do promptu idą podpowiedzi z historii (nazwa → kategoria/produkt),
  a po odczycie słownik z historii nadpisuje kategorię znanych nazw.
- Edytor: pozycje jako zwijane paski, suma kontrolna (pozycje vs „do zapłaty”) na dole, ostrzeżenie
  o duplikacie (ten sam sklep+data+kwota), zapis z niezgodną sumą wymaga drugiego dotknięcia.
- Zakładki: Paragony / Miesiąc (razem, jedzenie, prognoza, 6 miesięcy, kategorie) / Sklepy (sklepy +
  kategorie×sklepy) / Ceny (ten sam produkt w różnych sklepach — ostatnia cena za kg/l/szt; historia
  po dotknięciu; „ta sama rzecz, różne ceny”).
- Offline: bufor w localStorage + kolejka zmian wysyłana po powrocie sieci; konflikt (ktoś zmienił
  paragon w międzyczasie) → wygrywa nowsza wersja z serwera.
- Panel admina: konta (dodaj z e-mailem, wyślij link, odblokuj, zmień e-mail, wyłącz), klucz Gemini,
  import paragonów z pliku .json.

## Otwarte tematy

- Nic z tego nie było jeszcze testowane na prawdziwym Apps Script ani z prawdziwym Gemini API
  (tylko sandbox + atrapy). Po wdrożeniu: sprawdzić czas odczytu długiego paragonu (UrlFetchApp ma
  limit czasu — jeśli będzie za wolno, rozważyć inny model po zgodzie Szefa).
- Szef ma potwierdzić: 2 paczki parówek na paragonie Biedronki 18.09, co to „Lunchbox 250g” (Lidl 08.09),
  pomidory kiść 500 g za 14,99 zł.
- Pomysły na później: budżet miesięczny, wykresy trendu cen produktu, eksport do Excela.
