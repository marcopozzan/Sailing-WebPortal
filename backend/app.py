"""Sailing Cloud API - backend monolitico, no dipendenze esotiche.

File singolo per ridurre al minimo la complessita' di manutenzione.
Usa pymssql (puro Python) verso Azure SQL.

Endpoint:
- GET  /health                              : verifica DB
- POST /api/track                           : ingest dati dal tablet (Bearer)
- GET  /api/boats                           : lista barche
- GET  /api/boats/{id}/live                 : ultimo punto
- GET  /api/boats/{id}/track?since=...      : storico
- POST /api/admin/boats                     : crea barca (admin token)
"""
import os
import json
import asyncio
import hashlib
import secrets
from datetime import datetime, timedelta
from typing import Optional, List
from contextlib import contextmanager

import pymssql
from fastapi import FastAPI, HTTPException, Header, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# Caricamento .env per sviluppo locale. Su Azure App Service questo file non
# esiste e python-dotenv non fa nulla: le variabili arrivano dalle Application
# Settings impostate in portale (o via setup-app-service.ps1).
# In locale invece copia .env.example -> .env e popola le variabili.
try:
    from dotenv import load_dotenv
    # Cerca .env nella cartella dello script (backend/) e nelle directory
    # genitrici. Se non lo trova non fa nulla (silenzioso).
    load_dotenv()
except ImportError:
    # python-dotenv non installato (es. wheel minimo). Non e' fatale: le
    # variabili devono essere gia' presenti nell'ambiente.
    pass


# =============================================================================
# CONFIG (da variabili d'ambiente)
# =============================================================================

# App Service espone le variabili d'ambiente nelle "Configuration > Application Settings".
SQL_SERVER   = os.environ.get("SQL_SERVER",   "")
SQL_DATABASE = os.environ.get("SQL_DATABASE", "")
SQL_USER     = os.environ.get("SQL_USER",     "")
SQL_PASSWORD = os.environ.get("SQL_PASSWORD", "")
CORS_ORIGINS = [o.strip() for o in os.environ.get("CORS_ORIGINS", "*").split(",") if o.strip()]

# Token admin per creare barche via API. Se vuoto, l'endpoint admin e' disabilitato.
ADMIN_TOKEN  = os.environ.get("ADMIN_TOKEN", "")

# --- Event Hubs (live streaming) ---
# Il tablet di ogni barca pubblica snapshot su un Event Hub DEDICATO alla barca.
# L'EH per ciascuna barca e' configurato in dbo.Boats (colonne EventHubName e
# EventHubConnectionString, vedi migration 007_boats_eventhub.sql).
#
# EVENTHUB_NAMESPACE_CONNECTION_STRING e' la connection string del NAMESPACE
# (es. 'sailing-eventhubs.servicebus.windows.net') SENZA EntityPath. Il backend
# vi appende ';EntityPath=<EventHubName>' usando il valore preso dal DB per la
# barca richiesta. Compilarla SOLO se la maggior parte delle barche stanno su
# uno stesso namespace di default; per barche su namespace diversi popolare
# anche dbo.Boats.EventHubConnectionString (override per-barca).
EVENTHUB_NAMESPACE_CONNECTION_STRING = os.environ.get(
    "EVENTHUB_NAMESPACE_CONNECTION_STRING", "")
EVENTHUB_CONSUMER_GROUP = os.environ.get("EVENTHUB_CONSUMER_GROUP", "$Default")
SSE_HEARTBEAT_SECONDS   = int(os.environ.get("SSE_HEARTBEAT_SECONDS", "15"))


# =============================================================================
# DB - connessione semplice via pymssql
# =============================================================================

@contextmanager
def db_conn():
    """Apre una connessione e la chiude. Riusa connessione per richiesta."""
    conn = pymssql.connect(
        server=SQL_SERVER, user=SQL_USER, password=SQL_PASSWORD,
        database=SQL_DATABASE, port=1433, tds_version="7.4",
        login_timeout=30, timeout=30, as_dict=True,
    )
    try:
        yield conn
    finally:
        conn.close()


# =============================================================================
# SCHEMI Pydantic - validazione payload
# =============================================================================

class GpsIn(BaseModel):
    lat: Optional[float] = None
    lon: Optional[float] = None
    sog_kn: Optional[float] = None
    cog_deg: Optional[float] = None

class WindIn(BaseModel):
    tws_kn: Optional[float] = None
    twa_deg: Optional[float] = None
    twd_deg: Optional[float] = None
    aws_kn: Optional[float] = None
    awa_deg: Optional[float] = None

class BoatStateIn(BaseModel):
    heading_deg: Optional[float] = None
    depth_m: Optional[float] = None
    vmg_kn: Optional[float] = None
    target_bsp_kn: Optional[float] = None

class TacticalIn(BaseModel):
    advice: Optional[str] = None
    shift_deg: Optional[float] = None
    twd_avg_deg: Optional[float] = None
    window_min: Optional[int] = None

class MarkIn(BaseModel):
    name: Optional[str] = None
    bearing_deg: Optional[float] = None
    distance_nm: Optional[float] = None

class TrackIn(BaseModel):
    boat_id: str
    token: Optional[str] = None
    ts: datetime
    gps: GpsIn = Field(default_factory=GpsIn)
    wind: WindIn = Field(default_factory=WindIn)
    boat: BoatStateIn = Field(default_factory=BoatStateIn)
    tactical: TacticalIn = Field(default_factory=TacticalIn)
    mark: MarkIn = Field(default_factory=MarkIn)


class CreateBoatIn(BaseModel):
    boat_id: str
    name: str
    owner: Optional[str] = None


# =============================================================================
# UTILITY
# =============================================================================

def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()

def authenticate(boat_id: str, authorization: Optional[str], conn) -> dict:
    """Verifica Bearer token vs hash su DB. Restituisce la barca o solleva 401."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing Bearer token")
    token = authorization[7:].strip()
    if not token:
        raise HTTPException(401, "Empty token")

    with conn.cursor() as cur:
        cur.execute(
            "SELECT BoatId, Name, TokenHash FROM dbo.Boats "
            "WHERE BoatId = %s AND Active = 1", (boat_id,))
        row = cur.fetchone()
    if not row:
        raise HTTPException(401, "Unknown or inactive boat")
    if hash_token(token) != row["TokenHash"]:
        raise HTTPException(401, "Invalid token")
    return row


# =============================================================================
# APP
# =============================================================================

app = FastAPI(title="Sailing Cloud API", version="1.0")

if CORS_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ORIGINS,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )


@app.get("/health")
def health():
    """Liveness: verifica DB rispondente."""
    try:
        with db_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1 AS ok")
                cur.fetchone()
        return {"status": "ok", "ts": datetime.utcnow().isoformat()}
    except Exception as e:
        raise HTTPException(503, f"DB error: {e}")


@app.get("/api/diag/tracks-stats")
def diag_tracks_stats():
    """Endpoint diagnostico (sito pubblico): conta i punti track per barca,
    utile per verificare che la tabella dbo.Tracks abbia dati reali quando
    la schermata Live appare vuota.
    Ritorna: lista {boat_id, name, total_tracks, last_ts}.
    """
    try:
        with db_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT
                        b.BoatId            AS boat_id,
                        b.Name              AS name,
                        COUNT(t.BoatId)     AS total_tracks,
                        MAX(t.Ts)           AS last_ts
                    FROM dbo.Boats b
                    LEFT JOIN dbo.Tracks t ON t.BoatId = b.BoatId
                    WHERE b.Active = 1
                    GROUP BY b.BoatId, b.Name
                    ORDER BY b.Name
                """)
                rows = cur.fetchall()
        return [
            {
                "boat_id": r["boat_id"],
                "name": r["name"],
                "total_tracks": int(r["total_tracks"] or 0),
                "last_ts": r["last_ts"].isoformat() if r["last_ts"] else None,
            }
            for r in rows
        ]
    except Exception as e:
        raise HTTPException(500, f"DB query failed: {e}")


# =============================================================================
# INGEST
# =============================================================================

