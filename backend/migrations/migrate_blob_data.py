"""
Migrazione una-tantum: copia PolarJson e WaypointsJson dalle colonne SQL
al blob storage. Da eseguire UNA SOLA VOLTA prima della migration 005.

Sicuro da eseguire piu' volte: l'upload e' overwrite=True, idempotente.

Pre-requisiti:
  pip install pymssql azure-storage-blob

Variabili ambiente richieste (le stesse che usa il backend):
  SQL_SERVER, SQL_DATABASE, SQL_USER, SQL_PASSWORD
  AZURE_STORAGE_CONNECTION_STRING
  AZURE_BLOB_CONTAINER_POLARS     (default: polars)
  AZURE_BLOB_CONTAINER_WAYPOINTS  (default: waypoints)

Usage:
  # Copia le env dal .env locale e lancia
  python migrate_blob_data.py
  python migrate_blob_data.py --dry-run    # mostra solo cosa farebbe

Output: per ogni barca attiva con dati, log dell'upload (boat_id, bytes).
"""
import argparse
import json
import os
import sys

try:
    import pymssql
except ImportError:
    print("ERRORE: pymssql non installato. Esegui: pip install pymssql")
    sys.exit(1)

try:
    from azure.storage.blob import BlobServiceClient, ContentSettings
except ImportError:
    print("ERRORE: azure-storage-blob non installato. "
          "Esegui: pip install azure-storage-blob")
    sys.exit(1)


def env_required(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        print(f"ERRORE: variabile {name} non settata")
        sys.exit(1)
    return v


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="mostra cosa caricherebbe senza fare upload")
    args = ap.parse_args()

    # SQL connection
    conn = pymssql.connect(
        server=env_required("SQL_SERVER"),
        user=env_required("SQL_USER"),
        password=env_required("SQL_PASSWORD"),
        database=env_required("SQL_DATABASE"),
        port=1433, tds_version="7.4", as_dict=True,
    )

    # Blob client
    storage_conn = env_required("AZURE_STORAGE_CONNECTION_STRING")
    container_polars = os.environ.get("AZURE_BLOB_CONTAINER_POLARS", "polars")
    container_wpts = os.environ.get("AZURE_BLOB_CONTAINER_WAYPOINTS", "waypoints")
    svc = BlobServiceClient.from_connection_string(storage_conn)

    # Verifica container
    for cname in (container_polars, container_wpts):
        try:
            svc.get_container_client(cname).get_container_properties()
        except Exception as e:
            print(f"ERRORE: container '{cname}' non accessibile: {e}")
            sys.exit(1)

    cur = conn.cursor()
    # Solo barche attive con almeno una colonna popolata: evito di scaricare
    # tutto se ci sono migliaia di barche dismesse.
    cur.execute("""
        SELECT BoatId, Name, PolarJson, WaypointsJson
        FROM dbo.Boats
        WHERE Active = 1
          AND (PolarJson IS NOT NULL OR WaypointsJson IS NOT NULL)
        ORDER BY BoatId
    """)
    rows = cur.fetchall()
    if not rows:
        print("Nessuna barca con dati legacy nel DB. Nulla da migrare.")
        conn.close()
        return

    print(f"Trovate {len(rows)} barche con dati legacy.")
    if args.dry_run:
        print("[DRY RUN] non eseguo l'upload.")

    for row in rows:
        bid = row["BoatId"]
        name = row["Name"]
        if row["PolarJson"]:
            data = row["PolarJson"]
            # Validazione: deve essere JSON parseabile
            try:
                json.loads(data)
            except json.JSONDecodeError as e:
                print(f"  SKIP {bid} ({name}): PolarJson non valido ({e})")
            else:
                blob_name = f"{bid}/polar.json"
                if args.dry_run:
                    print(f"  [DRY] {bid}: polar -> {container_polars}/{blob_name} ({len(data)} bytes)")
                else:
                    svc.get_container_client(container_polars).upload_blob(
                        name=blob_name,
                        data=data.encode("utf-8"),
                        overwrite=True,
                        content_settings=ContentSettings(content_type="application/json"),
                    )
                    print(f"  OK {bid}: polar -> {blob_name} ({len(data)} bytes)")

        if row["WaypointsJson"]:
            data = row["WaypointsJson"]
            try:
                json.loads(data)
            except json.JSONDecodeError as e:
                print(f"  SKIP {bid} ({name}): WaypointsJson non valido ({e})")
            else:
                blob_name = f"{bid}/waypoints.json"
                if args.dry_run:
                    print(f"  [DRY] {bid}: waypoints -> {container_wpts}/{blob_name} ({len(data)} bytes)")
                else:
                    svc.get_container_client(container_wpts).upload_blob(
                        name=blob_name,
                        data=data.encode("utf-8"),
                        overwrite=True,
                        content_settings=ContentSettings(content_type="application/json"),
                    )
                    print(f"  OK {bid}: waypoints -> {blob_name} ({len(data)} bytes)")

    conn.close()
    print("")
    if args.dry_run:
        print("Dry-run completato. Rilancia senza --dry-run per eseguire l'upload.")
    else:
        print("Migrazione completata. Ora puoi eseguire 005_drop_legacy_columns.sql")


if __name__ == "__main__":
    main()
