/**
 * Sailing Cloud - Plot per il pannello analisi (turno 2).
 *
 * Tutti i grafici sono Canvas 2D puro, niente librerie esterne (no D3,
 * no Chart.js). Motivi: peso ridotto, full control sul rendering,
 * nessun problema di compatibilita' con artifacts/CSP.
 *
 * Espone window.SailingPlots con factory functions:
 *   makePolarPlot(canvas, points, polarLookup) -> { redraw(currentIdx) }
 *   makeStripChart(container, points, polarLookup) -> { redraw(currentIdx), onClick(callback) }
 *   makeWindRose(canvas, points)
 *   makeHeatmap(canvas, points, polarLookup)
 *
 * Tutte le factory ritornano un oggetto con almeno un metodo redraw()
 * che il chiamante deve invocare quando cambia il cursor del replay.
 */
(function() {
    "use strict";

    // -------------------------------------------------------------------
    // Palette: 7 colori per bucket di TWS (0-5, 5-8, 8-12, 12-16, 16-20, 20-25, 25+)
    // Scala "vento debole -> forte": blu -> verde -> giallo -> arancio -> rosso
    // -------------------------------------------------------------------
    const TWS_BUCKETS = [
        { max:  5, color: '#5cabff', label: '0-5' },
        { max:  8, color: '#5cffd4', label: '5-8' },
        { max: 12, color: '#7fff5c', label: '8-12' },
        { max: 16, color: '#ffe55c', label: '12-16' },
        { max: 20, color: '#ffae5c', label: '16-20' },
        { max: 25, color: '#ff7050', label: '20-25' },
        { max: 999, color: '#ff3030', label: '25+' },
    ];

    function bucketColor(tws) {
        for (const b of TWS_BUCKETS) {
            if (tws <= b.max) return b.color;
        }
        return TWS_BUCKETS[TWS_BUCKETS.length - 1].color;
    }

    // -------------------------------------------------------------------
    // Util: setup canvas con high-DPI (retina/4K).
    // Senza questo, su display ad alta densita' il canvas viene sfocato.
    // -------------------------------------------------------------------
    function setupCanvas(canvas, w, h) {
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return ctx;
    }

    // ===================================================================
    // POLAR PLOT
    // Layout: cerchio centrato. Asse 0 (avanti) verso l'alto. Raggio =
    // velocita'. Curve teoriche dalla polare (una per ogni TWS chiave),
    // punti reali (uno per ogni sample della traccia) come piccoli cerchi
    // colorati per TWS bucket, e un cursore "live" che segue il replay.
    //
    // Polare simmetrica: disegno solo lato dx (TWA 0..180), specchio lato
    // sx automaticamente per la cloud.
    // ===================================================================
    function makePolarPlot(canvas, points, polarLookup, options) {
        // options.size: 'compact' (default, per pannello laterale del replay)
        //               'large'   (per schermata Polari principale, ~2.5x)
        const opts = options || {};
        const isLarge = opts.size === 'large';

        // Dimensioni del canvas (scaled by DPR)
        let W, H, ctx, cx, cy, scale, maxSpeed;

        function resize() {
            const rect = canvas.parentElement.getBoundingClientRect();
            if (isLarge) {
                // Schermata Polari: usiamo tutto lo spazio disponibile, quadrato
                // (la rappresentazione e' un cerchio quindi W=H ha senso).
                // Cap a 1100px per evitare canvas enormi su monitor 4K (oltre
                // questa dimensione il diagramma non guadagna in leggibilita',
                // diventa solo "vuoto" al centro).
                W = Math.max(500, Math.min(rect.width - 16, 1100));
                H = W;
            } else {
                // Compact: pannello laterale del replay, max 360px
                W = Math.max(280, rect.width - 16);
                H = Math.max(280, Math.min(W, 360));
            }
            ctx = setupCanvas(canvas, W, H);
            cx = W / 2;
            cy = H / 2;
            // maxSpeed: leggo dalla polare; se non disponibile uso 12kn default
            maxSpeed = 12;
            if (polarLookup && polarLookup.matrix) {
                for (const row of polarLookup.matrix) {
                    for (const v of row) if (v > maxSpeed) maxSpeed = v;
                }
                maxSpeed = Math.ceil(maxSpeed * 1.1);  // 10% headroom
            }
            scale = Math.min(W, H) / 2 / maxSpeed * 0.85;  // 85% per lasciare margine label
        }

        /** Converte (twa[gradi 0..360 con 0=avanti], speed) in coord canvas.
         *  TWA 0 = avanti = -y (alto). TWA 90 = destra = +x. */
        function toXY(twaDeg, spd) {
            const r = spd * scale;
            const a = (twaDeg - 90) * Math.PI / 180;  // -90 perche' 0=alto
            return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
        }

        function drawGrid() {
            // Fattore di scala per font/linee in modalita' large
            const S = isLarge ? 2.0 : 1.0;
            // Cerchi concentrici ogni 2 nodi
            ctx.strokeStyle = 'rgba(255,255,255,0.08)';
            ctx.lineWidth = 1 * S;
            for (let v = 2; v <= maxSpeed; v += 2) {
                const r = v * scale;
                ctx.beginPath();
                ctx.arc(cx, cy, r, 0, 2 * Math.PI);
                ctx.stroke();
            }
            // Raggi ogni 30 gradi
            for (let a = 0; a < 360; a += 30) {
                const [x, y] = toXY(a, maxSpeed);
                ctx.beginPath();
                ctx.moveTo(cx, cy);
                ctx.lineTo(x, y);
                ctx.stroke();
            }
            // Etichette TWA principali
            ctx.fillStyle = 'rgba(255,255,255,0.55)';
            ctx.font = (10 * S) + 'px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const labels = [
                { a: 0,   text: '0°' },
                { a: 45,  text: '45°' },
                { a: 90,  text: '90°' },
                { a: 135, text: '135°' },
                { a: 180, text: '180°' },
                { a: 315, text: '45°' },
                { a: 270, text: '90°' },
                { a: 225, text: '135°' },
            ];
            for (const l of labels) {
                const [x, y] = toXY(l.a, maxSpeed * 1.05);
                ctx.fillText(l.text, x, y);
            }
            // Etichette velocita'
            ctx.textAlign = 'left';
            for (let v = 2; v <= maxSpeed; v += 2) {
                ctx.fillText(v + 'kn', cx + 3 * S, cy - v * scale);
            }
        }

        function drawPolarCurves() {
            if (!polarLookup) return;
            const S = isLarge ? 2.0 : 1.0;
            const tws = polarLookup.twsList;
            const twa = polarLookup.twaList;
            const mat = polarLookup.matrix;
            ctx.lineWidth = 1.5 * S;
            for (let i = 0; i < tws.length; i++) {
                const color = bucketColor(tws[i]);
                ctx.strokeStyle = color;
                ctx.globalAlpha = 0.85;
                // Lato destro (TWA positivi)
                ctx.beginPath();
                for (let j = 0; j < twa.length; j++) {
                    const v = mat[i][j];
                    const [x, y] = toXY(twa[j], v);
                    if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                }
                ctx.stroke();
                // Specchio lato sinistro (TWA negativi)
                ctx.beginPath();
                for (let j = 0; j < twa.length; j++) {
                    const v = mat[i][j];
                    const [x, y] = toXY(360 - twa[j], v);
                    if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                }
                ctx.stroke();
            }
            ctx.globalAlpha = 1;
        }

        function drawCloud() {
            // Punti reali della traccia: STW vs TWA, colorati per TWS bucket.
            // Se points e' null/undefined (es. schermata Polari principale che
            // mostra solo le curve teoriche, senza traccia), salta.
            if (!points || !points.length) return;
            // Sub-sampling: se piu' di 1500 punti, prendo 1 ogni N per non
            // saturare il canvas e non rallentare il render.
            ctx.globalAlpha = 0.5;
            const step = Math.max(1, Math.ceil(points.length / 1500));
            for (let i = 0; i < points.length; i += step) {
                const p = points[i];
                if (p.stw == null || p.twa == null || p.tws == null) continue;
                if (p.stw < 0.3) continue;  // ignora barca ferma (rumore)
                ctx.fillStyle = bucketColor(p.tws);
                const [x, y] = toXY(p.twa, p.stw);  // twa puo' essere negativo, toXY gestisce
                ctx.beginPath();
                ctx.arc(x, y, 1.5, 0, 2 * Math.PI);
                ctx.fill();
            }
            ctx.globalAlpha = 1;
        }

        // Flag per loggare una sola volta per sessione il motivo per cui il
        // pallino del cursor non e' visibile (utile per debug "perche' non
        // vedo il pallino"). Si resetta a ogni nuovo polar plot creato.
        let _diagWarnedNoCursor = false;

        function drawCurrentPoint(currentIdx) {
            // Gestisce points=null (schermata Polari senza traccia)
            if (!points || !points.length) return;
            const p = points[currentIdx];
            if (!p) {
                if (!_diagWarnedNoCursor) {
                    console.warn('[polarPlot] Pallino non visibile: punto', currentIdx, 'non esiste');
                    _diagWarnedNoCursor = true;
                }
                return;
            }
            // Fallback: se STW (speed-through-water) manca, uso SOG. Sono
            // diverse in presenza di corrente, ma per visualizzare il punto
            // sul polare e' meglio mostrare qualcosa che niente.
            const speed = p.stw != null ? p.stw : p.sog;
            // TWA: se manca, provo a calcolarlo da TWD - HDG (o COG come
            // fallback per HDG). Cosi' il pallino appare anche se lo strumento
            // fornisce solo TWD assoluto.
            let twa = p.twa;
            if (twa == null && p.twd != null) {
                const heading = p.hdg != null ? p.hdg : p.cog;
                if (heading != null) {
                    twa = ((p.twd - heading + 540) % 360) - 180;  // [-180, 180]
                }
            }
            if (speed == null || twa == null) {
                if (!_diagWarnedNoCursor) {
                    console.warn('[polarPlot] Pallino non visibile al cursor:',
                        'speed=' + speed, 'twa=' + twa,
                        'punto=', { stw: p.stw, sog: p.sog, twa: p.twa,
                                    twd: p.twd, hdg: p.hdg, cog: p.cog });
                    console.warn('[polarPlot] Per vedere il pallino servono' +
                        ' STW (o SOG) e TWA (o TWD+HDG). Verifica che il CSV' +
                        ' della traccia li contenga.');
                    _diagWarnedNoCursor = true;
                }
                return;
            }
            const [x, y] = toXY(twa, speed);
            // Cerchio piu' grande con alone
            ctx.fillStyle = '#ff8000';
            ctx.shadowColor = '#ff8000';
            ctx.shadowBlur = 8;
            ctx.beginPath();
            ctx.arc(x, y, 5, 0, 2 * Math.PI);
            ctx.fill();
            ctx.shadowBlur = 0;
            // Linea dal centro al punto (mostra il TWA istantaneo)
            ctx.strokeStyle = 'rgba(255,128,0,0.6)';
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(x, y);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        function drawLegend() {
            const S = isLarge ? 1.8 : 1.0;
            // Barra orizzontale in basso con i bucket TWS
            const barY = H - 18 * S;
            const barH = 12 * S;
            ctx.font = (9 * S) + 'px sans-serif';
            ctx.textBaseline = 'middle';
            const itemW = (W - 20) / TWS_BUCKETS.length;
            for (let i = 0; i < TWS_BUCKETS.length; i++) {
                const x = 10 + i * itemW;
                ctx.fillStyle = TWS_BUCKETS[i].color;
                ctx.fillRect(x, barY, 10 * S, barH);
                ctx.fillStyle = 'rgba(255,255,255,0.7)';
                ctx.textAlign = 'left';
                ctx.fillText(TWS_BUCKETS[i].label, x + 13 * S, barY + barH / 2);
            }
            ctx.fillStyle = 'rgba(255,255,255,0.55)';
            ctx.textAlign = 'left';
            ctx.fillText('TWS [kn]', 10, barY - 8 * S);
        }

        function redraw(currentIdx) {
            if (W == null) resize();
            ctx.clearRect(0, 0, W, H);
            drawGrid();
            drawPolarCurves();
            drawCloud();
            drawCurrentPoint(currentIdx != null ? currentIdx : 0);
            drawLegend();
        }

        return { redraw, resize };
    }

    // ===================================================================
    // STRIP CHART
    // 4 mini-grafici sovrapposti verticalmente: SOG/STW, TWS, TWA, %polar.
    // Asse x = tempo. Cursore verticale arancione segue il cursor del
    // replay. Click sul chart -> setIdx().
    // ===================================================================
    function makeStripChart(container, points, polarLookup) {
        const chartConfig = [
            { key: 'sog',      key2: 'stw',      label: 'SOG/STW [kn]', color: '#5cabff', color2: '#5cffd4', auto: true },
            { key: 'tws',      label: 'TWS [kn]',                       color: '#7fff5c', auto: true },
            { key: 'twa',      label: 'TWA [°]',  color: '#ffae5c', range: [-180, 180] },
            { key: 'polarPct', label: '%Polare',  color: '#ffd060',  range: [50, 130] },
        ];
        const N = chartConfig.length;
        // Container: lista di canvas, uno per chart
        container.innerHTML = '';
        container.style.display = 'flex';
        container.style.flexDirection = 'column';
        container.style.gap = '0.4rem';
        container.style.padding = '0.6rem';

        const charts = chartConfig.map(cfg => {
            const wrap = document.createElement('div');
            wrap.className = 'sc-wrap';
            wrap.style.cssText = 'background:rgba(255,255,255,0.04);border-radius:4px;padding:0.4rem 0.5rem;';
            const lbl = document.createElement('div');
            lbl.className = 'sc-label';
            lbl.textContent = cfg.label;
            lbl.style.cssText = 'font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:0.2rem;display:flex;justify-content:space-between;';
            const valSpan = document.createElement('span');
            valSpan.style.cssText = 'color:var(--text);font-weight:600;';
            valSpan.className = 'sc-val';
            lbl.appendChild(valSpan);
            wrap.appendChild(lbl);
            const cv = document.createElement('canvas');
            cv.style.cssText = 'display:block;width:100%;cursor:pointer;';
            wrap.appendChild(cv);
            container.appendChild(wrap);
            return { cfg, canvas: cv, valSpan };
        });

        let onClickFn = null;

        function computeRange(cfg) {
            if (cfg.range) return cfg.range;
            // Auto-range: min/max della serie con padding 10%
            let min = Infinity, max = -Infinity;
            for (const p of points) {
                const v = p[cfg.key];
                if (v != null && isFinite(v)) {
                    if (v < min) min = v;
                    if (v > max) max = v;
                }
                if (cfg.key2) {
                    const v2 = p[cfg.key2];
                    if (v2 != null && isFinite(v2)) {
                        if (v2 < min) min = v2;
                        if (v2 > max) max = v2;
                    }
                }
            }
            if (!isFinite(min) || !isFinite(max)) return [0, 1];
            const pad = (max - min) * 0.1 || 1;
            return [min - pad, max + pad];
        }

        function drawOne(chart, currentIdx) {
            const cfg = chart.cfg;
            const cv = chart.canvas;
            const W = cv.parentElement.clientWidth - 16;  // padding
            const H = 50;
            const ctx = setupCanvas(cv, W, H);
            ctx.clearRect(0, 0, W, H);
            const N_pts = points.length;
            if (N_pts < 2) return;
            const range = computeRange(cfg);
            const yMin = range[0], yMax = range[1];

            function valY(v) {
                if (v == null || !isFinite(v)) return null;
                return H - 2 - ((v - yMin) / (yMax - yMin)) * (H - 4);
            }

            // Zero-line (per TWA che ha range simmetrico)
            if (yMin < 0 && yMax > 0) {
                ctx.strokeStyle = 'rgba(255,255,255,0.12)';
                ctx.lineWidth = 1;
                ctx.setLineDash([2, 2]);
                ctx.beginPath();
                const y0 = valY(0);
                ctx.moveTo(0, y0);
                ctx.lineTo(W, y0);
                ctx.stroke();
                ctx.setLineDash([]);
            }

            // Linea principale
            ctx.strokeStyle = cfg.color;
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            let started = false;
            for (let i = 0; i < N_pts; i++) {
                const x = (i / (N_pts - 1)) * W;
                const y = valY(points[i][cfg.key]);
                if (y == null) { started = false; continue; }
                if (!started) { ctx.moveTo(x, y); started = true; }
                else ctx.lineTo(x, y);
            }
            ctx.stroke();

            // Linea secondaria (per SOG/STW chart)
            if (cfg.key2) {
                ctx.strokeStyle = cfg.color2;
                ctx.lineWidth = 1.2;
                ctx.globalAlpha = 0.85;
                ctx.beginPath();
                started = false;
                for (let i = 0; i < N_pts; i++) {
                    const x = (i / (N_pts - 1)) * W;
                    const y = valY(points[i][cfg.key2]);
                    if (y == null) { started = false; continue; }
                    if (!started) { ctx.moveTo(x, y); started = true; }
                    else ctx.lineTo(x, y);
                }
                ctx.stroke();
                ctx.globalAlpha = 1;
            }

            // Cursore verticale
            const cx = (currentIdx / (N_pts - 1)) * W;
            ctx.strokeStyle = '#ff8000';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(cx, 0);
            ctx.lineTo(cx, H);
            ctx.stroke();

            // Aggiorna valore corrente nella label
            const cur = points[currentIdx];
            if (cur) {
                let txt = '';
                const v = cur[cfg.key];
                if (v != null && isFinite(v)) {
                    txt = v.toFixed(cfg.key === 'polarPct' ? 0 : 1);
                    if (cfg.key2) {
                        const v2 = cur[cfg.key2];
                        if (v2 != null && isFinite(v2))
                            txt += ' / ' + v2.toFixed(1);
                    }
                } else {
                    txt = '--';
                }
                chart.valSpan.textContent = txt;
            }
        }

        // Wire click
        charts.forEach((chart, ci) => {
            chart.canvas.addEventListener('click', (e) => {
                const rect = chart.canvas.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const W = rect.width;
                const idx = Math.round((x / W) * (points.length - 1));
                if (onClickFn) onClickFn(idx);
            });
        });

        function redraw(currentIdx) {
            charts.forEach(c => drawOne(c, currentIdx));
        }
        function onClick(fn) { onClickFn = fn; }

        return { redraw, onClick };
    }

    // ===================================================================
    // WIND ROSE
    // Mostra distribuzione TWS in funzione di TWD (direzione assoluta da
    // cui viene il vento). Settori da 22.5 gradi (16 settori), altezza
    // proporzionale al tempo speso, colore = TWS medio nel settore.
    // ===================================================================
    function makeWindRose(canvas, points) {
        const SECTORS = 16;
        // Bin: settore -> { count, twsSum }
        const bins = Array(SECTORS).fill(null).map(() => ({ count: 0, twsSum: 0 }));
        let totalCount = 0;
        for (const p of points) {
            if (p.twd == null || p.tws == null || !isFinite(p.twd) || !isFinite(p.tws)) continue;
            const sec = Math.floor(((p.twd + 360) % 360) / (360 / SECTORS)) % SECTORS;
            bins[sec].count++;
            bins[sec].twsSum += p.tws;
            totalCount++;
        }

        function redraw() {
            const rect = canvas.parentElement.getBoundingClientRect();
            const W = Math.max(180, rect.width - 16);
            const H = Math.min(W, 220);
            const ctx = setupCanvas(canvas, W, H);
            ctx.clearRect(0, 0, W, H);
            const cx = W / 2, cy = H / 2;
            const R = Math.min(W, H) / 2 - 16;

            if (totalCount === 0) {
                ctx.fillStyle = 'rgba(255,255,255,0.4)';
                ctx.font = '11px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('Nessun dato vento', cx, cy);
                return;
            }

            // Trova max count per scala
            let maxCount = 0;
            for (const b of bins) if (b.count > maxCount) maxCount = b.count;

            // Disegno settori
            const angleStep = (2 * Math.PI) / SECTORS;
            for (let i = 0; i < SECTORS; i++) {
                const b = bins[i];
                if (b.count === 0) continue;
                const r = (b.count / maxCount) * R;
                const avgTws = b.twsSum / b.count;
                ctx.fillStyle = bucketColor(avgTws);
                ctx.globalAlpha = 0.7;
                // Settore rivolto verso l'alto (compass) -> -90 offset
                const a0 = i * angleStep - Math.PI / 2 - angleStep / 2;
                const a1 = a0 + angleStep;
                ctx.beginPath();
                ctx.moveTo(cx, cy);
                ctx.arc(cx, cy, r, a0, a1);
                ctx.closePath();
                ctx.fill();
            }
            ctx.globalAlpha = 1;

            // Cerchio esterno
            ctx.strokeStyle = 'rgba(255,255,255,0.2)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(cx, cy, R, 0, 2 * Math.PI);
            ctx.stroke();

            // Etichette N/E/S/W
            ctx.fillStyle = 'rgba(255,255,255,0.6)';
            ctx.font = 'bold 11px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('N', cx, cy - R - 8);
            ctx.fillText('S', cx, cy + R + 8);
            ctx.fillText('E', cx + R + 8, cy);
            ctx.fillText('W', cx - R - 8, cy);
        }

        return { redraw };
    }

    // ===================================================================
    // HEATMAP TWS x TWA
    // Griglia: righe = bucket TWS, colonne = bucket TWA. Cella colorata
    // in base al numero di samples (o tempo, equivalente a 1Hz).
    // Aiuta a vedere "dove" si e' navigato di piu'.
    // ===================================================================
    function makeHeatmap(canvas, points) {
        // Bucket TWA ogni 15 gradi (0..180), TWS ogni 4 nodi (0..28)
        const TWA_BUCKETS = 12;  // 0-15, 15-30, ..., 165-180
        const TWS_BUCKETS_N = 7;
        const grid = [];
        for (let i = 0; i < TWS_BUCKETS_N; i++) {
            grid.push(new Array(TWA_BUCKETS).fill(0));
        }
        let maxCell = 0;
        for (const p of points) {
            if (p.tws == null || p.twa == null) continue;
            const ti = Math.min(TWS_BUCKETS_N - 1, Math.floor(p.tws / 4));
            const ai = Math.min(TWA_BUCKETS - 1, Math.floor(Math.abs(p.twa) / 15));
            grid[ti][ai]++;
            if (grid[ti][ai] > maxCell) maxCell = grid[ti][ai];
        }

        function redraw() {
            const rect = canvas.parentElement.getBoundingClientRect();
            const W = Math.max(240, rect.width - 16);
            const H = 180;
            const ctx = setupCanvas(canvas, W, H);
            ctx.clearRect(0, 0, W, H);

            const padL = 36, padR = 8, padT = 8, padB = 24;
            const gridW = W - padL - padR;
            const gridH = H - padT - padB;
            const cellW = gridW / TWA_BUCKETS;
            const cellH = gridH / TWS_BUCKETS_N;

            // Celle
            for (let ti = 0; ti < TWS_BUCKETS_N; ti++) {
                for (let ai = 0; ai < TWA_BUCKETS; ai++) {
                    const v = grid[ti][ai];
                    const intensity = maxCell > 0 ? v / maxCell : 0;
                    if (v === 0) {
                        ctx.fillStyle = 'rgba(255,255,255,0.04)';
                    } else {
                        // Sfumatura blu->verde->giallo->arancio->rosso
                        ctx.fillStyle = heatColor(intensity);
                    }
                    // Inverto Y: TWS bassi sotto, alti sopra
                    const x = padL + ai * cellW;
                    const y = padT + (TWS_BUCKETS_N - 1 - ti) * cellH;
                    ctx.fillRect(x + 1, y + 1, cellW - 1, cellH - 1);
                }
            }
            // Etichette TWA (asse x)
            ctx.fillStyle = 'rgba(255,255,255,0.5)';
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            for (let ai = 0; ai <= TWA_BUCKETS; ai += 3) {
                const x = padL + ai * cellW;
                const deg = ai * 15;
                ctx.fillText(deg + '°', x, padT + gridH + 3);
            }
            ctx.fillText('TWA', padL + gridW / 2, H - 12);
            // Etichette TWS (asse y)
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            for (let ti = 0; ti < TWS_BUCKETS_N; ti++) {
                const y = padT + (TWS_BUCKETS_N - 1 - ti) * cellH + cellH / 2;
                ctx.fillText((ti * 4) + '-' + ((ti + 1) * 4), padL - 3, y);
            }
        }

        function heatColor(t) {
            // Gradiente: 0 -> blu scuro, 0.5 -> giallo, 1 -> rosso
            // semplice interpolazione lineare RGB
            const stops = [
                [0,    [40,  60,  120]],
                [0.3,  [60,  140, 180]],
                [0.55, [120, 200, 100]],
                [0.75, [240, 200, 70]],
                [1,    [220, 60,  40]],
            ];
            for (let i = 1; i < stops.length; i++) {
                if (t <= stops[i][0]) {
                    const f = (t - stops[i-1][0]) / (stops[i][0] - stops[i-1][0]);
                    const a = stops[i-1][1], b = stops[i][1];
                    const r = Math.round(a[0] + (b[0]-a[0])*f);
                    const g = Math.round(a[1] + (b[1]-a[1])*f);
                    const bl = Math.round(a[2] + (b[2]-a[2])*f);
                    return `rgb(${r},${g},${bl})`;
                }
            }
            return 'rgb(220,60,40)';
        }

        return { redraw };
    }

    // -------------------------------------------------------------------
    // Lift/Header colorato sulla traccia (Leaflet-side helper)
    // Calcolo qui: per ogni punto stimo "delta TWD" sui 30s precedenti.
    // Restituisco array di stesso size di points: 'lift' / 'header' / 'neutral'.
    // -------------------------------------------------------------------
    function computeLiftHeader(points) {
        const N = points.length;
        const out = new Array(N).fill('neutral');
        if (N < 30) return out;
        // Trovo per ogni i un j tale che ts[i] - ts[j] >= 30s
        let j = 0;
        for (let i = 0; i < N; i++) {
            while (j < i && (points[i].ts.getTime() - points[j].ts.getTime()) > 30000) j++;
            if (j === i) continue;
            const twdNow = points[i].twd, twdPast = points[j].twd;
            const twa = points[i].twa;
            if (twdNow == null || twdPast == null || twa == null) continue;
            // Delta TWD modulo 360 con segno
            let d = ((twdNow - twdPast + 540) % 360) - 180;  // [-180, 180]
            if (Math.abs(d) < 3) continue;  // soglia rumore
            // Mure dx (TWA > 0) -> shift positivo (orario) = lift; negativo = header
            // Mure sx (TWA < 0) -> opposto
            const onStarboard = twa > 0;
            const isLift = onStarboard ? (d > 0) : (d < 0);
            out[i] = isLift ? 'lift' : 'header';
        }
        return out;
    }

    // -------------------------------------------------------------------
    // Layline da una boa di bolina, dato Beat TWA dalla polare e TWD medio.
    // Restituisce due punti (port + starboard) che, partiti dalla boa, si
    // estendono di "len_m" metri.
    // -------------------------------------------------------------------
    function computeLaylines(markLat, markLon, beatTwaDeg, twdDeg, lenMeters) {
        if (markLat == null || markLon == null || twdDeg == null) return null;
        const len = lenMeters || 5000;  // default 5 km
        // Heading mure dx in rotta verso la boa = TWD - BeatTWA (boa a vento)
        // Layline mure dx parte dalla boa e va sopravento, in heading TWD - 180 + BeatTWA
        const hdgStbd = (twdDeg + 180 + beatTwaDeg) % 360;  // venendo da sopra-vento mure dx
        const hdgPort = (twdDeg + 180 - beatTwaDeg + 360) % 360;
        // Project markLat/lon su hdg per len metri
        function project(hdgDeg) {
            const R = 6371000;
            const phi1 = markLat * Math.PI / 180;
            const lam1 = markLon * Math.PI / 180;
            const brg = hdgDeg * Math.PI / 180;
            const dR = len / R;
            const phi2 = Math.asin(Math.sin(phi1) * Math.cos(dR) +
                                   Math.cos(phi1) * Math.sin(dR) * Math.cos(brg));
            const lam2 = lam1 + Math.atan2(
                Math.sin(brg) * Math.sin(dR) * Math.cos(phi1),
                Math.cos(dR) - Math.sin(phi1) * Math.sin(phi2));
            return [phi2 * 180 / Math.PI, lam2 * 180 / Math.PI];
        }
        return {
            stbd: project(hdgStbd),
            port: project(hdgPort),
            mark: [markLat, markLon],
        };
    }

    // -------------------------------------------------------------------
    // PDF EXPORT (lazy load di jsPDF da CDN)
    // -------------------------------------------------------------------
    let _jsPdfPromise = null;
    function loadJsPdf() {
        if (_jsPdfPromise) return _jsPdfPromise;
        _jsPdfPromise = new Promise((resolve, reject) => {
            if (window.jspdf) { resolve(window.jspdf); return; }
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
            script.onload = () => resolve(window.jspdf);
            script.onerror = () => reject(new Error('Errore caricamento jsPDF'));
            document.head.appendChild(script);
        });
        return _jsPdfPromise;
    }

    async function exportPdfReport(analysis, fileName, polarCanvas, windRoseCanvas) {
        const jspdf = await loadJsPdf();
        const { jsPDF } = jspdf;
        const doc = new jsPDF({ unit: 'mm', format: 'a4' });
        const F = window.SailingAnalysis;
        const s = analysis.summary;

        // Header
        doc.setFontSize(18);
        doc.setTextColor(20, 30, 50);
        doc.text('Sailing Cloud - Report di sessione', 15, 20);
        doc.setFontSize(10);
        doc.setTextColor(80, 80, 80);
        doc.text('File: ' + (fileName || '-'), 15, 27);
        doc.text('Generato: ' + new Date().toLocaleString('it-IT'), 15, 32);

        // KPI riepilogo
        doc.setFontSize(13);
        doc.setTextColor(20, 30, 50);
        doc.text('Riepilogo', 15, 45);
        doc.setFontSize(10);
        doc.setTextColor(40, 40, 40);
        let y = 52;
        const lines = [
            ['Inizio',         s.startTs.toLocaleString('it-IT')],
            ['Fine',           s.endTs.toLocaleString('it-IT')],
            ['Durata',         F.formatDuration(s.durationS)],
            ['Distanza',       F.formatNm(s.totalDist_m)],
            ['TWS medio',      F.formatKn(s.twsAvg) + '  (min ' + F.formatKn(s.twsMin) + ', max ' + F.formatKn(s.twsMax) + ')'],
            ['% Polare medio', F.formatPct(s.polarPctAvg)],
            ['% Target VMG',   F.formatPct(s.vmgPctAvg)],
            ['Bolina',         F.formatPct(s.upwindFrac * 100, 0)],
            ['Poppa/lasco',    F.formatPct(s.downwindFrac * 100, 0)],
            ['Virate',         String(s.tackCount)],
            ['Strambate',      String(s.gybeCount)],
        ];
        for (const [k, v] of lines) {
            doc.text(k + ':', 18, y);
            doc.text(String(v), 60, y);
            y += 5;
        }

        // Embed polar plot e wind rose (se forniti)
        if (polarCanvas) {
            try {
                const dataUrl = polarCanvas.toDataURL('image/png');
                doc.addImage(dataUrl, 'PNG', 110, 45, 85, 85);
                doc.setFontSize(9);
                doc.setTextColor(80, 80, 80);
                doc.text('Polar plot + cloud reali', 110, 134);
            } catch (e) { /* canvas tainted? skip */ }
        }
        if (windRoseCanvas) {
            try {
                const dataUrl = windRoseCanvas.toDataURL('image/png');
                doc.addImage(dataUrl, 'PNG', 15, 145, 75, 75);
                doc.setFontSize(9);
                doc.setTextColor(80, 80, 80);
                doc.text('Wind rose', 15, 224);
            } catch (e) { /* skip */ }
        }

        // Tabella leg (se ce ne sono almeno uno reale, non solo singolo "(start)->(end)")
        if (analysis.legs && analysis.legs.length > 0 && analysis.legs[0].leg.fromWpIdx !== -1) {
            doc.addPage();
            doc.setFontSize(13);
            doc.setTextColor(20, 30, 50);
            doc.text('Leg', 15, 20);
            doc.setFontSize(9);
            doc.setTextColor(60, 60, 60);
            const headers = ['Da', 'A', 'Durata', 'Dist.', '+%', '%Pol.', '%VMG'];
            const cols = [15, 50, 85, 110, 130, 145, 165];
            headers.forEach((h, i) => doc.text(h, cols[i], 28));
            doc.setLineWidth(0.2);
            doc.line(15, 30, 195, 30);
            let y = 35;
            analysis.legs.forEach(ls => {
                if (y > 280) { doc.addPage(); y = 20; }
                const stats = ls.stats;
                doc.text(String(ls.leg.from.name).substring(0, 14), cols[0], y);
                doc.text(String(ls.leg.to.name).substring(0, 14),   cols[1], y);
                doc.text(F.formatDuration(stats.durationS),         cols[2], y);
                doc.text(F.formatNm(stats.distSailed_m, 2),         cols[3], y);
                doc.text(stats.extraPct != null ? '+' + stats.extraPct.toFixed(0) + '%' : '-', cols[4], y);
                doc.text(F.formatPct(stats.polarPctAvg, 0),         cols[5], y);
                doc.text(F.formatPct(stats.vmgPctAvg,  0),          cols[6], y);
                y += 6;
            });
        }

        // Tabella manovre (se ce ne sono)
        if (analysis.maneuvers && analysis.maneuvers.length > 0) {
            doc.addPage();
            doc.setFontSize(13);
            doc.setTextColor(20, 30, 50);
            doc.text('Manovre', 15, 20);
            doc.setFontSize(9);
            doc.setTextColor(60, 60, 60);
            const headers = ['#', 'Tipo', 'Ora', 'TWS', 'Durata', 'TWA prima', 'TWA dopo'];
            const cols = [15, 25, 50, 85, 105, 130, 160];
            headers.forEach((h, i) => doc.text(h, cols[i], 28));
            doc.line(15, 30, 195, 30);
            let y = 35;
            analysis.maneuvers.forEach((m, i) => {
                if (y > 280) { doc.addPage(); y = 20; }
                doc.text(String(i + 1), cols[0], y);
                doc.text(m.type.toUpperCase(), cols[1], y);
                doc.text(m.ts.toLocaleTimeString('it-IT'), cols[2], y);
                doc.text(F.formatKn(m.twsAvg, 0), cols[3], y);
                doc.text(m.durationS.toFixed(0) + 's', cols[4], y);
                doc.text(m.twaBefore.toFixed(0) + '°', cols[5], y);
                doc.text(m.twaAfter.toFixed(0) + '°', cols[6], y);
                y += 6;
            });
        }

        // Footer
        const pageCount = doc.internal.getNumberOfPages();
        for (let p = 1; p <= pageCount; p++) {
            doc.setPage(p);
            doc.setFontSize(8);
            doc.setTextColor(120, 120, 120);
            doc.text('Sailing Cloud  -  Pag. ' + p + '/' + pageCount, 15, 290);
        }

        doc.save('sailing-report-' + (fileName || 'session') + '.pdf');
    }

    // -------------------------------------------------------------------
    // Espongo
    // -------------------------------------------------------------------
    window.SailingPlots = {
        makePolarPlot: makePolarPlot,
        makeStripChart: makeStripChart,
        makeWindRose: makeWindRose,
        makeHeatmap: makeHeatmap,
        computeLiftHeader: computeLiftHeader,
        computeLaylines: computeLaylines,
        exportPdfReport: exportPdfReport,
        bucketColor: bucketColor,
        TWS_BUCKETS: TWS_BUCKETS,
    };
})();