@app.post("/api/track")
def ingest_track(
    payload: TrackIn,
    authorization: Optional[str] = Header(default=None),
    x_boat_id:     Optional[str] = Header(default=None),
):
    """DEPRECATO: l'ingest dei dati live ora passa da Azure Event Hubs.

    Il tablet deve pubblicare direttamente sull'Event Hub 'sailing-eventhubs'
    usando la policy 'tablet-sender'. Questo endpoint resta solo per
    intercettare tablet non ancora aggiornati e segnalarlo chiaramente.
    """
    raise HTTPException(
        status_code=410,
        detail=(
            "Endpoint dismesso. Il tablet deve pubblicare i dati direttamente "
            "sull'Event Hub assegnato alla sua barca (vedi colonna EventHubName "
            "in dbo.Boats per la configurazione)."
        ),
    )


# =============================================================================
# QUERY FRONTEND
# =============================================================================

@app.get("/api/boats")
def list_boats():
    """Sito pubblico: ritorna tutte le barche attive (no auth utente)."""
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT BoatId, Name, Owner, LastSeenAt, Active "
                "FROM dbo.Boats WHERE Active = 1 ORDER BY Name")
            rows = cur.fetchall()
    return [
        {"boat_id": r["BoatId"], "name": r["Name"], "owner": r["Owner"],
         "last_seen_at": r["LastSeenAt"].isoformat() if r["LastSeenAt"] else None,
         "active": bool(r["Active"])}
        for r in rows
    ]


@app.get("/api/boats/{boat_id}/live")
def boat_live(boat_id: str):
    """DEPRECATO: il live ora arriva via SSE da /api/boats/{boat_id}/live/stream.
    Vedi anche boat_live_stream() pi\u00f9 sotto."""
    raise HTTPException(
        status_code=410,
        detail="Endpoint dismesso. Usare /api/boats/{boat_id}/live/stream (SSE).",
    )


# =============================================================================
# LIVE STREAM - Server-Sent Events da Azure Event Hubs
# =============================================================================
#
# Architettura:
# - Il tablet pubblica snapshot JSON sull'Event Hub 'EVENTHUB_NAME'.
# - Per ogni client SSE connesso, apriamo un EventHubConsumerClient asyncio
#   dedicato. Posizione: @latest (solo eventi nuovi, niente replay storico).
# - Gli eventi sono filtrati in-memoria per boat_id: l'Event Hub non supporta
#   filtri server-side, quindi ogni consumer riceve tutto il traffico del
#   namespace e scarta cio' che non corrisponde alla barca selezionata.
#   E' accettabile per flotte piccole (decine di barche, qualche evento/sec
#   per barca); con volumi molto piu' alti rivedere il design (es. un broker
#   interno con fan-out per boat_id, oppure un Event Hub per barca).
#
# Formato evento atteso dal tablet (JSON nel body):
#   {
#     "boat_id": "soar",
#     "ts": "2026-05-13T10:00:00Z",
#     "gps":      { "lat": ..., "lon": ..., "sog_kn": ..., "cog_deg": ... },
#     "wind":     { "tws_kn": ..., "twa_deg": ..., "twd_deg": ... },
#     "boat":     { "heading_deg": ..., "vmg_kn": ..., "target_bsp_kn": ... },
#     "tactical": { "advice": ..., "shift_deg": ... },
#     "mark":     { "name": ..., "bearing_deg": ..., "distance_nm": ... }
#   }
# Application Properties consigliate (per fan-out futuro): "boat_id".

def _resolve_boat_eventhub(boat_id: str) -> tuple[str, str]:
    """Risolve quale Event Hub usare per una barca leggendo da dbo.Boats.

    Ritorna (connection_string_completa, event_hub_name).

    Logica di risoluzione (vedi migration 007_boats_eventhub.sql):
      1. boat.EventHubName e' obbligatorio. Se NULL -> 503.
      2. Se boat.EventHubConnectionString e' valorizzata, viene usata cosi'
         com'e' (assumendo che gia' contenga EntityPath o lo riceva dall'SDK).
      3. Altrimenti si parte da EVENTHUB_NAMESPACE_CONNECTION_STRING (env) e
         vi si appende ';EntityPath=<EventHubName>'.

    Solleva HTTPException(404) se la barca non esiste, HTTPException(503) se
    la configurazione EH per quella barca e' incompleta.
    """
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT BoatId, EventHubName, EventHubConnectionString "
                "FROM dbo.Boats WHERE BoatId = %s AND Active = 1",
                (boat_id,))
            row = cur.fetchone()
    if not row:
        raise HTTPException(404, "Barca non trovata o non attiva")

    eh_name = row.get("EventHubName")
    if not eh_name:
        raise HTTPException(
            503,
            f"Event Hub non configurato per la barca '{boat_id}'. "
            "Impostare EventHubName via UI admin o UPDATE dbo.Boats.")

    eh_conn = row.get("EventHubConnectionString")
    if eh_conn:
        # Override per-barca: usa la connection string cosi' com'e'.
        # Se non contiene EntityPath, l'SDK lo accetta perche' lo passiamo
        # esplicitamente come parametro eventhub_name.
        return (eh_conn, eh_name)

    # Caso comune: tutte le barche su namespace di default, EH per-barca.
    if not EVENTHUB_NAMESPACE_CONNECTION_STRING:
        raise HTTPException(
            503,
            "EVENTHUB_NAMESPACE_CONNECTION_STRING non configurato sul backend "
            "e la barca non ha EventHubConnectionString proprio.")
    return (EVENTHUB_NAMESPACE_CONNECTION_STRING, eh_name)


def _event_to_live_point(payload: dict) -> dict:
    """Trasforma il payload pubblicato dal tablet nel formato che il frontend
    si aspetta (lo stesso che ritornava il vecchio _row_to_point su SQL).
    Robusto a chiavi mancanti: i campi non presenti diventano None."""
    gps  = payload.get("gps")      or {}
    wind = payload.get("wind")     or {}
    boat = payload.get("boat")     or {}
    tac  = payload.get("tactical") or {}
    mk   = payload.get("mark")     or {}
    return {
        "ts":            payload.get("ts"),
        "lat":           gps.get("lat"),
        "lon":           gps.get("lon"),
        "sog_kn":        gps.get("sog_kn"),
        "cog_deg":       gps.get("cog_deg"),
        "heading_deg":   boat.get("heading_deg"),
        "tws_kn":        wind.get("tws_kn"),
        "twa_deg":       wind.get("twa_deg"),
        "twd_deg":       wind.get("twd_deg"),
        "vmg_kn":        boat.get("vmg_kn"),
        "target_bsp_kn": boat.get("target_bsp_kn"),
        "advice":        tac.get("advice"),
        "shift_deg":     tac.get("shift_deg"),
        "mark_name":     mk.get("name"),
        "mark_bearing":  mk.get("bearing_deg"),
        "mark_distance": mk.get("distance_nm"),
    }


