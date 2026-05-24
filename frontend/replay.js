/**
 * Sailing Cloud - Modulo Replay (analisi posteriore da file CSV)
 *
 * Carica un file CSV di traccia, lo parsa e permette scrubbing/animazione
 * della rotta sulla mappa + grafici e analisi tattica.
 *
 * Formati CSV supportati (auto-rilevati dall'header, case-insensitive):
 *
 * 1) Formato palmare (12 colonne, minuscole):
 *      ts_iso, lat, lon, sog_kn, cog, hdg,
 *      tws_kn, twa, aws_kn, awa, vmg_kn, depth_m
 *
 * 2) Formato app Android v1.5+ (20 colonne, CamelCase):
 *      Timestamp, Lat, Lon, SOG_kn, COG_deg, HDG_deg,
 *      STW_kn, TARGET_kn, VMG_kn,
 *      TWS_kn, TWA_deg, TWD_deg, AWS_kn, AWA_deg, Depth_m,
 *      BRG_mark_deg, DIST_mark_NM, ETA_mark_min,
 *      TacticalAdvice, Shift_deg
 *
 * Le colonne assenti vengono nullate, e dove possibile ricostruite:
 *   - TWD = HDG + TWA mod 360 (se TWD manca ma c'e' HDG+TWA)
 *   - STW = SOG (fallback ragionevole in assenza di corrente)
 *   - VMG = STW * cos(TWA) (formula standard)
 *
 * Le analisi che richiedono campi davvero mancanti (es. TacticalAdvice
 * per i suggerimenti tattici live) vengono semplicemente saltate.
 */

