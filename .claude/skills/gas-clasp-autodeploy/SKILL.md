---
name: gas-clasp-autodeploy
description: Konfiguracja automatycznego wdrażania backendu Google Apps Script (Code.gs/Kod.gs) przez GitHub Actions + clasp, żeby push na main sam aktualizował działającą Web App bez ręcznego kopiowania do edytora script.google.com. Użyj tego skilla, gdy projekt ma backend w Apps Script (Sheets-bound web app) i użytkownik chce, żeby Claude mógł sam wdrażać zmiany.
---

# Auto-deploy Google Apps Script przez clasp + GitHub Actions

Ten skill dokumentuje jednorazową konfigurację, dzięki której zwykły `git push`
na `main` sam aktualizuje działający Web App w Google Apps Script — bez
ręcznego "Zarządzaj wdrożeniami → Nowa wersja → Wdróż" w przeglądarce.

Powstał po prawdziwej, bolesnej konfiguracji (projekt AGENT_JOHN, wrzesień
2026) — 7 nieudanych testów pipeline'u zanim zadziałał. Każda pułapka niżej
to realny błąd, na który wtedy trafiliśmy. Trzymaj się kolejności, a
konfiguracja nowego projektu powinna zająć < 15 minut zamiast > 2h.

## Kiedy używać

Użytkownik ma projekt z backendem w Google Apps Script (Web App bound do
Google Sheet) i chce, żeby Claude mógł samodzielnie wdrażać zmiany w
backendzie, zamiast prosić go za każdym razem o ręczne kopiowanie kodu do
edytora `script.google.com` i klikanie "Wdróż".

## Wymagania wstępne

- Użytkownik ma dostęp do Google Cloud Shell (shell.cloud.google.com) —
  darmowe, przeglądarkowe, nic nie trzeba instalować lokalnie, działa nawet
  z telefonu.
- Repo na GitHubie z uprawnieniami do dodawania sekretów (Settings →
  Secrets and variables → Actions).
- Zanotowany **scriptId** projektu Apps Script (z URL edytora:
  `script.google.com/d/<SCRIPT_ID>/edit`) i **deploymentId** istniejącego
  wdrożenia Web App (z `/exec` URL: `.../macros/s/<DEPLOYMENT_ID>/exec`).

## Krok po kroku

### 1. Pliki w repozytorium (rób to Ty, nie użytkownik)

**`.clasp.json`** (root repo):
```json
{
  "scriptId": "<SCRIPT_ID>",
  "rootDir": "."
}
```

**`.claspignore`** (root repo) — wypycha tylko wybrane pliki, nic więcej:
```
**/**
!<NazwaGlownegoPliku>.gs
!appsscript.json
```
⚠️ Zobacz pułapkę #5 niżej — nazwa pliku MUSI się zgadzać z tym, co już
istnieje w projekcie Apps Script, inaczej `clasp push` stworzy DRUGI,
konfliktowy plik zamiast zaktualizować istniejący.