@app.get("/api/boats/{boat_id}/live/stream")
async def boat_live_stream(boat_id: str, request: Request):
    """SSE stream del live per una barca. Apre un consumer Event Hub dedicato
    al client, sull'EH configurato per QUELLA barca specifica (dbo.Boats).
    Chiude tutto su disconnessione.

    Formato risposta: text/event-stream con eventi tipo:
        data: {"ts":"...","lat":...,"lon":...,...}\n\n

    Heartbeat ogni SSE_HEARTBEAT_SECONDS secondi (riga commento ': ping') per
    tenere viva la connessione attraverso proxy/load balancer Azure."""

    # Risolvo l'EH della barca dal DB. Solleva 404 se la barca non c'e',
    # 503 se non e' configurata (EventHubName NULL).
    eh_conn_str, eh_name = _resolve_boat_eventhub(boat_id)

    # Import locale: tengo il modulo opzionale, cosi' il backend parte anche se
    # azure-eventhub non e' installato (es. ambiente di test minimal).
    from azure.eventhub.aio import EventHubConsumerClient
    from sse_starlette.sse import EventSourceResponse

    queue: asyncio.Queue = asyncio.Queue(maxsize=100)

    async def on_event(partition_context, event):
        """Callback invocata dal consumer per ogni evento Event Hub."""
        if event is None:
            return
        try:
            body = event.body_as_str(encoding="UTF-8")
            payload = json.loads(body)
        except Exception as e:
            print(f"[eventhub] payload non JSON, skip: {e}")
            return

        # Safety net: anche se l'EH e' dedicato a questa barca, filtro per
        # boat_id per non fare casino in caso di config errata (es. due
        # barche per sbaglio configurate sullo stesso EH).
        evt_boat = None
        props = event.properties or {}
        for k in (b"boat_id", "boat_id"):
            if k in props:
                v = props[k]
                evt_boat = v.decode() if isinstance(v, (bytes, bytearray)) else str(v)
                break
        if evt_boat is None:
            evt_boat = payload.get("boat_id")

        if evt_boat is not None and evt_boat != boat_id:
            # Configurazione anomala: log e scarto
            print(f"[eventhub] evento di boat_id={evt_boat} su EH di {boat_id}, skip")
            return

        point = _event_to_live_point(payload)
        try:
            queue.put_nowait(point)
        except asyncio.QueueFull:
            # Client lento: scarto il piu' vecchio per fare spazio al nuovo
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            queue.put_nowait(point)

    client = EventHubConsumerClient.from_connection_string(
        conn_str=eh_conn_str,
        consumer_group=EVENTHUB_CONSUMER_GROUP,
        eventhub_name=eh_name,
    )

    # Avvio receive() in un task di background: la chiamata e' bloccante per
    # natura (pompa eventi finche' non viene cancellata).
    async def pump():
        try:
            await client.receive(
                on_event=on_event,
                starting_position="@latest",
                # max_wait_time evita che il consumer resti "muto" su partizioni
                # vuote: ricicla la callback periodicamente cosi' il client lo sa.
                max_wait_time=5,
            )
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"[eventhub] consumer error for boat_id={boat_id}: {e}")

    pump_task = asyncio.create_task(pump())

    async def event_generator():
        """Generatore SSE: emette eventi dalla queue + heartbeat periodico."""
        try:
            # Messaggio iniziale: il client capisce che la connessione e' viva.
            yield {"event": "ready", "data": json.dumps({"boat_id": boat_id})}

            while True:
                if await request.is_disconnected():
                    break
                try:
                    point = await asyncio.wait_for(
                        queue.get(), timeout=SSE_HEARTBEAT_SECONDS)
                    yield {"event": "live", "data": json.dumps(point)}
                except asyncio.TimeoutError:
                    # Heartbeat: commento SSE (riga che inizia con ':'),
                    # sse-starlette lo gestisce con event "ping".
                    yield {"event": "ping", "data": ""}
        finally:
            pump_task.cancel()
            try:
                await pump_task
            except (asyncio.CancelledError, Exception):
                pass
            await client.close()

    return EventSourceResponse(event_generator())


@app.get("/api/boats/{boat_id}/config-urls")
def boat_config_urls(boat_id: str):
    """Restituisce le URL blob per polare/waypoints di una barca.
    Sito pubblico: nessuna auth utente richiesta."""
    account_name, _ = _get_account_info()
    if not account_name:
        # Storage non configurato: ritorno URL vuote invece di 500 cosi'
        # i client possono distinguere "barca senza file" da "server rotto"
        return {
            "boat_id":       boat_id,
            "polar_url":     "",
            "waypoints_url": "",
            "meteo_url":     "",
            "configured":    False,
        }
    return {
        "boat_id":       boat_id,
        "polar_url":     _public_download_url(_container_polars, boat_id, "polar.json"),
        "waypoints_url": _public_download_url(_container_waypoints, boat_id, "waypoints.json"),
        "meteo_url":     _public_download_url(_container_meteo, boat_id, "meteo.json"),
        "configured":    True,
    }


@app.get("/api/boats/{boat_id}/track")
def boat_track(
    boat_id: str,
    since: Optional[datetime] = Query(default=None),
    until: Optional[datetime] = Query(default=None),
    limit: int = Query(default=2000, ge=1, le=10000),
):
    """DEPRECATO: lo storico track non e' piu' persistito su SQL.

    Per ricostruire la storia, abilitare Event Hub Capture (verso Blob/ADLS)
    e leggere i file Avro/Parquet. Vedi README sezione 'Storico e Capture'.
    """
    raise HTTPException(
        status_code=410,
        detail=(
            "Endpoint dismesso. Lo storico non e' piu' su SQL: ricostruirlo "
            "dai file di Event Hub Capture (Avro/Parquet su Blob)."
        ),
    )


def _row_to_point(r) -> dict:
    return {
        "ts": r["Ts"].isoformat() if r["Ts"] else None,
        "lat": r["Lat"], "lon": r["Lon"],
        "sog_kn": r["SogKn"], "cog_deg": r["CogDeg"], "heading_deg": r["HeadingDeg"],
        "tws_kn": r["TwsKn"], "twa_deg": r["TwaDeg"], "twd_deg": r["TwdDeg"],
        "vmg_kn": r["VmgKn"], "target_bsp_kn": r["TargetBspKn"],
        "advice": r["Advice"], "shift_deg": r["ShiftDeg"],
        "mark_name": r["MarkName"],
        "mark_bearing": r["MarkBearing"], "mark_distance": r["MarkDistance"],
    }


# =============================================================================
# ADMIN: crea barca + token (richiede ADMIN_TOKEN configurato)
# =============================================================================

@app.post("/api/admin/boats")
def create_boat(
    payload: CreateBoatIn,
    x_admin_token: Optional[str] = Header(default=None),
):
    """Crea una nuova barca e restituisce il token (visibile UNA SOLA VOLTA).

    Per usare: configura la env var ADMIN_TOKEN sul backend con un valore
    segreto. Poi chiama questo endpoint con `X-Admin-Token: <quello>`.
    """
    if not ADMIN_TOKEN:
        raise HTTPException(403, "Admin endpoint disabled (ADMIN_TOKEN not set)")
    if x_admin_token != ADMIN_TOKEN:
        raise HTTPException(401, "Invalid admin token")

    token = secrets.token_urlsafe(32)
    th = hash_token(token)
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 AS x FROM dbo.Boats WHERE BoatId = %s", (payload.boat_id,))
            if cur.fetchone():
                raise HTTPException(409, f"BoatId '{payload.boat_id}' already exists")
            cur.execute(
                "INSERT INTO dbo.Boats (BoatId, Name, Owner, TokenHash, Active) "
                "VALUES (%s, %s, %s, %s, 1)",
                (payload.boat_id, payload.name, payload.owner, th))
        conn.commit()

    return {
        "boat_id": payload.boat_id,
        "name": payload.name,
        "token": token,  # mostrato una sola volta
        "warning": "Save this token NOW. It cannot be recovered.",
    }


# -----------------------------------------------------------------------------
# ADMIN: configurazione Event Hub per barca
# -----------------------------------------------------------------------------

class BoatEventHubIn(BaseModel):
    """Payload per PATCH /api/admin/boats/{boat_id}/eventhub.

    - event_hub_name: obbligatorio se si vuole abilitare il live per la barca.
      Passare stringa vuota o null per "scollegare" la barca (live disabilitato).
    - event_hub_connection_string: opzionale. Se null/omesso, viene usata
      EVENTHUB_NAMESPACE_CONNECTION_STRING dalle env. Compilare solo se la
      barca sta su un namespace diverso da quello di default.
    """
    event_hub_name: Optional[str] = None
    event_hub_connection_string: Optional[str] = None


def _require_admin(x_admin_token: Optional[str]) -> None:
    if not ADMIN_TOKEN:
        raise HTTPException(403, "Admin endpoint disabled (ADMIN_TOKEN not set)")
    if x_admin_token != ADMIN_TOKEN:
        raise HTTPException(401, "Invalid admin token")


@app.get("/api/admin/boats/{boat_id}/eventhub")
def get_boat_eventhub(
    boat_id: str,
    x_admin_token: Optional[str] = Header(default=None),
):
    """Restituisce la configurazione EH della barca.

    La connection string completa NON viene mai restituita per intero (security):
    se valorizzata, viene mascherata in '***...***' per uso UI."""
    _require_admin(x_admin_token)
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT BoatId, Name, EventHubName, EventHubConnectionString "
                "FROM dbo.Boats WHERE BoatId = %s",
                (boat_id,))
            row = cur.fetchone()
    if not row:
        raise HTTPException(404, "Barca non trovata")

    eh_conn = row.get("EventHubConnectionString")
    return {
        "boat_id": row["BoatId"],
        "name":    row["Name"],
        "event_hub_name": row.get("EventHubName"),
        "has_custom_connection_string": bool(eh_conn),
        # Mai esporre il valore reale: solo flag presenza + namespace estratto
        "custom_connection_string_namespace": _extract_namespace(eh_conn) if eh_conn else None,
        "default_namespace": _extract_namespace(EVENTHUB_NAMESPACE_CONNECTION_STRING)
                             if EVENTHUB_NAMESPACE_CONNECTION_STRING else None,
    }


