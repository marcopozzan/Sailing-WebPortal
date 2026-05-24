/**
 * Sailing Cloud - Modulo Meteo previsionale.
 *
 * Stack:
 * - Open-Meteo Forecast API (atmosferica): vento, raffiche, pioggia, pressione, temp
 * - Open-Meteo Marine API: onda significativa, periodo, direzione, sea surface temp
 * - Niente API key. CORS supportato. Fetch direttamente dal browser.
 *
 * Flusso:
 * 1. L'utente seleziona una barca con waypoint caricati
 * 2. Click su "Aggiorna previsione"
 * 3. Per ogni waypoint chiamo /v1/forecast e /v1/marine in parallelo
 * 4. Aggrego in 4 orizzonti (+6/+12/+24/+48h) per ricavare il "vento medio
 *    sulla rotta" da mostrare nelle cards di riepilogo
 * 5. Tabella per waypoint con sotto-righe per ogni orizzonte
 *
 * Espone window.SailingWeather (refresh, getPrefs, savePrefs, init).
 */
(function() {
    "use strict";

    const API_BASE_FORECAST = 'https://api.open-meteo.com/v1/forecast';
    const API_BASE_MARINE   = 'https://marine-api.open-meteo.com/v1/marine';

    /** Orizzonti delle cards riassuntive (in ore). */
    const HORIZONS = [6, 12, 24, 48];

    /** Default delle preferenze. Salvate in localStorage chiave 'sailing_weather_prefs'. */
    const DEFAULT_PREFS = {
        model: 'best_match',
        vars: { wind: true, wave: true, precip: true, pressure: false, temp: false },
        // Soglie per alert (turno 2). Card/righe diventano rosse oltre.
        // Default ragionevoli per regata costiera.
        thresholds: {
            wind:   22,   // nodi
            gust:   28,   // nodi
            wave:   2.0,  // metri
            precip: 2.0,  // mm/h
        },
        // Auto-refresh ogni 30 minuti (default OFF)
        autoRefresh: false,
    };
    const PREFS_KEY = 'sailing_weather_prefs';
    const AUTO_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

    let initDone = false;
    // Cache dei waypoints della barca corrente (caricati dal config-urls)
    let currentBoatId = null;
    let currentWaypoints = null;
    // PolarLookup della barca corrente (opzionale): carica anche il polar.json
    // della barca, se disponibile, per poter mostrare la vela suggerita
    // sulle cards meteo. Se la barca non ha polare, currentPolarLookup = null
    // e le sezioni "Vela" non vengono mostrate.
    let currentPolarLookup = null;
    // Reference time (turno data partenza): se l'utente sceglie una data
    // specifica nell'header, tutti i calcoli di "+0h, +6h, +12h..." sono
    // relativi a quella, NON a Date.now(). Se null, fallback a ora corrente
    // = comportamento storico invariato.
    let referenceTimeMs = null;

    /** Restituisce il timestamp di riferimento per i calcoli di orizzonte
     *  meteo (cards +6h/+12h/+24h/+48h, slider mappa, meteogram). Se l'utente
     *  ha impostato una data di partenza nell'header, usa quella; altrimenti
     *  usa Date.now() (comportamento storico). */
    function getReferenceTimeMs() {
        return referenceTimeMs != null ? referenceTimeMs : Date.now();
    }
    /** Imposta il reference time. Passa null per resettare a "adesso". */
    function setReferenceTime(ms) {
        referenceTimeMs = (ms != null && isFinite(ms)) ? ms : null;
    }
    // Ultima previsione fetchata (per export futuro / refresh map)
    let lastForecast = null;
    // Auto-refresh timer (turno 2)
    let autoRefreshTimer = null;
    // Mappa Leaflet (turno 2): inizializzata lazy alla prima refresh.
    let weatherMap = null;
    let weatherMapMarkers = null;  // L.LayerGroup di marker waypoint (sempre)
    let weatherMapBarbs = null;    // L.LayerGroup di wind barbs (cambiano con slider)
    // jsPDF lazy-loaded (riusa la promise di analysis-plots se gia' caricato)
    let _jsPdfPromise = null;

    // -------------------------------------------------------------------
    // Preferenze (localStorage)
    // -------------------------------------------------------------------
    function getPrefs() {
        try {
            const raw = localStorage.getItem(PREFS_KEY);
            if (!raw) return JSON.parse(JSON.stringify(DEFAULT_PREFS));
            const p = JSON.parse(raw);
            // Merge con default per gestire migrazioni (utente che ha salvato
            // preferenze con la vecchia struttura senza thresholds/autoRefresh).
            return {
                model: p.model || DEFAULT_PREFS.model,
                vars: Object.assign({}, DEFAULT_PREFS.vars, p.vars || {}),
                thresholds: Object.assign({}, DEFAULT_PREFS.thresholds, p.thresholds || {}),
                autoRefresh: p.autoRefresh != null ? !!p.autoRefresh : DEFAULT_PREFS.autoRefresh,
            };
        } catch (e) {
            return JSON.parse(JSON.stringify(DEFAULT_PREFS));
        }
    }
    function savePrefs(prefs) {
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    }

    // -------------------------------------------------------------------
    // Caricamento waypoint della barca selezionata
    // (riusa il pattern di replay.js: GET /api/boats/{id}/config-urls -> blob)
    // -------------------------------------------------------------------
    async function loadBoats() {
        const sel = document.getElementById('weather-boat-select');
        if (!sel) return;
        const apiBase = window.SAILING_API_BASE ?? '';
        try {
            const res = await SailingAuth.authFetch(apiBase + '/api/boats');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const boats = await res.json();
            const cur = sel.value;
            sel.innerHTML = '<option value="">-- seleziona barca --</option>';
            boats.forEach(b => {
                const opt = document.createElement('option');
                // Il backend ritorna {boat_id, name, owner, ...} - vedi
                // /api/boats in backend/app.py. Allineato a wptview.js e
                // polarview.js. NON usare b.id (era un bug: undefined ->
                // sel.value = "undefined" -> URL waypoints/undefined/... 404).
                opt.value = b.boat_id;
                opt.textContent = `${b.name} (${b.boat_id})`;
                sel.appendChild(opt);
            });
            if (cur && [...sel.options].some(o => o.value === cur)) {
                sel.value = cur;
            }
        } catch (e) {
            console.error('Errore loadBoats meteo:', e);
        }
    }

    async function loadWaypointsForBoat(boatId) {
        // Allineato al pattern usato da wptview.js (che funziona). API_BASE
        // di default coincide con l'origine del portale: in produzione e'
        // l'App Service, in dev locale e' http://localhost:8000.
        const apiBase = window.SAILING_API_BASE ?? 'http://localhost:8000';
        console.log('[weather] loadWaypointsForBoat boatId=', JSON.stringify(boatId));

        const cfgUrl = apiBase +
            '/api/boats/' + encodeURIComponent(boatId) + '/config-urls';
        console.log('[weather] fetching config-urls:', cfgUrl);
        const cfgRes = await fetch(cfgUrl);
        if (!cfgRes.ok) throw new Error('config-urls HTTP ' + cfgRes.status);
        const cfg = await cfgRes.json();
        console.log('[weather] config-urls response:', cfg);
        // Nota: cfg.waypoints_url e' sempre popolato se lo storage e'
        // configurato (e' l'URL atteso, calcolato da boat_id). NON garantisce
        // che il file esista davvero sul blob: per quello bisogna provare a
        // scaricarlo e gestire il 404 separatamente.
        if (!cfg.configured || !cfg.waypoints_url) {
            throw new Error('Storage non configurato sul server.');
        }

        const wpUrl = cfg.waypoints_url +
            (cfg.waypoints_url.includes('?') ? '&' : '?') + 'nocache=' + Date.now();
        console.log('[weather] fetching waypoints from blob:', wpUrl);
        const wpRes = await fetch(wpUrl);
        console.log('[weather] waypoints fetch status:', wpRes.status);

        if (wpRes.status === 404) {
            // Distingo questo caso dagli altri errori: il file non e' mai stato
            // caricato per questa barca. Messaggio actionable per l'utente.
            throw new Error(
                `La barca "${boatId}" non ha un file waypoints.json sul cloud.\n\n` +
                'Per usare la previsione meteo lungo la rotta:\n' +
                '1. Vai in ⚙ Config\n' +
                '2. Inserisci l\'admin token\n' +
                '3. Seleziona la barca\n' +
                '4. Carica il file waypoints.json\n\n' +
                'Oppure verifica nella schermata 📍 WPT se i waypoints sono visibili.\n\n' +
                'URL chiamato: ' + cfg.waypoints_url
            );
        }
        if (!wpRes.ok) {
            throw new Error('Errore download waypoints (HTTP ' + wpRes.status + ')');
        }
        const wpJson = await wpRes.json();

        // Parsing in [{name, lat, lon}] decimali
        if (window.SailingCoord && window.SailingCoord.validateWaypointsJson) {
            return window.SailingCoord.validateWaypointsJson(wpJson);
        }
        // Fallback minimale (non dovrebbe mai capitare in produzione)
        return (wpJson.waypoints || []).map(w => ({
            name: w.name, lat: parseFloat(w.lat), lon: parseFloat(w.lon),
        }));
    }

    /** Carica la polare della barca dal blob (se disponibile) e ritorna il
     *  polarLookup pronto per lookupSail. Se la barca non ha polare, ritorna
     *  null senza errore: la schermata meteo continua a funzionare ma senza
     *  la sezione "vela suggerita". */
    async function loadPolarLookupForBoat(boatId) {
        const apiBase = window.SAILING_API_BASE ?? 'http://localhost:8000';
        try {
            const cfgRes = await SailingAuth.authFetch(apiBase +
                '/api/boats/' + encodeURIComponent(boatId) + '/config-urls');
            if (!cfgRes.ok) return null;
            const cfg = await cfgRes.json();
            if (!cfg.configured || !cfg.polar_url) return null;
            const polRes = await fetch(cfg.polar_url +
                (cfg.polar_url.includes('?') ? '&' : '?') + 'nocache=' + Date.now());
            if (!polRes.ok) return null;  // 404 = polare non caricata: ok
            const polJson = await polRes.json();
            if (window.SailingAnalysis && window.SailingAnalysis.buildPolarLookup) {
                return window.SailingAnalysis.buildPolarLookup(polJson);
            }
            return null;
        } catch (e) {
            console.warn('[weather] caricamento polare fallito:', e.message);
            return null;
        }
    }

    // -------------------------------------------------------------------
    // Build URL Open-Meteo /v1/forecast.
    // Variables incluse in funzione delle preferenze utente.
    // -------------------------------------------------------------------
    function buildForecastUrl(lat, lon, prefs) {
        const hourly = [];
        if (prefs.vars.wind) {
            hourly.push('wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m');
        }
        if (prefs.vars.precip)   hourly.push('precipitation', 'precipitation_probability');
        if (prefs.vars.pressure) hourly.push('surface_pressure');
        if (prefs.vars.temp)     hourly.push('temperature_2m');
        // forecast_days: deve coprire da OGGI fino a reference_time + 48h.
        // Open-Meteo permette max 16 giorni con AROME/ARPEGE/ICON (in pratica
        // i modelli stessi si fermano prima: AROME HD a 48h, AROME a 42h,
        // ARPEGE a 96h, ICON a 120h). Calcolo i giorni necessari e lascio
        // che l'API tronchi se chiediamo oltre il limite del modello: gli
        // hourly oltre il limite saranno semplicemente null.
        const referenceMs = getReferenceTimeMs();
        const horizonDaysNeeded = Math.ceil(
            (referenceMs - Date.now() + 48 * 3600 * 1000) / (24 * 3600 * 1000)) + 1;
        const forecastDays = Math.max(3, Math.min(16, horizonDaysNeeded));

        const params = new URLSearchParams({
            latitude: lat.toFixed(4),
            longitude: lon.toFixed(4),
            hourly: hourly.join(','),
            // Se model = best_match, NON passo &models, lascio default
            // Altrimenti passo il modello specifico
            wind_speed_unit: 'kn',  // nodi (standard regata)
            timezone: 'auto',
            forecast_days: forecastDays,
        });
        if (prefs.model && prefs.model !== 'best_match') {
            params.set('models', prefs.model);
        }
        return API_BASE_FORECAST + '?' + params.toString();
    }

    function buildMarineUrl(lat, lon, prefs) {
        if (!prefs.vars.wave) return null;
        const hourly = [
            'wave_height',
            'wave_direction',
            'wave_period',
            // Componenti separate (utili per analisi se vogliamo distinguere swell/wind sea)
            'wind_wave_height',
            'swell_wave_height',
        ];
        // Stesso calcolo dinamico di buildForecastUrl
        const referenceMs = getReferenceTimeMs();
        const horizonDaysNeeded = Math.ceil(
            (referenceMs - Date.now() + 48 * 3600 * 1000) / (24 * 3600 * 1000)) + 1;
        const forecastDays = Math.max(3, Math.min(16, horizonDaysNeeded));
        const params = new URLSearchParams({
            latitude: lat.toFixed(4),
            longitude: lon.toFixed(4),
            hourly: hourly.join(','),
            timezone: 'auto',
            forecast_days: forecastDays,
        });
        return API_BASE_MARINE + '?' + params.toString();
    }

    /** Fetch parallelo per un singolo waypoint (atmosfera + mare).
     *  Ritorna { wp, forecast, marine, err } */
    async function fetchWaypointForecast(wp, prefs) {
        const fUrl = buildForecastUrl(wp.lat, wp.lon, prefs);
        const mUrl = buildMarineUrl(wp.lat, wp.lon, prefs);
        try {
            const tasks = [fetch(fUrl).then(r => r.json())];
            if (mUrl) {
                tasks.push(
                    fetch(mUrl).then(r => r.json())
                        .catch(e => {
                            // Marine API puo' fallire se la posizione e' interna
                            // (es. lago non coperto). Gestisco come "no marine data".
                            return null;
                        })
                );
            }
            const results = await Promise.all(tasks);
            return {
                wp: wp,
                forecast: results[0],
                marine: results[1] || null,
                err: null,
            };
        } catch (e) {
            return { wp: wp, forecast: null, marine: null, err: e.message };
        }
    }

    // -------------------------------------------------------------------
    // Estrazione del valore "all'ora T" da una risposta Open-Meteo.
    // L'API ritorna hourly.time = ['2026-05-07T14:00', ...] e per ogni var
    // un array allineato. Trovo l'indice piu' vicino a (now + offsetHours).
    // -------------------------------------------------------------------
    function extractAtOffset(forecast, marine, offsetHours) {
        if (!forecast || !forecast.hourly || !forecast.hourly.time) return null;
        // Usa il reference time (data partenza utente o ora corrente) come
        // base per il calcolo dell'orizzonte +offsetHours.
        const targetMs = getReferenceTimeMs() + offsetHours * 3600 * 1000;
        const times = forecast.hourly.time;
        // Trovo l'indice piu' vicino. I times sono ISO senza Z (timezone=auto),
        // quindi li interpreto come "local time del waypoint" e parsifico.
        let bestIdx = 0;
        let bestDelta = Infinity;
        for (let i = 0; i < times.length; i++) {
            const t = new Date(times[i]).getTime();
            const d = Math.abs(t - targetMs);
            if (d < bestDelta) { bestDelta = d; bestIdx = i; }
        }
        const h = forecast.hourly;
        const out = {
            ts: new Date(times[bestIdx]),
            wind_speed:     pick(h.wind_speed_10m, bestIdx),
            wind_direction: pick(h.wind_direction_10m, bestIdx),
            wind_gusts:     pick(h.wind_gusts_10m, bestIdx),
            precipitation:  pick(h.precipitation, bestIdx),
            precip_prob:    pick(h.precipitation_probability, bestIdx),
            pressure:       pick(h.surface_pressure, bestIdx),
            temperature:    pick(h.temperature_2m, bestIdx),
        };
        // Marine alignment (potrebbe avere times leggermente diversi)
        if (marine && marine.hourly && marine.hourly.time) {
            const mTimes = marine.hourly.time;
            let mIdx = 0, mBestDelta = Infinity;
            for (let i = 0; i < mTimes.length; i++) {
                const t = new Date(mTimes[i]).getTime();
                const d = Math.abs(t - targetMs);
                if (d < mBestDelta) { mBestDelta = d; mIdx = i; }
            }
            out.wave_height    = pick(marine.hourly.wave_height, mIdx);
            out.wave_direction = pick(marine.hourly.wave_direction, mIdx);
            out.wave_period    = pick(marine.hourly.wave_period, mIdx);
        }
        return out;
    }
    function pick(arr, i) {
        if (!arr || !Array.isArray(arr)) return null;
        const v = arr[i];
        return (v == null || !isFinite(v)) ? null : v;
    }

    // -------------------------------------------------------------------
    // Aggregazione "lungo la rotta": media vento e onda di tutti i waypoint
    // a un certo orizzonte. Usa media vettoriale per la direzione (sin/cos)
    // per evitare problema wraparound a 0/360.
    // -------------------------------------------------------------------
    function aggregateAlongRoute(perWaypointAtOffset) {
        let speedSum = 0, speedN = 0;
        let gustMax = 0;
        let waveSum = 0, waveN = 0;
        let precipSum = 0, precipN = 0;
        let dirSinSum = 0, dirCosSum = 0, dirN = 0;
        for (const r of perWaypointAtOffset) {
            if (!r) continue;
            if (r.wind_speed != null) { speedSum += r.wind_speed; speedN++; }
            if (r.wind_gusts != null && r.wind_gusts > gustMax) gustMax = r.wind_gusts;
            if (r.wind_direction != null) {
                const rad = r.wind_direction * Math.PI / 180;
                dirSinSum += Math.sin(rad);
                dirCosSum += Math.cos(rad);
                dirN++;
            }
            if (r.wave_height != null) { waveSum += r.wave_height; waveN++; }
            if (r.precipitation != null) { precipSum += r.precipitation; precipN++; }
        }
        return {
            wind_speed:     speedN > 0 ? speedSum / speedN : null,
            wind_direction: dirN > 0 ?
                ((Math.atan2(dirSinSum, dirCosSum) * 180 / Math.PI) + 360) % 360 : null,
            wind_gusts_max: gustMax > 0 ? gustMax : null,
            wave_height:    waveN > 0 ? waveSum / waveN : null,
            precipitation:  precipN > 0 ? precipSum / precipN : null,
        };
    }

    // -------------------------------------------------------------------
    // MAPPA con WIND BARBS (turno 2)
    //
    // Per ogni waypoint un marker piu' una barba vento ruotata in base alla
    // direzione di provenienza del vento al tempo selezionato dallo slider.
    //
    // Le wind barbs sono disegnate in SVG inline dentro un divIcon Leaflet,
    // perche' Leaflet non supporta direttamente la rotazione dei marker e
    // usare un'immagine raster ruotata via CSS transform funziona ma
    // perdiamo la qualita' alle rotazioni intermedie. SVG si ridisegna
    // sempre nitido.
    // -------------------------------------------------------------------

    /** Genera SVG di una wind barb meteorologica.
     *  twsKn: velocita' in nodi
     *  dirDeg: direzione DA CUI viene il vento (0=N, 90=E)
     *  Convenzione meteorologica: la barba e' "ancorata" al punto e
     *  punta nella direzione DI ARRIVO (cioe' opposta a "da cui viene").
     */
    function buildWindBarbSvg(twsKn, dirDeg) {
        if (twsKn == null || dirDeg == null) {
            return '<svg width="40" height="40" viewBox="-20 -20 40 40">' +
                '<circle r="3" fill="#888"/></svg>';
        }
        // Componenti: triangoli (50kn), barre lunghe (10kn), mezze (5kn)
        const tri = Math.floor(twsKn / 50);
        let rem = twsKn - tri * 50;
        const longBars = Math.floor(rem / 10);
        rem -= longBars * 10;
        const halfBar = rem >= 2.5 ? 1 : 0;  // arrotondo a 5kn

        // Coda della barba: lunga 30, parte da (0,0) e va verso "alto"
        // nella convenzione meteo (asse y verso l'alto). Le tacche vanno
        // sul lato sinistro della coda, una sopra l'altra dalla cima.
        const tailLen = 28;
        const tickLen = 10;
        const tickSpacing = 4;
        let yPos = -tailLen + 2;  // partenza in alto, scende verso 0
        const elements = [];
        // Linea principale
        elements.push(
            `<line x1="0" y1="0" x2="0" y2="${-tailLen}" stroke="#fff" stroke-width="1.5"/>`);
        // Triangoli (se >= 50kn ognuno)
        for (let i = 0; i < tri; i++) {
            const y0 = yPos;
            const y1 = yPos + 6;
            elements.push(
                `<polygon points="0,${y0} ${tickLen},${y0 - 3} 0,${y1}" fill="#fff"/>`);
            yPos = y1 + tickSpacing;
        }
        // Barre lunghe (10kn)
        for (let i = 0; i < longBars; i++) {
            elements.push(
                `<line x1="0" y1="${yPos}" x2="${tickLen}" y2="${yPos - 3}" ` +
                `stroke="#fff" stroke-width="1.5"/>`);
            yPos += tickSpacing;
        }
        // Mezza barra (5kn) - se prima barba della coda, va spostata di poco
        if (halfBar) {
            const y = (tri === 0 && longBars === 0) ? yPos + tickSpacing : yPos;
            const len = tickLen / 2;
            elements.push(
                `<line x1="0" y1="${y}" x2="${len}" y2="${y - 1.5}" ` +
                `stroke="#fff" stroke-width="1.5"/>`);
        }
        // Calma (< 3kn): cerchio
        if (twsKn < 3) {
            elements.length = 0;
            elements.push('<circle r="4" fill="none" stroke="#fff" stroke-width="1.2"/>');
            return '<svg width="40" height="40" viewBox="-20 -20 40 40">' +
                elements.join('') + '</svg>';
        }
        // Color overlay basato su intensita': cambio colore tacche solo
        // se vento forte (>=20kn). Sotto, bianche.
        const color = twsKn >= 25 ? '#ff7050' : (twsKn >= 18 ? '#ffae5c' : '#ffffff');
        const out = elements.join('').replace(/#fff/g, color);

        // Rotazione: il vento DA dirDeg significa che la barba "punta" verso
        // dirDeg (la testa e' a dirDeg, la coda viene dall'opposto). Nello
        // SVG sopra ho disegnato con la coda verso il'alto (-y). Per allinearla
        // con dirDeg = 0 (Nord) la testa deve essere in alto, quindi rotazione
        // 0 va bene. Per dirDeg=90 (Est) ruoto di 90.
        return '<svg width="40" height="40" viewBox="-20 -20 40 40">' +
            '<g transform="rotate(' + dirDeg + ')">' + out + '</g></svg>';
    }

    /** Inizializza la mappa Leaflet alla prima chiamata. */
    function ensureWeatherMap() {
        if (weatherMap) return weatherMap;
        const div = document.getElementById('weather-map');
        if (!div) return null;
        weatherMap = L.map(div, {
            center: [45.7, 12.3],  // default, viene aggiustato a fitBounds dopo
            zoom: 10,
            zoomControl: true,
        });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap',
            maxZoom: 18,
        }).addTo(weatherMap);
        return weatherMap;
    }

    /** Disegna marker waypoint + wind barbs sulla mappa, all'orizzonte
     *  selezionato (in ore da ora). Aggiunto al layer weatherMapBarbs. */
    function drawWindBarbsOnMap(allWaypointForecasts, hourOffset) {
        if (!weatherMap) return;
        // Pulisco layer barbs precedente
        if (weatherMapBarbs) {
            weatherMap.removeLayer(weatherMapBarbs);
        }
        const layerObjs = [];
        const bounds = [];
        // Coordinate per la polyline del percorso (in ordine waypoint)
        const routeLatLngs = [];

        allWaypointForecasts.forEach((r, wpIdx) => {
            const wp = r.wp;
            if (wp.lat == null || wp.lon == null) return;
            bounds.push([wp.lat, wp.lon]);
            routeLatLngs.push([wp.lat, wp.lon]);

            const data = r.forecast ?
                extractAtOffset(r.forecast, r.marine, hourOffset) : null;
            const barbSvg = data ?
                buildWindBarbSvg(data.wind_speed, data.wind_direction) :
                '<svg width="40" height="40" viewBox="-20 -20 40 40">' +
                '<text x="0" y="0" text-anchor="middle" fill="#888" font-size="10">?</text></svg>';
            const tooltipHtml = data ?
                `<strong>${escapeHtml(wp.name)}</strong><br>` +
                `Vento: ${fmtKn(data.wind_speed)} ${dirToCardinal(data.wind_direction)} ${fmtDeg(data.wind_direction)}<br>` +
                `Raffica: ${fmtKn(data.wind_gusts)}` +
                (data.wave_height != null ? `<br>Onda: ${fmtM(data.wave_height)}` : '') :
                `<strong>${escapeHtml(wp.name)}</strong><br><em>Dati non disponibili</em>`;
            const icon = L.divIcon({
                className: 'wind-barb-icon',
                html: barbSvg,
                iconSize: [40, 40],
                iconAnchor: [20, 20],
            });

            // Marker barba: click = highlight riga tabella waypoint
            const barbMarker = L.marker([wp.lat, wp.lon], { icon: icon })
                .bindTooltip(tooltipHtml, { direction: 'top', sticky: true });
            barbMarker.on('click', () => highlightWaypointRow(wpIdx, wp.name));
            layerObjs.push(barbMarker);

            // Punto centrale waypoint, anche lui cliccabile
            const dot = L.circleMarker([wp.lat, wp.lon], {
                radius: 5, color: '#ffae5c', weight: 2, fillColor: '#1a1a1a',
                fillOpacity: 1,
            }).bindTooltip(escapeHtml(wp.name));
            dot.on('click', () => highlightWaypointRow(wpIdx, wp.name));
            layerObjs.push(dot);

            // Etichetta numero/nome waypoint vicino al punto, sempre visibile
            const labelIcon = L.divIcon({
                className: 'weather-wp-label',
                html: '<span>' + escapeHtml(wp.name) + '</span>',
                iconSize: [80, 16],
                iconAnchor: [-8, -10],  // offset a destra+sotto del marker
            });
            layerObjs.push(L.marker([wp.lat, wp.lon], {
                icon: labelIcon,
                interactive: false,
            }));
        });

        // Polyline del percorso (sotto le barbe, sopra le tile): unisce i
        // waypoint in ordine. Bordo bianco semi-trasparente con linea
        // arancione sopra per visibilita' su qualsiasi sfondo mappa.
        if (routeLatLngs.length >= 2) {
            // Sotto: alone bianco
            layerObjs.unshift(L.polyline(routeLatLngs, {
                color: '#ffffff', weight: 6, opacity: 0.4,
            }));
            // Sopra: arancione
            layerObjs.unshift(L.polyline(routeLatLngs, {
                color: '#ff8c42', weight: 3, opacity: 0.95,
                dashArray: '8, 6',
            }));
        }

        weatherMapBarbs = L.layerGroup(layerObjs).addTo(weatherMap);

        // Adatta la vista ai waypoint (solo la prima volta o se cambiano)
        if (bounds.length > 0 && !weatherMapMarkers) {
            try {
                weatherMap.fitBounds(bounds, { padding: [60, 60], maxZoom: 13 });
            } catch (e) { /* singolo punto: ignora */ }
            weatherMapMarkers = true;  // flag: bounds gia' fatti
        }
    }

    /** Click su marker mappa: trova la riga corrispondente nella tabella
     *  waypoint e applica classe .wt-highlight + scroll into view. */
    function highlightWaypointRow(wpIdx, wpName) {
        const tbl = document.getElementById('weather-table');
        if (!tbl) return;
        // Trova le righe (ogni waypoint ha HORIZONS.length righe consecutive
        // nel tbody, la prima ha il rowspan con il nome).
        const tbody = tbl.querySelector('tbody');
        if (!tbody) return;
        const allRows = [...tbody.querySelectorAll('tr')];
        // Pulisco highlight precedenti
        allRows.forEach(tr => tr.classList.remove('wt-highlight'));
        // Identifico le righe del waypoint cliccato: cerco tutte quelle che
        // hanno la cella .wt-wpname con il nome combaciante. Tutte le righe
        // dello stesso waypoint condividono la stessa cella nameCell con
        // rowspan, quindi a partire dalla riga "ancora" trovo le successive
        // entro HORIZONS.length.
        const norm = s => String(s || '').trim().toLowerCase();
        let anchorIdx = -1;
        for (let i = 0; i < allRows.length; i++) {
            const nameCell = allRows[i].querySelector('.wt-wpname');
            if (nameCell && norm(nameCell.textContent) === norm(wpName)) {
                anchorIdx = i;
                break;
            }
        }
        if (anchorIdx === -1) return;
        // Highlight le 4 righe (HORIZONS.length) consecutive
        for (let i = anchorIdx; i < Math.min(anchorIdx + HORIZONS.length, allRows.length); i++) {
            allRows[i].classList.add('wt-highlight');
        }
        // Scroll into view
        allRows[anchorIdx].scrollIntoView({
            behavior: 'smooth', block: 'center',
        });
        // Auto-rimozione dopo 4 secondi
        setTimeout(() => {
            for (let i = anchorIdx; i < Math.min(anchorIdx + HORIZONS.length, allRows.length); i++) {
                if (allRows[i]) allRows[i].classList.remove('wt-highlight');
            }
        }, 4000);
    }

    /** Aggiorna label sotto lo slider con timestamp leggibile. */
    function updateTimeSliderLabel(hOff) {
        const lbl = document.getElementById('weather-time-label');
        const det = document.getElementById('weather-time-detail');
        if (!lbl) return;
        // "Adesso" solo se reference time = ora corrente; altrimenti mostra
        // "Partenza" perche' lo slider si riferisce alla data della regata.
        const isCustomStart = referenceTimeMs != null;
        if (hOff === 0) lbl.textContent = isCustomStart ? 'Partenza' : 'Adesso';
        else            lbl.textContent = '+' + hOff + 'h';
        if (det) {
            const t = new Date(getReferenceTimeMs() + hOff * 3600 * 1000);
            det.textContent = t.toLocaleString('it-IT',
                { weekday: 'short', day: '2-digit', month: 'short',
                  hour: '2-digit', minute: '2-digit' });
        }
    }


    function fmtKn(v)    { return v == null ? '--' : v.toFixed(1) + ' kn'; }
    function fmtDeg(v)   { return v == null ? '--' : v.toFixed(0) + '°'; }
    function fmtM(v)     { return v == null ? '--' : v.toFixed(1) + ' m'; }
    function fmtMm(v)    { return v == null ? '--' : v.toFixed(1) + ' mm'; }
    function fmtPct(v)   { return v == null ? '--' : v.toFixed(0) + '%'; }
    function fmtHpa(v)   { return v == null ? '--' : v.toFixed(0) + ' hPa'; }
    function fmtC(v)     { return v == null ? '--' : v.toFixed(1) + '°C'; }

    /** Da TWS in nodi -> classe CSS Beaufort-like (per colorazione card). */
    function windClass(kn) {
        if (kn == null) return '';
        if (kn < 5)    return 'wind-calm';
        if (kn < 11)   return 'wind-light';   // forza 1-3
        if (kn < 17)   return 'wind-mod';     // forza 4
        if (kn < 22)   return 'wind-fresh';   // forza 5
        if (kn < 28)   return 'wind-strong';  // forza 6
        if (kn < 34)   return 'wind-near-gale'; // forza 7
        return 'wind-gale';                   // forza 8+
    }

    /** Punto cardinale da gradi (0=N). */
    function dirToCardinal(deg) {
        if (deg == null) return '';
        const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE',
                      'S','SSW','SW','WSW','W','WNW','NW','NNW'];
        return dirs[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
    }

    /** Verifica se UNA QUALSIASI metrica supera la soglia. Ritorna true/false.
     *  Usato per colorare card e righe in rosso quando ci sono condizioni
     *  fuori dai limiti accettabili definiti dall'utente. */
    function isAlert(data, thresholds) {
        if (!data || !thresholds) return false;
        if (data.wind_speed != null && data.wind_speed > thresholds.wind) return true;
        if (data.wind_gusts != null && data.wind_gusts > thresholds.gust) return true;
        if (data.wave_height != null && data.wave_height > thresholds.wave) return true;
        if (data.precipitation != null && data.precipitation > thresholds.precip) return true;
        return false;
    }
    /** Aggregato di route (wind_speed, wind_gusts_max, wave_height,
     *  precipitation): adatta isAlert per la struttura aggregata. */
    function isAlertAggregate(agg, thresholds) {
        if (!agg || !thresholds) return false;
        if (agg.wind_speed != null && agg.wind_speed > thresholds.wind) return true;
        if (agg.wind_gusts_max != null && agg.wind_gusts_max > thresholds.gust) return true;
        if (agg.wave_height != null && agg.wave_height > thresholds.wave) return true;
        if (agg.precipitation != null && agg.precipitation > thresholds.precip) return true;
        return false;
    }

    function renderSummaryCards(allWaypointForecasts, prefs) {
        const container = document.getElementById('weather-cards');
        if (!container) return;
        container.innerHTML = '';

        HORIZONS.forEach(hOff => {
            const perWp = allWaypointForecasts.map(r =>
                r.forecast ? extractAtOffset(r.forecast, r.marine, hOff) : null);
            const agg = aggregateAlongRoute(perWp);
            const card = document.createElement('div');
            const alertCls = isAlertAggregate(agg, prefs.thresholds) ? ' alert' : '';
            card.className = 'weather-card ' + windClass(agg.wind_speed) + alertCls;
            const cardTime = new Date(getReferenceTimeMs() + hOff * 3600 * 1000);
            const timeStr = cardTime.toLocaleString('it-IT',
                { weekday: 'short', hour: '2-digit', minute: '2-digit' });
            let bodyParts = [
                '<div class="wc-horizon">+' + hOff + 'h</div>',
                '<div class="wc-time">' + timeStr + '</div>',
                '<div class="wc-arrow" style="transform:rotate(' +
                    ((agg.wind_direction || 0) + 180) + 'deg);">↓</div>',
                '<div class="wc-wind">',
                '  <span class="wc-speed">' + fmtKn(agg.wind_speed) + '</span>',
                '  <span class="wc-dir">' + dirToCardinal(agg.wind_direction) +
                    '  ' + fmtDeg(agg.wind_direction) + '</span>',
                '</div>',
                agg.wind_gusts_max != null ?
                    '<div class="wc-gust">raff. max ' + fmtKn(agg.wind_gusts_max) + '</div>' : '',
            ];
            if (prefs.vars.wave && agg.wave_height != null) {
                bodyParts.push(
                    '<div class="wc-wave">🌊 ' + fmtM(agg.wave_height) + '</div>');
            }
            if (prefs.vars.precip && agg.precipitation != null && agg.precipitation > 0.05) {
                bodyParts.push(
                    '<div class="wc-precip">☔ ' + fmtMm(agg.precipitation) + '</div>');
            }
            // Vele utilizzabili a questo TWS (sail crossover): mostro la lista
            // unica delle vele che compaiono nella riga TWS (per qualsiasi TWA).
            // Cosi' il navigatore vede a colpo d'occhio quale "kit" preparare.
            if (currentPolarLookup && currentPolarLookup.hasSails &&
                agg.wind_speed != null) {
                const sailsAtTws = sailsUsableAtTws(currentPolarLookup, agg.wind_speed);
                if (sailsAtTws.length > 0) {
                    const dotsHtml = sailsAtTws.map(s =>
                        '<span class="wc-sail-dot" style="background:' + s.color + '" ' +
                        'title="' + escapeHtml(s.label) + '"></span>'
                    ).join('');
                    const labelsHtml = sailsAtTws.map(s =>
                        escapeHtml(s.key)).join(', ');
                    bodyParts.push(
                        '<div class="wc-sails" title="' + escapeHtml(
                            sailsAtTws.map(s => s.label).join(' • ')) + '">' +
                        dotsHtml + '<span class="wc-sails-text">' + labelsHtml + '</span></div>');
                }
            }
            card.innerHTML = bodyParts.join('');
            container.appendChild(card);
        });
    }

    /** Lista delle vele uniche che compaiono nella riga TWS della tabella
     *  crossover (snappata al TWS piu' vicino). Ritorna array di {key, label, color}. */
    function sailsUsableAtTws(polarLookup, tws) {
        if (!polarLookup || !polarLookup.sailCrossover) return [];
        // Trovo l'entry con TWS piu' vicino
        let best = null, bd = Infinity;
        for (const e of polarLookup.sailCrossover) {
            const d = Math.abs(e.tws - tws);
            if (d < bd) { bd = d; best = e; }
        }
        if (!best) return [];
        const set = new Set();
        if (best.beatSail) set.add(best.beatSail);
        if (best.runSail)  set.add(best.runSail);
        for (const r of best.numeric) set.add(r.sail);
        const defs = polarLookup.sailDefinitions || {};
        return [...set].map(key => ({
            key: key,
            label: (defs[key] && defs[key].label) || key,
            color: (defs[key] && defs[key].color) || '#888',
        }));
    }

    function renderTable(allWaypointForecasts, prefs) {
        const tbl = document.getElementById('weather-table');
        if (!tbl) return;

        // Header: WP | TWS | TWD | Raff | Onda? | Pioggia? | Press? | Temp?
        const headers = ['Waypoint', '+h', 'Vento', 'Dir', 'Raff'];
        if (prefs.vars.wave)     headers.push('Onda');
        if (prefs.vars.precip)   headers.push('Pioggia');
        if (prefs.vars.pressure) headers.push('Pressione');
        if (prefs.vars.temp)     headers.push('Temp');

        let html = '<thead><tr>';
        headers.forEach(h => { html += '<th>' + h + '</th>'; });
        html += '</tr></thead><tbody>';

        allWaypointForecasts.forEach(r => {
            const wp = r.wp;
            // Per ogni orizzonte, una riga
            HORIZONS.forEach((hOff, i) => {
                const data = r.forecast ?
                    extractAtOffset(r.forecast, r.marine, hOff) : null;
                const wcls = data ? windClass(data.wind_speed) : '';
                const alertCls = isAlert(data, prefs.thresholds) ? ' alert' : '';
                html += '<tr class="' + wcls + alertCls + '">';
                if (i === 0) {
                    html += '<td rowspan="' + HORIZONS.length + '" class="wt-wpname">' +
                        escapeHtml(wp.name) + '</td>';
                }
                html += '<td>+' + hOff + 'h</td>';
                if (data) {
                    html += '<td>' + fmtKn(data.wind_speed) + '</td>';
                    html += '<td>' + dirToCardinal(data.wind_direction) +
                        ' <span class="muted small">' + fmtDeg(data.wind_direction) + '</span></td>';
                    html += '<td>' + fmtKn(data.wind_gusts) + '</td>';
                    if (prefs.vars.wave)
                        html += '<td>' + fmtM(data.wave_height) + '</td>';
                    if (prefs.vars.precip) {
                        const p = data.precip_prob != null ? ' <span class="muted small">(' + fmtPct(data.precip_prob) + ')</span>' : '';
                        html += '<td>' + fmtMm(data.precipitation) + p + '</td>';
                    }
                    if (prefs.vars.pressure)
                        html += '<td>' + fmtHpa(data.pressure) + '</td>';
                    if (prefs.vars.temp)
                        html += '<td>' + fmtC(data.temperature) + '</td>';
                } else {
                    const ncols = headers.length - 2;
                    html += '<td colspan="' + ncols + '" class="muted">--</td>';
                }
                html += '</tr>';
            });
        });
        html += '</tbody>';
        tbl.innerHTML = html;
    }

    /** Meteogram per ogni waypoint: 1 canvas con 3 righe sovrapposte
     *  (vento+raffica, onda, pioggia). Asse x = ore, da +0h a +48h. */
    function renderMeteograms(allWaypointForecasts, prefs) {
        const container = document.getElementById('weather-meteograms');
        if (!container) return;
        container.innerHTML = '';
        // Salvo i risultati per ridisegnare al resize della finestra
        // (la sidebar a destra puo' cambiare la larghezza disponibile e
        // il canvas senza redraw resterebbe della vecchia dimensione).
        container.__meteogramData = { allWaypointForecasts, prefs };

        allWaypointForecasts.forEach(r => {
            if (!r.forecast || !r.forecast.hourly) return;
            const wrap = document.createElement('div');
            wrap.className = 'weather-meteogram';
            wrap.innerHTML =
                '<div class="weather-meteogram-title">' +
                escapeHtml(r.wp.name) +
                '<span class="muted">+0h → +48h</span>' +
                '</div>' +
                '<canvas></canvas>';
            container.appendChild(wrap);
        });

        // Render del canvas dentro RAF: il browser ha bisogno di applicare
        // il layout (flex/grid stabilizzato) prima che clientWidth ritorni
        // un valore corretto. Senza RAF il primo render esce stretto.
        requestAnimationFrame(() => {
            container.querySelectorAll('.weather-meteogram').forEach((wrap, i) => {
                const cv = wrap.querySelector('canvas');
                if (cv && allWaypointForecasts[i]) {
                    drawMeteogram(cv, allWaypointForecasts[i], prefs);
                }
            });
        });

        // Listener resize: ricalcola larghezza canvas se la finestra cambia
        // dimensione. Idempotente: rimuovo eventuale handler precedente.
        if (container.__resizeHandler) {
            window.removeEventListener('resize', container.__resizeHandler);
        }
        container.__resizeHandler = () => {
            // Debounce 200ms per non spammare ridisegno durante drag della finestra
            clearTimeout(container.__resizeTimer);
            container.__resizeTimer = setTimeout(() => {
                const data = container.__meteogramData;
                if (!data) return;
                container.querySelectorAll('.weather-meteogram').forEach((wrap, i) => {
                    const cv = wrap.querySelector('canvas');
                    if (cv && data.allWaypointForecasts[i]) {
                        drawMeteogram(cv, data.allWaypointForecasts[i], data.prefs);
                    }
                });
            }, 200);
        };
        window.addEventListener('resize', container.__resizeHandler);
    }

    /** Disegna 3 sub-chart in un canvas con grafica leggibile. Asse x = 0..48
     *  ore. Hover col mouse mostra cursor verticale + tooltip con i valori. */
    function drawMeteogram(canvas, wpResult, prefs) {
        // Layout: padding sinistro 36px per label Y, dx 8px, alto 6px,
        // basso 18px per asse X. Ogni riga 60px alta + 8px gap.
        const PAD_L = 38, PAD_R = 8, PAD_T = 6, PAD_B = 22;
        const ROW_H = 60, ROW_GAP = 8;
        const N_ROWS = 3;
        const H = PAD_T + N_ROWS * ROW_H + (N_ROWS - 1) * ROW_GAP + PAD_B;
        // Larghezza: prendo quella del parent (.weather-meteogram) menos il
        // padding interno. Se il parent non e' ancora layoutato (clientWidth=0)
        // uso un fallback ragionevole.
        const parent = canvas.parentElement;
        let availableW = parent ? parent.clientWidth - 24 : 0;
        if (availableW < 200) {
            // Parent non ancora dimensionato: provo a salire al container
            // e usare quella larghezza.
            const grand = parent && parent.parentElement;
            availableW = grand ? grand.clientWidth - 32 : 800;
        }
        const W = Math.max(600, availableW);  // minimo 600px per leggibilita'
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(W * dpr);
        canvas.height = Math.floor(H * dpr);
        canvas.style.width = W + 'px';
        canvas.style.height = H + 'px';
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);

        const f = wpResult.forecast.hourly;
        const m = wpResult.marine ? wpResult.marine.hourly : null;
        // startMs = reference time (data partenza utente o ora corrente).
        // Il meteogram parte da qui e mostra le 48 ore successive.
        const startMs = getReferenceTimeMs();
        const times = f.time;
        const N = 49;

        // Trovo nowIdx: il primo indice con times[i] >= startMs.
        // ATTENZIONE: se startMs e' OLTRE l'ultimo times[], il loop non
        // trova nulla e dobbiamo gestirlo come "fuori range modello".
        let nowIdx = -1;
        for (let i = 0; i < times.length; i++) {
            if (new Date(times[i]).getTime() >= startMs) { nowIdx = i; break; }
        }

        // Disegno cornice base anche in caso di errore, cosi' il meteogram
        // non scompare ma mostra un messaggio "fuori range".
        const drawNoData = (msg) => {
            ctx.fillStyle = 'rgba(255,255,255,0.04)';
            ctx.fillRect(0, 0, W, H);
            ctx.fillStyle = 'rgba(255,200,100,0.9)';
            ctx.font = 'bold 11px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(msg, W / 2, H / 2);
            ctx.fillStyle = 'rgba(255,255,255,0.45)';
            ctx.font = '9px sans-serif';
            ctx.fillText('Cambia modello (es. ICON-EU per +120h) o data di partenza',
                W / 2, H / 2 + 18);
        };

        if (nowIdx === -1) {
            drawNoData('Data partenza oltre l\'orizzonte del modello');
            return;
        }
        const endIdx = Math.min(nowIdx + N, times.length);
        const sliceLen = endIdx - nowIdx;
        if (sliceLen < 2) {
            drawNoData('Pochi dati disponibili dopo la data di partenza');
            return;
        }

        const plotW = W - PAD_L - PAD_R;
        const xAt = (i) => PAD_L + (i / (sliceLen - 1)) * plotW;

        // Trovo l'ultimo indice con almeno una serie con dato valido. Se i
        // dati finiscono prima delle 48h (modello non copre), disegno area
        // grigia sulla parte senza dati, cosi' visivamente l'utente capisce.
        let lastDataIdx = -1;
        const hasValid = (idx) => {
            const i = nowIdx + idx;
            if (f.wind_speed_10m && f.wind_speed_10m[i] != null) return true;
            if (f.wind_gusts_10m && f.wind_gusts_10m[i] != null) return true;
            if (m && m.wave_height && m.wave_height[i] != null) return true;
            if (f.precipitation && f.precipitation[i] != null) return true;
            return false;
        };
        for (let i = sliceLen - 1; i >= 0; i--) {
            if (hasValid(i)) { lastDataIdx = i; break; }
        }
        if (lastDataIdx === -1) {
            drawNoData('Nessun dato disponibile per questa data');
            return;
        }

        // 3 righe: vento+raff, onda, pioggia
        const rows = [
            {
                y0: PAD_T,
                label: 'Vento',
                unit: 'kn',
                arrA: f.wind_speed_10m,  colorA: '#7fff5c', labelA: 'TWS',
                arrB: f.wind_gusts_10m,  colorB: '#ffae5c', labelB: 'Raff',
                threshold: prefs.thresholds.wind,
                threshold2: prefs.thresholds.gust,
                yMaxMin: 15,  // anche se vento e' calmo, scala almeno a 15kn
            },
            {
                y0: PAD_T + ROW_H + ROW_GAP,
                label: 'Onda',
                unit: 'm',
                arrA: m ? m.wave_height : null, colorA: '#5cabff', labelA: 'Hs',
                threshold: prefs.thresholds.wave,
                yMaxMin: 1.0,
            },
            {
                y0: PAD_T + 2 * (ROW_H + ROW_GAP),
                label: 'Pioggia',
                unit: 'mm',
                arrA: f.precipitation, colorA: '#5cffd4', labelA: 'mm/h', filled: true,
                threshold: prefs.thresholds.precip,
                yMaxMin: 2.0,
            },
        ];

        // === Grid verticale (ore) di sfondo, una sola volta ===
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 1;
        for (let h = 0; h <= 48; h += 6) {
            const x = PAD_L + (h / 48) * plotW;
            ctx.beginPath();
            ctx.moveTo(x, PAD_T);
            ctx.lineTo(x, H - PAD_B);
            ctx.stroke();
        }

        // Overlay grigio sull'area dopo lastDataIdx (modello non copre):
        // segnala visivamente che oltre certo punto non c'e' previsione.
        // Cosi' l'utente vede chiaramente "qui finisce il modello" invece
        // di linee tagliate misteriosamente.
        if (lastDataIdx < sliceLen - 1) {
            const xCutoff = xAt(lastDataIdx);
            ctx.fillStyle = 'rgba(80,80,80,0.35)';
            ctx.fillRect(xCutoff, PAD_T, (W - PAD_R) - xCutoff,
                H - PAD_B - PAD_T);
            // Linea di demarcazione + label
            ctx.strokeStyle = 'rgba(255,200,100,0.6)';
            ctx.setLineDash([4, 3]);
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(xCutoff, PAD_T); ctx.lineTo(xCutoff, H - PAD_B);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = 'rgba(255,200,100,0.85)';
            ctx.font = '8px sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            // Label "limite modello" piccola, solo se c'e' spazio
            if (W - PAD_R - xCutoff > 60) {
                ctx.fillText('limite modello', xCutoff + 3, PAD_T + 2);
            }
        }

        rows.forEach(row => {
            // Calcola range Y
            let yMax = row.yMaxMin || 1;
            const probe = (arr) => {
                if (!arr) return;
                for (let i = nowIdx; i < endIdx; i++) {
                    const v = arr[i];
                    if (v != null && isFinite(v) && v > yMax) yMax = v;
                }
            };
            probe(row.arrA); probe(row.arrB);
            // Headroom 15%, e arrotondo a numero "bello"
            yMax = niceMax(yMax * 1.15);
            // Considera anche le soglie: se la soglia e' fuori scala, espandi
            if (row.threshold && row.threshold > yMax) yMax = niceMax(row.threshold * 1.15);
            if (row.threshold2 && row.threshold2 > yMax) yMax = niceMax(row.threshold2 * 1.15);

            const yBottom = row.y0 + ROW_H;
            const yPx = (v) => yBottom - (v / yMax) * ROW_H;

            // Sfondo riga
            ctx.fillStyle = 'rgba(255,255,255,0.025)';
            ctx.fillRect(PAD_L, row.y0, plotW, ROW_H);

            // Asse Y: 3 tick (0, mid, max) con label
            ctx.fillStyle = 'rgba(255,255,255,0.45)';
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            const ticks = [0, yMax / 2, yMax];
            ticks.forEach(t => {
                const y = yPx(t);
                // tick line
                ctx.strokeStyle = 'rgba(255,255,255,0.08)';
                ctx.beginPath();
                ctx.moveTo(PAD_L - 3, y); ctx.lineTo(PAD_L, y);
                ctx.stroke();
                // grid line orizzontale leggera
                if (t > 0) {
                    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
                    ctx.beginPath();
                    ctx.moveTo(PAD_L, y); ctx.lineTo(W - PAD_R, y);
                    ctx.stroke();
                }
                // label
                const txt = t === 0 ? '0' : (t < 10 ? t.toFixed(1) : t.toFixed(0));
                ctx.fillStyle = 'rgba(255,255,255,0.45)';
                ctx.fillText(txt, PAD_L - 5, y);
            });

            // Label riga in alto a sinistra (sopra il grafico)
            ctx.fillStyle = 'rgba(255,255,255,0.85)';
            ctx.font = 'bold 10px sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(row.label + ' (' + row.unit + ')', PAD_L + 4, row.y0 + 2);

            // Soglie: linee tratteggiate
            const drawThr = (val, color, dash) => {
                if (val == null || val <= 0 || val >= yMax) return;
                ctx.strokeStyle = color;
                ctx.setLineDash(dash);
                ctx.lineWidth = 1;
                const y = yPx(val);
                ctx.beginPath();
                ctx.moveTo(PAD_L, y); ctx.lineTo(W - PAD_R, y);
                ctx.stroke();
                ctx.setLineDash([]);
                // Mini label "soglia" a destra
                ctx.fillStyle = color;
                ctx.font = '8px sans-serif';
                ctx.textAlign = 'right';
                ctx.textBaseline = 'bottom';
                ctx.fillText(val.toFixed(0), W - PAD_R - 2, y - 1);
            };
            drawThr(row.threshold,  'rgba(224,83,58,0.55)', [3, 3]);
            drawThr(row.threshold2, 'rgba(240,160,60,0.55)', [2, 4]);

            // Plot serie A (filled o linea)
            const drawSeries = (arr, color, filled) => {
                if (!arr) return;
                if (filled) {
                    // Area chiusa per pioggia
                    ctx.fillStyle = color + '40';  // alpha bassa
                    ctx.beginPath();
                    let started = false;
                    for (let i = 0; i < sliceLen; i++) {
                        const v = arr[nowIdx + i];
                        if (v == null) continue;
                        const x = xAt(i);
                        const y = yPx(v);
                        if (!started) { ctx.moveTo(x, yBottom); ctx.lineTo(x, y); started = true; }
                        else ctx.lineTo(x, y);
                    }
                    if (started) {
                        // Chiudi su baseline
                        ctx.lineTo(xAt(sliceLen - 1), yBottom);
                        ctx.closePath();
                        ctx.fill();
                    }
                }
                ctx.strokeStyle = color;
                ctx.lineWidth = 1.6;
                ctx.beginPath();
                let started = false;
                for (let i = 0; i < sliceLen; i++) {
                    const v = arr[nowIdx + i];
                    if (v == null) { started = false; continue; }
                    const x = xAt(i);
                    const y = yPx(v);
                    if (!started) { ctx.moveTo(x, y); started = true; }
                    else ctx.lineTo(x, y);
                }
                ctx.stroke();
            };
            drawSeries(row.arrA, row.colorA, row.filled);
            if (row.arrB) drawSeries(row.arrB, row.colorB, false);
        });

        // === Asse X (in basso): label ore ogni 6h ===
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const xAxisY = H - PAD_B + 4;
        for (let h = 0; h <= 48; h += 6) {
            const x = PAD_L + (h / 48) * plotW;
            ctx.fillText('+' + h + 'h', x, xAxisY);
            // Tick
            ctx.strokeStyle = 'rgba(255,255,255,0.2)';
            ctx.beginPath();
            ctx.moveTo(x, H - PAD_B); ctx.lineTo(x, H - PAD_B + 3);
            ctx.stroke();
        }

        // === Legenda colorata in alto a destra ===
        const legendItems = [
            { color: '#7fff5c', label: 'TWS' },
            { color: '#ffae5c', label: 'Raff' },
            { color: '#5cabff', label: 'Onda' },
            { color: '#5cffd4', label: 'Pioggia' },
        ];
        let legX = W - PAD_R;
        ctx.font = '9px sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'right';
        for (let i = legendItems.length - 1; i >= 0; i--) {
            const it = legendItems[i];
            ctx.fillStyle = 'rgba(255,255,255,0.6)';
            ctx.fillText(it.label, legX, PAD_T + 6);
            const tw = ctx.measureText(it.label).width;
            legX -= tw + 5;
            ctx.fillStyle = it.color;
            ctx.fillRect(legX - 8, PAD_T + 3, 6, 6);
            legX -= 14;
        }

        // === Hover interattivo: cursor verticale + tooltip ===
        // Salvo i dati necessari per il redraw del cursor sul canvas, cosi'
        // non devo riprocessare tutto al move del mouse.
        canvas.__meteogramData = {
            W, H, PAD_L, PAD_R, PAD_T, PAD_B, ROW_H, ROW_GAP,
            sliceLen, nowIdx, times, rows,
            forecast: f, marine: m,
            wpName: wpResult.wp.name,
        };
        attachMeteogramHover(canvas);
    }

    /** Arrotonda un numero a un valore "bello" per la scala Y. */
    function niceMax(v) {
        if (v <= 1) return Math.ceil(v * 10) / 10;
        if (v <= 5) return Math.ceil(v * 2) / 2;
        if (v <= 10) return Math.ceil(v);
        if (v <= 50) return Math.ceil(v / 5) * 5;
        return Math.ceil(v / 10) * 10;
    }

    /** Aggancia handler mousemove al canvas che disegna un cursor verticale
     *  e un tooltip con i valori al tempo sotto il puntatore. Lo overlay e'
     *  un secondo canvas posizionato sopra (assoluto) per non dover ridisegnare
     *  tutto il meteogram a ogni mousemove. */
    function attachMeteogramHover(canvas) {
        // Crea overlay se non esiste gia'
        let ov = canvas.__hoverOverlay;
        if (!ov) {
            ov = document.createElement('canvas');
            ov.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
            const wrap = canvas.parentElement;
            if (wrap.style.position !== 'relative') wrap.style.position = 'relative';
            wrap.appendChild(ov);
            canvas.__hoverOverlay = ov;
        }
        const data = canvas.__meteogramData;
        ov.width = canvas.width;
        ov.height = canvas.height;
        ov.style.width = canvas.style.width;
        ov.style.height = canvas.style.height;
        const ovCtx = ov.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        ovCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const tooltip = ensureMeteogramTooltip();

        canvas.onmousemove = (ev) => {
            const rect = canvas.getBoundingClientRect();
            const px = ev.clientX - rect.left;
            const py = ev.clientY - rect.top;
            // Verifica che il mouse sia nell'area plot
            if (px < data.PAD_L || px > data.W - data.PAD_R ||
                py < data.PAD_T || py > data.H - data.PAD_B) {
                ovCtx.clearRect(0, 0, data.W, data.H);
                tooltip.style.display = 'none';
                return;
            }
            // Indice piu' vicino
            const plotW = data.W - data.PAD_L - data.PAD_R;
            const rel = (px - data.PAD_L) / plotW;
            const i = Math.round(rel * (data.sliceLen - 1));
            const dataIdx = data.nowIdx + i;
            const x = data.PAD_L + (i / (data.sliceLen - 1)) * plotW;

            ovCtx.clearRect(0, 0, data.W, data.H);
            ovCtx.strokeStyle = 'rgba(255,255,255,0.5)';
            ovCtx.lineWidth = 1;
            ovCtx.beginPath();
            ovCtx.moveTo(x, data.PAD_T);
            ovCtx.lineTo(x, data.H - data.PAD_B);
            ovCtx.stroke();

            // Tooltip
            const t = new Date(data.times[dataIdx]);
            const tStr = t.toLocaleString('it-IT',
                { weekday: 'short', day: '2-digit', month: 'short',
                  hour: '2-digit', minute: '2-digit' });
            const f = data.forecast, m = data.marine;
            const lines = [
                '<strong>' + escapeHtml(data.wpName) + '</strong>',
                '<span class="muted">' + tStr + '</span>',
            ];
            const v = (arr, fmt) => {
                if (!arr) return '--';
                const x = arr[dataIdx];
                return x != null ? fmt(x) : '--';
            };
            lines.push('Vento: <strong>' + v(f.wind_speed_10m, x => x.toFixed(1) + ' kn') +
                '</strong> raff. ' + v(f.wind_gusts_10m, x => x.toFixed(1)) + ' kn');
            if (m) lines.push('Onda: <strong>' + v(m.wave_height, x => x.toFixed(1) + ' m') + '</strong>');
            lines.push('Pioggia: <strong>' +
                v(f.precipitation, x => x.toFixed(1) + ' mm') + '</strong>');
            tooltip.innerHTML = lines.join('<br>');
            tooltip.style.display = 'block';
            // Posizione tooltip (vicino al cursore, ma evita di uscire dallo schermo)
            const ttX = ev.clientX + 14;
            const ttY = ev.clientY + 14;
            tooltip.style.left = ttX + 'px';
            tooltip.style.top = ttY + 'px';
        };
        canvas.onmouseleave = () => {
            ovCtx.clearRect(0, 0, data.W, data.H);
            tooltip.style.display = 'none';
        };
    }

    /** Tooltip globale unico, riusato da tutti i meteogram. */
    function ensureMeteogramTooltip() {
        let tt = document.getElementById('meteogram-tooltip');
        if (tt) return tt;
        tt = document.createElement('div');
        tt.id = 'meteogram-tooltip';
        tt.style.cssText = 'position:fixed;display:none;pointer-events:none;' +
            'background:rgba(20,25,40,0.95);color:#fff;padding:6px 10px;' +
            'border-radius:4px;font-size:0.78rem;border:1px solid rgba(255,255,255,0.15);' +
            'z-index:10000;line-height:1.4;white-space:nowrap;';
        document.body.appendChild(tt);
        return tt;
    }

    function renderMeta(allWaypointForecasts) {
        const div = document.getElementById('weather-meta');
        if (!div) return;
        const f = allWaypointForecasts.find(r => r.forecast)?.forecast;
        if (!f) { div.innerHTML = ''; return; }
        const updateInfo = f.generationtime_ms ?
            (f.generationtime_ms.toFixed(0) + ' ms') : '?';
        const modelUsed = (Array.isArray(f.models) && f.models[0]) || f.model || 'auto';
        const tz = f.timezone || '';
        div.innerHTML = `
            <p class="muted small">
                Generato in ${updateInfo}, modello: <strong>${escapeHtml(String(modelUsed))}</strong>,
                fuso: ${escapeHtml(tz)}.
                Aggiornato: ${new Date().toLocaleString('it-IT')}.
                <br>
                Dati: <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a>
                — uso non commerciale, CC-BY 4.0.
            </p>
        `;
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
            '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
        }[c]));
    }

    // -------------------------------------------------------------------
    // Main: refresh
    // -------------------------------------------------------------------
    async function refresh() {
        const sel = document.getElementById('weather-boat-select');
        const btn = document.getElementById('weather-refresh-btn');
        const stat = document.getElementById('weather-status');
        const empty = document.getElementById('weather-empty');
        const content = document.getElementById('weather-content');
        if (!sel || !btn) return;
        const boatId = sel.value;
        if (!boatId) {
            alert('Seleziona prima una barca.');
            return;
        }
        btn.disabled = true;
        const oldLabel = btn.textContent;
        btn.textContent = 'Caricamento…';
        stat.textContent = 'Recupero waypoints…';
        try {
            // 1. Carica waypoints della barca + polare (se disponibile, per
            //    sail crossover sulle cards). Polare e' opzionale: se la
            //    barca non ce l'ha le sezioni "vela" non vengono mostrate.
            const [wpts, polarLookup] = await Promise.all([
                loadWaypointsForBoat(boatId),
                loadPolarLookupForBoat(boatId),
            ]);
            currentBoatId = boatId;
            currentWaypoints = wpts;
            currentPolarLookup = polarLookup;
            if (wpts.length === 0) {
                throw new Error('Nessun waypoint nel file della barca.');
            }
            // 2. Per ogni waypoint, fetch forecast + marine in parallelo
            //    (tutto insieme, Promise.all). Open-Meteo regge una decina di
            //    chiamate simultanee senza problemi.
            stat.textContent = `Recupero meteo per ${wpts.length} waypoint…`;
            const prefs = getPrefs();
            const tasks = wpts.map(wp => fetchWaypointForecast(wp, prefs));
            const results = await Promise.all(tasks);
            const failed = results.filter(r => r.err);
            if (failed.length === results.length) {
                throw new Error('Tutte le chiamate Open-Meteo sono fallite. Errore: ' +
                    failed[0].err);
            }
            lastForecast = results;
            // 3. Render
            renderSummaryCards(results, prefs);
            renderTable(results, prefs);
            renderMeteograms(results, prefs);
            renderMeta(results);
            // Mappa: inizializzo la prima volta + disegno barbe all'orizzonte 0
            ensureWeatherMap();
            // Forzo il fit dei bounds anche se i waypoint sono cambiati rispetto
            // a una sessione precedente (cambio barca)
            weatherMapMarkers = null;
            const slider = document.getElementById('weather-time-slider');
            const initialHour = slider ? parseInt(slider.value, 10) : 0;
            drawWindBarbsOnMap(results, initialHour);
            updateTimeSliderLabel(initialHour);
            // Reflow Leaflet (la mappa potrebbe essere stata creata mentre
            // la schermata era hidden e quindi avere dimensioni 0x0)
            setTimeout(() => { if (weatherMap) weatherMap.invalidateSize(); }, 100);

            empty.style.display = 'none';
            content.style.display = 'block';
            stat.textContent = failed.length > 0 ?
                ('OK (' + failed.length + ' waypoint falliti)') : 'OK';
            // NB: il salvataggio su blob NON parte automatico qui.
            // Per salvare sul blob storage l'utente deve cliccare il bottone
            // "💾 Salva su blob" nella sezione meteo (richiede admin token).
        } catch (e) {
            console.error('Errore refresh meteo:', e);
            alert('Errore caricamento meteo:\n' + e.message);
            stat.textContent = 'Errore';
        } finally {
            btn.disabled = false;
            btn.textContent = oldLabel;
        }
    }

    // -------------------------------------------------------------------
    // Wiring sezione Config (preferenze meteo)
    // -------------------------------------------------------------------
    function loadPrefsIntoConfig() {
        const p = getPrefs();
        // Modello: ora unico, nella sidebar Meteo (id cfg-weather-model)
        const m = document.getElementById('cfg-weather-model');
        if (m) m.value = p.model;
        const setCb = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.checked = !!val;
        };
        setCb('cfg-weather-var-wind', p.vars.wind);
        setCb('cfg-weather-var-wave', p.vars.wave);
        setCb('cfg-weather-var-precip', p.vars.precip);
        setCb('cfg-weather-var-pressure', p.vars.pressure);
        setCb('cfg-weather-var-temp', p.vars.temp);
        // Soglie alert (turno 2)
        const setVal = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.value = val;
        };
        setVal('cfg-weather-thr-wind',   p.thresholds.wind);
        setVal('cfg-weather-thr-gust',   p.thresholds.gust);
        setVal('cfg-weather-thr-wave',   p.thresholds.wave);
        setVal('cfg-weather-thr-precip', p.thresholds.precip);
    }
    function readPrefsFromConfig() {
        const m = document.getElementById('cfg-weather-model');
        const get = id => {
            const el = document.getElementById(id);
            return el ? el.checked : false;
        };
        const getNum = (id, fallback) => {
            const el = document.getElementById(id);
            if (!el) return fallback;
            const n = parseFloat(el.value);
            return isFinite(n) ? n : fallback;
        };
        const def = DEFAULT_PREFS.thresholds;
        // Auto-refresh non ha controllo nell'overlay (e' nel header della
        // schermata Meteo): preservo il valore esistente.
        const cur = getPrefs();
        return {
            model: m ? m.value : DEFAULT_PREFS.model,
            vars: {
                wind:     get('cfg-weather-var-wind'),
                wave:     get('cfg-weather-var-wave'),
                precip:   get('cfg-weather-var-precip'),
                pressure: get('cfg-weather-var-pressure'),
                temp:     get('cfg-weather-var-temp'),
            },
            thresholds: {
                wind:   getNum('cfg-weather-thr-wind',   def.wind),
                gust:   getNum('cfg-weather-thr-gust',   def.gust),
                wave:   getNum('cfg-weather-thr-wave',   def.wave),
                precip: getNum('cfg-weather-thr-precip', def.precip),
            },
            autoRefresh: cur.autoRefresh,
        };
    }

    /** Attiva/disattiva il timer di auto-refresh (30 minuti). */
    function setAutoRefresh(enabled) {
        if (autoRefreshTimer) {
            clearInterval(autoRefreshTimer);
            autoRefreshTimer = null;
        }
        if (enabled) {
            autoRefreshTimer = setInterval(() => {
                // Auto-refresh solo se siamo ancora nella schermata Meteo e
                // c'e' una barca selezionata. Niente fetch silenzioso in
                // background quando l'utente e' altrove.
                const isWeatherActive = window.SailingNav &&
                    window.SailingNav.getCurrent() === 'weather';
                const sel = document.getElementById('weather-boat-select');
                if (isWeatherActive && sel && sel.value) {
                    console.log('[weather] auto-refresh');
                    refresh().catch(e => console.error('Auto-refresh error:', e));
                }
            }, AUTO_REFRESH_INTERVAL_MS);
        }
        // Persisto la scelta nelle prefs
        const p = getPrefs();
        p.autoRefresh = !!enabled;
        savePrefs(p);
    }

    /** Carica jsPDF (lazy) e genera un report PDF della previsione meteo
     *  corrente. Riusa la stessa CDN di analysis-plots.js. */
    function loadJsPdf() {
        if (_jsPdfPromise) return _jsPdfPromise;
        _jsPdfPromise = new Promise((resolve, reject) => {
            if (window.jspdf) { resolve(window.jspdf); return; }
            const s = document.createElement('script');
            s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
            s.onload = () => resolve(window.jspdf);
            s.onerror = () => reject(new Error('Errore caricamento jsPDF'));
            document.head.appendChild(s);
        });
        return _jsPdfPromise;
    }

    async function exportPdf() {
        if (!lastForecast) {
            alert('Carica prima una previsione (Aggiorna previsione).');
            return;
        }
        const btn = document.getElementById('weather-export-pdf');
        if (btn) { btn.disabled = true; btn.textContent = 'Generazione PDF…'; }
        try {
            const jspdf = await loadJsPdf();
            const { jsPDF } = jspdf;
            const doc = new jsPDF({ unit: 'mm', format: 'a4' });
            const prefs = getPrefs();

            // Header
            doc.setFontSize(18);
            doc.setTextColor(20, 30, 50);
            doc.text('Sailing Cloud - Report Meteo', 15, 20);
            doc.setFontSize(10);
            doc.setTextColor(80, 80, 80);
            doc.text('Barca: ' + (currentBoatId || '-'), 15, 27);
            doc.text('Generato: ' + new Date().toLocaleString('it-IT'), 15, 32);
            // Se l'utente ha impostato una data di partenza specifica, indicarla
            // nel report cosi' chi legge sa che gli orizzonti sono relativi
            // a quella, non a "ora corrente".
            if (referenceTimeMs != null) {
                doc.setTextColor(160, 80, 30);  // arancione, evidenza
                doc.text('Partenza: ' + new Date(referenceTimeMs).toLocaleString('it-IT'),
                    15, 37);
                doc.setTextColor(80, 80, 80);
            }

            // Riepilogo lungo la rotta (cards)
            doc.setFontSize(13);
            doc.setTextColor(20, 30, 50);
            doc.text('Riepilogo lungo la rotta', 15, 45);
            let y = 53;
            HORIZONS.forEach(hOff => {
                const perWp = lastForecast.map(r =>
                    r.forecast ? extractAtOffset(r.forecast, r.marine, hOff) : null);
                const agg = aggregateAlongRoute(perWp);
                const alert = isAlertAggregate(agg, prefs.thresholds);
                doc.setFontSize(10);
                doc.setTextColor(alert ? 200 : 40, alert ? 40 : 40, 40);
                doc.text(`+${hOff}h:`, 18, y);
                doc.setTextColor(40, 40, 40);
                doc.text(
                    `${fmtKn(agg.wind_speed)} ${dirToCardinal(agg.wind_direction)} ` +
                    `(${fmtDeg(agg.wind_direction)}), raff. ${fmtKn(agg.wind_gusts_max)}` +
                    (agg.wave_height != null ? `, onda ${fmtM(agg.wave_height)}` : '') +
                    (alert ? '   [ALERT]' : ''),
                    35, y);
                y += 6;
            });

            // Tabella per waypoint
            y += 4;
            doc.setFontSize(13);
            doc.setTextColor(20, 30, 50);
            doc.text('Dettaglio per waypoint', 15, y);
            y += 7;
            doc.setFontSize(8);
            doc.setTextColor(60, 60, 60);
            const cols = [15, 50, 65, 90, 115, 140, 165];
            const headers = ['Waypoint', '+h', 'Vento', 'Dir', 'Raff', 'Onda', 'Pioggia'];
            headers.forEach((h, i) => doc.text(h, cols[i], y));
            y += 1;
            doc.setLineWidth(0.2);
            doc.line(15, y, 195, y);
            y += 4;
            lastForecast.forEach(r => {
                HORIZONS.forEach((hOff, i) => {
                    if (y > 280) { doc.addPage(); y = 20; }
                    const data = r.forecast ?
                        extractAtOffset(r.forecast, r.marine, hOff) : null;
                    if (i === 0) {
                        doc.setTextColor(20, 30, 50);
                        doc.text(String(r.wp.name).substring(0, 18), cols[0], y);
                    }
                    doc.setTextColor(60, 60, 60);
                    doc.text('+' + hOff + 'h', cols[1], y);
                    if (data) {
                        const alert = isAlert(data, prefs.thresholds);
                        if (alert) doc.setTextColor(200, 40, 40);
                        doc.text(fmtKn(data.wind_speed), cols[2], y);
                        doc.text(dirToCardinal(data.wind_direction), cols[3], y);
                        doc.text(fmtKn(data.wind_gusts), cols[4], y);
                        doc.text(fmtM(data.wave_height), cols[5], y);
                        doc.text(fmtMm(data.precipitation), cols[6], y);
                    }
                    y += 5;
                });
                y += 1;
            });

            // Soglie usate
            if (y > 270) { doc.addPage(); y = 20; }
            y += 5;
            doc.setFontSize(9);
            doc.setTextColor(80, 80, 80);
            doc.text(`Soglie alert: vento>${prefs.thresholds.wind}kn  ` +
                `raff>${prefs.thresholds.gust}kn  onda>${prefs.thresholds.wave}m  ` +
                `pioggia>${prefs.thresholds.precip}mm/h`, 15, y);

            // Footer
            const pageCount = doc.internal.getNumberOfPages();
            for (let p = 1; p <= pageCount; p++) {
                doc.setPage(p);
                doc.setFontSize(8);
                doc.setTextColor(120, 120, 120);
                doc.text(
                    'Sailing Cloud Meteo - Open-Meteo - Pag. ' + p + '/' + pageCount,
                    15, 290);
            }
            doc.save('weather-report-' + (currentBoatId || 'session') + '.pdf');
        } catch (e) {
            alert('Errore export PDF: ' + e.message);
            console.error(e);
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '📄 Esporta report PDF'; }
        }
    }

    // -------------------------------------------------------------------
    // SALVA SU BLOB: bottone "Salva su blob (per tablet)"
    //
    // Genera un JSON con summary + dettaglio waypoint e lo carica nel
    // container 'meteo' del blob storage (path: {boat_id}/meteo.json).
    // Dopo l'upload il file e' accessibile pubblicamente come:
    //   https://{account}.blob.core.windows.net/meteo/{boat_id}/meteo.json
    //
    // Workflow:
    //   1. Build oggetto JSON (vedi schema 1.0 documentato)
    //   2. POST al backend /api/boats/{boat_id}/meteo/upload-url -> SAS URL
    //   3. PUT diretto al SAS URL con il body JSON
    // -------------------------------------------------------------------
    /** Costruisce l'oggetto JSON conforme allo schema 1.0 da pubblicare. */
    function buildMeteoJson() {
        if (!lastForecast || !lastForecast.length) return null;
        const prefs = getPrefs();
        const refMs = getReferenceTimeMs();
        const refIso = new Date(refMs).toISOString();
        const now = new Date().toISOString();
        const horizons = [0].concat(HORIZONS);  // [0, 6, 12, 24, 48]

        // Username dell'utente loggato (se SailingAuth disponibile)
        let generatedBy = null;
        try {
            const u = window.SailingAuth && window.SailingAuth.getCurrentUser();
            if (u && u.username) generatedBy = u.username;
        } catch (_) { /* no auth, OK */ }

        // Boat name dal selettore (data-name attribute o fallback all'id)
        let boatName = currentBoatId;
        const sel = document.getElementById('weather-boat-select');
        if (sel) {
            const opt = sel.options[sel.selectedIndex];
            if (opt && opt.text) boatName = opt.text;
        }

        // Helper: costruisce un oggetto forecast-at-offset (campo per riga)
        const buildForecastEntry = (data, hOff) => {
            if (!data) return null;
            const validAtMs = refMs + hOff * 3600 * 1000;
            const entry = {
                horizon_h: hOff,
                valid_at: new Date(validAtMs).toISOString(),
                wind_speed: data.wind_speed != null ? round1(data.wind_speed) : null,
                wind_gusts: data.wind_gusts != null ? round1(data.wind_gusts) : null,
                wind_direction: data.wind_direction != null ? Math.round(data.wind_direction) : null,
                wind_direction_cardinal: data.wind_direction != null ?
                    dirToCardinal(data.wind_direction) : null,
                wave_height: data.wave_height != null ? round1(data.wave_height) : null,
                wave_period: data.wave_period != null ? round1(data.wave_period) : null,
                wave_direction: data.wave_direction != null ?
                    Math.round(data.wave_direction) : null,
                precip: data.precip != null ? round1(data.precip) : null,
                temperature: data.temperature != null ? round1(data.temperature) : null,
                pressure: data.pressure != null ? round1(data.pressure) : null,
            };
            // alert flags
            const isAlert = isAlertSingle(data, prefs.thresholds);
            entry.alert = isAlert.any;
            if (isAlert.any) entry.alert_reasons = isAlert.reasons;
            return entry;
        };

        // === Summary cards (aggregato lungo la rotta) ===
        const summary = HORIZONS.map(hOff => {
            const perWp = lastForecast.map(r =>
                r.forecast ? extractAtOffset(r.forecast, r.marine, hOff) : null);
            const agg = aggregateAlongRoute(perWp);
            const entry = buildForecastEntry(agg, hOff);
            // Per il summary uso la chiave senza wave_period/wave_direction
            // (nell'aggregato direzione onda non e' significativa)
            if (entry) {
                delete entry.wave_period;
                delete entry.wave_direction;
                delete entry.temperature;
                delete entry.pressure;
            }
            return entry;
        }).filter(e => e !== null);

        // === Waypoints con tutti gli orizzonti + serie orarie 48h ===
        // Includo anche le serie orarie complete (time, vento, onde, ecc) cosi'
        // chi legge il JSON puo' ricostruire il meteogram identico a quello
        // visualizzato in UI senza dover rifare le chiamate Open-Meteo.
        const waypoints = lastForecast.map(r => {
            const wp = r.wp;
            const forecasts = horizons.map(hOff => {
                if (!r.forecast) return null;
                const data = extractAtOffset(r.forecast, r.marine, hOff);
                return buildForecastEntry(data, hOff);
            }).filter(e => e !== null);

            // Serie orarie complete (per ricostruire il meteogram)
            const fcH = (r.forecast && r.forecast.hourly) || {};
            const marH = (r.marine && r.marine.hourly) || {};
            const hourly = {
                time:                fcH.time              || [],
                wind_speed_kn:       fcH.wind_speed_10m    || [],
                wind_direction_deg:  fcH.wind_direction_10m || [],
                wind_gusts_kn:       fcH.wind_gusts_10m    || [],
                temperature_c:       fcH.temperature_2m    || [],
                precipitation_mm:    fcH.precipitation     || [],
                pressure_hpa:        fcH.surface_pressure  || [],
                cloud_cover_pct:     fcH.cloud_cover       || [],
                wave_height_m:       marH.wave_height      || [],
                wave_direction_deg:  marH.wave_direction   || [],
                wave_period_s:       marH.wave_period      || [],
            };

            return {
                name: wp.name,
                lat: wp.lat != null ? Number(wp.lat.toFixed(5)) : null,
                lon: wp.lon != null ? Number(wp.lon.toFixed(5)) : null,
                forecasts: forecasts,
                hourly: hourly,
            };
        });

        return {
            schema_version: '1.0',
            meta: {
                boat_id: currentBoatId,
                boat_name: boatName,
                generated_at: now,
                generated_by: generatedBy,
                source: {
                    provider: 'open-meteo',
                    model: prefs.model,
                    wind_unit: 'kn',
                    wave_unit: 'm',
                    precip_unit: 'mm',
                    temperature_unit: 'C',
                    pressure_unit: 'hPa',
                },
                reference_time: refIso,
                reference_time_is_now: referenceTimeMs == null,
                horizons_h: horizons,
            },
            summary: summary,
            waypoints: waypoints,
        };
    }

    /** Round a 1 decimale (per stabilita' numeri JSON). */
    function round1(v) {
        if (v == null || !isFinite(v)) return null;
        return Math.round(v * 10) / 10;
    }

    /** Verifica alert per una singola row (waypoint+orizzonte). Ritorna
     *  {any: bool, reasons: string[]}. Specchio leggero di isAlertAggregate
     *  ma per dato puntuale: necessario perche' isAlertAggregate accetta
     *  l'aggregato e ha logica leggermente diversa. */
    function isAlertSingle(data, thresholds) {
        const reasons = [];
        if (data.wind_speed != null && thresholds.wind > 0 &&
            data.wind_speed >= thresholds.wind) reasons.push('wind');
        if (data.wind_gusts != null && thresholds.gust > 0 &&
            data.wind_gusts >= thresholds.gust) reasons.push('gust');
        if (data.wave_height != null && thresholds.wave > 0 &&
            data.wave_height >= thresholds.wave) reasons.push('wave');
        if (data.precip != null && thresholds.precip > 0 &&
            data.precip >= thresholds.precip) reasons.push('precip');
        return { any: reasons.length > 0, reasons };
    }

    /** Bottone "Salva su blob (per tablet)". */
    async function saveToBlob() {
        const btn = document.getElementById('weather-save-blob');
        const status = document.getElementById('weather-save-blob-status');
        const setStatus = (msg, color) => {
            if (status) {
                status.textContent = msg;
                status.style.color = color || '';
            }
        };

        if (!lastForecast || !lastForecast.length) {
            alert('Carica una previsione prima di salvarla su blob.');
            return;
        }
        if (!currentBoatId) {
            alert('Nessuna barca selezionata.');
            return;
        }

        const json = buildMeteoJson();
        if (!json) {
            alert('Impossibile generare il JSON: dati mancanti.');
            return;
        }

        const apiBase = window.SAILING_API_BASE || '';
        try {
            if (btn) { btn.disabled = true; btn.textContent = '💾 Salvataggio...'; }
            setStatus('Richiesta SAS URL...', '#ffae5c');

            // L'endpoint /meteo/upload-url richiede admin token (Bearer).
            // Verifico che sia presente in localStorage (chiave usata anche
            // dal pannello Config 'sailing_admin_token').
            const adminToken = localStorage.getItem('sailing_admin_token');
            if (!adminToken) {
                throw new Error("Admin token non impostato. Vai su Config (in basso a sinistra), inserisci l'admin token e salva.");
            }

            // Filename dinamico con timestamp UTC: meteo-YYYY-MM-DD-HH-mm.json
            // Cosi' ogni "Salva su blob" produce uno snapshot storico distinto
            // invece di sovrascrivere sempre lo stesso meteo.json.
            const now = new Date();
            const pad = n => String(n).padStart(2, '0');
            const filename = `meteo-${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())}-${pad(now.getUTCHours())}-${pad(now.getUTCMinutes())}.json`;

            // Step 1: ottengo SAS URL dal backend (richiede admin token)
            const sasRes = await SailingAuth.authFetch(
                apiBase + '/api/boats/' + encodeURIComponent(currentBoatId) +
                '/meteo/upload-url?filename=' + encodeURIComponent(filename),
                {
                    method: 'POST',
                    headers: {
                        'Authorization': 'Bearer ' + adminToken,
                        'Content-Type': 'application/json',
                    },
                });
            if (!sasRes.ok) {
                let detail = '';
                try {
                    const err = await sasRes.json();
                    detail = err.detail || '';
                } catch (_) {}
                throw new Error('SAS URL fallita (HTTP ' + sasRes.status +
                    (detail ? ': ' + detail : '') + ')');
            }
            const sasData = await sasRes.json();

            // Step 2: PUT diretto al blob via SAS URL
            setStatus('Upload in corso...', '#ffae5c');
            const body = JSON.stringify(json, null, 2);
            const putRes = await fetch(sasData.upload_url, {
                method: 'PUT',
                headers: sasData.headers || {
                    'x-ms-blob-type': 'BlockBlob',
                    'Content-Type': 'application/json',
                },
                body: body,
            });
            if (!putRes.ok) {
                const txt = await putRes.text().catch(() => '');
                throw new Error('Upload blob fallito (HTTP ' + putRes.status + ')' +
                    (txt ? ': ' + txt.substring(0, 200) : ''));
            }

            // Successo
            const sizeKb = (body.length / 1024).toFixed(1);
            setStatus('✓ Salvato (' + sizeKb + ' KB) - ' +
                new Date().toLocaleTimeString('it-IT'), '#5fb874');
            console.log('[meteo] Salvato su blob:', sasData.blob_url);
        } catch (e) {
            console.error('[meteo] saveToBlob error:', e);
            setStatus('✗ Errore: ' + e.message, '#e0533a');
            alert('Errore salvataggio su blob:\n' + e.message);
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '💾 Salva su blob (per tablet)'; }
        }
    }

    // -------------------------------------------------------------------
    // Init
    // -------------------------------------------------------------------
    function init() {
        if (initDone) return;
        initDone = true;

        // Selettore barca: abilita pulsante refresh quando c'e' una scelta
        const sel = document.getElementById('weather-boat-select');
        const btn = document.getElementById('weather-refresh-btn');
        if (sel && btn) {
            sel.addEventListener('change', () => {
                btn.disabled = !sel.value;
            });
        }
        if (btn) btn.addEventListener('click', refresh);

        // Auto-refresh toggle (turno 2)
        const autoCb = document.getElementById('weather-autorefresh');
        if (autoCb) {
            const p = getPrefs();
            autoCb.checked = !!p.autoRefresh;
            if (p.autoRefresh) setAutoRefresh(true);
            autoCb.addEventListener('change', () => setAutoRefresh(autoCb.checked));
        }

        // Selettore modello in sidebar (id cfg-weather-model). Quando cambia,
        // salva la preferenza e fa refresh automatico se c'e' gia' una
        // previsione caricata (cosi' l'utente vede subito il nuovo modello).
        // Niente piu' duplicato in Config: la sidebar e' l'unica UI per le
        // preferenze meteo.
        const modelSel = document.getElementById('cfg-weather-model');
        if (modelSel) {
            const p = getPrefs();
            modelSel.value = p.model;
            modelSel.addEventListener('change', () => {
                const cur = getPrefs();
                cur.model = modelSel.value;
                savePrefs(cur);
                // Re-fetch automatico se c'e' una barca selezionata
                const boatSel = document.getElementById('weather-boat-select');
                if (boatSel && boatSel.value && lastForecast) {
                    refresh().catch(e => console.error('Refresh dopo cambio modello:', e));
                }
            });
        }

        // Campo data di partenza: input datetime-local. Se settato, le cards
        // +6/+12/+24/+48h, lo slider mappa e i meteogram si riferiscono a
        // quella data. Vuoto = "adesso" (comportamento storico).
        const startInput = document.getElementById('weather-start-time');
        const startClear = document.getElementById('weather-start-clear');
        if (startInput) {
            startInput.addEventListener('change', () => {
                if (!startInput.value) {
                    setReferenceTime(null);
                } else {
                    // datetime-local restituisce stringa ISO senza timezone:
                    // viene interpretata come local time, che e' quello che
                    // vogliamo (l'utente sceglie l'ora locale di partenza).
                    const d = new Date(startInput.value);
                    if (!isNaN(d.getTime())) {
                        // Validazione: data nel passato? Tollero fino a -1h
                        // (utile per piccoli ritardi di compilazione).
                        if (d.getTime() < Date.now() - 3600 * 1000) {
                            alert('La data di partenza e\' nel passato. ' +
                                'Imposta una data futura o lascia vuoto per "adesso".');
                            startInput.value = '';
                            setReferenceTime(null);
                            return;
                        }
                        setReferenceTime(d.getTime());
                    } else {
                        setReferenceTime(null);
                    }
                }
                // Auto-refresh se c'e' gia' una previsione: la nuova data
                // potrebbe richiedere piu' giorni di dati e l'orizzonte
                // dei modelli puo' tagliare. Refresh completo evita confusione.
                if (lastForecast) {
                    refresh().catch(e => console.error('Refresh dopo cambio data partenza:', e));
                }
            });
        }
        if (startClear && startInput) {
            startClear.addEventListener('click', () => {
                startInput.value = '';
                setReferenceTime(null);
                if (lastForecast) {
                    refresh().catch(e => console.error('Refresh dopo reset data:', e));
                }
            });
        }

        // Slider tempo: scrubba 0-48h e ridisegna le barbe
        const slider = document.getElementById('weather-time-slider');
        if (slider) {
            slider.addEventListener('input', () => {
                const h = parseInt(slider.value, 10);
                updateTimeSliderLabel(h);
                if (lastForecast) drawWindBarbsOnMap(lastForecast, h);
            });
        }

        // Bottone export PDF
        const pdfBtn = document.getElementById('weather-export-pdf');
        if (pdfBtn) pdfBtn.addEventListener('click', exportPdf);

        // Bottone Salva su blob (genera JSON e fa upload via SAS URL).
        // Vedi saveToBlob() per i dettagli.
        const saveBlobBtn = document.getElementById('weather-save-blob');
        if (saveBlobBtn) saveBlobBtn.addEventListener('click', saveToBlob);

        // Wiring config (i pulsanti potrebbero non esistere ancora se l'overlay
        // config viene popolato dopo, quindi uso delegation idempotente)
        const saveBtn = document.getElementById('cfg-weather-save');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                savePrefs(readPrefsFromConfig());
                alert('Preferenze meteo salvate in questo browser.');
            });
        }
        const resetBtn = document.getElementById('cfg-weather-reset');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                savePrefs(JSON.parse(JSON.stringify(DEFAULT_PREFS)));
                loadPrefsIntoConfig();
            });
        }

        loadBoats();
        loadPrefsIntoConfig();
    }

    // Lazy-init quando si entra nella schermata
    window.addEventListener('screenChanged', (e) => {
        if (e.detail.name === 'weather') {
            init();
            loadBoats();  // refresh idempotente
            loadPrefsIntoConfig();  // potrebbero essere cambiate dall'overlay
            // Reflow Leaflet se la mappa esiste gia' (cambio schermata)
            setTimeout(() => { if (weatherMap) weatherMap.invalidateSize(); }, 100);
        }
    });

    // -------------------------------------------------------------------
    // SALVATAGGIO SNAPSHOT METEO SU BLOB STORAGE
    // -------------------------------------------------------------------
    // Quando l'utente clicca "Aggiorna previsione" e il fetch completa,
    // serializzo i dati meteo in JSON e li salvo nel container 'meteo' del
    // blob storage azure. Il path e':
    //
    //     <boat_id>/meteo-<YYYY-MM-DD-HH-mm>.json
    //
    // (es. soar/meteo-2026-05-09-12-00.json)
    //
    // Lo snapshot include:
    //  - metadata: barca, timestamp, departure date, prefs di soglie
    //  - summary: cards orizzonti +6/+12/+24/+48 (analoghe a quelle UI)
    //  - waypoints[]: per ciascun WP -> dettaglio con array forecast orari
    //                (= dati che alimentano i meteogrammi)
    //
    // Richiede: admin token in localStorage('sailing_admin_token').
    // Senza admin token salta silenziosamente (non blocca il rendering UI).

    function buildMeteoSnapshotPayload(boatId, allWpForecasts, prefs, waypoints) {
        // Trovo data primo orario (per metadata "from")
        const firstFc = allWpForecasts.find(r => r.forecast)?.forecast;
        const generatedAt = new Date().toISOString();
        const fromTime = firstFc?.hourly?.time?.[0] || null;
        const lastTime = firstFc?.hourly?.time?.slice(-1)[0] || null;

        // Per ogni waypoint, costruisco il dettaglio:
        //  - meta WP (name, lat, lon)
        //  - hourly arrays (time, wind_speed, wind_direction, gust, wave, temp, precip)
        //    cosi' chi legge il JSON puo' ricostruire meteogram + tabella
        const waypointsPayload = allWpForecasts.map((r, i) => {
            const wp = waypoints[i] || {};
            const fc = r.forecast || {};
            const mar = r.marine || {};
            const h = fc.hourly || {};
            const m = mar.hourly || {};
            return {
                index: i,
                name: wp.name || ('WP-' + i),
                lat: wp.lat,
                lon: wp.lon,
                error: r.err || null,
                hourly: {
                    time:                h.time             || [],
                    wind_speed_kn:       h.wind_speed_10m   || [],
                    wind_direction_deg:  h.wind_direction_10m || [],
                    wind_gusts_kn:       h.wind_gusts_10m   || [],
                    temperature_c:       h.temperature_2m   || [],
                    precipitation_mm:    h.precipitation    || [],
                    pressure_hpa:        h.surface_pressure || [],
                    cloud_cover_pct:     h.cloud_cover      || [],
                    wave_height_m:       m.wave_height      || [],
                    wave_direction_deg:  m.wave_direction   || [],
                },
                summary_horizons: prefs ? buildHorizonSummaryForWp(r, prefs) : null,
            };
        });

        // Riepilogo aggregato lungo la rotta (uguale alle cards in UI)
        const HORIZONS = [6, 12, 24, 48];
        const summaryAlongRoute = HORIZONS.map(h => {
            const perWp = allWpForecasts.map(r => extractAtHorizon(r, h)).filter(x => x);
            if (perWp.length === 0) return { horizon_h: h, count: 0 };
            const winds = perWp.map(x => x.wind_speed_kn).filter(v => v != null);
            const gusts = perWp.map(x => x.wind_gusts_kn).filter(v => v != null);
            const waves = perWp.map(x => x.wave_height_m).filter(v => v != null);
            return {
                horizon_h: h,
                count: perWp.length,
                wind_speed_kn: { avg: avg(winds), max: Math.max(...winds), min: Math.min(...winds) },
                wind_gusts_kn: gusts.length ? { avg: avg(gusts), max: Math.max(...gusts) } : null,
                wave_height_m: waves.length ? { avg: avg(waves), max: Math.max(...waves) } : null,
            };
        });

        return {
            schema_version: "1.0",
            boat_id: boatId,
            generated_at: generatedAt,
            forecast_window: {
                from: fromTime,
                to: lastTime,
            },
            prefs: prefs || null,
            summary_along_route: summaryAlongRoute,
            waypoints: waypointsPayload,
        };
    }

    // Helper: estrae i valori chiave a un orizzonte temporale (h ore da ora)
    function extractAtHorizon(forecastRes, hoursAhead) {
        if (!forecastRes || !forecastRes.forecast || !forecastRes.forecast.hourly) return null;
        const h = forecastRes.forecast.hourly;
        const m = (forecastRes.marine && forecastRes.marine.hourly) || {};
        // Trovo l'indice piu' vicino a now + hoursAhead
        const target = Date.now() + hoursAhead * 3600 * 1000;
        const times = h.time || [];
        let bestIdx = 0, bestDiff = Infinity;
        for (let i = 0; i < times.length; i++) {
            const t = new Date(times[i]).getTime();
            const d = Math.abs(t - target);
            if (d < bestDiff) { bestDiff = d; bestIdx = i; }
        }
        if (bestDiff > 4 * 3600 * 1000) return null;  // troppo lontano
        return {
            time: times[bestIdx],
            wind_speed_kn:      h.wind_speed_10m?.[bestIdx],
            wind_direction_deg: h.wind_direction_10m?.[bestIdx],
            wind_gusts_kn:      h.wind_gusts_10m?.[bestIdx],
            wave_height_m:      m.wave_height?.[bestIdx],
            precipitation_mm:   h.precipitation?.[bestIdx],
        };
    }

    function buildHorizonSummaryForWp(forecastRes, prefs) {
        const HORIZONS = [6, 12, 24, 48];
        return HORIZONS.map(h => {
            const v = extractAtHorizon(forecastRes, h);
            if (!v) return { horizon_h: h, available: false };
            return Object.assign({ horizon_h: h, available: true }, v);
        });
    }

    function avg(arr) {
        if (!arr || arr.length === 0) return null;
        return arr.reduce((a, b) => a + b, 0) / arr.length;
    }

    /** Genera il filename per lo snapshot in formato:
     *  meteo-YYYY-MM-DD-HH-mm.json
     *  Tutto in UTC per consistenza con generated_at del payload. */
    function buildMeteoSnapshotFilename() {
        const d = new Date();
        const pad = n => String(n).padStart(2, '0');
        const y = d.getUTCFullYear();
        const M = pad(d.getUTCMonth() + 1);
        const D = pad(d.getUTCDate());
        const H = pad(d.getUTCHours());
        const m = pad(d.getUTCMinutes());
        return `meteo-${y}-${M}-${D}-${H}-${m}.json`;
    }

    /** Salva lo snapshot meteo su blob. Workflow:
     *  1. Verifica admin token in localStorage (key: 'sailing_admin_token')
     *  2. POST /api/boats/{id}/meteo/upload-url?filename=...
     *     -> ottiene SAS URL temporanea (10 min)
     *  3. PUT del JSON al SAS URL con header x-ms-blob-type: BlockBlob
     *  4. Aggiorna lo status in UI con link al blob_url pubblico
     *
     *  Errori non bloccanti: se manca admin token o backend ko, log+warning
     *  ma la UI meteo resta visibile e funzionante. */
    async function saveMeteoSnapshotToBlob(boatId, allWpForecasts, prefs, waypoints) {
        const adminToken = localStorage.getItem('sailing_admin_token');
        if (!adminToken) {
            console.log('[weather] No admin token in localStorage; skip blob save');
            return;
        }

        const stat = document.getElementById('weather-status');
        const oldStatus = stat ? stat.textContent : '';

        // 1. Build payload
        const payload = buildMeteoSnapshotPayload(boatId, allWpForecasts, prefs, waypoints);
        const filename = buildMeteoSnapshotFilename();
        const jsonText = JSON.stringify(payload, null, 2);
        const sizeKB = (new Blob([jsonText]).size / 1024).toFixed(1);
        console.log(`[weather] Saving meteo snapshot: ${filename} (${sizeKB} KB)`);
        if (stat) stat.textContent = oldStatus + ' · salvataggio blob…';

        // 2. POST /api/.../meteo/upload-url -> SAS URL
        const sasRes = await SailingAuth.authFetch(
            `/api/boats/${encodeURIComponent(boatId)}/meteo/upload-url?filename=${encodeURIComponent(filename)}`,
            {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + adminToken,
                    'Content-Type': 'application/json',
                },
            }
        );
        if (!sasRes.ok) {
            const errText = await sasRes.text().catch(() => '');
            throw new Error(`SAS request failed: HTTP ${sasRes.status} ${errText.substring(0, 200)}`);
        }
        const sasInfo = await sasRes.json();

        // 3. PUT al SAS URL con il JSON
        const putRes = await fetch(sasInfo.upload_url, {
            method: 'PUT',
            headers: sasInfo.headers || {
                'x-ms-blob-type': 'BlockBlob',
                'Content-Type': 'application/json',
            },
            body: jsonText,
        });
        if (!putRes.ok) {
            const errText = await putRes.text().catch(() => '');
            throw new Error(`Blob upload failed: HTTP ${putRes.status} ${errText.substring(0, 200)}`);
        }

        // 4. UI feedback
        console.log(`[weather] Meteo snapshot saved: ${sasInfo.blob_url}`);
        if (stat) {
            const dt = new Date().toLocaleTimeString();
            stat.textContent = `${oldStatus} · salvato su blob ${dt}`;
        }
    }


    // Espongo per chiamate esterne
    window.SailingWeather = {
        refresh: refresh,
        getPrefs: getPrefs,
        savePrefs: savePrefs,
        getLastForecast: () => lastForecast,
        getCurrentWaypoints: () => currentWaypoints,
    };
})();
