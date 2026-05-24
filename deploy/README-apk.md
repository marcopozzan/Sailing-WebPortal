# Distribuzione APK via portale

Aggiunta la pagina **`/apk.html`** per scaricare le versioni APK del tablet,
con bottone admin nascosto per pubblicare nuove versioni via drag&drop.

## File modificati

- `backend/app.py` — aggiunti 3 endpoint:
  - `GET /api/apks` — lista pubblica
  - `POST /api/admin/apks/upload-url` — SAS upload (admin token)
  - `DELETE /api/admin/apks/{filename}` — elimina (admin token)
- `frontend/apk.html` — pagina nuova, autocontenuta (HTML + CSS + JS inline)
- `frontend/index.html` — aggiunto link 📱 App nel menu sidebar

## File nuovo

- `deploy/setup-apks-container.ps1` — script idempotente di setup container Azure

## Setup (una sola volta)

### 1. Crea il container `apks` su Azure Blob Storage

```powershell
cd deploy
PowerShell -ExecutionPolicy Bypass -File .\setup-apks-container.ps1 -StorageAccount sailingapp
```

Lo script:
- Verifica/crea il container `apks`
- Imposta public-access `blob` (download anonimo via URL, no listing)

### 2. Aggiungi la app setting al backend

```powershell
az webapp config appsettings set --name sailingrace --resource-group rg-sailing `
    --settings AZURE_BLOB_CONTAINER_APKS=apks
```

### 3. Rilancia il deploy del portale

```powershell
.\deploy.ps1
```

## Uso quotidiano

### Pubblicare un nuovo APK

1. Apri `https://sailingrace.azurewebsites.net/apk.html`
2. In fondo alla pagina clicca su **⚙ Pannello amministratore**
3. Inserisci l'admin token (lo stesso usato per polari/waypoints/meteo)
4. Trascina il file `.apk` (es. `soar-1.7.0.apk`) nella zona drag&drop
5. L'upload mostra una barra di progresso (file ~50MB)
6. Appena finito, l'APK appare in lista con badge "ULTIMA"

### Far installare l'APK ai membri del team

Mandi loro semplicemente l'URL:

```
https://sailingrace.azurewebsites.net/apk.html
```

Loro:
1. Aprono dal browser del tablet
2. Toccano "Scarica" sulla versione più recente
3. Aprono il file dal Download del browser
4. Android chiede permesso "Installare da fonti sconosciute" → accettano
5. App installata. Aggiornamenti successivi: rifanno dalla stessa pagina,
   non serve disinstallare prima (gli aggiornamenti mantengono i dati).

### Eliminare versioni vecchie

Dal pannello admin (token inserito), accanto ad ogni APK appare un bottone 🗑.

## Sicurezza

- **Container public-access blob**: chiunque conosca il nome del file può
  scaricarlo (URL pubblico Azure). Non è un problema: i nomi sono prevedibili
  (`soar-1.7.0.apk`) e l'APK in sé non contiene segreti.
- **Listing degli APK**: passa dal backend `/api/apks`, non è anonimo a livello
  Azure. Comodo per non mostrare le versioni dev.
- **Upload e delete**: richiedono admin token (Bearer). Stesso token già usato
  per le altre operazioni admin del portale (polari, waypoints, meteo).

## Naming consigliato per gli APK

Usa una convenzione coerente per ordinamento e identificazione facile:

- `soar-1.7.0.apk` (release stabile)
- `soar-1.7.1-beta.apk` (test interno)
- `soar-1.8.0.apk`

La lista è ordinata per **data di upload** (più recente in alto, badge "ULTIMA"),
non per nome. Quindi il nome serve solo per riconoscibilità.