@app.patch("/api/admin/boats/{boat_id}/eventhub")
def update_boat_eventhub(
    boat_id: str,
    payload: BoatEventHubIn,
    x_admin_token: Optional[str] = Header(default=None),
):
    """Aggiorna EventHubName / EventHubConnectionString per una barca.

    Semantica:
    - event_hub_name = stringa non vuota   -> setta quel valore
    - event_hub_name = stringa vuota o null -> mette NULL (disabilita live)
    - event_hub_connection_string = stringa non vuota -> override per-barca
    - event_hub_connection_string = stringa vuota o null -> rimuove override
      (la barca tornera' a usare il namespace di default)
    """
    _require_admin(x_admin_token)

    # Normalizza: stringhe vuote/whitespace -> None (= SQL NULL)
    eh_name = (payload.event_hub_name or "").strip() or None
    eh_conn = (payload.event_hub_connection_string or "").strip() or None

    # Sanity check di base: se passi una connection string deve almeno avere
    # 'Endpoint=sb://' (cosi' intercetti errori di copy-paste prima del save)
    if eh_conn and "Endpoint=sb://" not in eh_conn:
        raise HTTPException(
            400,
            "EventHubConnectionString non valida: deve contenere 'Endpoint=sb://'")

    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 AS x FROM dbo.Boats WHERE BoatId = %s",
                (boat_id,))
            if not cur.fetchone():
                raise HTTPException(404, "Barca non trovata")
            cur.execute(
                "UPDATE dbo.Boats "
                "   SET EventHubName = %s, EventHubConnectionString = %s "
                " WHERE BoatId = %s",
                (eh_name, eh_conn, boat_id))
        conn.commit()

    return {
        "boat_id": boat_id,
        "event_hub_name": eh_name,
        "has_custom_connection_string": bool(eh_conn),
        "ok": True,
    }


def _extract_namespace(conn_str: Optional[str]) -> Optional[str]:
    """Estrae il FQDN del namespace da una EventHub connection string.
    Es. 'Endpoint=sb://xxx.servicebus.windows.net/;...' -> 'xxx.servicebus.windows.net'.
    Usato per mostrare in UI il namespace senza esporre la SAS key."""
    if not conn_str:
        return None
    try:
        # Cerca Endpoint=sb://<host>/
        for part in conn_str.split(";"):
            part = part.strip()
            if part.lower().startswith("endpoint=sb://"):
                host = part[len("Endpoint=sb://"):]
                return host.rstrip("/")
    except Exception:
        pass
    return None


# =============================================================================
# CONFIGURAZIONE BARCA: polar.json e waypoints.json
# =============================================================================
# Pattern:
# - Upload: richiede X-Admin-Token. Usato dal portale per caricare i file.
# - Download: pubblico, accesso libero via URL.
#   I file sono polari nautiche e waypoint del campo di regata, non dati
#   sensibili. URL semplici (boat_id leggibile) facilitano l'uso dal tablet.
# =============================================================================

from fastapi import Response


# ---------- Upload (richiede admin token) ----------

class ConfigUploadIn(BaseModel):
    """Payload generico per upload polar/waypoints. Il body deve essere un
    JSON valido (qualsiasi struttura) - sara' restituito as-is in download."""
    pass  # accetta dict arbitrario via Body raw, gestito sotto


# ---------- SAS Upload URL per polar/waypoints (browser -> blob diretto) ----------
#
# NB: gli endpoint legacy POST /api/admin/boats/{id}/polar e
# /api/admin/boats/{id}/waypoints (upload via backend con il body JSON come
# payload) sono stati RIMOSSI. La UI ora usa esclusivamente il pattern SAS:
#   1. POST /api/admin/boats/{id}/polar/upload-url     -> riceve SAS URL
#   2. PUT  <sas_url>  con body JSON                    -> browser scrive su blob
#   3. POST /api/admin/boats/{id}/polar/notify-uploaded -> aggiorna timestamp DB
# (idem per waypoints).
#
# Vantaggi: zero traffico via backend per il file, niente limiti di body
# size FastAPI, controllo accessi mantenuto via SAS firmate (write+create
# only, scadenza 30min, blob path specifico).

@app.post("/api/admin/boats/{boat_id}/polar/upload-url")
def get_polar_upload_url(
    boat_id: str,
    x_admin_token: Optional[str] = Header(default=None),
):
    """Genera una SAS URL temporanea per l'upload diretto di polar.json
    dal browser al blob storage.

    Workflow lato browser:
      1. POST a questo endpoint con header X-Admin-Token
      2. Riceve {upload_url, blob_url, expires_in_minutes}
      3. PUT diretto a upload_url con header x-ms-blob-type: BlockBlob
         e body = contenuto JSON
      4. Il blob diventa subito disponibile a blob_url

    Vantaggi rispetto al POST via backend:
      - File transitano direttamente browser -> Azure Storage
      - Zero carico sul backend FastAPI per il trasferimento
      - Niente limiti di dimensione richiesta FastAPI

    Il backend mantiene il controllo di accesso: la SAS e' valida solo 30 min
    e SOLO per il blob {polars}/{boat_id}/polar.json (write+create only)."""
    if not ADMIN_TOKEN:
        raise HTTPException(403, "Admin endpoint disabled")
    if x_admin_token != ADMIN_TOKEN:
        raise HTTPException(401, "Invalid admin token")

    # Verifica che la barca esista
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 AS x FROM dbo.Boats WHERE BoatId = %s", (boat_id,))
            if not cur.fetchone():
                raise HTTPException(404, f"Boat '{boat_id}' not found")

    if not _get_blob_service():
        raise HTTPException(500, "Blob storage not configured")

    try:
        sas_url = _generate_upload_sas(
            boat_id, "polar.json",
            container_name=_container_polars,
            expires_minutes=30,
        )
        return {
            "upload_url": sas_url,
            "expires_in_minutes": 30,
            "method": "PUT",
            "headers": {"x-ms-blob-type": "BlockBlob",
                        "Content-Type": "application/json"},
            "blob_url": _public_download_url(_container_polars, boat_id, "polar.json"),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"SAS generation failed: {e}")


@app.post("/api/admin/boats/{boat_id}/waypoints/upload-url")
def get_waypoints_upload_url(
    boat_id: str,
    x_admin_token: Optional[str] = Header(default=None),
):
    """Genera una SAS URL temporanea per upload diretto di waypoints.json
    dal browser al blob storage. Stessa logica di polar/upload-url."""
    if not ADMIN_TOKEN:
        raise HTTPException(403, "Admin endpoint disabled")
    if x_admin_token != ADMIN_TOKEN:
        raise HTTPException(401, "Invalid admin token")

    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 AS x FROM dbo.Boats WHERE BoatId = %s", (boat_id,))
            if not cur.fetchone():
                raise HTTPException(404, f"Boat '{boat_id}' not found")

    if not _get_blob_service():
        raise HTTPException(500, "Blob storage not configured")

    try:
        sas_url = _generate_upload_sas(
            boat_id, "waypoints.json",
            container_name=_container_waypoints,
            expires_minutes=30,
        )
        return {
            "upload_url": sas_url,
            "expires_in_minutes": 30,
            "method": "PUT",
            "headers": {"x-ms-blob-type": "BlockBlob",
                        "Content-Type": "application/json"},
            "blob_url": _public_download_url(_container_waypoints, boat_id, "waypoints.json"),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"SAS generation failed: {e}")


