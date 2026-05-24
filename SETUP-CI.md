# Deploy automatico via GitHub Actions

Quando fai `git push origin main`, parte automaticamente un workflow che:
1. Costruisce lo zip (backend + frontend) con i path corretti
2. Deploya su Azure App Service `sailingrace`
3. Fa smoke test su `/health`

Puoi anche lanciare il deploy manualmente dalla UI GitHub
(tab **Actions** → workflow "Deploy Sailing Portal" → bottone **Run workflow**).

## Setup iniziale (una sola volta)

### 1. Scarica il publish profile da Azure

1. Vai su [portal.azure.com](https://portal.azure.com)
2. Apri **App Service `sailingrace`**
3. Nella toolbar in alto clicca **"Get publish profile"** (o "Scarica profilo di pubblicazione")
4. Si scarica un file `sailingrace.PublishSettings` — è un XML

### 2. Salva il publish profile come secret in GitHub

1. Apri il repo su GitHub
2. **Settings** → **Secrets and variables** → **Actions**
3. Click **"New repository secret"**
4. **Name:** `AZUREAPPSERVICE_PUBLISHPROFILE`
5. **Value:** apri il file XML scaricato con notepad, copia **tutto** il contenuto,
   incollalo nel campo (deve iniziare con `<publishData>` e finire con `</publishData>`)
6. Click **"Add secret"**

### 3. Verifica che le App Settings critiche siano configurate

Il publish profile NON tocca le app settings. Quindi devono essere già OK:

```powershell
az webapp config appsettings list --name sailingrace --resource-group rg-sailing `
    --query "[?name=='BUILD_FLAGS' || name=='SCM_DO_BUILD_DURING_DEPLOYMENT' || name=='ENABLE_ORYX_BUILD']" -o table
```

Devi vedere:
```
BUILD_FLAGS                       UseExpressBuild=false
SCM_DO_BUILD_DURING_DEPLOYMENT    true
ENABLE_ORYX_BUILD                 true
```

Se mancano (succede solo se hai ricreato l'app), lanciale una volta:

```powershell
az webapp config appsettings set --name sailingrace --resource-group rg-sailing `
    --settings BUILD_FLAGS=UseExpressBuild=false `
               SCM_DO_BUILD_DURING_DEPLOYMENT=true `
               ENABLE_ORYX_BUILD=true
```

### 4. Commit del workflow e push

```bash
git add .github/workflows/deploy.yml SETUP-CI.md
git commit -m "Add CI deploy workflow"
git push origin main
```

Subito dopo il push:
1. Vai sul repo GitHub → tab **Actions**
2. Vedi il workflow "Deploy Sailing Portal" in esecuzione
3. Click sopra per vedere i log in real-time

## Cosa fa il workflow, in ordine

| Step | Cosa fa |
|------|---------|
| Checkout | Clona il repo |
| Setup Python | Installa Python 3.11 per validazione |
| Verifica sorgenti | Controlla che `backend/app.py`, `frontend/index.html`, ecc. esistano |
| Build deploy package | Crea staging dir: `backend/*` alla radice + `frontend/*` dentro `static/`, poi `zip -r` (slash corretti su Linux) |
| Deploy to Azure | Action ufficiale `azure/webapps-deploy@v3` con publish profile |
| Smoke test | Aspetta 30s, poi cURL su `/health` con 6 retry |
| Summary | Scrive riepilogo nel job log con link e comandi diagnostici |

## Note pratiche

### Tempo deploy

Stima totale: **3-5 minuti** dal push:
- ~30s checkout + setup
- ~10s build zip
- ~1-2 min upload e estrazione su Azure
- ~30s pip install (più veloce con `BUILD_FLAGS=UseExpressBuild=false`)
- ~30s smoke test
- ~30s restart Kestrel/gunicorn

### Concurrency control

Il workflow ha `concurrency: cancel-in-progress: true`. Se fai 3 push in fila,
parte solo l'ultimo. Niente race condition su Azure.

### Failed deploy

Se il deploy fallisce, GitHub Actions ti notifica via email (default) o nell'app.
Diagnostica:
1. Tab Actions → click sull'esecuzione fallita → log dello step rosso
2. Se l'errore è su Azure (non build), verifica:
   ```
   https://sailingrace.scm.azurewebsites.net/api/deployments/latest
   ```

### Rollback

Per tornare a una versione precedente:
1. Trova lo SHA del commit "buono" nella history Git
2. Su GitHub: **Actions** → workflow → bottone **Run workflow** in alto a destra
3. Nel dropdown, lascia "Use workflow from: main" ma con un altro commit non si può
4. **Più semplice**: `git revert <sha-cattivo>` + `git push` → riparte automatico

In alternativa, dal portale Azure: **App Service** → **Deployment Center** → **Logs** → click sul deploy precedente → **Redeploy**.

### Rotazione publish profile

Se devi ruotare il password (es. credenziali compromesse):
1. Azure Portal → App Service → **Deployment Center** → **Manage deployment credentials** → reset
2. Riscarica il publish profile
3. GitHub Secrets → aggiorna `AZUREAPPSERVICE_PUBLISHPROFILE`

## Differenze rispetto a `deploy.ps1`

Il workflow fa quello che fa `deploy.ps1` ma **adattato all'ambiente CI**:

| Aspetto | `deploy.ps1` locale | Workflow GitHub |
|---------|---------------------|-----------------|
| Autenticazione | `az login` interattivo | Publish profile (secret) |
| Build zip | `[System.IO.Compression.ZipFile]` Windows | `zip -r` Linux (slash nativo) |
| Pre-flight App Settings | Sì, le imposta | No (assume già OK) |
| Smoke test | Sì | Sì (più conciso) |
| Verifica Kudu VFS | Sì | No (publish profile non lo supporta facilmente) |
| Tempo | 2-3 min | 3-5 min |

Quando vuoi un **deploy controllato dal tuo PC** (es. con verifica Kudu dettagliata), continui a usare `deploy.ps1`. Quando vuoi **automazione su push**, usi il workflow.

I due metodi sono compatibili: puoi usarli entrambi sullo stesso App Service.
