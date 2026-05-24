"""
Seed users for Sailing Cloud auth.

Inserisce nel database 3 utenti del team Soar:
  - marco.pozzan    info@marcopozzan.it
  - mauro.cinello   mauro.cinello@gmail.com
  - alberto.venco   alberto.venco@generali.it

Tutti con la stessa password (definita in DEFAULT_PASSWORD) e legati alla
barca "soar".

USAGE:
  cd backend
  python migrations/seed_users.py

Richiede env vars: SQL_SERVER, SQL_DATABASE, SQL_USER, SQL_PASSWORD
(le stesse usate da app.py).

Lo script e' IDEMPOTENTE: lo puoi rilanciare e non duplica gli utenti
ne' le associazioni user-boat. Se l'utente esiste gia' AGGIORNA solo la
password (utile per cambiarla in batch).
"""
import os
import sys
import bcrypt
import pymssql

# Password di team. Salvata SOLO come hash bcrypt nel DB.
DEFAULT_PASSWORD = os.environ.get('SEED_USERS_PASSWORD', 'Buongiorno1Cazzo')

# Lista utenti da seed. Ogni tupla: (username, email, display_name)
SEED_USERS = [
    ('marco.pozzan',   'info@marcopozzan.it',          'Marco Pozzan'),
    ('mauro.cinello',  'mauro.cinello@gmail.com',      'Mauro Cinello'),
    ('alberto.venco',  'alberto.venco@generali.it',    'Alberto Venco'),
]

# Barca a cui agganciare tutti gli utenti seed
SEED_BOAT_ID = 'soar'
SEED_ROLE = 'crew'


def get_conn():
    """Apre connessione al SQL Server usando le env vars di app.py."""
    server = os.environ['SQL_SERVER']
    database = os.environ['SQL_DATABASE']
    user = os.environ['SQL_USER']
    password = os.environ['SQL_PASSWORD']
    return pymssql.connect(server=server, user=user, password=password,
                           database=database, timeout=30)


def hash_password(plain: str) -> str:
    """bcrypt cost 12 (default sicuro). Ritorna stringa $2b$..."""
    salt = bcrypt.gensalt(rounds=12)
    return bcrypt.hashpw(plain.encode('utf-8'), salt).decode('utf-8')


def main():
    pwd_hash = hash_password(DEFAULT_PASSWORD)
    print(f'Password hash generato (bcrypt): {pwd_hash[:20]}... (len={len(pwd_hash)})')

    conn = get_conn()
    cur = conn.cursor()

    # Verifica che la barca soar esista; se no, errore esplicito.
    cur.execute("SELECT BoatId FROM dbo.Boats WHERE BoatId = %s", (SEED_BOAT_ID,))
    if cur.fetchone() is None:
        print(f'ERRORE: barca "{SEED_BOAT_ID}" non esiste in dbo.Boats. '
              f'Esegui prima migration 006_users_auth.sql che la crea.',
              file=sys.stderr)
        sys.exit(1)

    inserted = 0
    updated = 0
    linked = 0
    for username, email, display_name in SEED_USERS:
        # MERGE-like: se username esiste, aggiorna password e email; altrimenti inserisci
        cur.execute(
            "SELECT UserId FROM dbo.Users WHERE Username = %s", (username,))
        row = cur.fetchone()
        if row:
            user_id = row[0]
            cur.execute("""
                UPDATE dbo.Users
                   SET PasswordHash = %s,
                       Email = %s,
                       DisplayName = %s,
                       Active = 1
                 WHERE UserId = %s
            """, (pwd_hash, email, display_name, user_id))
            updated += 1
            print(f'  AGGIORNATO {username} (UserId={user_id})')
        else:
            cur.execute("""
                INSERT INTO dbo.Users (Username, Email, PasswordHash, DisplayName)
                OUTPUT INSERTED.UserId
                VALUES (%s, %s, %s, %s)
            """, (username, email, pwd_hash, display_name))
            user_id = cur.fetchone()[0]
            inserted += 1
            print(f'  INSERITO   {username} (UserId={user_id})')

        # Aggancia alla barca soar (se non gia' presente)
        cur.execute("""
            IF NOT EXISTS (SELECT 1 FROM dbo.UserBoats
                           WHERE UserId = %s AND BoatId = %s)
                INSERT INTO dbo.UserBoats (UserId, BoatId, Role)
                VALUES (%s, %s, %s)
        """, (user_id, SEED_BOAT_ID, user_id, SEED_BOAT_ID, SEED_ROLE))
        linked += 1

    conn.commit()
    cur.close()
    conn.close()

    print(f'\nRiassunto:')
    print(f'  Utenti inseriti:   {inserted}')
    print(f'  Utenti aggiornati: {updated}')
    print(f'  Link user-boat:    {linked} (idempotente)')
    print(f'\nLogin con uno degli username + password "{DEFAULT_PASSWORD}"')


if __name__ == '__main__':
    main()