@app.post("/api/admin/boats/{boat_id}/polar/notify-uploaded")
def notify_polar_uploaded(
    boat_id: str,
    x_admin_token: Optional[str] = Header(default=None),
):
    """Notifica al backend che il browser ha completato l'upload PUT diretto
    al blob via SAS URL. Aggiorna ConfigUpdatedAt nel DB cosi' il portale
    vede il timestamp di ultima modifica corretto.

    Endpoint opzionale ma raccomandato: senza, il timestamp ConfigUpdatedAt
    resta indietro e il portale mostra la data sbagliata."""
    if not ADMIN_TOKEN or x_admin_token != ADMIN_TOKEN:
        raise HTTPException(401, "Invalid admin token")
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE dbo.Boats SET ConfigUpdatedAt = SYSUTCDATETIME() "
                "WHERE BoatId = %s", (boat_id,))
        conn.commit()
    return {"ok": True}


@app.post("/api/admin/boats/{boat_id}/waypoints/notify-uploaded")
def notify_waypoints_uploaded(
    boat_id: str,
    x_admin_token: Optional[str] = Header(default=None),
):
    """Notifica upload waypoints completato (vedi polar/notify-uploaded)."""
    if not ADMIN_TOKEN or x_admin_token != ADMIN_TOKEN:
        raise HTTPException(401, "Invalid admin token")
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE dbo.Boats SET ConfigUpdatedAt = SYSUTCDATETIME() "
                "WHERE BoatId = %s", (boat_id,))
        conn.commit()
    return {"ok": True}


@app.post("/api/boats/{boat_id}/meteo/upload-url")
def get_meteo_upload_url(
    boat_id: str,
    filename: Optional[str] = Query(default=None),
    authorization: Optional[str] = Header(None),
):
    """Genera SAS URL temporanea per upload del JSON meteo della barca.
    Sito pubblico: ora richiede solo l'admin token (per coerenza con
    polar/waypoints). Se vuoi che sia accessibile a tutti, togli il check
    di require_admin sotto. Vista la natura del dato (meteo configurato dal
    team), tenerlo dietro admin token e' la scelta sicura.

    Parametro opzionale 'filename' (es. ?filename=meteo-2026-05-09-12-00.json):
    se passato, il blob avra' quel nome (sanitizzato). Se omesso, il default
    e' 'meteo.json' (sovrascrive il precedente).

    Workflow lato browser:
      1. Utente clicca "Genera meteo" nella schermata Meteo
      2. POST a questo endpoint con Bearer = admin token + ?filename=...
      3. Riceve {upload_url, blob_url, ...}
      4. PUT diretto al SAS URL con il JSON
      5. Il blob diventa subito disponibile a blob_url (container pubblico)

    SAS valida 10 min (write+create only sul singolo blob).
    """
    # Admin token check (sostituisce auth utente)
    if not ADMIN_TOKEN:
        raise HTTPException(503, "Admin endpoints disabled (ADMIN_TOKEN not set)")
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing Bearer token")
    if authorization[7:].strip() != ADMIN_TOKEN:
        raise HTTPException(401, "Invalid admin token")

    if not _get_blob_service():
        raise HTTPException(500, "Blob storage not configured")

    # Sanitizza filename: solo nome file, no path. Default 'meteo.json'.
    # Caratteri ammessi: alfanumerici, trattini, punti, underscore.
    # Massimo 100 caratteri (per evitare abusi).
    if filename:
        # Tolgo eventuali path traversal
        filename = os.path.basename(filename).strip()
        # Solo caratteri sicuri
        import re as _re
        if not _re.match(r'^[A-Za-z0-9._-]{1,100}$', filename):
            raise HTTPException(400, "Filename non valido (alfanumerici, '.', '_', '-' max 100 char)")
        if not filename.lower().endswith('.json'):
            filename = filename + '.json'
    else:
        filename = "meteo.json"

    try:
        sas_url = _generate_upload_sas(
            boat_id, filename,
            container_name=_container_meteo,
            expires_minutes=10,
        )
        return {
            "upload_url": sas_url,
            "filename": filename,
            "expires_in_minutes": 10,
            "method": "PUT",
            "headers": {
                "x-ms-blob-type": "BlockBlob",
                "Content-Type": "application/json",
            },
            "blob_url": _public_download_url(_container_meteo, boat_id, filename),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"SAS generation failed: {e}")


@app.get("/api/admin/blob-config")
def get_blob_config(
    x_admin_token: Optional[str] = Header(default=None),
):
    """Restituisce la configurazione corrente del blob storage al portale.
    Usato per pre-popolare il pannello di config con i default reali.

    NB: l'AccountKey NON viene mai restituita. La UI mostra solo l'account
    name (pubblico) e i nomi dei container; per cambiare le credenziali
    bisogna modificare la connection string come Application Setting su
    Azure App Service (l'utente non puo' cambiarla dal portale)."""
    if not ADMIN_TOKEN:
        raise HTTPException(403, "Admin endpoint disabled")
    if x_admin_token != ADMIN_TOKEN:
        raise HTTPException(401, "Invalid admin token")

    account_name, _account_key = _get_account_info()
    configured = bool(account_name)

    return {
        "configured": configured,
        "account_name": account_name or "",
        "containers": {
            "polars":    _container_polars,
            "waypoints": _container_waypoints,
            "tracks":    _container_tracks,
            "meteo":     _container_meteo,
        },
        "base_urls": {
            "polars":    f"https://{account_name}.blob.core.windows.net/{_container_polars}"    if account_name else "",
            "waypoints": f"https://{account_name}.blob.core.windows.net/{_container_waypoints}" if account_name else "",
            "tracks":    f"https://{account_name}.blob.core.windows.net/{_container_tracks}"    if account_name else "",
            "meteo":     f"https://{account_name}.blob.core.windows.net/{_container_meteo}"     if account_name else "",
        },
    }


@app.get("/api/admin/boats/{boat_id}/config-status")
def config_status(
    boat_id: str,
    x_admin_token: Optional[str] = Header(default=None),
):
    """Restituisce stato dei file config (presenza, timestamp, URL download).
    Usato dal portale per popolare la sezione 'Configurazione barca'.
    Polar/Waypoints leggono dai blob storage; ConfigUpdatedAt arriva dal DB
    (aggiornato all'ultimo upload)."""
    if not ADMIN_TOKEN:
        raise HTTPException(403, "Admin endpoint disabled")
    if x_admin_token != ADMIN_TOKEN:
        raise HTTPException(401, "Invalid admin token")

    # Verifica che la barca esista e prendi ConfigUpdatedAt
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT BoatId, Name, ConfigUpdatedAt "
                "FROM dbo.Boats WHERE BoatId = %s", (boat_id,))
            row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"Boat '{boat_id}' not found")

    # Stato polar dal blob
    polar_size, polar_modified = _blob_get_size(
        _container_polars, boat_id, "polar.json")
    # Stato waypoints dal blob
    wpt_size, wpt_modified = _blob_get_size(
        _container_waypoints, boat_id, "waypoints.json")

    # ConfigUpdatedAt dal DB se presente, altrimenti il last_modified piu'
    # recente tra i due blob (se almeno uno e' presente).
    cfg_updated = row["ConfigUpdatedAt"]
    if not cfg_updated:
        candidates = [m for m in (polar_modified, wpt_modified) if m]
        cfg_updated = max(candidates) if candidates else None

    return {
        "boat_id": row["BoatId"],
        "name": row["Name"],
        "polar": {
            "uploaded": polar_size > 0,
            "size_bytes": polar_size,
            "blob_url": _public_download_url(_container_polars, boat_id, "polar.json")
                        if polar_size > 0 else "",
            "last_modified": polar_modified.isoformat() if polar_modified else None,
        },
        "waypoints": {
            "uploaded": wpt_size > 0,
            "size_bytes": wpt_size,
            "blob_url": _public_download_url(_container_waypoints, boat_id, "waypoints.json")
                        if wpt_size > 0 else "",
            "last_modified": wpt_modified.isoformat() if wpt_modified else None,
        },
        "config_updated_at": (cfg_updated.isoformat() if cfg_updated else None),
    }


# ---------- (Endpoint proxy rimossi) ----------
# I vecchi endpoint /api/boats/{id}/polar.json e /api/boats/{id}/waypoints.json
# sono stati rimossi: il tablet e il portale ora accedono DIRETTAMENTE ai
# blob storage URL (es. https://sailingapp.blob.core.windows.net/polars/<boat>/polar.json).
# Vantaggi: nessun carico sul backend per i download, nessuna latenza di proxy,
# il backend resta libero per le scritture. I container blob 'polars' e
# 'waypoints' devono essere configurati come anonymous-read (lo fa
# setup-app-service.ps1).