**`appsscript.json`** — NIE zgaduj tej treści. Pobierz prawdziwą (patrz
pułapka #4 niżej) i wklej dokładnie to, co zwróci `clasp pull`.

**`.github/workflows/deploy-gas.yml`**:
```yaml
name: Deploy Apps Script backend
on:
  push:
    branches: [main]
    paths:
      - '<NazwaGlownegoPliku>.gs'
      - 'appsscript.json'
  workflow_dispatch: {}

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install clasp
        run: npm install -g @google/clasp@latest
      - name: Restore clasp login credentials
        run: echo "$CLASP_CREDENTIALS" > ~/.clasprc.json
        env:
          CLASP_CREDENTIALS: ${{ secrets.CLASP_CREDENTIALS }}
      - name: Push to Apps Script
        run: clasp push -f
      # --deploymentId jest obowiązkowe: bez niego clasp tworzy NOWE
      # wdrożenie (nowy URL) zamiast zaktualizować istniejące.
      - name: Deploy new version to the existing web app (same URL)
        run: clasp deploy --deploymentId "$GAS_DEPLOYMENT_ID" --description "auto-deploy $(date -u +%Y-%m-%dT%H:%M:%SZ)"
        env:
          GAS_DEPLOYMENT_ID: ${{ secrets.GAS_DEPLOYMENT_ID }}
```

Commit + push tych plików do repo.

### 2. Logowanie clasp w Cloud Shell (rób to użytkownik, przez przeglądarkę)

Instruuj użytkownika żeby otworzył **shell.cloud.google.com** i wpisał:

```
npm install -g @google/clasp
clasp login --no-localhost
```

**Użyj od razu `--no-localhost`, nie zwykłego `clasp login`** — patrz
pułapka #1 niżej, to oszczędza kilka nieudanych prób.

Procedura logowania (jedna, nieprzerwana sekwencja — patrz pułapka #2):
1. Poczekaj aż pojawią się OBIE linijki: link do autoryzacji ORAZ
   "After authorizing, copy the URL from your browser and paste it here:".
2. Kliknij link, zaloguj się na Google, zatwierdź uprawnienia.
3. Wyląduje na stronie błędu "nieosiągalna"/"connection refused" —
   **to jest normalne i oczekiwane**, liczy się tylko pasek adresu.
4. Skopiuj cały adres z paska (Ctrl+A, Ctrl+C).
5. Wróć do TEJ SAMEJ karty terminala, wklej dokładnie po "paste it here:",
   Enter.
6. Powinno pokazać się "Logged in as ...".

Zanim ruszysz dalej, każ użytkownikowi zweryfikować LOKALNIE (patrz pułapka
#3):
```
cd <folder-z-projektem>
clasp deployments
```
Powinna pokazać się lista istniejących wdrożeń bez błędu.

### 3. Sekrety w GitHubie — przez `gh`, NIGDY przez ręczne kopiowanie

**Nie każ użytkownikowi wklejać `~/.clasprc.json` do przeglądarki ręcznie**
— patrz pułapka #2 niżej, to prawie zawsze się psuje przy długim
kopiowaniu. Zamiast tego, w tym samym terminalu Cloud Shell:

```
gh --version
```
(jeśli brak: `sudo apt-get update && sudo apt-get install gh -y`)

```
gh auth login
```
(GitHub.com → HTTPS → Login with a web browser — osobne logowanie niż do
Google, na konto właściciela repo)

```
gh secret set CLASP_CREDENTIALS --repo <owner>/<repo> < ~/.clasprc.json
gh secret set GAS_DEPLOYMENT_ID --repo <owner>/<repo> --body "<DEPLOYMENT_ID>"
```

### 4. Manifest appsscript.json — pobierz, nie zgaduj

W tym samym folderze w Cloud Shell:
```
clasp pull
cat appsscript.json
```
Skopiuj TREŚĆ (nie jest tajna — strefa czasowa, ustawienia, nic sekretnego)
i wklej ją do pliku `appsscript.json` w repo. **Nigdy nie pisz tego pliku
z głowy** — pole `webapp.access`/`webapp.executeAs` kontroluje kto może
używać wdrożonej appki; zgadnięcie źle po cichu zmieniłoby uprawnienia
dostępu przy najbliższym `clasp push`.

`clasp pull` przy okazji pokaże Ci prawdziwą nazwę głównego pliku (patrz
pułapka #5) — jeśli to nie "Code.gs" tylko np. "Kod.js", nazwij lokalny
plik dokładnie tak samo (z rozszerzeniem `.gs`).

### 5. Włącz Apps Script API (jednorazowo, konto Google)

Każ użytkownikowi wejść na **script.google.com/home/usersettings** i
włączyć przełącznik "Google Apps Script API". Bez tego `clasp push`/`clasp
deploy` (ale nie `clasp login`/`clasp deployments`!) kończą się błędem
"User has not enabled the Apps Script API" — to osobne ustawienie od
logowania OAuth.

### 6. Test end-to-end

Wyzwól workflow ręcznie (GitHub Actions MCP tool `actions_run_trigger`,
method `run_workflow`, albo przycisk "Run workflow" w zakładce Actions) i
sprawdź logi. Sukces wygląda tak: krok `clasp push -f` wypisuje listę
wypchniętych plików, krok `clasp deploy` wypisuje `Deployed <ID> @<N>` z
rosnącym numerem wersji pod TYM SAMYM deploymentId. Dla pewności, curl na
`.../macros/s/<DEPLOYMENT_ID>/exec` powinien zwrócić odpowiedź appki (nawet
błąd typu "brak autoryzacji" dla nieznanej akcji dowodzi, że kod się
wykonuje), a nie stronę błędu Google.

## Najczęstsze pułapki (kolejność = kolejność w jakiej realnie wystąpiły)

1. **Zwykłe `clasp login` w Cloud Shell często nie działa.** Cloud Shell to
   zdalna maszyna — przeglądarka użytkownika i proces `clasp` są na dwóch
   różnych komputerach. `clasp login` (bez flagi) startuje lokalny listener
   na porcie zdalnej maszyny i liczy na to, że Cloud Shell automatycznie
   przekieruje ruch (czasem działa, czasem nie — kończy się
   `ERR_CONNECTION_REFUSED` na `localhost:<port>` w przeglądarce, bo to
   PC użytkownika próbuje połączyć się samo ze sobą). Użyj
   `--no-localhost` od razu, nie trać czasu na zwykłe `login`.

2. **Nie każ nikomu ręcznie kopiować `~/.clasprc.json` do pola tekstowego w
   przeglądarce.** To jedna długa linijka JSON — przy zawijaniu w
   terminalu prawie zawsze coś się urywa/dubluje przy zaznaczaniu myszką,
   dając błąd typu `Unexpected non-whitespace character after JSON at
   position N` w CI. Zawsze `gh secret set NAZWA < plik` bezpośrednio z
   terminala — zero kopiowania, zero okazji do uszkodzenia.

3. **`invalid_grant` w CI = token już nieważny, nie problem z transportem.**
   Może się zdarzyć nawet po świeżym `clasp login`, jeśli coś po drodze
   unieważniło token (np. użytkownik odwiedził stronę "Połączone
   aplikacje" Google i coś tam kliknął, albo zbyt wiele
   logowań/wylogowań pod rząd). Zanim znowu testujesz przez GitHuba
   (traci czas na cały przebieg CI), każ zweryfikować `clasp deployments`
   LOKALNIE w Cloud Shell — jeśli to też pada, problem jest w
   logowaniu/koncie, nie w GitHubie.

4. **`clasp push` wymaga `appsscript.json` w wypychanym zestawie plików.**
   Jeśli `.claspignore` przepuszcza tylko główny plik `.gs`, push pada z
   "Project contents must include a manifest file named appsscript".
   Zawsze pobieraj prawdziwy manifest przez `clasp pull` (krok 4 wyżej) —
   nigdy nie zgaduj, bo można przypadkiem zmienić ustawienia dostępu do
   Web App.

5. **Lokalna nazwa pliku MUSI się zgadzać z nazwą na serwerze.** `clasp
   push` mapuje nazwę pliku (bez rozszerzenia) 1:1 na nazwę pliku po
   stronie Apps Script. Jeśli lokalne repo ma `Code.gs`, a prawdziwy
   projekt (sprawdź przez `clasp pull` — pokaże realne nazwy plików) ma
   plik nazwany inaczej (np. "Kod" — zdarza się w projektach tworzonych z
   polskim interfejsem), push NIE zaktualizuje istniejącego pliku — stworzy
   DRUGI, osobny plik obok, z takimi samymi nazwami funkcji top-level
   (`doGet`, `doPost` itd.), co Apps Script odrzuci albo obsłuży w
   nieprzewidywalny sposób. Zawsze rób `clasp pull` PRZED ustaleniem nazwy
   lokalnego pliku, nie po fakcie.

6. **"User has not enabled the Apps Script API"** to osobny, jednorazowy
   przełącznik na `script.google.com/home/usersettings` — nie ma nic
   wspólnego z zakresami OAuth ani z logowaniem. Włącz go zanim zaczniesz
   testować `clasp push`/`clasp deploy` w CI, oszczędzi to jeden cykl
   testowy.

7. **`--deploymentId` w `clasp deploy` jest obowiązkowe.** Bez niego clasp
   tworzy nowe, osobne wdrożenie (nowy URL `/exec`) zamiast zaktualizować
   istniejące — frontend dalej wskazuje na stary URL, zmiany "nie działają"
   mimo że deploy przeszedł bez błędu.

## Bezpieczeństwo — pilnuj tego zawsze

`~/.clasprc.json` to pełny, długożyjący token OAuth (client_id,
client_secret, refresh_token, access_token) — traktuj jak hasło. Kody
autoryzacji (`code=...` w adresach URL) są krótkotrwałe, ale też nie
powinny trafiać do czatu. Zasada dla użytkownika: **terminal Cloud Shell i
pole sekretu w GitHubie = można wklejać długie/wrażliwe ciągi; czat z
Claude = nigdy** (opisz słownie albo wyślij zrzut ekranu terminala zamiast
kopiować tekst). Jeśli coś wrażliwego trafi jednak do czatu — powiedz to
wprost użytkownikowi, nie używaj/nie powtarzaj tej wartości, i każ
odwołać/wygenerować nowe dane (Google: myaccount.google.com/permissions).
