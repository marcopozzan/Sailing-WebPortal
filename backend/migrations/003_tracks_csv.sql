-- =============================================================================
-- Migration 003 - aggiunge tabella metadati per tracce CSV
-- =============================================================================
-- I CSV veri sono in Azure Blob Storage, qui solo metadati per audit/cleanup.
-- Eseguire UNA SOLA VOLTA. Idempotente.

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Tracks_csv')
BEGIN
    CREATE TABLE dbo.Tracks_csv (
        Id          BIGINT IDENTITY(1,1) PRIMARY KEY,
        BoatId      NVARCHAR(64) NOT NULL,
        Filename    NVARCHAR(256) NOT NULL,
        UploadedAt  DATETIME2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
        SizeBytes   BIGINT NULL,
        CONSTRAINT UK_TracksCsv_BoatFile UNIQUE (BoatId, Filename),
        CONSTRAINT FK_TracksCsv_Boat FOREIGN KEY (BoatId)
            REFERENCES dbo.Boats(BoatId) ON DELETE CASCADE
    );

    CREATE INDEX IX_TracksCsv_BoatUploaded
        ON dbo.Tracks_csv (BoatId, UploadedAt DESC);

    PRINT 'Tabella Tracks_csv creata';
END
ELSE
    PRINT 'Tabella Tracks_csv gia esistente';
GO