# =============================================================================
# AZURE BLOB STORAGE - tre container separati
# =============================================================================
# Pattern:
# - Storage: account "sailingapp", TRE container con accesso pubblico in lettura:
#     polars/<boat_id>/polar.json         -> file polari
#     waypoints/<boat_id>/waypoints.json  -> file waypoint
#     tracks/<boat_id>/<filename.csv>     -> tracce regate
# - Polar/Waypoints: PUT diretto via backend (admin auth), il backend scrive
#   sul blob. Download pubblico via URL diretto al blob (no backend in mezzo)
#   oppure via endpoint /api/boats/{id}/polar.json|waypoints.json (proxy).
# - Tracks: il tablet/portale richiede una SAS URL al backend, poi fa PUT
#   diretto al blob. Listing via Azure SDK; download diretto pubblico.
#
# Configurazione richiesta su App Service:
#   AZURE_STORAGE_CONNECTION_STRING       (connection string completa)
#   AZURE_BLOB_CONTAINER_POLARS           (default "polars")
#   AZURE_BLOB_CONTAINER_WAYPOINTS        (default "waypoints")
#   AZURE_BLOB_CONTAINER_TRACKS           (default "tracks")
#   AZURE_BLOB_CONTAINER_METEO            (default "meteo")
# =============================================================================

from datetime import datetime as _dt, timedelta as _td

# Default dei nomi container come da richiesta utente. Sovrascrivibili da env.
_blob_service_client     = None
_container_polars        = os.getenv("AZURE_BLOB_CONTAINER_POLARS",    "polars")
_container_waypoints     = os.getenv("AZURE_BLOB_CONTAINER_WAYPOINTS", "waypoints")
_container_tracks        = os.getenv("AZURE_BLOB_CONTAINER_TRACKS",    "tracks")
_container_meteo         = os.getenv("AZURE_BLOB_CONTAINER_METEO",     "meteo")
_container_apks          = os.getenv("AZURE_BLOB_CONTAINER_APKS",      "apks")
# Mantengo l'alias _blob_container_name per i tracks (compatibilita' con
# il codice tracce esistente, che usa il nome senza suffisso).
_blob_container_name     = _container_tracks


def _get_blob_service():
    """Inizializza pigramente il BlobServiceClient. None se non configurato."""
    global _blob_service_client
    if _blob_service_client is not None:
        return _blob_service_client
    conn_str = os.getenv("AZURE_STORAGE_CONNECTION_STRING")
    if not conn_str:
        return None
    try:
        from azure.storage.blob import BlobServiceClient
        _blob_service_client = BlobServiceClient.from_connection_string(conn_str)
        return _blob_service_client
    except Exception as e:
        print(f"[blob] init failed: {e}")
        return None


def _get_account_info():
    """Estrae account_name e account_key dalla connection string."""
    conn_str = os.getenv("AZURE_STORAGE_CONNECTION_STRING", "")
    parts = dict(p.split("=", 1) for p in conn_str.split(";") if "=" in p)
    return parts.get("AccountName"), parts.get("AccountKey")


def _get_container_client(container_name: str):
    """Helper: ContainerClient per il container indicato. Crea il container
    se non esiste (idempotente). Ritorna None se storage non configurato."""
    svc = _get_blob_service()
    if not svc:
        return None
    try:
        cc = svc.get_container_client(container_name)
        # Crea il container se non esiste. Senza accesso pubblico di default:
        # se vuoi accesso anonymous-read, configuralo manualmente nel portale
        # Azure (oppure scommenta la riga sotto e riesegui una volta).
        try:
            cc.create_container()
        except Exception:
            pass  # gia' esistente, ok
        return cc
    except Exception as e:
        print(f"[blob] container '{container_name}' error: {e}")
        return None


def _blob_read_text(container_name: str, boat_id: str, filename: str):
    """Legge un blob di testo da {container}/{boat_id}/{filename}.
    Ritorna (text, last_modified) oppure (None, None) se assente o errore.
    last_modified e' un datetime UTC (puo' essere None se il backend Azure
    non lo restituisce)."""
    cc = _get_container_client(container_name)
    if not cc:
        return None, None
    blob_path = f"{boat_id}/{filename}"
    try:
        bc = cc.get_blob_client(blob_path)
        props = bc.get_blob_properties()
        data = bc.download_blob().readall()
        text = data.decode("utf-8") if isinstance(data, (bytes, bytearray)) else str(data)
        return text, props.last_modified
    except Exception as e:
        # Distinguo "blob non trovato" (caso normale: ancora niente uploadato)
        # da errori reali, che invece loggo.
        if "BlobNotFound" in str(e) or "404" in str(e):
            return None, None
        print(f"[blob] read {container_name}/{blob_path} error: {e}")
        return None, None


def _blob_write_text(container_name: str, boat_id: str, filename: str,
                     text: str, content_type: str = "application/json"):
    """Scrive un blob di testo in {container}/{boat_id}/{filename} (overwrite).
    Solleva eccezione se il blob storage non e' configurato o la PUT fallisce."""
    cc = _get_container_client(container_name)
    if not cc:
        raise HTTPException(500, "Blob storage not configured")
    blob_path = f"{boat_id}/{filename}"
    from azure.storage.blob import ContentSettings
    bc = cc.get_blob_client(blob_path)
    bc.upload_blob(
        text.encode("utf-8"),
        overwrite=True,
        content_settings=ContentSettings(content_type=content_type),
    )


def _blob_get_size(container_name: str, boat_id: str, filename: str):
    """Ritorna la dimensione in byte del blob, o 0 se non esiste."""
    cc = _get_container_client(container_name)
    if not cc:
        return 0, None
    blob_path = f"{boat_id}/{filename}"
    try:
        bc = cc.get_blob_client(blob_path)
        props = bc.get_blob_properties()
        return props.size, props.last_modified
    except Exception as e:
        if "BlobNotFound" in str(e) or "404" in str(e):
            return 0, None
        return 0, None


def _generate_upload_sas(boat_id: str, filename: str,
                         container_name: str = None,
                         expires_minutes: int = 30) -> str:
    """Genera un URL SAS per upload (PUT) di un singolo blob.

    Args:
      boat_id, filename: path del blob = {boat_id}/{filename}.
                         Se boat_id e' "" o None, il blob va alla RADICE del
                         container (path = filename). Utile per APK condivisi
                         o asset globali.
      container_name: in quale container scrivere. Se None usa _container_tracks
                      (default storico per compatibilita').
      expires_minutes: validita' della SAS, default 30 minuti.

    Permessi concessi: write + create. NON list, NON read, NON delete.
    Cosi' chi ottiene la SAS puo' SOLO sovrascrivere quel blob specifico.
    Solleva HTTPException 500 se lo storage non e' configurato."""
    from azure.storage.blob import generate_blob_sas, BlobSasPermissions
    account_name, account_key = _get_account_info()
    if not account_name or not account_key:
        raise HTTPException(500, "Storage not configured")

    container = container_name or _container_tracks
    # Blob path: con prefisso se boat_id non vuoto, altrimenti alla radice
    blob_path = f"{boat_id}/{filename}" if boat_id else filename
    sas = generate_blob_sas(
        account_name=account_name,
        container_name=container,
        blob_name=blob_path,
        account_key=account_key,
        permission=BlobSasPermissions(write=True, create=True),
        expiry=_dt.utcnow() + _td(minutes=expires_minutes),
    )
    return f"https://{account_name}.blob.core.windows.net/{container}/{blob_path}?{sas}"


def _public_download_url(container_name: str, boat_id: str, filename: str) -> str:
    """URL pubblico di download (no SAS). Funziona se il container e'
    configurato come anonymous-read sul portale Azure."""
    account_name, _ = _get_account_info()
    if not account_name:
        return ""
    return f"https://{account_name}.blob.core.windows.net/{container_name}/{boat_id}/{filename}"


