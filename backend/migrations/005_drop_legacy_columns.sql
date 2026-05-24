-- =============================================================================
-- Migration 005 - drop colonne legacy PolarJson e WaypointsJson da dbo.Boats
-- =============================================================================
-- PREREQUISITI (da verificare PRIMA di eseguire questa migration):
--   1. Tutti i polar.json e waypoints.json delle barche attive sono stati
--      migrati al blob storage. Verifica con la migration 004 (sezione
--      diagnostica): NON deve restituire righe.
--   2. Il backend NON usa piu' le colonne PolarJson/WaypointsJson. Cerca
--      nei sorgenti che non ci siano riferimenti:
--        grep -r "PolarJson\|WaypointsJson" backend/
--      Deve restituire solo questa migration e la 002 (creazione).
--   3. Hai un BACKUP del DB. Le colonne erano NVARCHAR(MAX) e potrebbero
--      contenere KB di dati: una volta droppate non si recuperano.
--
-- Idempotente: si puo' rilanciare senza errori (verifica esistenza colonne).
--
-- Eseguire UNA SOLA VOLTA con sqlcmd o Azure Data Studio:
--   sqlcmd -S sailing-sql.database.windows.net -d sailing-db ^
--          -U <user> -P <pass> -i 005_drop_legacy_columns.sql
-- =============================================================================

-- Pre-flight: blocca se ci sono ancora dati. Sei al sicuro.
DECLARE @PolarRows INT, @WptRows INT;
SELECT @PolarRows = COUNT(*) FROM dbo.Boats
    WHERE Active = 1 AND PolarJson IS NOT NULL;
SELECT @WptRows = COUNT(*) FROM dbo.Boats
    WHERE Active = 1 AND WaypointsJson IS NOT NULL;

IF @PolarRows > 0 OR @WptRows > 0
BEGIN
    PRINT '====================================================================';
    PRINT 'ABORT: ci sono ancora dati nelle colonne PolarJson/WaypointsJson:';
    PRINT '  Barche con PolarJson:    ' + CAST(@PolarRows AS VARCHAR);
    PRINT '  Barche con WaypointsJson: ' + CAST(@WptRows AS VARCHAR);
    PRINT '';
    PRINT 'Migra prima questi dati al blob storage (vedi script Python';
    PRINT 'documentato nella migration 004), poi rilancia 005.';
    PRINT '====================================================================';
    -- Fail esplicito per evitare drop accidentale
    THROW 51000, 'Pre-flight check failed: dati ancora in DB. Migra prima ai blob.', 1;
END

PRINT 'Pre-flight OK: nessuna barca attiva ha dati in DB. Procedo con il drop.';
GO

-- Drop PolarJson
IF EXISTS (SELECT 1 FROM sys.columns
           WHERE object_id = OBJECT_ID('dbo.Boats') AND name = 'PolarJson')
BEGIN
    ALTER TABLE dbo.Boats DROP COLUMN PolarJson;
    PRINT 'Droppata colonna dbo.Boats.PolarJson';
END
ELSE
BEGIN
    PRINT 'Colonna PolarJson gia inesistente, salto.';
END
GO

-- Drop WaypointsJson
IF EXISTS (SELECT 1 FROM sys.columns
           WHERE object_id = OBJECT_ID('dbo.Boats') AND name = 'WaypointsJson')
BEGIN
    ALTER TABLE dbo.Boats DROP COLUMN WaypointsJson;
    PRINT 'Droppata colonna dbo.Boats.WaypointsJson';
END
ELSE
BEGIN
    PRINT 'Colonna WaypointsJson gia inesistente, salto.';
END
GO

-- Reclaim spazio (rebuild indice clustered: facoltativo ma consigliato dopo
-- il drop di colonne NVARCHAR(MAX), libera lo spazio sul filesystem SQL)
ALTER TABLE dbo.Boats REBUILD;
PRINT 'Tabella dbo.Boats rebuilt: spazio recuperato.';
GO

-- Verifica finale
PRINT '--- Schema attuale dbo.Boats ---';
SELECT name AS ColumnName, system_type_name = TYPE_NAME(user_type_id),
       max_length, is_nullable
FROM sys.columns
WHERE object_id = OBJECT_ID('dbo.Boats')
ORDER BY column_id;