(function() {
    const API_BASE = window.SAILING_API_BASE ?? 'http://localhost:8000';

    const state = {
        points: [],
        currentIdx: 0,
        playing: false,
        playTimer: null,
        playSpeed: 5,
        fileName: null,
        analysis: null,        // popolato da SailingAnalysis.buildAnalysis()
        // Plot instances (turno 2)
        polarPlot: null,       // SailingPlots.makePolarPlot
        stripChart: null,      // SailingPlots.makeStripChart
        windRose: null,
        heatmap: null,
        // Overlay sulla mappa
        liftHeaderArr: null,   // array 'lift'/'header'/'neutral' per ogni punto
        liftHeaderLayer: null, // L.LayerGroup
        laylineLayer: null,    // L.LayerGroup
        markRoundingsLayer: null, // L.LayerGroup
    };

    let replayMap, replayTrackLayer, replayBoatMarker, replayHeadingArrow,
        replayMarkBoaMarker;

    // Mappa dei campi: per ciascun campo "logico" (chiave) elenco tutti gli
    // alias di header CSV accettati, in ordine di preferenza. Il match e'
    // case-insensitive. Cosi' supportiamo SIA il formato vecchio del palmare
    // a 20 colonne (Timestamp, Lat, SOG_kn, ...) SIA il nuovo formato a 12
    // colonne (ts_iso, lat, sog_kn, ...).
    const COLUMN_ALIASES = {
        ts:       ['Timestamp', 'ts_iso', 'ts', 'timestamp', 'time', 'datetime'],
        lat:      ['Lat', 'lat', 'latitude'],
        lon:      ['Lon', 'lon', 'longitude', 'lng'],
        sog:      ['SOG_kn', 'sog_kn', 'sog', 'speed'],
        cog:      ['COG_deg', 'cog', 'cog_deg', 'course'],
        hdg:      ['HDG_deg', 'hdg', 'hdg_deg', 'heading'],
        stw:      ['STW_kn', 'stw_kn', 'stw'],
        target:   ['TARGET_kn', 'target_kn', 'target'],
        vmg:      ['VMG_kn', 'vmg_kn', 'vmg'],
        tws:      ['TWS_kn', 'tws_kn', 'tws'],
        twa:      ['TWA_deg', 'twa', 'twa_deg'],
        twd:      ['TWD_deg', 'twd', 'twd_deg'],
        aws:      ['AWS_kn', 'aws_kn', 'aws'],
        awa:      ['AWA_deg', 'awa', 'awa_deg'],
        depth:    ['Depth_m', 'depth_m', 'depth'],
        markBrg:  ['BRG_mark_deg', 'brg_mark', 'brg_mark_deg'],
        markDist: ['DIST_mark_NM', 'dist_mark', 'dist_mark_nm'],
        markEta:  ['ETA_mark_min', 'eta_mark', 'eta_mark_min'],
        advice:   ['TacticalAdvice', 'tactical_advice', 'advice'],
        shift:    ['Shift_deg', 'shift', 'shift_deg'],
    };

    // Campi OBBLIGATORI per poter usare il replay: senza questi non riusciamo
    // a fare nulla di utile (mappa, time-series, leg detection).
    const ESSENTIAL_FIELDS = ['ts', 'lat', 'lon'];

    /** Trova l'indice della colonna in 'header' che matcha uno qualsiasi
     *  degli alias passati (case-insensitive). Ritorna -1 se nessun match. */
    function findColIdx(header, aliases) {
        const headerLc = header.map(h => h.toLowerCase());
        for (const alias of aliases) {
            const i = headerLc.indexOf(alias.toLowerCase());
            if (i !== -1) return i;
        }
        return -1;
    }

    /** Normalizza un angolo a [0,360). */
    function norm360(deg) {
        if (deg == null || !isFinite(deg)) return null;
        let d = deg % 360;
        if (d < 0) d += 360;
        return d;
    }

    function parseCSV(text) {
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        if (lines.length < 2) throw new Error('File CSV vuoto o senza dati');
        const header = lines[0].split(',').map(s => s.trim());

        // Costruisco una mappa logical_field -> column_index (o -1 se manca)
        const idx = {};
        for (const field of Object.keys(COLUMN_ALIASES)) {
            idx[field] = findColIdx(header, COLUMN_ALIASES[field]);
        }

        // Verifico SOLO i campi essenziali. Tutti gli altri possono mancare:
        // riempiamo con null e le analisi che ne hanno bisogno semplicemente
        // saranno skippate o ridotte.
        const missing = ESSENTIAL_FIELDS.filter(f => idx[f] === -1);
        if (missing.length > 0) {
            const missingAliases = missing.map(f =>
                f + ' (es: ' + COLUMN_ALIASES[f].slice(0, 3).join(' / ') + ')'
            );
            throw new Error(
                'Colonne essenziali mancanti nel CSV:\n' + missingAliases.join('\n') +
                '\n\nIl CSV deve contenere almeno timestamp, latitudine e longitudine.\n' +
                'Header rilevato: ' + header.join(', ')
            );
        }

        // Log diagnostico (utile in console del browser)
        const found = Object.keys(idx).filter(k => idx[k] !== -1);
        const notFound = Object.keys(idx).filter(k => idx[k] === -1);
        console.log('[replay] CSV header rilevato:', header.length, 'colonne');
        console.log('[replay] Campi trovati:', found.join(', '));
        if (notFound.length > 0) {
            console.log('[replay] Campi MANCANTI (saranno null):', notFound.join(', '));
        }

        const points = [];
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',');
            // Skip righe con troppo poche colonne rispetto all'header
            if (cols.length < 3) continue;

            // Timestamp: gestisco anche formati senza timezone (es. "2026-05-24T11:00:22")
            const tsStr = cols[idx.ts];
            const ts = new Date(tsStr);
            if (isNaN(ts.getTime())) continue;

            const lat = parseFloat(cols[idx.lat]);
            const lon = parseFloat(cols[idx.lon]);
            if (!isFinite(lat) || !isFinite(lon)) continue;

            // get(field) -> valore della colonna se l'idx esiste, altrimenti null
            const get = (field) =>
                idx[field] !== -1 ? parseNum(cols[idx[field]]) : null;
            const getStr = (field) => {
                if (idx[field] === -1) return null;
                const v = (cols[idx[field]] || '').trim();
                return v || null;
            };

            // Campi base
            const hdg = get('hdg');
            const cog = get('cog');
            const twa = get('twa');
            let twd = get('twd');

            // Se TWD manca ma abbiamo TWA + (HDG o COG), lo calcolo.
            // Formula: TWD = HDG + TWA (con normalizzazione 0..360).
            // (TWA e' relativo alla prua, positivo a destra: vento da destra
            // = TWA > 0; somma HDG porta in coord. assolute.)
            if (twd == null && twa != null) {
                const ref = hdg != null ? hdg : cog;
                if (ref != null) twd = norm360(ref + twa);
            }

            // STW (Speed Through Water) fallback: se manca, uso SOG.
            // In assenza di corrente STW == SOG; in mare aperto la
            // differenza e' tipicamente piccola (<0.5 kn). Importante per
            // far funzionare polar lookup, polarPct, manovre ranking, ecc.
            let stw = get('stw');
            const sog = get('sog');
            if (stw == null && sog != null) stw = sog;

            // VMG fallback: se manca, lo calcolo come STW * cos(TWA).
            // E' la velocita' utile verso/contro vento (positivo in bolina,
            // negativo in poppa). Cosi' grafici e ranking VMG funzionano
            // anche se la colonna VMG nel CSV e' vuota (caso palmare).
            let vmg = get('vmg');
            if (vmg == null && stw != null && twa != null) {
                vmg = stw * Math.cos(twa * Math.PI / 180);
            }

            points.push({
                ts: ts,
                lat: lat,
                lon: lon,
                sog:    sog,
                cog:    cog,
                hdg:    hdg,
                stw:    stw,
                target: get('target'),
                vmg:    vmg,
                tws:    get('tws'),
                twa:    twa,
                twd:    twd,
                aws:    get('aws'),
                awa:    get('awa'),
                depth:  get('depth'),
                markBrg:  get('markBrg'),
                markDist: get('markDist'),
                markEta:  get('markEta'),
                advice:   getStr('advice'),
                shift:    get('shift'),
            });
        }
        if (points.length === 0) throw new Error('Nessuna riga con dati validi nel CSV');
        return points;
    }


    function parseNum(s) {
        if (s === undefined || s === '') return null;
        const v = parseFloat(s);
        return isFinite(v) ? v : null;
    }

    function ensureMap() {
        if (replayMap) return;
        replayMap = L.map('replay-map', {
            zoomControl: true,
        }).setView([45.6, 12.4], 11);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '© OpenStreetMap'
        }).addTo(replayMap);
        replayTrackLayer = L.layerGroup().addTo(replayMap);
    }

    function drawFullTrack() {
        replayTrackLayer.clearLayers();
        const validPts = state.points.filter(p => p.lat != null && p.lon != null);
        if (validPts.length === 0) return;

        const latlngs = validPts.map(p => [p.lat, p.lon]);

        // Sail-coloring: se l'analisi corrente ha lookupSail, segmento la
        // traccia per "vela suggerita" e disegno ogni run con il colore
        // della vela. Altrimenti polyline arancione tradizionale.
        const pl = state.analysis && state.analysis.polarLookup;
        const useSailColors = pl && pl.hasSails && pl.lookupSail;

        if (useSailColors) {
            // Per ogni punto valido determino la vela. Raggruppo run consecutivi
            // con la stessa vela e li disegno come polyline separate.
            let runStart = 0;
            let currentSail = sailKeyAt(validPts[0], pl);
            for (let i = 1; i <= validPts.length; i++) {
                const sailHere = i < validPts.length ? sailKeyAt(validPts[i], pl) : null;
                if (i === validPts.length || sailHere !== currentSail) {
                    // Chiudo il run [runStart..i-1]
                    const segLatlngs = latlngs.slice(runStart, i);
                    if (segLatlngs.length >= 2) {
                        // Aggiungo il primo punto del run successivo per evitare
                        // "buchi" tra segmenti (la polyline collega i punti)
                        if (i < validPts.length) segLatlngs.push(latlngs[i]);
                        const color = sailColorFor(pl, currentSail) || '#C55A11';
                        L.polyline(segLatlngs, { color: color, weight: 4, opacity: 0.9 })
                            .bindTooltip(sailLabelFor(pl, currentSail) || 'Traccia',
                                { sticky: true })
                            .addTo(replayTrackLayer);
                    }
                    runStart = i;
                    currentSail = sailHere;
                }
            }
        } else {
            L.polyline(latlngs, { color: '#C55A11', weight: 3, opacity: 0.8 })
                .addTo(replayTrackLayer);
        }

        const start = validPts[0], end = validPts[validPts.length - 1];
        L.circleMarker([start.lat, start.lon], {
            radius: 8, color: '#ffffff', fillColor: '#00ff88',
            fillOpacity: 1, weight: 2,
        }).bindTooltip('Partenza').addTo(replayTrackLayer);

        L.circleMarker([end.lat, end.lon], {
            radius: 8, color: '#ffffff', fillColor: '#ff4444',
            fillOpacity: 1, weight: 2,
        }).bindTooltip('Arrivo').addTo(replayTrackLayer);

        const bounds = L.latLngBounds(latlngs);
        replayMap.fitBounds(bounds, { padding: [40, 40] });
    }

    /** Helpers per il sail-coloring della traccia. */
    function sailKeyAt(point, polarLookup) {
        if (!polarLookup || !polarLookup.lookupSail) return null;
        if (point.tws == null || point.twa == null) return null;
        const s = polarLookup.lookupSail(point.tws, point.twa);
        return s ? s.key : null;
    }
    function sailColorFor(polarLookup, key) {
        if (!key || !polarLookup || !polarLookup.sailDefinitions) return null;
        const d = polarLookup.sailDefinitions[key];
        return d ? d.color : null;
    }
    function sailLabelFor(polarLookup, key) {
        if (!key || !polarLookup || !polarLookup.sailDefinitions) return null;
        const d = polarLookup.sailDefinitions[key];
        return d ? d.label : key;
    }

    function updateBoatPosition() {
        const p = state.points[state.currentIdx];
        if (!p) return;

        if (replayBoatMarker)    replayMap.removeLayer(replayBoatMarker);
        if (replayHeadingArrow)  replayMap.removeLayer(replayHeadingArrow);
        if (replayMarkBoaMarker) replayMap.removeLayer(replayMarkBoaMarker);

        if (p.lat == null || p.lon == null) return;
        const ll = [p.lat, p.lon];

        // Cerchio barca colorato secondo l'advice tattico al momento
        const fillColor = adviceColor(p.advice);
        replayBoatMarker = L.circleMarker(ll, {
            radius: 9, color: '#ffffff', fillColor: fillColor,
            fillOpacity: 1, weight: 3,
        }).addTo(replayMap);
        replayBoatMarker.bindTooltip(formatTooltip(p));

        if (p.hdg != null) {
            const arrowEnd = projectFromLatLng(ll, p.hdg, 0.0008);
            replayHeadingArrow = L.polyline([ll, arrowEnd], {
                color: '#ffffff', weight: 3, opacity: 0.9,
            }).addTo(replayMap);
        }

        // Boa target se presente
        if (p.markDist != null && p.markBrg != null && p.markDist > 0) {
            const distDeg = (p.markDist / 60) * 1.0;
            const boaLatLng = projectFromLatLng(ll, p.markBrg, distDeg);
            replayMarkBoaMarker = L.marker(boaLatLng, {
                icon: L.divIcon({
                    className: 'replay-boa-marker',
                    html: '🟡',
                    iconSize: [24, 24],
                })
            }).addTo(replayMap);
            replayMarkBoaMarker.bindTooltip(`Boa<br>DIST ${p.markDist.toFixed(2)} NM`);
        }
    }

    function adviceColor(advice) {
        switch (advice) {
            case 'LATO BUONO': return '#00ff88';
            case 'VIRA':       return '#C55A11';
            case 'LAYLINE':    return '#ffeb3b';
            case 'OK':         return '#1B3A6B';
            default:           return '#1B3A6B';
        }
    }

    function projectFromLatLng(latlng, bearingDeg, distanceDeg) {
        const rad = bearingDeg * Math.PI / 180;
        return [
            latlng[0] + Math.cos(rad) * distanceDeg,
            latlng[1] + Math.sin(rad) * distanceDeg / Math.cos(latlng[0] * Math.PI / 180),
        ];
    }

    function formatTooltip(p) {
        const parts = [];
        parts.push(p.ts.toLocaleTimeString('it-IT'));
        if (p.sog != null) parts.push(`SOG ${p.sog.toFixed(1)} kn`);
        if (p.tws != null) parts.push(`TWS ${p.tws.toFixed(1)} kn`);
        if (p.advice) parts.push(`<strong>${p.advice}</strong>`);
        return parts.join('<br>');
    }

    function renderInfo() {
        const info = document.getElementById('replay-info');
        if (state.points.length === 0) {
            info.innerHTML = '<p class="muted">Carica un file CSV per iniziare</p>';
            return;
        }
        const first = state.points[0].ts;
        const last  = state.points[state.points.length - 1].ts;
        const durMin = Math.round((last - first) / 60000);
        const validGps = state.points.filter(p => p.lat != null).length;

        const adviceCount = { 'LATO BUONO': 0, 'VIRA': 0, 'LAYLINE': 0, 'OK': 0 };
        state.points.forEach(p => {
            if (p.advice && adviceCount[p.advice] !== undefined) adviceCount[p.advice]++;
        });

        info.innerHTML = `
            <div class="row"><span class="k">File</span><span title="${escapeHtml(state.fileName||'')}">${escapeHtml(truncate(state.fileName||'--', 24))}</span></div>
            <div class="row"><span class="k">Punti totali</span><span>${state.points.length}</span></div>
            <div class="row"><span class="k">Punti GPS</span><span>${validGps}</span></div>
            <div class="row"><span class="k">Inizio</span><span>${first.toLocaleString('it-IT')}</span></div>
            <div class="row"><span class="k">Fine</span><span>${last.toLocaleString('it-IT')}</span></div>
            <div class="row"><span class="k">Durata</span><span>${durMin} min</span></div>
            <div class="advice-summary">
                <div class="advice-bar advice-lb"   style="flex:${adviceCount['LATO BUONO']}" title="LATO BUONO: ${adviceCount['LATO BUONO']}"></div>
                <div class="advice-bar advice-vira" style="flex:${adviceCount['VIRA']}"       title="VIRA: ${adviceCount['VIRA']}"></div>
                <div class="advice-bar advice-lay"  style="flex:${adviceCount['LAYLINE']}"    title="LAYLINE: ${adviceCount['LAYLINE']}"></div>
                <div class="advice-bar advice-ok"   style="flex:${adviceCount['OK']}"         title="OK: ${adviceCount['OK']}"></div>
            </div>
            <div class="advice-legend">
                <span><span class="dot" style="background:#00ff88"></span>${adviceCount['LATO BUONO']} buono</span>
                <span><span class="dot" style="background:#C55A11"></span>${adviceCount['VIRA']} vira</span>
                <span><span class="dot" style="background:#ffeb3b"></span>${adviceCount['LAYLINE']} lay</span>
                <span><span class="dot" style="background:#1B3A6B"></span>${adviceCount['OK']} ok</span>
            </div>
        `;
    }

    function renderLive() {
        const grid = document.getElementById('replay-live');
        const tac  = document.getElementById('replay-tactical');
        if (state.points.length === 0) {
            grid.innerHTML = '<p class="muted">--</p>';
            tac.className = '';
            tac.innerHTML = '<p class="muted">--</p>';
            return;
        }
        const p = state.points[state.currentIdx];

        const cells = [
            ['SOG',    p.sog,    'kn',  1],
            ['STW',    p.stw,    'kn',  1],
            ['TARGET', p.target, 'kn',  1],
            ['VMG',    p.vmg,    'kn',  2],
            ['COG',    p.cog,    '°',   0],
            ['HDG',    p.hdg,    '°',   0],
            ['TWS',    p.tws,    'kn',  1],
            ['TWA',    p.twa,    '°',   0],
            ['TWD',    p.twd,    '°',   0],
            ['AWS',    p.aws,    'kn',  1],
            ['AWA',    p.awa,    '°',   0],
            ['Depth',  p.depth,  'm',   1],
        ];
        grid.innerHTML = cells.map(([label, val, unit, dec]) => `
            <div class="live-cell">
                <div class="label">${label}</div>
                <div class="value">${val != null ? val.toFixed(dec) : '--'}<span class="unit">${unit}</span></div>
            </div>
        `).join('');

        // Vela suggerita (sail crossover): cerca lookupSail nel polarLookup
        // dell'analisi corrente. Solo se il polar.json contiene la sezione
        // sails. Mostra una pillola colorata con il colore della vela.
        const sailEl = document.getElementById('replay-sail');
        if (sailEl) {
            const pl = state.analysis && state.analysis.polarLookup;
            if (pl && pl.hasSails && pl.lookupSail && p.tws != null && p.twa != null) {
                const sail = pl.lookupSail(p.tws, p.twa);
                if (sail) {
                    sailEl.style.display = '';
                    sailEl.innerHTML =
                        '<span class="sail-dot" style="background:' + sail.color + '"></span>' +
                        '<span class="sail-label">Vela: <strong>' + escapeHtml(sail.label) + '</strong></span>';
                } else {
                    sailEl.style.display = 'none';
                }
            } else {
                sailEl.style.display = 'none';
            }
        }

        let cls = 'ok', text = '—';
        if (p.advice === 'LATO BUONO') {
            cls = 'lato-buono';
            text = `LATO BUONO ${p.shift != null ? `+${Math.abs(p.shift).toFixed(0)}°` : ''}`;
        } else if (p.advice === 'VIRA') {
            cls = 'vira';
            text = `VIRA ${p.shift != null ? `${p.shift >= 0 ? '+' : ''}${p.shift.toFixed(0)}°` : ''}`;
        } else if (p.advice === 'LAYLINE') {
            cls = 'layline';
            text = 'VIRA (layline)';
        } else if (p.advice === 'OK') {
            cls = 'ok';
            text = `OK ${p.shift != null ? `${p.shift >= 0 ? '+' : ''}${p.shift.toFixed(0)}°` : ''}`;
        }
        tac.className = cls;
        tac.innerHTML = text;

        const boa = document.getElementById('replay-mark');
        if (p.markDist != null && p.markBrg != null) {
            boa.innerHTML = `
                <div class="row"><span class="k">BRG</span><span>${p.markBrg.toFixed(0)}°</span></div>
                <div class="row"><span class="k">DIST</span><span>${p.markDist.toFixed(3)} NM</span></div>
                <div class="row"><span class="k">ETA</span><span>${p.markEta != null ? p.markEta.toFixed(1) + ' min' : '--'}</span></div>
            `;
        } else {
            boa.innerHTML = '<p class="muted">Nessuna boa target</p>';
        }
    }

    function renderTimestamp() {
        const lbl = document.getElementById('replay-current-ts');
        if (state.points.length === 0) { lbl.textContent = '--'; return; }
        const p = state.points[state.currentIdx];
        const first = state.points[0].ts;
        const elapsedSec = Math.round((p.ts - first) / 1000);
        const m = Math.floor(elapsedSec / 60);
        const s = elapsedSec % 60;
        lbl.textContent = `${p.ts.toLocaleTimeString('it-IT')} (T+${m}:${s.toString().padStart(2,'0')})`;
    }

    function setIdx(i) {
        if (state.points.length === 0) return;
        state.currentIdx = Math.max(0, Math.min(state.points.length - 1, i));
        document.getElementById('replay-slider').value = state.currentIdx;
        updateBoatPosition();
        renderLive();
        renderTimestamp();
        // Aggiorna evidenziazione leg corrente nel pannello analisi
        // (chiamata leggera, modifica solo le classi CSS, niente re-render)
        if (state.analysis && state.analysis.ok) {
            updateAnalysisCursor();
        }
        // Ridisegno polar plot SEMPRE: ha il pallino arancione che segue
        // il cursor della traccia, vogliamo che sia gia' nel posto giusto
        // quando l'utente passa al tab Polar (no "salto" visivo). Costo
        // trascurabile.
        if (state.polarPlot) {
            state.polarPlot.redraw(state.currentIdx);
        }
        // Strip chart: solo se visibile (e' un canvas grosso, costo non
        // trascurabile). Quando l'utente apre il tab Charts viene comunque
        // ridisegnato dalla logica di tab-switching.
        const chartsPanel = document.getElementById('ra-charts');
        if (state.stripChart && chartsPanel && chartsPanel.style.display !== 'none') {
            state.stripChart.redraw(state.currentIdx);
        }
    }

    function play() {
        if (state.playing || state.points.length < 2) return;
        state.playing = true;
        document.getElementById('replay-playpause').textContent = '⏸';

        function tick() {
            if (!state.playing) return;
            const cur = state.currentIdx;
            if (cur >= state.points.length - 1) { pause(); return; }
            const next = state.points[cur + 1];
            const now  = state.points[cur];
            const realDeltaMs = next.ts - now.ts;
            const playDelay = Math.max(20, realDeltaMs / state.playSpeed);

            state.playTimer = setTimeout(() => {
                setIdx(cur + 1);
                tick();
            }, playDelay);
        }
        tick();
    }

    function pause() {
        state.playing = false;
        if (state.playTimer) { clearTimeout(state.playTimer); state.playTimer = null; }
        document.getElementById('replay-playpause').textContent = '▶';
    }

    function togglePlay() {
        if (state.playing) pause(); else play();
    }

    function setSpeed(s) {
        state.playSpeed = s;
        document.querySelectorAll('.replay-speed-btn').forEach(b => {
            b.classList.toggle('active', parseFloat(b.dataset.speed) === s);
        });
    }

    // ========================================================================
    // Caricamento da Blob Storage (modalita' principale)
    // ========================================================================

    /** Carica la lista delle barche e popola il select #replay-boat-select.
     *  Chiamata una sola volta al primo accesso alla schermata Replay. */
    async function loadBoatsList() {
        const sel = document.getElementById('replay-boat-select');
        if (sel.dataset.loaded === '1') return;  // gia' fatto

        try {
            const res = await SailingAuth.authFetch(API_BASE + '/api/boats');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const boats = await res.json();
            // svuota e ripopola (mantenendo l'opzione vuota)
            sel.innerHTML = '<option value="">— Scegli barca —</option>';
            for (const b of boats) {
                const opt = document.createElement('option');
                opt.value = b.boat_id;
                opt.textContent = b.name + ' (' + b.boat_id + ')';
                sel.appendChild(opt);
            }
            sel.dataset.loaded = '1';
        } catch (e) {
            console.error('Errore caricamento lista barche:', e);
            sel.innerHTML = '<option value="">— Errore: ' + e.message + ' —</option>';
        }
    }

    /** Quando l'utente sceglie una barca, carica la lista delle tracce per
     *  quella barca e popola il select #replay-track-select.
     *  Salva il download_url di ogni traccia in dataset per uso successivo. */
    async function loadTracksList(boatId) {
        const trackSel = document.getElementById('replay-track-select');
        const loadBtn = document.getElementById('replay-load-btn');
        trackSel.innerHTML = '<option value="">— Caricamento… —</option>';
        trackSel.disabled = true;
        loadBtn.disabled = true;

        if (!boatId) {
            trackSel.innerHTML = '<option value="">— Scegli traccia —</option>';
            return;
        }

        try {
            const res = await SailingAuth.authFetch(API_BASE + '/api/boats/' +
                                    encodeURIComponent(boatId) + '/tracks');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            const tracks = data.tracks || [];
            trackSel.innerHTML = '<option value="">— Scegli traccia —</option>';
            if (tracks.length === 0) {
                trackSel.innerHTML = '<option value="">— Nessuna traccia disponibile —</option>';
                return;
            }
            for (const t of tracks) {
                const opt = document.createElement('option');
                opt.value = t.filename;
                // Salvo l'URL di download diretto al blob nel dataset
                opt.dataset.url = t.download_url;
                const sizeKb = (t.size_bytes / 1024).toFixed(1);
                const dt = t.uploaded_at ? new Date(t.uploaded_at).toLocaleString() : '?';
                opt.textContent = t.filename + ' (' + sizeKb + ' KB, ' + dt + ')';
                trackSel.appendChild(opt);
            }
            trackSel.disabled = false;
        } catch (e) {
            console.error('Errore caricamento tracce:', e);
            trackSel.innerHTML = '<option value="">— Errore: ' + e.message + ' —</option>';
        }
    }

    /** Scarica il CSV scelto direttamente dal blob storage e lo carica
     *  nel replay senza salvarlo sul disco dell'utente. */
    async function loadTrackFromBlob() {
        const trackSel = document.getElementById('replay-track-select');
        const opt = trackSel.options[trackSel.selectedIndex];
        if (!opt || !opt.value) return;
        const url = opt.dataset.url;
        const filename = opt.value;
        if (!url) {
            alert('URL del blob mancante per ' + filename);
            return;
        }

        const boatSel = document.getElementById('replay-boat-select');
        const boatId = boatSel.value;

        const loadBtn = document.getElementById('replay-load-btn');
        const originalLabel = loadBtn.textContent;
        loadBtn.textContent = 'Scaricamento…';
        loadBtn.disabled = true;

        try {
            // 1) Fetch traccia CSV (DIRETTO dal blob storage, no proxy backend).
            //    ?nocache forza bypass cache del browser.
            const res = await fetch(url + (url.includes('?') ? '&' : '?') +
                                    'nocache=' + Date.now());
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const text = await res.text();

            // Riusa la stessa pipeline di parsing del file locale
            const points = parseCSV(text);
            // Reset di tutti gli overlay e plots della traccia precedente
            // (le references ai vecchi punti non sono piu' valide).
            ensureMap();  // mi serve replayMap per resetOverlays
            resetOverlays();
            state.points = points;
            state.fileName = filename;
            state.currentIdx = 0;
            state.analysis = null;
            pause();

            drawFullTrack();
            document.getElementById('replay-slider').max = points.length - 1;
            document.getElementById('replay-slider').value = 0;
            document.getElementById('replay-controls').style.display = 'flex';
            renderInfo();
            setIdx(0);

            // 2) In parallelo: scarico polare e waypoint della barca per
            //    abilitare l'analisi post-regata. Se uno dei due manca,
            //    l'analisi gira ugualmente con dati ridotti (es. senza
            //    %polare se manca la polar.json).
            await loadConfigAndAnalyze(boatId);

        } catch (e) {
            alert('Errore caricamento traccia dal cloud:\n' + e.message);
            console.error(e);
        } finally {
            loadBtn.textContent = originalLabel;
            loadBtn.disabled = false;
        }
    }

    /** Scarica polar.json e waypoints.json della barca dal blob storage,
     *  poi chiama il modulo SailingAnalysis per costruire l'analisi e
     *  popola i tab del pannello laterale. */
    async function loadConfigAndAnalyze(boatId) {
        if (!boatId) return;
        let polar = null, waypoints = null;

        try {
            // Endpoint pubblico che torna gli URL blob della barca.
            // Riuso lo stesso pattern di polarview.js / wptview.js.
            const cfgRes = await SailingAuth.authFetch(API_BASE +
                `/api/boats/${encodeURIComponent(boatId)}/config-urls`);
            if (cfgRes.ok) {
                const cfg = await cfgRes.json();
                // Polare
                if (cfg.polar_url) {
                    try {
                        const r = await fetch(cfg.polar_url +
                            (cfg.polar_url.includes('?') ? '&' : '?') +
                            'nocache=' + Date.now());
                        if (r.ok) polar = await r.json();
                    } catch (e) { console.warn('Polar fetch failed:', e); }
                }
                // Waypoints
                if (cfg.waypoints_url) {
                    try {
                        const r = await fetch(cfg.waypoints_url +
                            (cfg.waypoints_url.includes('?') ? '&' : '?') +
                            'nocache=' + Date.now());
                        if (r.ok) waypoints = await r.json();
                    } catch (e) { console.warn('Waypoints fetch failed:', e); }
                }
            }
        } catch (e) {
            console.warn('Config-urls fetch failed:', e);
            // L'analisi gira lo stesso ma senza polare/waypoints
        }

        // Costruisco l'analisi e la salvo nello state per cursor sync
        if (window.SailingAnalysis) {
            try {
                state.analysis = window.SailingAnalysis.buildAnalysis(
                    state.points, polar, waypoints);
                renderAnalysis();
            } catch (e) {
                console.error('Errore buildAnalysis:', e);
                state.analysis = null;
            }
        }
    }

    // NB: la funzione handleFile (per caricare un CSV dal disco locale) e'
    // stata rimossa: il replay carica le tracce ESCLUSIVAMENTE dal blob
    // storage (container "tracks", sottocartella per boat_id) tramite la
    // funzione loadTrackFromBlob piu' sopra.

    // ========================================================================
    // PANNELLO ANALISI (5 tab: Riepilogo, Leg, Manovre, Polar, Strip Chart)
    // I dati vengono da window.SailingAnalysis.buildAnalysis() salvato in
    // state.analysis. Il render avviene una sola volta dopo il load; il
    // sync col cursor del replay fa solo aggiornamento di classi CSS via
    // updateAnalysisCursor().
    // ========================================================================

    function renderAnalysis() {
        const a = state.analysis;
        if (!a || !a.ok) {
            document.getElementById('ra-empty').style.display = 'flex';
            return;
        }
        document.getElementById('ra-empty').style.display = 'none';
        renderSummaryTab(a);
        appendWindAndHeatmap();   // wind rose + heatmap + bottone PDF in fondo
        renderLegsTab(a);
        renderManeuversTab(a);
        renderAdvancedTab(a);
        // Mostra il tab attivo (default: summary)
        switchTab('summary');
        // Mostra la toolbar mappa (toggle layline / lift-header / boe)
        const tb = document.getElementById('replay-map-toolbar');
        if (tb) tb.style.display = 'flex';
        // Boe: di default ON (ho gia' messo checked nell'HTML)
        toggleMarks(true);
    }

    function renderSummaryTab(a) {
        const F = window.SailingAnalysis;
        const s = a.summary;
        if (!s) {
            document.getElementById('ra-summary').innerHTML =
                '<p class="muted small">Riepilogo non disponibile.</p>';
            return;
        }
        const polarCls = F.ratingClass(s.polarPctAvg);
        const vmgCls = F.ratingClass(s.vmgPctAvg);

        const html = `
            <div class="ra-section-title">Tempo &amp; distanza</div>
            <div class="ra-kpi-grid">
              <div class="ra-kpi">
                <div class="ra-kpi-label">Durata</div>
                <div class="ra-kpi-value">${F.formatDuration(s.durationS)}</div>
              </div>
              <div class="ra-kpi">
                <div class="ra-kpi-label">Distanza percorsa</div>
                <div class="ra-kpi-value">${F.formatNm(s.totalDist_m)}</div>
              </div>
            </div>

            <div class="ra-section-title">Vento</div>
            <div class="ra-kpi-grid">
              <div class="ra-kpi">
                <div class="ra-kpi-label">TWS medio</div>
                <div class="ra-kpi-value">${F.formatKn(s.twsAvg)}</div>
                <div class="ra-kpi-sub">min ${F.formatKn(s.twsMin)} · max ${F.formatKn(s.twsMax)}</div>
              </div>
              <div class="ra-kpi">
                <div class="ra-kpi-label">Andature</div>
                <div class="ra-kpi-value">${F.formatPct(s.upwindFrac != null ? s.upwindFrac * 100 : null, 0)} bolina</div>
                <div class="ra-kpi-sub">${F.formatPct(s.downwindFrac != null ? s.downwindFrac * 100 : null, 0)} poppa/lasco</div>
              </div>
            </div>

            <div class="ra-section-title">Performance vs polare</div>
            <div class="ra-kpi-grid">
              <div class="ra-kpi">
                <div class="ra-kpi-label">% Polare medio</div>
                <div class="ra-kpi-value ${polarCls}">${F.formatPct(s.polarPctAvg)}</div>
                <div class="ra-kpi-sub">STW vs polar(TWS,TWA)</div>
              </div>
              <div class="ra-kpi">
                <div class="ra-kpi-label">% Target VMG</div>
                <div class="ra-kpi-value ${vmgCls}">${F.formatPct(s.vmgPctAvg)}</div>
                <div class="ra-kpi-sub">VMG vs target VMG</div>
              </div>
            </div>

            <div class="ra-section-title">Manovre</div>
            <div class="ra-kpi-grid">
              <div class="ra-kpi">
                <div class="ra-kpi-label">Virate</div>
                <div class="ra-kpi-value">${s.tackCount}</div>
              </div>
              <div class="ra-kpi">
                <div class="ra-kpi-label">Strambate</div>
                <div class="ra-kpi-value">${s.gybeCount}</div>
              </div>
            </div>
        `;
        document.getElementById('ra-summary').innerHTML = html;
    }

    function renderLegsTab(a) {
        const F = window.SailingAnalysis;
        if (!a.legs || a.legs.length === 0) {
            document.getElementById('ra-legs').innerHTML =
                '<p class="muted small">Nessun leg rilevato.</p>';
            return;
        }
        // Header tabella + righe (una per leg, click per saltare il replay)
        let html = `
            <table class="ra-table" id="ra-legs-table">
              <thead>
                <tr>
                  <th>Leg</th>
                  <th>Durata</th>
                  <th>Dist.</th>
                  <th>+%</th>
                  <th>%Pol.</th>
                </tr>
              </thead>
              <tbody>
        `;
        a.legs.forEach((ls, i) => {
            const stats = ls.stats;
            const polarCls = F.ratingClass(stats.polarPctAvg);
            const extraCls = stats.extraPct == null ? '' :
                (stats.extraPct < 5 ? 'good' : stats.extraPct < 15 ? 'warn' : 'bad');
            const label = `${escapeHtml(ls.leg.from.name)} → ${escapeHtml(ls.leg.to.name)}`;
            html += `
              <tr class="clickable" data-leg-idx="${i}" data-start="${ls.leg.startIdx}">
                <td title="${label}">${escapeHtml(truncate(label, 24))}</td>
                <td>${F.formatDuration(stats.durationS)}</td>
                <td>${F.formatNm(stats.distSailed_m, 2)}</td>
                <td class="${extraCls}">${stats.extraPct != null ? '+' + stats.extraPct.toFixed(0) + '%' : '--'}</td>
                <td class="${polarCls}">${F.formatPct(stats.polarPctAvg, 0)}</td>
              </tr>
            `;
        });
        html += '</tbody></table>';
        const container = document.getElementById('ra-legs');
        container.innerHTML = html;
        // Click su riga -> sposta il cursor del replay all'inizio del leg
        container.querySelectorAll('tr.clickable').forEach(tr => {
            tr.onclick = () => {
                const idx = parseInt(tr.dataset.start, 10);
                if (!isNaN(idx)) {
                    pause();
                    setIdx(idx);
                }
            };
        });
    }

    function renderManeuversTab(a) {
        const F = window.SailingAnalysis;
        if (!a.maneuvers || a.maneuvers.length === 0) {
            document.getElementById('ra-maneuvers').innerHTML =
                '<p class="muted small">Nessuna virata o strambata rilevata.</p>';
            return;
        }
        let html = `
            <table class="ra-table" id="ra-maneuvers-table">
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Ora</th>
                  <th>TWS</th>
                  <th>Δt</th>
                  <th>Da → A</th>
                </tr>
              </thead>
              <tbody>
        `;
        a.maneuvers.forEach((m, i) => {
            const badgeCls = m.type === 'tack' ? 'ra-badge-tack' : 'ra-badge-gybe';
            const label = m.type === 'tack' ? 'TACK' : 'GYBE';
            const time = m.ts.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const twaArrow = `${m.twaBefore.toFixed(0)}° → ${m.twaAfter.toFixed(0)}°`;
            html += `
              <tr class="clickable" data-man-idx="${i}" data-start="${m.startIdx}">
                <td><span class="ra-badge ${badgeCls}">${label}</span></td>
                <td>${time}</td>
                <td>${F.formatKn(m.twsAvg, 0)}</td>
                <td>${m.durationS.toFixed(0)}s</td>
                <td>${twaArrow}</td>
              </tr>
            `;
        });
        html += '</tbody></table>';
        const container = document.getElementById('ra-maneuvers');
        container.innerHTML = html;
        container.querySelectorAll('tr.clickable').forEach(tr => {
            tr.onclick = () => {
                const idx = parseInt(tr.dataset.start, 10);
                if (!isNaN(idx)) {
                    pause();
                    setIdx(idx);
                }
            };
        });
    }

    /** Tab "Avanzate": 4 sezioni con le nuove analisi post-race. Layout
     *  scrollabile verticale, ogni sezione ha titolo + contenuto. */
    function renderAdvancedTab(a) {
        const F = window.SailingAnalysis;
        const div = document.getElementById('ra-advanced');
        if (!div) return;
        const parts = [];

        // === 1. Wind shifts ===
        parts.push('<div class="adv-section"><h4 class="adv-h">🌬 Wind shifts</h4>');
        if (a.windShifts && a.windShifts.length > 0) {
            parts.push('<table class="adv-table"><thead><tr>' +
                '<th>Tempo</th><th>Da → A</th><th>Δ</th><th>Lato</th>' +
                '</tr></thead><tbody>');
            a.windShifts.forEach(s => {
                const tStr = s.ts.toLocaleTimeString('it-IT',
                    { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                const arrow = s.delta_deg > 0 ? '→' : '←';
                const dirIcon = s.direction === 'right' ? '↻' : '↺';
                parts.push(
                    '<tr data-idx="' + s.idx + '">' +
                    '<td>' + tStr + '</td>' +
                    '<td>' + s.from_twd.toFixed(0) + '° → ' + s.to_twd.toFixed(0) + '°</td>' +
                    '<td>' + arrow + ' ' + Math.abs(s.delta_deg).toFixed(0) + '°</td>' +
                    '<td>' + dirIcon + ' ' + s.direction + '</td>' +
                    '</tr>'
                );
            });
            parts.push('</tbody></table>');
        } else {
            parts.push('<p class="muted small">Nessun salto di vento >= 10° rilevato.</p>');
        }
        parts.push('</div>');

        // === 2. Overstand ===
        parts.push('<div class="adv-section"><h4 class="adv-h">📐 Overstand</h4>');
        if (a.overstand && a.overstand.totalOverstandSec > 0) {
            parts.push('<p class="adv-summary">Tempo totale oltre layline: ' +
                '<strong>' + F.formatDuration(a.overstand.totalOverstandSec) + '</strong>' +
                '</p>');
            parts.push('<table class="adv-table"><thead><tr>' +
                '<th>Leg</th><th>Episodi</th><th>Tempo perso</th><th>TWA opt</th>' +
                '</tr></thead><tbody>');
            a.overstand.perLeg.forEach(l => {
                if (l.overstand_s <= 0) return;
                parts.push(
                    '<tr><td>' + escapeHtml(l.legName) + '</td>' +
                    '<td>' + l.episodes + '</td>' +
                    '<td>' + F.formatDuration(l.overstand_s) + '</td>' +
                    '<td>' + l.optimalUpTwa.toFixed(0) + '°</td></tr>'
                );
            });
            parts.push('</tbody></table>');
        } else if (a.overstand && a.overstand.perLeg.length > 0) {
            parts.push('<p class="muted small">Niente overstand significativo: ' +
                'sei sempre rimasto entro la layline. ✓</p>');
        } else {
            parts.push('<p class="muted small">Calcolo non disponibile (richiede ' +
                'leg upwind con waypoint target).</p>');
        }
        parts.push('</div>');

        // === 3. Ranking manovre (top 5 + bottom 3) ===
        parts.push('<div class="adv-section"><h4 class="adv-h">🏆 Ranking manovre</h4>');
        if (a.maneuverRanking && a.maneuverRanking.length > 0) {
            const top = a.maneuverRanking.slice(0, 5);
            const bottom = a.maneuverRanking.slice(-3).reverse();
            parts.push('<p class="muted small">Migliori 5:</p>');
            parts.push('<table class="adv-table"><thead><tr>' +
                '<th>#</th><th>Tipo</th><th>Score</th><th>Loss</th><th>Recovery</th>' +
                '</tr></thead><tbody>');
            top.forEach((m, i) => {
                parts.push(
                    '<tr data-idx="' + m.idx + '" class="rank-good">' +
                    '<td>' + (i + 1) + '</td>' +
                    '<td>' + m.type + '</td>' +
                    '<td>' + m.score.toFixed(0) + '</td>' +
                    '<td>' + (m.speedLossKn != null ? m.speedLossKn.toFixed(1) + ' kn' : '--') + '</td>' +
                    '<td>' + (m.recoveryDelta != null ?
                        (m.recoveryDelta >= 0 ? '+' : '') + m.recoveryDelta.toFixed(1) + ' kn' : '--') + '</td>' +
                    '</tr>'
                );
            });
            parts.push('</tbody></table>');
            if (a.maneuverRanking.length > 5) {
                parts.push('<p class="muted small" style="margin-top:0.6rem;">Da migliorare:</p>');
                parts.push('<table class="adv-table"><thead><tr>' +
                    '<th>Tipo</th><th>Score</th><th>Loss</th><th>Recovery</th>' +
                    '</tr></thead><tbody>');
                bottom.forEach(m => {
                    parts.push(
                        '<tr data-idx="' + m.idx + '" class="rank-bad">' +
                        '<td>' + m.type + '</td>' +
                        '<td>' + m.score.toFixed(0) + '</td>' +
                        '<td>' + (m.speedLossKn != null ? m.speedLossKn.toFixed(1) + ' kn' : '--') + '</td>' +
                        '<td>' + (m.recoveryDelta != null ?
                            (m.recoveryDelta >= 0 ? '+' : '') + m.recoveryDelta.toFixed(1) + ' kn' : '--') + '</td>' +
                        '</tr>'
                    );
                });
                parts.push('</tbody></table>');
            }
        } else {
            parts.push('<p class="muted small">Nessuna manovra rilevata.</p>');
        }
        parts.push('</div>');

        // === 4. Sail usage real vs teoretico ===
        parts.push('<div class="adv-section"><h4 class="adv-h">⛵ Vela: reale vs teorico</h4>');
        if (a.sailUsage) {
            const u = a.sailUsage;
            parts.push('<p class="adv-summary">Match con polare: ' +
                '<strong>' + (u.matchPct != null ? u.matchPct.toFixed(0) + '%' : '--') +
                '</strong> del tempo</p>');
            if (u.misses && u.misses.length > 0) {
                parts.push('<p class="muted small">' + u.missCount +
                    ' periodi con vela "non ottimale" (>30s):</p>');
                parts.push('<table class="adv-table"><thead><tr>' +
                    '<th>Durata</th><th>Reale</th><th>Suggerita</th>' +
                    '</tr></thead><tbody>');
                u.misses.slice(0, 10).forEach(m => {
                    parts.push(
                        '<tr data-idx="' + m.startIdx + '">' +
                        '<td>' + F.formatDuration(m.duration_s) + '</td>' +
                        '<td>' + escapeHtml(m.real) + '</td>' +
                        '<td>' + escapeHtml(m.theory) + '</td>' +
                        '</tr>'
                    );
                });
                parts.push('</tbody></table>');
            }
        } else {
            parts.push('<p class="muted small">Analisi non disponibile: serve un ' +
                'CSV con campo "sail" + polare con sezione sail crossover.</p>');
        }
        parts.push('</div>');

        div.innerHTML = parts.join('');

        // Click su righe -> sposta cursor (riusa logica di altri tab)
        div.querySelectorAll('tr[data-idx]').forEach(tr => {
            tr.style.cursor = 'pointer';
            tr.addEventListener('click', () => {
                const idx = parseInt(tr.dataset.idx, 10);
                if (isFinite(idx)) setIdx(idx);
            });
        });
    }

    /** Aggiorna le classi .current sulle righe leg/manovre in base al
     *  cursor corrente del replay. Chiamato da setIdx(). Volutamente
     *  leggero: niente re-render, solo toggle CSS. */
    function updateAnalysisCursor() {
        const a = state.analysis;
        if (!a || !a.ok) return;
        const cur = state.currentIdx;
        // Leg corrente
        const legsTable = document.getElementById('ra-legs-table');
        if (legsTable) {
            const rows = legsTable.querySelectorAll('tbody tr');
            rows.forEach((tr, i) => {
                const ls = a.legs[i];
                const inLeg = ls && cur >= ls.leg.startIdx && cur <= ls.leg.endIdx;
                tr.classList.toggle('current', !!inLeg);
            });
        }
        // Manovra corrente: highlight se il cursor e' dentro la finestra
        const manTable = document.getElementById('ra-maneuvers-table');
        if (manTable) {
            const rows = manTable.querySelectorAll('tbody tr');
            rows.forEach((tr, i) => {
                const m = a.maneuvers[i];
                const inMan = m && cur >= m.startIdx && cur <= m.endIdx;
                tr.classList.toggle('current', !!inMan);
            });
        }
    }

    function switchTab(tabName) {
        // Aggiorna stato visivo dei pulsanti tab
        document.querySelectorAll('.ra-tab').forEach(b => {
            b.classList.toggle('active', b.dataset.tab === tabName);
        });

        // Nasconde tutti i pannelli, mostra solo quello attivo. Il banner
        // "L'analisi compare..." (#ra-empty) viene tolto: il messaggio
        // viene messo *dentro* il tab attivo cosi' il click da' feedback.
        ['summary', 'legs', 'maneuvers', 'polar', 'charts', 'advanced'].forEach(name => {
            const panel = document.getElementById('ra-' + name);
            if (panel) panel.style.display = (name === tabName) ? 'block' : 'none';
        });
        const empty = document.getElementById('ra-empty');
        if (empty) empty.style.display = 'none';

        const activePanel = document.getElementById('ra-' + tabName);
        if (!activePanel) return;

        const a = state.analysis;
        // Caso 1: nessuna analisi disponibile -> placeholder "carica una traccia"
        if (!a || !a.ok) {
            activePanel.innerHTML = placeholderHtml(
                'Carica una traccia per vedere l\'analisi qui.');
            return;
        }
        // Caso 2: tab Polar - crea il grafico se non esiste e ridisegna
        if (tabName === 'polar') {
            const plot = ensurePolarPlot();
            if (plot) plot.redraw(state.currentIdx);
            return;
        }
        // Caso 3: tab Strip Chart - idem
        if (tabName === 'charts') {
            const sc = ensureStripChart();
            if (sc) sc.redraw(state.currentIdx);
            return;
        }
        // Caso 4: tab summary/legs/maneuvers/advanced - i contenuti sono gia'
        // stati riempiti da renderAnalysis(). Nulla da fare qui se non capita
        // che siano stati cancellati da un cambio di stato; in tal caso
        // ricostruisco.
        if (!activePanel.innerHTML.trim() ||
            activePanel.querySelector('.ra-placeholder')) {
            if (tabName === 'summary')   {
                renderSummaryTab(a);
                appendWindAndHeatmap();
            }
            if (tabName === 'legs')      renderLegsTab(a);
            if (tabName === 'maneuvers') renderManeuversTab(a);
            if (tabName === 'advanced')  renderAdvancedTab(a);
        }
    }

    function placeholderHtml(text) {
        return '<div class="ra-placeholder">' +
               '<p class="muted small">' + text + '</p></div>';
    }

    // ========================================================================
    // TURNO 2: PLOTS (polar, strip chart, wind rose, heatmap) + OVERLAY MAPPA
    // (layline, lift/header, mark roundings) + EXPORT PDF
    // ========================================================================

    /** Disegna il polar plot nel tab. Lazy: si crea solo quando l'utente
     *  clicca per la prima volta sul tab Polar (evita lavoro inutile). */
    function ensurePolarPlot() {
        if (state.polarPlot) return state.polarPlot;
        if (!state.analysis || !state.analysis.ok || !window.SailingPlots) return null;
        const panel = document.getElementById('ra-polar');
        panel.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.style.cssText = 'padding:0.5rem;';
        const cv = document.createElement('canvas');
        wrap.appendChild(cv);
        panel.appendChild(wrap);
        state.polarPlot = window.SailingPlots.makePolarPlot(
            cv, state.points, state.analysis.polarLookup);
        return state.polarPlot;
    }

    function ensureStripChart() {
        if (state.stripChart) return state.stripChart;
        if (!state.analysis || !state.analysis.ok || !window.SailingPlots) return null;
        const panel = document.getElementById('ra-charts');
        panel.innerHTML = '';
        state.stripChart = window.SailingPlots.makeStripChart(
            panel, state.points, state.analysis.polarLookup);
        // Click su un punto del chart -> sposta cursor del replay
        state.stripChart.onClick(idx => { pause(); setIdx(idx); });
        return state.stripChart;
    }

    /** Aggiunge wind rose e heatmap in fondo al tab Riepilogo. */
    function appendWindAndHeatmap() {
        if (!state.analysis || !state.analysis.ok || !window.SailingPlots) return;
        const panel = document.getElementById('ra-summary');
        if (!panel || panel.querySelector('.ra-rose-heatmap')) return;  // gia' fatto

        const wrap = document.createElement('div');
        wrap.className = 'ra-rose-heatmap';
        wrap.innerHTML = `
            <div class="ra-mini-section">
                <div class="ra-mini-section-title">Wind rose (TWD × TWS)</div>
                <canvas id="ra-windrose-canvas"></canvas>
            </div>
            <div class="ra-mini-section">
                <div class="ra-mini-section-title">Heatmap tempo speso (TWS × TWA)</div>
                <canvas id="ra-heatmap-canvas"></canvas>
            </div>
            <button class="ra-export-btn" id="ra-export-pdf">
                📄 Esporta report PDF
            </button>
        `;
        panel.appendChild(wrap);

        state.windRose = window.SailingPlots.makeWindRose(
            document.getElementById('ra-windrose-canvas'), state.points);
        state.heatmap = window.SailingPlots.makeHeatmap(
            document.getElementById('ra-heatmap-canvas'), state.points);
        state.windRose.redraw();
        state.heatmap.redraw();

        document.getElementById('ra-export-pdf').onclick = exportPdf;
    }

    async function exportPdf() {
        const btn = document.getElementById('ra-export-pdf');
        if (!btn || !state.analysis || !window.SailingPlots) return;
        const orig = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Generazione PDF…';
        try {
            // Mi assicuro che polar plot e wind rose siano renderizzati
            // (per embed nel PDF). Se l'utente non ha aperto il tab Polar,
            // il canvas non esiste: lo creo al volo.
            const polarP = ensurePolarPlot();
            if (polarP && polarP.redraw) polarP.redraw(state.currentIdx);
            const polarCv = document.querySelector('#ra-polar canvas');
            const windRoseCv = document.getElementById('ra-windrose-canvas');
            await window.SailingPlots.exportPdfReport(
                state.analysis, state.fileName, polarCv, windRoseCv);
        } catch (e) {
            alert('Errore export PDF: ' + e.message);
            console.error(e);
        } finally {
            btn.disabled = false;
            btn.textContent = orig;
        }
    }

    // -------------------------------------------------------------------
    // OVERLAY MAPPA: lift/header (traccia colorata), layline (linee
    // tratteggiate), mark roundings (marker boe raggiunte).
    // -------------------------------------------------------------------

    /** Toggle: ricolora la traccia base coloured con verde=lift,
     *  rosso=header, grigio=neutral. Se off, ripristina la traccia
     *  monocolore. */
    function toggleLiftHeader(on) {
        if (!replayMap || state.points.length === 0) return;
        if (state.liftHeaderLayer) {
            replayMap.removeLayer(state.liftHeaderLayer);
            state.liftHeaderLayer = null;
        }
        if (!on) {
            // Riattivo la traccia base se nascosta
            if (replayTrackLayer) replayTrackLayer.addTo(replayMap);
            return;
        }
        // Calcolo lift/header se non gia' fatto
        if (!state.liftHeaderArr) {
            state.liftHeaderArr = window.SailingPlots.computeLiftHeader(state.points);
        }
        // Costruisco segmenti (polylines) di colore omogeneo
        const layers = [];
        let curColor = null, curSeg = [];
        const colorMap = {
            lift:    '#5fff80',
            header:  '#ff5050',
            neutral: '#888888',
        };
        for (let i = 0; i < state.points.length; i++) {
            const p = state.points[i];
            if (p.lat == null || p.lon == null) continue;
            const tag = state.liftHeaderArr[i];
            const c = colorMap[tag] || colorMap.neutral;
            if (c !== curColor) {
                if (curSeg.length > 1) {
                    layers.push(L.polyline(curSeg, {
                        color: curColor, weight: 4, opacity: 0.85,
                    }));
                }
                curSeg = curSeg.length > 0 ? [curSeg[curSeg.length - 1]] : [];
                curColor = c;
            }
            curSeg.push([p.lat, p.lon]);
        }
        if (curSeg.length > 1) {
            layers.push(L.polyline(curSeg, {
                color: curColor, weight: 4, opacity: 0.85,
            }));
        }
        state.liftHeaderLayer = L.layerGroup(layers).addTo(replayMap);
        // Nascondo la traccia base per non sovrapporsi
        if (replayTrackLayer) replayMap.removeLayer(replayTrackLayer);
    }

    /** Toggle: per ogni boa "raggiunta" (cioe' fromWp -> toWp valido)
     *  disegno layline mure dx e mure sx (linee tratteggiate). */
    function toggleLaylines(on) {
        if (!replayMap || !state.analysis || !state.analysis.ok) return;
        if (state.laylineLayer) {
            replayMap.removeLayer(state.laylineLayer);
            state.laylineLayer = null;
        }
        if (!on) return;

        const layers = [];
        const polLookup = state.analysis.polarLookup;
        // Raccolgo tutte le boe distinte dai leg
        const marks = [];
        const seen = new Set();
        state.analysis.legs.forEach(ls => {
            const key = ls.leg.to.lat + ',' + ls.leg.to.lon;
            if (ls.leg.toWpIdx !== -1 && !seen.has(key) &&
                ls.leg.to.lat != null && ls.leg.to.lon != null) {
                marks.push(ls.leg.to);
                seen.add(key);
            }
        });
        // TWD medio della sessione
        const twdAvg = state.analysis.summary.twdAvg;
        if (twdAvg == null || marks.length === 0 || !polLookup) return;
        // BeatTWA medio: prendo target a TWS medio
        const twsAvg = state.analysis.summary.twsAvg || 10;
        const targets = polLookup.targetsFor(twsAvg);
        const beatTwa = targets.upTwa;

        marks.forEach(mark => {
            const ll = window.SailingPlots.computeLaylines(
                mark.lat, mark.lon, beatTwa, twdAvg, 4000);
            if (!ll) return;
            // Mure dritte (verde tratteggiato)
            layers.push(L.polyline([ll.mark, ll.stbd], {
                color: '#66dd99', weight: 2, opacity: 0.7,
                dashArray: '6,6',
            }).bindTooltip('Layline mure dritte (a ' + mark.name + ')'));
            // Mure sinistre (rosso tratteggiato)
            layers.push(L.polyline([ll.mark, ll.port], {
                color: '#ff7060', weight: 2, opacity: 0.7,
                dashArray: '6,6',
            }).bindTooltip('Layline mure sinistre (a ' + mark.name + ')'));
        });
        state.laylineLayer = L.layerGroup(layers).addTo(replayMap);
    }

    /** Toggle: marker per ogni boa raggiunta (basato sui leg). */
    function toggleMarks(on) {
        if (!replayMap || !state.analysis || !state.analysis.ok) return;
        if (state.markRoundingsLayer) {
            replayMap.removeLayer(state.markRoundingsLayer);
            state.markRoundingsLayer = null;
        }
        if (!on) return;
        const markers = [];
        const seen = new Set();
        state.analysis.legs.forEach(ls => {
            // Disegno la "destinazione" di ogni leg (toWp), eccetto se e'
            // il segnaposto (fine traccia / start)
            if (ls.leg.toWpIdx === -1) return;
            const key = ls.leg.to.lat + ',' + ls.leg.to.lon;
            if (seen.has(key)) return;
            seen.add(key);
            if (ls.leg.to.lat == null || ls.leg.to.lon == null) return;
            const icon = L.divIcon({
                className: 'mark-rounding-icon',
                html: '<div style="background:#ffae5c;color:#1a1a1a;border:2px solid #1a1a1a;' +
                      'border-radius:50%;width:24px;height:24px;display:flex;' +
                      'align-items:center;justify-content:center;font-weight:bold;' +
                      'font-size:0.7rem;box-shadow:0 1px 3px rgba(0,0,0,0.6);">' +
                      escapeHtml(String(ls.leg.to.name).substring(0, 3)) + '</div>',
                iconSize: [24, 24], iconAnchor: [12, 12],
            });
            const m = L.marker([ls.leg.to.lat, ls.leg.to.lon], { icon: icon })
                .bindTooltip('Boa: ' + ls.leg.to.name);
            markers.push(m);
        });
        state.markRoundingsLayer = L.layerGroup(markers).addTo(replayMap);
    }

    /** Reset di tutti gli overlay: chiamato quando si carica una nuova
     *  traccia (gli array/layer della traccia precedente non sono piu'
     *  validi). */
    function resetOverlays() {
        if (state.liftHeaderLayer) {
            replayMap.removeLayer(state.liftHeaderLayer);
            state.liftHeaderLayer = null;
        }
        if (state.laylineLayer) {
            replayMap.removeLayer(state.laylineLayer);
            state.laylineLayer = null;
        }
        if (state.markRoundingsLayer) {
            replayMap.removeLayer(state.markRoundingsLayer);
            state.markRoundingsLayer = null;
        }
        state.liftHeaderArr = null;
        state.polarPlot = null;
        state.stripChart = null;
        state.windRose = null;
        state.heatmap = null;
        // Reset checkbox UI
        const cb1 = document.getElementById('replay-toggle-laylines');
        const cb2 = document.getElementById('replay-toggle-liftheader');
        if (cb1) cb1.checked = false;
        if (cb2) cb2.checked = false;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
        }[c]));
    }

    function truncate(s, n) {
        if (s.length <= n) return s;
        return s.substring(0, n - 1) + '…';
    }

    document.addEventListener('DOMContentLoaded', () => {
        // Selettore barca: quando cambia, carica la lista tracce dal blob
        const boatSel = document.getElementById('replay-boat-select');
        const trackSel = document.getElementById('replay-track-select');
        const loadBtn = document.getElementById('replay-load-btn');

        boatSel.onchange = () => loadTracksList(boatSel.value);

        // Selettore traccia: abilita "Carica" solo se l'opzione ha un URL
        trackSel.onchange = () => {
            const opt = trackSel.options[trackSel.selectedIndex];
            loadBtn.disabled = !(opt && opt.dataset && opt.dataset.url);
        };

        loadBtn.onclick = loadTrackFromBlob;

        document.getElementById('replay-slider').oninput = (e) => {
            pause();
            setIdx(parseInt(e.target.value, 10));
        };

        document.getElementById('replay-playpause').onclick = togglePlay;

        document.querySelectorAll('.replay-speed-btn').forEach(btn => {
            btn.onclick = () => setSpeed(parseFloat(btn.dataset.speed));
        });

        // Click sui tab del pannello analisi
        document.querySelectorAll('.ra-tab').forEach(btn => {
            btn.onclick = () => switchTab(btn.dataset.tab);
        });

        // Toggle overlay mappa (turno 2)
        const tLay = document.getElementById('replay-toggle-laylines');
        if (tLay) tLay.onchange = () => toggleLaylines(tLay.checked);
        const tLh = document.getElementById('replay-toggle-liftheader');
        if (tLh) tLh.onchange = () => toggleLiftHeader(tLh.checked);
        const tMk = document.getElementById('replay-toggle-marks');
        if (tMk) tMk.onchange = () => toggleMarks(tMk.checked);

        // Quando si attiva la screen replay, init la mappa (lazy)
        // E al primo ingresso popola la lista barche.
        window.addEventListener('screenChanged', (e) => {
            if (e.detail.name === 'replay') {
                ensureMap();
                setTimeout(() => { if (replayMap) replayMap.invalidateSize(); }, 50);
                loadBoatsList();  // idempotente: si esegue solo la prima volta
                // Inizializza il pannello analisi (mostra placeholder se
                // non c'e' una traccia caricata)
                switchTab('summary');
            } else {
                pause();  // mette pausa se navigh fuori da replay
            }
        });
    });
})();