def _verify_boat_token(boat_id: str, authorization: Optional[str]) -> bool:
    """Verifica che il Bearer token corrisponda al TokenHash della barca.
    Usa la stessa logica di autenticazione di /api/track (sha256 confronto)."""
    if not authorization or not authorization.startswith("Bearer "):
        return False
    token = authorization[7:].strip()
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT TokenHash FROM dbo.Boats WHERE BoatId = %s AND Active = 1",
                (boat_id,))
            row = cur.fetchone()
    if not row or not row.get("TokenHash"):
        return False
    return hash_token(token) == row["TokenHash"]


# ---------- Upload: genera SAS URL ----------

class TrackUploadRequest(BaseModel):
    filename: str  # es. "track_20260429_142315.csv"


@app.post("/api/boats/{boat_id}/tracks/upload-url")
def get_track_upload_url(
    boat_id: str,
    body: TrackUploadRequest,
    authorization: Optional[str] = Header(default=None),
):
    """Endpoint chiamato dal tablet per ottenere una SAS URL temporanea.
    Il tablet poi fa PUT diretto a quella URL con il contenuto del CSV.
    Auth: Bearer token della barca (lo stesso usato per /api/track)."""
    if not _verify_boat_token(boat_id, authorization):
        raise HTTPException(401, "Invalid boat token")

    # Sanitizzo il filename: solo nome+ext, niente path
    fn = body.filename.strip().replace("\\", "/").split("/")[-1]
    if not fn.lower().endswith(".csv"):
        raise HTTPException(400, "Filename must end with .csv")
    if not all(c.isalnum() or c in "._-" for c in fn):
        raise HTTPException(400, "Invalid characters in filename")

    if not _get_blob_service():
        raise HTTPException(500, "Blob storage not configured")

    try:
        sas_url = _generate_upload_sas(boat_id, fn)
        # Salva metadati in DB (sara' visibile anche se l'upload non avviene,
        # ma cleanup periodico puo' rimuovere orfani - per ora lasciamo)
        with db_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "MERGE dbo.Tracks_csv AS T "
                    "USING (SELECT %s AS BoatId, %s AS Filename) AS S "
                    "ON T.BoatId = S.BoatId AND T.Filename = S.Filename "
                    "WHEN NOT MATCHED THEN INSERT (BoatId, Filename, UploadedAt) "
                    "VALUES (S.BoatId, S.Filename, SYSUTCDATETIME());",
                    (boat_id, fn))
            conn.commit()
        return {
            "upload_url": sas_url,
            "expires_in_minutes": 30,
            "method": "PUT",
            "headers": {"x-ms-blob-type": "BlockBlob"},
            "public_url": _public_download_url(_container_tracks, boat_id, fn),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"SAS generation failed: {e}")


# NB: l'endpoint admin POST /api/admin/boats/{id}/tracks/upload-url e' stato
# RIMOSSO. I track CSV vengono caricati ESCLUSIVAMENTE dal tablet che ha il
# proprio boat-token, via POST /api/boats/{id}/tracks/upload-url. Il portale
# web puo' solo leggere (GET /api/boats/{id}/tracks) e cancellare
# (DELETE /api/admin/boats/{id}/tracks/{filename}).


# ---------- Listing per utente loggato ----------

@app.get("/api/boats/{boat_id}/tracks")
def list_tracks(boat_id: str):
    """Lista CSV di una barca - sito pubblico."""
    svc = _get_blob_service()
    if not svc:
        raise HTTPException(500, "Blob storage not configured")

    try:
        container = svc.get_container_client(_blob_container_name)
        prefix = f"{boat_id}/"
        blobs = []
        for blob in container.list_blobs(name_starts_with=prefix):
            fn = blob.name[len(prefix):]
            if not fn.lower().endswith(".csv"):
                continue
            blobs.append({
                "filename": fn,
                "size_bytes": blob.size,
                "uploaded_at": blob.last_modified.isoformat() if blob.last_modified else None,
                "download_url": _public_download_url(_container_tracks, boat_id, fn),
            })
        # Ordina per nome decrescente (track_YYYYMMDD_HHMMSS.csv ordina cronologicamente)
        blobs.sort(key=lambda b: b["filename"], reverse=True)
        return {"boat_id": boat_id, "tracks": blobs, "count": len(blobs)}
    except Exception as e:
        raise HTTPException(500, f"Listing failed: {e}")


# ---------- Delete (admin) ----------

@app.delete("/api/admin/boats/{boat_id}/tracks/{filename}")
def delete_track(
    boat_id: str,
    filename: str,
    x_admin_token: Optional[str] = Header(default=None),
):
    """Cancella una traccia CSV (richiede admin token)."""
    if not ADMIN_TOKEN or x_admin_token != ADMIN_TOKEN:
        raise HTTPException(401, "Invalid admin token")

    if not all(c.isalnum() or c in "._-" for c in filename):
        raise HTTPException(400, "Invalid filename")

    svc = _get_blob_service()
    if not svc:
        raise HTTPException(500, "Blob storage not configured")

    try:
        blob_path = f"{boat_id}/{filename}"
        blob_client = svc.get_blob_client(container=_blob_container_name, blob=blob_path)
        blob_client.delete_blob()

        # Rimuovi anche metadati DB
        with db_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM dbo.Tracks_csv WHERE BoatId = %s AND Filename = %s",
                    (boat_id, filename))
            conn.commit()
        return {"ok": True, "deleted": filename}
    except Exception as e:
        # Se il blob non esiste, considera ok (idempotente)
        if "BlobNotFound" in str(e):
            return {"ok": True, "deleted": filename, "note": "blob already missing"}
        raise HTTPException(500, f"Delete failed: {e}")


# =============================================================================
# FRONTEND STATICO
# =============================================================================
# I file statici del portale (HTML/CSS/JS) vengono serviti dalla stessa app
# FastAPI sotto la root "/". Layout su disco:
#
#   backend/
#   |-- app.py
#   |-- startup.sh
#   `-- static/             <- popolata da deploy-backend.ps1 prima dello zip
#       ├── index.html
#       ├── app.js
#       ├── style.css
#       └── ...
#
# =============================================================================
# DISTRIBUZIONE APK (sideloading tablet)
# =============================================================================
# Permette di:
#   - Listare gli APK disponibili (pubblico, per la pagina di download)
#   - Generare SAS URL per upload di nuove versioni (admin token)
#   - Cancellare versioni vecchie (admin token)
#
# Gli APK sono salvati nel container blob 'apks' (env AZURE_BLOB_CONTAINER_APKS),
# alla RADICE del container con nomi tipo: soar-1.7.0.apk, soar-1.7.1.apk.
# Il container deve essere configurato come 'anonymous read' su Azure Portal
# perche' i tablet del team possano scaricare senza autenticazione.
#
# Workflow upload nuovo APK:
#   1. Browser admin: drag&drop file APK -> richiede SAS URL al backend
#   2. POST /api/admin/apks/upload-url?filename=soar-1.7.0.apk + Bearer admin
#   3. Riceve SAS URL + blob_url pubblico
#   4. Browser fa PUT diretto del file binario al SAS URL
#   5. APK pubblicato istantaneamente, visibile in GET /api/apks

def _read_active_apk() -> Optional[str]:
    """Legge il filename dell'APK attualmente marcato come 'attivo' dal blob
    '_active.json' nel container apks. Se non esiste, ritorna None.

    Il file ha formato: {"filename": "soar-1.7.0.apk"}.
    Il prefisso underscore '_active.json' lo distingue dai file .apk veri:
    il filtro su list_apks esclude tutto cio' che non finisce per .apk.
    """
    svc = _get_blob_service()
    if not svc:
        return None
    try:
        container = svc.get_container_client(_container_apks)
        blob = container.get_blob_client("_active.json")
        if not blob.exists():
            return None
        import json as _json
        data = _json.loads(blob.download_blob().readall())
        return data.get("filename")
    except Exception:
        return None


def _write_active_apk(filename: str) -> None:
    """Sovrascrive '_active.json' nel container apks con il filename indicato.
    Atomic: la PUT su blob storage e' una singola operazione."""
    svc = _get_blob_service()
    if not svc:
        raise HTTPException(500, "Blob storage not configured")
    import json as _json
    container = svc.get_container_client(_container_apks)
    blob = container.get_blob_client("_active.json")
    body = _json.dumps({"filename": filename}, ensure_ascii=False).encode("utf-8")
    blob.upload_blob(body, overwrite=True, content_type="application/json")


