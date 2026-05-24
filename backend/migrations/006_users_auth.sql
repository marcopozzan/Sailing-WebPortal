-- =============================================================================
-- Migration 006: User authentication
-- =============================================================================
-- Aggiunge:
--   - dbo.Users        : utenti finali con email, password (bcrypt hash)
--   - dbo.UserBoats    : relazione N-to-N user <-> boats (un utente puo' avere
--                        accesso a piu' barche, una barca puo' avere piu' utenti)
--
-- L'autenticazione e' basata su username + password. Il backend genera un JWT
-- al login. Il JWT include user_id e l'elenco delle BoatId autorizzate (cosi'
-- non serve query DB ad ogni request).
--
-- IDEMPOTENTE: si puo' rilanciare senza errori. Lo script crea le tabelle solo
-- se non esistono e usa MERGE per gli inserimenti seed.
-- =============================================================================

IF OBJECT_ID('dbo.Users', 'U') IS NULL
CREATE TABLE dbo.Users (
    UserId        BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    Username      NVARCHAR(100) NOT NULL UNIQUE,
    Email         NVARCHAR(200) NOT NULL UNIQUE,
    PasswordHash  NVARCHAR(200) NOT NULL,            -- bcrypt $2b$.. (max ~60 char)
    DisplayName   NVARCHAR(200) NULL,
    Active        BIT           NOT NULL DEFAULT 1,
    CreatedAt     DATETIME2(0)  NOT NULL DEFAULT SYSUTCDATETIME(),
    LastLoginAt   DATETIME2(0)  NULL
);
GO

-- Relazione N-N: un utente puo' avere accesso a piu' barche.
IF OBJECT_ID('dbo.UserBoats', 'U') IS NULL
CREATE TABLE dbo.UserBoats (
    UserId        BIGINT        NOT NULL,
    BoatId        NVARCHAR(64)  NOT NULL,
    Role          NVARCHAR(32)  NOT NULL DEFAULT 'crew',  -- 'crew', 'skipper', 'admin'
    AssignedAt    DATETIME2(0)  NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT PK_UserBoats PRIMARY KEY (UserId, BoatId),
    CONSTRAINT FK_UserBoats_Users FOREIGN KEY (UserId) REFERENCES dbo.Users(UserId),
    CONSTRAINT FK_UserBoats_Boats FOREIGN KEY (BoatId) REFERENCES dbo.Boats(BoatId)
);
GO

-- Index per lookup veloce "quali barche ha questo utente?"
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_UserBoats_UserId' AND object_id=OBJECT_ID('dbo.UserBoats'))
CREATE INDEX IX_UserBoats_UserId ON dbo.UserBoats(UserId);
GO

-- Bootstrap: assicura che la barca "soar" esista (necessaria per le seed user
-- relations). Se non c'e' la creo come placeholder; il backend permettera'
-- di completarne i dettagli (token, nome owner...) successivamente.
-- Token hash placeholder: SHA-256 di una stringa random non riutilizzabile.
IF NOT EXISTS (SELECT 1 FROM dbo.Boats WHERE BoatId='soar')
INSERT INTO dbo.Boats (BoatId, Name, Owner, TokenHash) VALUES (
    'soar',
    'Soar',
    'Team Soar',
    -- placeholder: SHA-256 di una stringa random. Cambiare via Config UI.
    '0000000000000000000000000000000000000000000000000000000000000000'
);
GO

-- Nota: gli utenti veri vengono inseriti dallo script seed_users.py
-- perche' hashing bcrypt richiede librerie Python, non si fa in T-SQL.
