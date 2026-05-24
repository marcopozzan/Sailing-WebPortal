-- =============================================================================
-- Sailing Cloud - schema Azure SQL Database
-- =============================================================================

IF OBJECT_ID('dbo.Boats', 'U') IS NULL
CREATE TABLE dbo.Boats (
    BoatId        NVARCHAR(64)  NOT NULL PRIMARY KEY,
    Name          NVARCHAR(200) NOT NULL,
    Owner         NVARCHAR(200) NULL,
    TokenHash     NVARCHAR(128) NOT NULL,        -- SHA-256 del bearer token
    CreatedAt     DATETIME2(0)  NOT NULL DEFAULT SYSUTCDATETIME(),
    LastSeenAt    DATETIME2(0)  NULL,
    Active        BIT           NOT NULL DEFAULT 1
);

IF OBJECT_ID('dbo.Tracks', 'U') IS NULL
CREATE TABLE dbo.Tracks (
    TrackId       BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    BoatId        NVARCHAR(64)  NOT NULL,
    Ts            DATETIME2(0)  NOT NULL,
    ReceivedAt    DATETIME2(0)  NOT NULL DEFAULT SYSUTCDATETIME(),
    Position      GEOGRAPHY     NULL,
    Lat           FLOAT         NULL,
    Lon           FLOAT         NULL,
    SogKn         FLOAT         NULL,
    CogDeg        FLOAT         NULL,
    HeadingDeg    FLOAT         NULL,
    TwsKn         FLOAT         NULL,
    TwaDeg        FLOAT         NULL,
    TwdDeg        FLOAT         NULL,
    AwsKn         FLOAT         NULL,
    AwaDeg        FLOAT         NULL,
    VmgKn         FLOAT         NULL,
    TargetBspKn   FLOAT         NULL,
    DepthM        FLOAT         NULL,
    Advice        NVARCHAR(20)  NULL,
    ShiftDeg      FLOAT         NULL,
    TwdAvgDeg     FLOAT         NULL,
    WindowMin     INT           NULL,
    MarkName      NVARCHAR(100) NULL,
    MarkBearing   FLOAT         NULL,
    MarkDistance  FLOAT         NULL,
    RawJson       NVARCHAR(MAX) NULL,

    CONSTRAINT FK_Tracks_Boats FOREIGN KEY (BoatId) REFERENCES dbo.Boats(BoatId)
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_Tracks_Boat_Ts' AND object_id=OBJECT_ID('dbo.Tracks'))
CREATE INDEX IX_Tracks_Boat_Ts ON dbo.Tracks(BoatId, Ts DESC);

IF NOT EXISTS (SELECT 1 FROM sys.spatial_indexes WHERE name='SIX_Tracks_Position')
CREATE SPATIAL INDEX SIX_Tracks_Position ON dbo.Tracks(Position)
USING GEOGRAPHY_AUTO_GRID;

GO

-- Bootstrap: barca demo con token "changeme" (DA CAMBIARE in produzione)
IF NOT EXISTS (SELECT 1 FROM dbo.Boats WHERE BoatId='regolofarm-1')
INSERT INTO dbo.Boats (BoatId, Name, Owner, TokenHash) VALUES (
    'regolofarm-1',
    'Regolo Farm Demo',
    'Marco Pozzan',
    -- SHA-256 di 'changeme'
    '057ba03d6c44104863dc7361fe4578965d1887360f90a0895882e58a6248fc86'
);
GO