@app.get("/api/apks")
def list_apks():
    """Lista pubblica degli APK disponibili per il download.
    Ordinata per ultima modifica (piu' recenti prima).
    Ogni voce contiene: filename, size_bytes, last_modified, download_url, is_active.

    Il campo 'is_active' indica l'APK marcato esplicitamente dall'admin come
    quello principale. Se l'admin non ha ancora scelto, oppure se l'APK
    attivo non esiste piu' (cancellato), il campo e' True per il piu' recente
    (fallback).
    """
    svc = _get_blob_service()
    if not svc:
        raise HTTPException(500, "Blob storage not configured")
    try:
        container = svc.get_container_client(_container_apks)
        apks = []
        for blob in container.list_blobs():
            # Filtro solo .apk (escludo metadata come _active.json)
            if not blob.name.lower().endswith(".apk"):
                continue
            apks.append({
                "filename": blob.name,
                "size_bytes": blob.size,
                "size_mb": round(blob.size / 1024 / 1024, 1),
                "last_modified": blob.last_modified.isoformat() if blob.last_modified else None,
                "download_url": _public_download_url(_container_apks, "", blob.name),
                "is_active": False,  # default; popolato sotto
            })
        # Piu' recenti prima
        apks.sort(key=lambda a: a["last_modified"] or "", reverse=True)

        # Marca l'APK attivo. Logica fallback:
        #   1) Se esiste _active.json e il filename indicato e' nella lista ->
        #      quello e' attivo.
        #   2) Altrimenti il piu' recente (primo della lista ordinata).
        active_filename = _read_active_apk()
        existing = [a["filename"] for a in apks]
        if active_filename and active_filename in existing:
            for a in apks:
                a["is_active"] = (a["filename"] == active_filename)
        elif apks:
            # Fallback: il piu' recente
            apks[0]["is_active"] = True
        return apks
    except Exception as e:
        raise HTTPException(500, f"List APKs failed: {e}")


@app.get("/api/apks/active")
def get_active_apk():
    """Endpoint pubblico: ritorna le info dell'APK attivo (quello che i
    tablet devono scaricare). Comoda per i tablet/script che vogliono il
    'latest stable' senza fare list+filter.

    Risponde con: {filename, download_url, size_bytes, last_modified}.
    Se nessun APK e' presente, ritorna 404.
    """
    apks = list_apks()
    if not apks:
        raise HTTPException(404, "No APKs available")
    active = next((a for a in apks if a["is_active"]), apks[0])
    return {
        "filename": active["filename"],
        "download_url": active["download_url"],
        "size_bytes": active["size_bytes"],
        "size_mb": active["size_mb"],
        "last_modified": active["last_modified"],
    }


@app.put("/api/admin/apks/active")
def set_active_apk(
    filename: str = Query(..., description="Nome del file APK da impostare come attivo"),
    authorization: Optional[str] = Header(None),
):
    """Imposta l'APK attivo (quello che i tablet scaricheranno).
    Richiede admin token.

    Verifica che l'APK esista davvero nel container prima di salvare
    _active.json: cosi' evitiamo di marcare attivo un file inesistente.
    """
    if not ADMIN_TOKEN:
        raise HTTPException(503, "Admin endpoints disabled (ADMIN_TOKEN not set)")
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing Bearer token")
    if authorization[7:].strip() != ADMIN_TOKEN:
        raise HTTPException(401, "Invalid admin token")

    # Sanitizza filename
    import re as _re
    filename = os.path.basename(filename).strip()
    if not _re.match(r'^[A-Za-z0-9._-]{1,100}$', filename):
        raise HTTPException(400, "Filename non valido")
    if not filename.lower().endswith('.apk'):
        raise HTTPException(400, "Filename deve terminare in .apk")

    svc = _get_blob_service()
    if not svc:
        raise HTTPException(500, "Blob storage not configured")

    # Verifica che il blob esista davvero
    try:
        container = svc.get_container_client(_container_apks)
        blob = container.get_blob_client(filename)
        if not blob.exists():
            raise HTTPException(404, f"APK '{filename}' non trovato nel container")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Blob check failed: {e}")

    try:
        _write_active_apk(filename)
        return {"ok": True, "active": filename}
    except Exception as e:
        raise HTTPException(500, f"Save active marker failed: {e}")


@app.post("/api/admin/apks/upload-url")
def get_apk_upload_url(
    filename: str = Query(..., description="Nome del file APK, es. soar-1.7.0.apk"),
    authorization: Optional[str] = Header(None),
):
    """Genera SAS URL temporanea per upload di un nuovo APK.
    Richiede admin token (Bearer).

    Filename sanitizzato: deve matchare regex [A-Za-z0-9._-] e terminare in .apk.
    SAS valida 30 minuti (file grandi, upload puo' essere lento su 4G).
    """
    if not ADMIN_TOKEN:
        raise HTTPException(503, "Admin endpoints disabled (ADMIN_TOKEN not set)")
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing Bearer token")
    if authorization[7:].strip() != ADMIN_TOKEN:
        raise HTTPException(401, "Invalid admin token")

    # Sanitizza filename: solo nome file, no path. Massimo 100 char.
    import re as _re
    filename = os.path.basename(filename).strip()
    if not _re.match(r'^[A-Za-z0-9._-]{1,100}$', filename):
        raise HTTPException(400, "Filename non valido (alfanumerici, '.', '_', '-' max 100 char)")
    if not filename.lower().endswith('.apk'):
        raise HTTPException(400, "Filename deve terminare in .apk")

    if not _get_blob_service():
        raise HTTPException(500, "Blob storage not configured")

    try:
        # boat_id="" -> blob alla radice del container apks
        sas_url = _generate_upload_sas(
            "", filename,
            container_name=_container_apks,
            expires_minutes=30,
        )
        return {
            "upload_url": sas_url,
            "filename": filename,
            "expires_in_minutes": 30,
            "method": "PUT",
            "headers": {
                "x-ms-blob-type": "BlockBlob",
                "Content-Type": "application/vnd.android.package-archive",
            },
            "blob_url": _public_download_url(_container_apks, "", filename),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"SAS generation failed: {e}")


@app.delete("/api/admin/apks/{filename}")
def delete_apk(
    filename: str,
    authorization: Optional[str] = Header(None),
):
    """Cancella un APK dal container. Richiede admin token."""
    if not ADMIN_TOKEN:
        raise HTTPException(503, "Admin endpoints disabled")
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing Bearer token")
    if authorization[7:].strip() != ADMIN_TOKEN:
        raise HTTPException(401, "Invalid admin token")

    import re as _re
    filename = os.path.basename(filename).strip()
    if not _re.match(r'^[A-Za-z0-9._-]{1,100}$', filename):
        raise HTTPException(400, "Filename non valido")
    if not filename.lower().endswith('.apk'):
        raise HTTPException(400, "Filename deve terminare in .apk")

    svc = _get_blob_service()
    if not svc:
        raise HTTPException(500, "Blob storage not configured")
    try:
        container = svc.get_container_client(_container_apks)
        container.delete_blob(filename)
        return {"ok": True, "deleted": filename}
    except Exception as e:
        if "BlobNotFound" in str(e):
            return {"ok": True, "deleted": filename, "note": "already missing"}
        raise HTTPException(500, f"Delete failed: {e}")


# =============================================================================
# STATIC FILES (frontend)
# =============================================================================

#
# html=True fa servire index.html in automatico quando la URL e' "/" oppure
# punta a una directory. check_dir=False evita un crash se la cartella non
# esiste (es. backend in dev senza frontend, o test runner).

import os as _os
from fastapi.staticfiles import StaticFiles as _StaticFiles

_STATIC_DIR = _os.path.join(_os.path.dirname(__file__), "static")
if _os.path.isdir(_STATIC_DIR):
    app.mount("/", _StaticFiles(directory=_STATIC_DIR, html=True),
              name="frontend")
    print(f"[static] serving frontend from {_STATIC_DIR}")
else:
    # Cartella assente: il backend funziona lo stesso, solo il frontend non
    # e' raggiungibile. Utile in sviluppo locale puro-API.
    print(f"[static] frontend directory not found ({_STATIC_DIR}); "
          f"API only mode")
