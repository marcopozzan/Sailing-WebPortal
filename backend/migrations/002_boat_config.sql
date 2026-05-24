-- =============================================================================
-- Migration 002 - aggiunge storage di polar.json e waypoints.json sulle barche
-- =============================================================================
-- Eseguire UNA SOLA VOLTA con sqlcmd o Azure Data Studio.
-- Idempotente: si puo' rilanciare senza errori.

IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID('dbo.Boats')
               AND name = 'PolarJson')
BEGIN
    ALTER TABLE dbo.Boats ADD PolarJson NVARCHAR(MAX) NULL;
    PRINT 'Aggiunta colonna PolarJson';
END

IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID('dbo.Boats')
               AND name = 'WaypointsJson')
BEGIN
    ALTER TABLE dbo.Boats ADD WaypointsJson NVARCHAR(MAX) NULL;
    PRINT 'Aggiunta colonna WaypointsJson';
END

IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID('dbo.Boats')
               AND name = 'ConfigUpdatedAt')
BEGIN
    ALTER TABLE dbo.Boats ADD ConfigUpdatedAt DATETIME2(0) NULL;
    PRINT 'Aggiunta colonna ConfigUpdatedAt';
END

GO
