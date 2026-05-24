-- =============================================================================
-- Migration 004 (OPZIONALE) - migra polar/waypoints da DB a Blob Storage
-- =============================================================================
-- Da eseguire DOPO aver aggiornato il backend alla versione che usa i blob.
-- Questa migration NON tocca lo schema (le colonne PolarJson/WaypointsJson
-- restano in dbo.Boats per non rompere nulla); serve solo a:
--   1. Listare le barche con polar/waypoints ancora in DB ma non ancora
--      copiati su blob: cosi' puoi accorgerti se manca qualcosa da migrare.
--   2. Documentare la migrazione (commenti).
--
-- La migrazione vera e propria dei BYTES da DB a blob NON la fa SQL: la
-- devi fare con uno script Python una tantum. Esempio (da eseguire localmente
-- con AZURE_STORAGE_CONNECTION_STRING e i parametri DB nelle env):
--
--   python -c "
--   import os, pymssql
--   from azure.storage.blob import BlobServiceClient, ContentSettings
--   svc = BlobServiceClient.from_connection_string(os.environ['AZURE_STORAGE_CONNECTION_STRING'])
--   conn = pymssql.connect(server=os.environ['SQL_SERVER'], user=os.environ['SQL_USER'],
--                          password=os.environ['SQL_PASSWORD'], database=os.environ['SQL_DATABASE'],
--                          port=1433, tds_version='7.4', as_dict=True)
--   cur = conn.cursor()
--   cur.execute('SELECT BoatId, PolarJson, WaypointsJson FROM dbo.Boats WHERE Active = 1')
--   for row in cur.fetchall():
--       bid = row['BoatId']
--       if row['PolarJson']:
--           svc.get_container_client('polars').upload_blob(
--               name=f'{bid}/polar.json', data=row['PolarJson'].encode('utf-8'),
--               overwrite=True, content_settings=ContentSettings(content_type='application/json'))
--           print(f'{bid}: polar -> blob ({len(row[\"PolarJson\"])} bytes)')
--       if row['WaypointsJson']:
--           svc.get_container_client('waypoints').upload_blob(
--               name=f'{bid}/waypoints.json', data=row['WaypointsJson'].encode('utf-8'),
--               overwrite=True, content_settings=ContentSettings(content_type='application/json'))
--           print(f'{bid}: waypoints -> blob ({len(row[\"WaypointsJson\"])} bytes)')
--   conn.close()
--   "
--
-- DOPO la migrazione e dopo aver verificato che i blob siano leggibili dal
-- portale, puoi opzionalmente droppare le colonne dal DB con la query in fondo.
-- =============================================================================

-- Diagnostica: barche con dati ancora solo nel DB
PRINT '--- Barche con polar.json nel DB ---';
SELECT BoatId, Name, LEN(PolarJson) AS PolarBytes, ConfigUpdatedAt
FROM dbo.Boats
WHERE Active = 1 AND PolarJson IS NOT NULL
ORDER BY BoatId;

PRINT '--- Barche con waypoints.json nel DB ---';
SELECT BoatId, Name, LEN(WaypointsJson) AS WptBytes, ConfigUpdatedAt
FROM dbo.Boats
WHERE Active = 1 AND WaypointsJson IS NOT NULL
ORDER BY BoatId;

GO

-- =============================================================================
-- ATTENZIONE: le righe sotto sono COMMENTATE per sicurezza.
-- Decommentale SOLO dopo aver migrato i dati ai blob e verificato il portale.
-- Il drop di colonne con NVARCHAR(MAX) e' irreversibile in produzione.
-- =============================================================================

-- IF EXISTS (SELECT 1 FROM sys.columns
--            WHERE object_id = OBJECT_ID('dbo.Boats') AND name = 'PolarJson')
-- BEGIN
--     ALTER TABLE dbo.Boats DROP COLUMN PolarJson;
--     PRINT 'Droppata colonna PolarJson';
-- END
--
-- IF EXISTS (SELECT 1 FROM sys.columns
--            WHERE object_id = OBJECT_ID('dbo.Boats') AND name = 'WaypointsJson')
-- BEGIN
--     ALTER TABLE dbo.Boats DROP COLUMN WaypointsJson;
--     PRINT 'Droppata colonna WaypointsJson';
-- END
--
-- GO
