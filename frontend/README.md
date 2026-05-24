# Sailing Portal

Portale web per il monitoraggio remoto delle barche da regata, accoppiato
all'app tablet `main.py` (Kivy/buildozer).

## Cosa contiene

```
sailing-portal/
├── README.md            (questo file)
├── backend/             FastAPI (Python 3.11)
│   ├── app.py
│   ├── requirements.txt
│   ├── startup.sh       comando di avvio per Azure App Service
│   ├── .env.example     copialo in .env e personalizzalo
│   └── migrations/      script SQL per Azure SQL DB
├── frontend/            Pagine HTML/JS/CSS (vanilla)
│   ├── index.html
│   ├── replay.js, polarview.js, wptview.js, ...
│   └── style.css
└── deploy/              Script PowerShell per deploy su Azure
    ├── deploy.ps1               script principale (deploy zip su App Service)
    ├── set-env.ps1              push delle env vars (.env -> Azure App Settings)
    ├── deploy-config.ps1        configurazione (modifica qui RG e APP_NAME)
    └── README-deploy.md         istruzioni dettagliate
```

## Architettura

- **Backend FastAPI** + **frontend statico** girano sulla **stessa risorsa**
  Azure App Service Linux. I file statici sono serviti dalla cartella
  `backend/static/` (popolata al deploy) via `StaticFiles` di FastAPI.
- **Azure SQL Database** per: anagrafica barche/token, metadata varie.
  **Non contiene piu' la tabella live**: i dati real-time non passano da SQL.
- **Azure Event Hubs** (namespace `sailing-eventhubs`) per il flusso live:
  - Il **tablet** pubblica snapshot JSON sull'Event Hub usando la policy
    `tablet-sender` (SAS).
  - Il **backend** apre un consumer Event Hub per ogni client SSE connesso
    al portale e gli stream-a in tempo reale i dati della barca selezionata.
  - **Endpoint live**: `GET /api/boats/{boat_id}/live/stream` (text/event-stream).
- **Azure Storage Account** con container blob:
  - `polars/{boat_id}/polar.json`        — polari di velocita' per barca
  - `waypoints/{boat_id}/waypoints.json` — waypoint del campo regata
  - `meteo/{boat_id}/meteo.json`         — meteo
  - (`tracks/` non e' piu' alimentato dal live; lo storico passa da Event
    Hub **Capture** quando attivato — vedi sezione "Storico" sotto)

## Storico (Event Hub Capture)

Lo storico track non e' piu' persistito su SQL: la tabella `dbo.Tracks` resta
in DB per i dati pregressi ma non viene piu' scritta. Per ricostruire lo
storico nuovo:

1. Su Azure: Event Hub `sailing-eventhubs` -> Capture -> abilita verso
   uno Storage Account (es. container `eventhub-capture`). Output Avro
   (default) o Parquet.
2. Per query offline: leggere i file Avro/Parquet con PySpark / Fabric /
   Synapse / qualsiasi notebook.
3. L'endpoint `GET /api/boats/{id}/track?since=...` e' attualmente disabilitato
   (ritorna 410 Gone). Se serve lo riabilitiamo facendolo leggere da Capture.

## Quick start

### 1. Configurazione Azure (solo prima volta)

Vedi `deploy/README-deploy.md`.

### 2. Modifiche e deploy

```powershell
cd deploy
.\deploy.ps1
```

Lo script:
1. Verifica che az CLI sia installata e logged in
2. Controlla che frontend/index.html e backend/app.py esistano
3. Crea una cartella di staging temporanea
4. Copia backend + frontend in staging
5. Verifica esplicitamente che static/index.html sia in staging
6. Crea zip dalla staging
7. Verifica il contenuto dello zip prima di uploadare
8. Esegue az webapp deploy --type zip
9. Restart forzato dell'App Service
10. Aspetta che /health risponda 200
11. Verifica che / serva HTML (frontend up)
12. Pulisce zip e staging temporanei

### 2bis. Variabili di ambiente (DB, blob storage, admin token)

Il backend ha bisogno di credenziali per: Azure SQL DB, Azure Blob Storage,
admin token. Non vanno hard-coded nel codice ne' committate in git.

**Setup una volta sola:**

1. Copia `backend/.env.example` in `backend/.env`
2. Apri `backend/.env` e personalizza i valori (vedi sotto)
3. Lancia:
   ```powershell
   cd deploy
   .\set-env.ps1
   ```

Lo script legge il `.env` locale, mostra cosa cambiera' (con valori sensibili
mascherati), chiede conferma, poi pubblica le variabili come **App Settings**
sull'App Service. L'app viene riavviata automaticamente.

**Quando aggiornare:** ogni volta che cambi una credenziale (es. ruoti
l'AccountKey del blob, cambi password DB, ruoti l'ADMIN_TOKEN), modifichi
`.env` e rilanci `.\set-env.ps1`.

**Variabili necessarie:**

| Variabile | Dove prenderla |
|---|---|
| `SQL_SERVER` | nome server Azure SQL (es. `myserver.database.windows.net`) |
| `SQL_DATABASE` | nome del DB (es. `sailing`) |
| `SQL_USER` | username admin SQL |
| `SQL_PASSWORD` | password admin SQL |
| `AZURE_STORAGE_CONNECTION_STRING` | Storage Account `sailingapp` -> Access keys -> Connection string |
| `AZURE_BLOB_CONTAINER_POLARS` | nome container (default `polars`) |
| `AZURE_BLOB_CONTAINER_WAYPOINTS` | nome container (default `waypoints`) |
| `AZURE_BLOB_CONTAINER_TRACKS` | nome container (default `tracks`) |
| `ADMIN_TOKEN` | stringa segreta a tua scelta (per la UI admin del portale) |

**Sicurezza:** il file `backend/.env` contiene segreti. Il `.gitignore` di
questo repo lo esclude gia'. NON committarlo MAI in git.

### 3. URL pubblici

Sostituisci `<APP>` con il valore di `APP_NAME` in `deploy-config.ps1`:

- **Portale**:        `https://<APP>.azurewebsites.net/`
- **Health**:         `https://<APP>.azurewebsites.net/health`
- **API base**:       `https://<APP>.azurewebsites.net/api/...`
- **Blob polare**:    `https://sailingapp.blob.core.windows.net/polars/<boat_id>/polar.json`
- **Blob waypoint**:  `https://sailingapp.blob.core.windows.net/waypoints/<boat_id>/waypoints.json`
- **Blob tracce**:    `https://sailingapp.blob.core.windows.net/tracks/<boat_id>/track_*.csv`

## Modifiche frequenti

**Solo backend** (no copia frontend, deploy piu' veloce):
```powershell
.\deploy.ps1 -SkipFrontend
```

**Vedere log live del backend**:
```powershell
az webapp log tail --name <APP> --resource-group <RG>
```

**Restart manuale** (utile se ci sono cache strane):
```powershell
az webapp restart --name <APP> --resource-group <RG>
```
