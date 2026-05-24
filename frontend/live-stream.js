/**
 * Sailing Cloud - Modulo Live Stream (SSE)
 * =========================================
 *
 * Modulo self-contained che gestisce:
 *  - Connessione SSE all'endpoint /api/boats/{boat_id}/live/stream
 *  - Aggiornamento marker barca sulla mappa Leaflet (#map)
 *  - Aggiornamento pannelli dati (#live-data, #live-tactical)
 *  - Aggiornamento boa target sulla mappa
 *  - Badge di stato visibile (#live-status)
 *  - Riconnessione automatica con backoff in caso di disconnect
 *  - Logging verboso con prefisso [live] per debug
 *
 * Espone l'API minimale:
 *  - window.SailingLive.start(boatId)  -> apre stream per la barca
 *  - window.SailingLive.stop()         -> chiude stream
 *  - window.SailingLive.getLastPoint() -> ultimo punto ricevuto (per debug)
 *
 * Si aspetta che la mappa Leaflet globale `window.SailingMap` (oppure variabile
 * `map`) sia gia' inizializzata. Se non lo e' al momento di start(), aspetta
 * fino a 5 secondi che lo diventi.
 */
(function() {
    'use strict';

    const API_BASE = window.SAILING_API_BASE ?? '';
    const RECONNECT_BASE_MS = 1000;     // primo retry dopo 1s
    const RECONNECT_MAX_MS  = 30000;    // tetto: 30s
    const MAP_WAIT_MAX_MS   = 5000;     // attesa massima che la mappa sia pronta

    // Stato modulo
    let currentBoatId  = null;
    let eventSource    = null;
    let reconnectTries = 0;
    let lastPoint      = null;
    let liveCount      = 0;     // numero eventi ricevuti dall'apertura stream

    // Layer Leaflet creati DA QUESTO MODULO (separati da quelli che potrebbe
    // creare app.js o altri moduli, cosi' non interferiamo).
    let boatMarker      = null;
    let boatTrail       = null;     // polyline ultimi N punti
    let markBoaMarker   = null;
    let headingArrow    = null;
    const trailPoints   = [];       // array di [lat, lon]
    const TRAIL_MAX     = 200;      // tieni gli ultimi 200 punti per la scia
    let firstPointSeen  = false;    // per centrare la mappa al primo punto

    // =========================================================================
    // LOGGING
    // =========================================================================
    function log(...args) {
        console.log('[live]', ...args);
    }
    function warn(...args) {
        console.warn('[live]', ...args);
    }
    function err(...args) {
        console.error('[live]', ...args);
    }

    // =========================================================================
    // UI: BADGE DI STATO
    // =========================================================================
    function setStatus(state, text) {
        const el = document.getElementById('live-status');
        if (!el) return;
        // state: 'connecting' | 'connected' | 'streaming' | 'error' | 'idle'
        el.dataset.state = state;
        el.textContent = text;
    }

    // =========================================================================
    // MAPPA: ATTESA DELLA MAPPA LEAFLET
    // =========================================================================
    /**
     * Restituisce l'istanza Leaflet map. Cerca in window.SailingMap (variabile
     * standard se app.js espone la mappa cosi'), oppure window.map (variabile
     * globale legacy). Ritorna null se nessuna e' disponibile.
     */
    function getMap() {
        if (window.SailingMap && typeof window.SailingMap.setView === 'function') {
            return window.SailingMap;
        }
        if (window.map && typeof window.map.setView === 'function') {
            return window.map;
        }
        return null;
    }

    /**
     * Aspetta fino a MAP_WAIT_MAX_MS che la mappa Leaflet sia pronta.
     * Ritorna l'istanza map quando disponibile, oppure null se scaduto il timeout.
     * E' utile perche' SailingLive.start() puo' essere chiamato prima che app.js
     * abbia finito initMap(): poll ogni 50ms.
     */
    async function waitForMap() {
        const start = Date.now();
        while (Date.now() - start < MAP_WAIT_MAX_MS) {
            const m = getMap();
            if (m) return m;
            await new Promise(r => setTimeout(r, 50));
        }
        return null;
    }

    // =========================================================================
    // RENDERING: MARKER BARCA + SCIA + BOA TARGET + FRECCIA HEADING
    // =========================================================================
    function clearAllLayers(map) {
        if (boatMarker)    { map.removeLayer(boatMarker);    boatMarker = null; }
        if (boatTrail)     { map.removeLayer(boatTrail);     boatTrail = null; }
        if (markBoaMarker) { map.removeLayer(markBoaMarker); markBoaMarker = null; }
        if (headingArrow)  { map.removeLayer(headingArrow);  headingArrow = null; }
        trailPoints.length = 0;
        firstPointSeen = false;
    }

    /**
     * Calcola un secondo punto a partire da (lat, lon) muovendosi di
     * distanceNm verso bearingDeg. Modello flat-earth, ok per pochi km.
     */
    function projectFromLatLon(lat, lon, bearingDeg, distanceNm) {
        const rad = bearingDeg * Math.PI / 180;
        const dLatDeg = (distanceNm / 60) * Math.cos(rad);
        const dLonDeg = (distanceNm / 60) * Math.sin(rad) /
                        Math.cos(lat * Math.PI / 180);
        return [lat + dLatDeg, lon + dLonDeg];
    }

    /**
     * Renderizza un punto live sulla mappa: marker barca, scia, boa target,
     * freccia heading. Centra automaticamente al primo punto.
     */
    function renderPointOnMap(map, p) {
        if (p.lat == null || p.lon == null) {
            warn('punto senza lat/lon, skip rendering mappa', p);
            return;
        }
        const ll = [p.lat, p.lon];

        // --- MARKER BARCA (cerchio arancione, ben visibile) ---
        if (!boatMarker) {
            log('creo marker barca a', ll);
            boatMarker = L.circleMarker(ll, {
                radius: 10,
                color: '#ffffff',
                fillColor: '#C55A11',
                fillOpacity: 1,
                weight: 3,
            }).addTo(map);
            boatMarker.bindTooltip(buildTooltip(p), {
                permanent: false,
                direction: 'top',
            });
        } else {
            boatMarker.setLatLng(ll);
            boatMarker.setTooltipContent(buildTooltip(p));
        }

        // --- SCIA (polyline ultimi TRAIL_MAX punti) ---
        trailPoints.push(ll);
        if (trailPoints.length > TRAIL_MAX) trailPoints.shift();
        if (boatTrail) {
            boatTrail.setLatLngs(trailPoints);
        } else if (trailPoints.length >= 2) {
            boatTrail = L.polyline(trailPoints, {
                color: '#C55A11',
                weight: 2,
                opacity: 0.7,
            }).addTo(map);
        }

        // --- FRECCIA HEADING ---
        if (headingArrow) {
            map.removeLayer(headingArrow);
            headingArrow = null;
        }
        if (p.heading_deg != null) {
            const tip = projectFromLatLon(p.lat, p.lon, p.heading_deg, 0.05);
            headingArrow = L.polyline([ll, tip], {
                color: '#ffffff',
                weight: 4,
                opacity: 0.95,
            }).addTo(map);
        }

        // --- BOA TARGET ---
        if (markBoaMarker) {
            map.removeLayer(markBoaMarker);
            markBoaMarker = null;
        }
        if (p.mark_distance != null && p.mark_bearing != null && p.mark_name) {
            const boaLatLon = projectFromLatLon(
                p.lat, p.lon, p.mark_bearing, p.mark_distance);
            markBoaMarker = L.marker(boaLatLon, {
                icon: L.divIcon({
                    className: 'boa-marker',
                    html: '<div style="font-size:24px;line-height:24px;">🟡</div>',
                    iconSize: [24, 24],
                    iconAnchor: [12, 12],
                }),
            }).addTo(map);
            markBoaMarker.bindTooltip(
                `${p.mark_name} (${p.mark_distance.toFixed(2)} nm)`);
        }

        // --- CENTRA MAPPA AL PRIMO PUNTO ---
        if (!firstPointSeen) {
            log('primo punto ricevuto, centro mappa su', ll);
            map.setView(ll, 14);
            firstPointSeen = true;
        }
    }

    function buildTooltip(p) {
        const fmt = (v, d, u) => v != null ? `${v.toFixed(d)} ${u}` : '--';
        return [
            `<strong>${currentBoatId || 'barca'}</strong>`,
            `SOG ${fmt(p.sog_kn, 1, 'kn')}`,
            `COG ${fmt(p.cog_deg, 0, '°')}`,
            `TWS ${fmt(p.tws_kn, 1, 'kn')}`,
            `TWA ${fmt(p.twa_deg, 0, '°')}`,
            `VMG ${fmt(p.vmg_kn, 2, 'kn')}`,
        ].join('<br>');
    }

    // =========================================================================
    // RENDERING: PANNELLI DATI LATERALI
    // =========================================================================
    function renderPanels(p) {
        const grid = document.getElementById('live-data');
        const tac  = document.getElementById('live-tactical');

        if (!grid) { warn('elemento #live-data non trovato'); }
        if (!tac)  { warn('elemento #live-tactical non trovato'); }

        if (grid) {
            const cells = [
                ['SOG',    p.sog_kn,        'kn', 1],
                ['COG',    p.cog_deg,       '°',  0],
                ['HDG',    p.heading_deg,   '°',  0],
                ['TWS',    p.tws_kn,        'kn', 1],
                ['TWA',    p.twa_deg,       '°',  0],
                ['TWD',    p.twd_deg,       '°',  0],
                ['VMG',    p.vmg_kn,        'kn', 2],
                ['Target', p.target_bsp_kn, 'kn', 1],
            ];
            grid.innerHTML = cells.map(([label, val, unit, dec]) => `
                <div class="live-cell">
                    <div class="label">${label}</div>
                    <div class="value">${val != null ? val.toFixed(dec) : '--'}<span class="unit">${unit}</span></div>
                </div>
            `).join('');
        }

        if (tac) {
            // L'advice puo' arrivare in formati vari (LATO BUONO, VIRA,
            // OK, layline, oppure stringhe italiane libere dal simulatore).
            // Mostriamo quello che arriva, con uno stile in base alle parole chiave.
            const advice = (p.advice || '').toString();
            const shift  = p.shift_deg;
            const shiftStr = (shift != null)
                ? `${shift >= 0 ? '+' : ''}${shift.toFixed(0)}°`
                : '';
            let cls = 'ok', text = '—';
            const adv = advice.toUpperCase();
            if (adv.includes('VIRA') || adv.includes('TACK')) {
                cls = 'vira'; text = `VIRA ${shiftStr}`;
            } else if (adv.includes('LAYLINE') || adv.includes('APPROCCIO')) {
                cls = 'layline'; text = advice;
            } else if (adv.includes('BOLINA') || adv.includes('POPPA')) {
                cls = 'ok'; text = `${advice} ${shiftStr}`;
            } else if (advice) {
                cls = 'ok'; text = advice;
            }
            tac.className = cls;
            tac.innerHTML = text;
        }
    }

    function renderLastUpdate() {
        const el = document.getElementById('last-update');
        if (el) {
            el.textContent = 'Live: ' + new Date().toLocaleTimeString('it-IT');
        }
    }

    // =========================================================================
    // EVENT SOURCE - GESTIONE STREAM SSE
    // =========================================================================
    function closeStream() {
        if (eventSource) {
            log('chiudo EventSource');
            eventSource.close();
            eventSource = null;
        }
    }

    /**
     * Apre lo stream SSE per la barca. Logga ogni evento ricevuto.
     * Riconnessione automatica con backoff esponenziale in caso di errore.
     */
    async function openStream(boatId) {
        closeStream();

        const map = await waitForMap();
        if (!map) {
            err('mappa Leaflet non disponibile dopo ' + MAP_WAIT_MAX_MS + 'ms; '
                + 'verifico che app.js inizializzi window.map o window.SailingMap');
            setStatus('error', 'Mappa non pronta');
            return;
        }

        log('apro stream per boat_id=' + boatId);
        setStatus('connecting', 'Connessione...');

        const url = `${API_BASE}/api/boats/${encodeURIComponent(boatId)}/live/stream`;
        log('URL stream:', url);

        let es;
        try {
            es = new EventSource(url);
        } catch (e) {
            err('EventSource construction failed:', e);
            setStatus('error', 'Errore apertura stream');
            scheduleReconnect(boatId);
            return;
        }
        eventSource = es;
        liveCount = 0;

        // Tre tipi di evento dal backend: 'ready', 'live', 'ping'.
        es.addEventListener('ready', (ev) => {
            log('SSE ready:', ev.data);
            setStatus('connected', 'Connesso, in attesa dati...');
            reconnectTries = 0;
        });

        es.addEventListener('live', (ev) => {
            let p;
            try {
                p = JSON.parse(ev.data);
            } catch (e) {
                err('parse JSON fallito:', e, ev.data);
                return;
            }
            liveCount++;
            lastPoint = p;
            if (liveCount <= 3 || liveCount % 25 === 0) {
                // log dettagliato sui primi 3, poi ogni 25 per non spammare
                log(`live #${liveCount}:`, p);
            }
            setStatus('streaming', `Live (${liveCount} eventi)`);
            try {
                renderPointOnMap(map, p);
            } catch (e) {
                err('renderPointOnMap eccezione:', e);
            }
            try {
                renderPanels(p);
            } catch (e) {
                err('renderPanels eccezione:', e);
            }
            renderLastUpdate();
        });

        es.addEventListener('ping', () => {
            // heartbeat keep-alive: non logghiamo per non spammare,
            // ma aggiorniamo lo stato per dire che siamo vivi
            if (liveCount === 0) {
                setStatus('connected', 'Connesso, in attesa dati...');
            }
        });

        // L'evento 'error' su EventSource scatta sia su disconnect transienti
        // (il browser ricollega da solo) sia su errori fatali. Distinguiamo
        // guardando readyState.
        es.onerror = (e) => {
            const readyState = es.readyState;
            // 0 = CONNECTING, 1 = OPEN, 2 = CLOSED
            if (readyState === 2) {
                warn('stream chiuso dal server, schedulo riconnessione');
                setStatus('error', 'Disconnesso');
                scheduleReconnect(boatId);
            } else {
                warn('errore stream (readyState=' + readyState
                    + '), il browser tenter\u00e0 riconnessione automatica');
                setStatus('connecting', 'Riconnessione...');
            }
        };
    }

    /**
     * Schedula una riconnessione con backoff esponenziale (1s, 2s, 4s, ...
     * fino a max 30s). Necessario perche' EventSource del browser fa retry
     * automatico SOLO sui drop di connessione; se il server chiude lo stream
     * (readyState=2) il retry non c'e' e dobbiamo gestirlo noi.
     */
    function scheduleReconnect(boatId) {
        if (currentBoatId !== boatId) {
            log('riconnessione annullata, barca cambiata');
            return;
        }
        reconnectTries++;
        const delay = Math.min(
            RECONNECT_BASE_MS * Math.pow(2, reconnectTries - 1),
            RECONNECT_MAX_MS);
        log(`riconnessione fra ${delay}ms (tentativo ${reconnectTries})`);
        setTimeout(() => {
            if (currentBoatId === boatId) {
                openStream(boatId);
            }
        }, delay);
    }

    // =========================================================================
    // API PUBBLICA
    // =========================================================================
    async function start(boatId) {
        if (!boatId) {
            warn('start() chiamato senza boat_id, ignoro');
            return;
        }
        log('start(' + boatId + ')');
        currentBoatId = boatId;
        reconnectTries = 0;

        // Reset mappa: la barca e' cambiata, via i layer della precedente
        const map = getMap();
        if (map) {
            clearAllLayers(map);
        }

        // Reset pannelli
        renderPanels({});

        await openStream(boatId);
    }

    function stop() {
        log('stop()');
        currentBoatId = null;
        closeStream();
        const map = getMap();
        if (map) clearAllLayers(map);
        setStatus('idle', 'Disconnesso');
    }

    function getLastPoint() {
        return lastPoint;
    }

    // =========================================================================
    // EXPORT
    // =========================================================================
    window.SailingLive = {
        start,
        stop,
        getLastPoint,
        // debug helpers
        _internals: () => ({
            currentBoatId,
            liveCount,
            reconnectTries,
            hasEventSource: !!eventSource,
            hasMap: !!getMap(),
        }),
    };

    // Cleanup automatico su unload pagina
    window.addEventListener('beforeunload', () => {
        closeStream();
    });

    // Handler del bottone "centra mappa sulla barca" (vedi index.html, sopra mappa)
    document.addEventListener('DOMContentLoaded', () => {
        const btn = document.getElementById('btn-center-boat');
        if (btn) {
            btn.addEventListener('click', () => {
                const m = getMap();
                if (!m) { warn('mappa non disponibile'); return; }
                if (!lastPoint || lastPoint.lat == null) {
                    warn('nessun punto ricevuto ancora, niente da centrare');
                    return;
                }
                log('centro mappa su', [lastPoint.lat, lastPoint.lon]);
                m.setView([lastPoint.lat, lastPoint.lon], 14);
            });
        }
    });

    log('modulo SailingLive caricato');
})();
