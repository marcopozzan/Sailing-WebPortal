/**
 * Sailing Cloud - Portale di analisi (parte non-live).
 *
 * Questo modulo gestisce solo:
 *  - Inizializzazione mappa Leaflet (esposta come window.map per altri moduli)
 *  - Lista barche e selezione
 *  - Dettaglio della barca selezionata (sidebar)
 *
 * Tutta la logica del live stream (SSE, marker barca, scia, pannelli dati)
 * sta in live-stream.js (modulo SailingLive). app.js chiama SailingLive.start()
 * quando l'utente seleziona una barca, e SailingLive.stop() quando va via.
 *
 * URL backend definito in config.js (window.SAILING_API_BASE).
 */

const API_BASE = window.SAILING_API_BASE ?? 'http://localhost:8000';
// Intervallo di refresh della LISTA barche (non del live: quello arriva via SSE).
const REFRESH_MS = 60000;
const ONLINE_THRESHOLD_MIN = 15;

let selectedBoatId = null;
let autoRefreshTimer = null;

// =============================================================================
// MAPPA
// =============================================================================
// Centro iniziale: Golfo di Trieste (la flotta SOAR e' qui). Zoom 12.
// La mappa viene esposta come window.map perche' SailingLive (live-stream.js)
// ne ha bisogno per piazzare il marker della barca.

function initMap() {
    const m = L.map('map', {
        center: [45.70, 13.70],   // Trieste / Barcola
        zoom: 12,
        zoomControl: true,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
    }).addTo(m);

    // Espongo come globale per SailingLive (vedi live-stream.js, getMap())
    window.map = m;
    return m;
}

// =============================================================================
// API
// =============================================================================

async function apiGet(path) {
    const res = await fetch(API_BASE + path);
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${path}: ${txt.slice(0, 200)}`);
    }
    return res.json();
}

async function loadBoats() {
    const boats = await apiGet('/api/boats');
    renderBoatList(boats);
    return boats;
}

// =============================================================================
// RENDERING SIDEBAR
// =============================================================================

function renderBoatList(boats) {
    const ul = document.getElementById('boat-list');
    ul.innerHTML = '';
    if (!boats || boats.length === 0) {
        ul.innerHTML = '<li class="muted">Nessuna barca</li>';
        return;
    }
    const now = Date.now();
    boats.forEach(b => {
        const li = document.createElement('li');
        li.dataset.boatId = b.boat_id;
        if (b.boat_id === selectedBoatId) li.classList.add('active');

        let statusClass = 'offline', statusText = 'mai vista';
        if (b.last_seen_at) {
            const ts = new Date(b.last_seen_at);
            const minAgo = (now - ts.getTime()) / 60000;
            if (minAgo < ONLINE_THRESHOLD_MIN) {
                statusClass = 'online';
                statusText = 'online';
            } else {
                statusText = formatTimeAgo(ts);
            }
        }
        li.innerHTML = `
            <span class="name">${escapeHtml(b.name)}</span>
            <span class="meta ${statusClass}">${statusText}</span>
        `;
        li.onclick = () => selectBoat(b.boat_id);
        ul.appendChild(li);
    });
}

function renderBoatDetail(boat) {
    const div = document.getElementById('boat-detail');
    if (!boat) { div.innerHTML = '<p class="muted">--</p>'; return; }
    const rows = [
        ['ID', boat.boat_id],
        ['Nome', boat.name],
        ['Owner', boat.owner || '--'],
        ['Ultimo dato', boat.last_seen_at
            ? formatTimeAgo(new Date(boat.last_seen_at)) : '--'],
    ];
    div.innerHTML = rows.map(([k, v]) =>
        `<div class="kv"><span class="k">${k}</span><span class="v">${escapeHtml(String(v))}</span></div>`
    ).join('');
}

// =============================================================================
// AZIONI UTENTE
// =============================================================================

async function selectBoat(boatId) {
    selectedBoatId = boatId;
    document.querySelectorAll('#boat-list li').forEach(li => {
        li.classList.toggle('active', li.dataset.boatId === boatId);
    });

    // Carico dettaglio
    try {
        const boats = await apiGet('/api/boats');
        const boat = boats.find(b => b.boat_id === boatId);
        renderBoatDetail(boat);
    } catch (e) {
        console.error('[app] errore caricando dettaglio barca:', e);
    }

    // Delego al modulo live
    if (window.SailingLive && typeof window.SailingLive.start === 'function') {
        window.SailingLive.start(boatId);
    } else {
        console.error('[app] window.SailingLive non disponibile; '
                    + 'live-stream.js incluso nella pagina?');
    }
}

async function refreshAll() {
    try {
        const boats = await loadBoats();
        if (selectedBoatId) {
            const boat = boats.find(b => b.boat_id === selectedBoatId);
            renderBoatDetail(boat);
        }
        document.getElementById('last-update').textContent =
            'Aggiornato: ' + new Date().toLocaleTimeString('it-IT');
    } catch (e) {
        console.error('[app] refreshAll:', e);
        document.getElementById('last-update').textContent = 'Errore: ' + e.message;
    }
}

function setAutoRefresh(enabled) {
    if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
    if (enabled) autoRefreshTimer = setInterval(refreshAll, REFRESH_MS);
}

// =============================================================================
// UTIL
// =============================================================================

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
    }[c]));
}

function formatTimeAgo(d) {
    const sec = Math.floor((Date.now() - d.getTime()) / 1000);
    if (sec < 60)     return `${sec}s fa`;
    if (sec < 3600)   return `${Math.floor(sec/60)}min fa`;
    if (sec < 86400)  return `${Math.floor(sec/3600)}h fa`;
    return `${Math.floor(sec/86400)}g fa`;
}

// =============================================================================
// BOOT
// =============================================================================

document.addEventListener('DOMContentLoaded', () => {
    initMap();

    document.getElementById('btn-refresh').onclick = refreshAll;
    document.getElementById('chk-auto').onchange = (e) => {
        setAutoRefresh(e.target.checked);
    };

    // I bottoni "time-range" non hanno piu' senso per il live (lo storico e'
    // disabilitato in questa versione); tengo gli handler per non lasciarli
    // morti, ma non fanno nulla di utile finche' non ricolleghiamo lo storico
    // a Event Hub Capture.
    document.querySelectorAll('.time-range button').forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll('.time-range button').forEach(b =>
                b.classList.toggle('active', b === btn));
        };
    });

    refreshAll();
    setAutoRefresh(true);

    // Quando si torna alla schermata Live, forza il resize della mappa
    // (Leaflet ha bisogno di sapere le nuove dimensioni del container)
    window.addEventListener('screenChanged', (e) => {
        if (e.detail && e.detail.name === 'live' && window.map) {
            setTimeout(() => window.map.invalidateSize(), 50);
        }
    });
});
