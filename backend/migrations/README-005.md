# Migration 005 - Cleanup colonne legacy PolarJson/WaypointsJson

## Cosa fa
Rimuove le colonne `PolarJson` e `WaypointsJson` dalla tabella `dbo.Boats`
nel database SQL. Queste colonne erano usate per memorizzare polare e
waypoint direttamente nel DB, sostituite ora dal blob storage.

## Perché farlo
- Riduce dimensione del DB (NVARCHAR(MAX) può contenere KB per riga)
- Toglie ambiguità: oggi la "fonte di verità" è il blob, le colonne DB
  sono dead weight che potrebbero indurre confusione futura
- Allinea schema all'uso reale del backend

## Procedura - eseguire in ordine

### 1. Verifica che NESSUN backend usi ancora le colonne
```bash
grep -r "PolarJson\|WaypointsJson" backend/
# Output atteso: solo le migration (002, 005). Se compaiono in app.py o
# altri file, ferma e investiga.
```

### 2. Verifica stato dati nel DB
Esegui la migration 004 in modalità diagnostica (è già diagnostica, non
modifica nulla):
```sql
-- da Azure Data Studio o sqlcmd
:r 004_polar_waypoints_blob.sql
```
Se l'output mostra barche con `PolarBytes` o `WptBytes`, vai allo step 3.
Se non mostra nulla, salta direttamente allo step 4.

### 3. Migra dati DB → blob (solo se step 2 ha mostrato dati)
```bash
cd backend/migrations
# Imposta env vars (SQL_SERVER, SQL_USER, SQL_PASSWORD, SQL_DATABASE,
# AZURE_STORAGE_CONNECTION_STRING, AZURE_BLOB_CONTAINER_POLARS,
# AZURE_BLOB_CONTAINER_WAYPOINTS) - le stesse del backend.

# Dry-run: mostra cosa caricherebbe
python migrate_blob_data.py --dry-run

# Esegui per davvero
python migrate_blob_data.py
```
Verifica nel portale che le barche carichino correttamente polare/waypoint
dal blob (schermata Polari + Waypoints).

### 4. Backup del DB
Sull'Azure Portal → SQL Database → Export → salva un .bacpac.
Le colonne dropppate non si recuperano se non da questo backup.

### 5. Esegui il drop
```bash
sqlcmd -S sailing-sql.database.windows.net -d sailing-db \
       -U <user> -P <pass> -i 005_drop_legacy_columns.sql
```

Lo script ha un **pre-flight check**: se trova ancora dati nelle colonne
abortisce con `THROW`. È sicuro lanciarlo "alla cieca".

### 6. Verifica
Lo script alla fine stampa lo schema attuale di `dbo.Boats`. Le colonne
`PolarJson` e `WaypointsJson` non devono più comparire.

Sul portale, fai un test rapido:
- Schermata 🌊 Polari → seleziona una barca → la polare deve apparire
- Schermata 📍 Waypoints → idem

## Rollback (in caso di disastro)
1. Restore del .bacpac in un DB nuovo dall'Azure Portal
2. Aggiorna `SQL_DATABASE` nelle App Settings dell'App Service
3. Restart App Service

## Note
- La migration usa `ALTER TABLE ... REBUILD` alla fine: l'operazione su
  Azure SQL S0/S1 può durare qualche secondo per migliaia di righe, qualche
  minuto per centinaia di migliaia. Durante il rebuild la tabella è in lock
  esclusivo (no insert/update). Per il sailing-portal non è un problema.
- Lo script è idempotente: se rilanciato dopo che le colonne sono già
  state droppate, stampa solo "gia inesistente, salto".
