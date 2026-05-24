/**
 * Sailing Cloud - Modulo di analisi post-regata.
 *
 * Espone una sola funzione `buildAnalysis(points, polar, waypoints)` che
 * prende la traccia parsata da replay.js, la polare e i waypoints della barca
 * e produce un oggetto con tutti i numeri necessari per popolare i tab del
 * pannello "Analisi" (Riepilogo, Leg, Manovre, Polar, Strip Chart).
 *
 * Tutti i calcoli sono fatti in pura JS, senza dipendenze esterne. Ogni
 * funzione e' documentata con il suo razionale, perche' un domani uno deve
 * poter capire (es. perche' il tack-detection ha quei threshold) senza
 * doversi rileggere tutto il codice.
 *
 * NOTA per il turno 2: il polar plot, lo strip chart e l'export PDF non
 * sono qui. Vengono da analysis-plots.js (ancora da fare). Questo file si
 * limita ai numeri.
 */
(function() {
    "use strict";

    // -------------------------------------------------------------------
    // Costanti tunabili. Documento il perche' di ogni valore cosi' uno
    // domani sa cosa toccare.
    // -------------------------------------------------------------------

    /** Soglia in gradi per considerare un cambio di mura un "tack" o
     *  "gybe". TWA passa da +X a -X (o viceversa) in pochi secondi: il
     *  segno del TWA cambia, e il modulo del delta supera questa soglia.
     *  60 e' un compromesso ragionevole: tack reali sui foiler possono
     *  vedere TWA passare da +25 a -25 (delta 50), su barche IRC normali
     *  spesso superi 80. Sotto 60 sarebbero solo sbandate marginali. */
    const TACK_DELTA_MIN_DEG = 60;

    /** Finestra di tempo in cui cercare il completamento del tack/gybe.
     *  Dal momento in cui TWA cambia segno, il "transitorio" dura tipicamente
     *  6-15 secondi su una barca da regata IRC. 30s e' un cap di sicurezza:
     *  oltre, e' un'altra cosa (es. pause, perdita di vento). */
    const MANEUVER_WINDOW_S = 30;

    /** Se il modulo del TWA supera 90, e' un gybe (vento da poppa).
     *  Sotto 90, e' un tack (vento da prua). */
    const GYBE_TWA_THRESHOLD = 90;

    /** Raggio in metri entro cui consideriamo "passata" una boa. */
    const MARK_ROUNDING_RADIUS_M = 50;

    // Costanti per il nuovo algoritmo detectManeuvers (heading-first):
    /** Smoothing finestra in secondi per HDG e TWA: media vettoriale per
     *  togliere il rumore senza distorcere il segnale. */
    const MANEUVER_SMOOTH_S = 5;
    /** Una virata reale produce cambio di heading >= questo (delta su 15s).
     *  Tack e gybe entrambi superano questo valore facilmente: tack ~70-90°,
     *  gybe ~140-160°. False positive tipici (shift di vento, deriva) restano
     *  sotto 30°. */
    const MANEUVER_HDG_DELTA_MIN_DEG = 50;
    /** Finestra in secondi per misurare il delta heading (rolling window). */
    const MANEUVER_HDG_WINDOW_S = 20;
    /** Soglia minima di durata stimata della manovra. Sotto questo
     *  e' rumore o errore di tracking (3s = troppo veloce per essere reale). */
    const MANEUVER_MIN_DURATION_S = 3;
    /** Distanza minima tra due eventi consecutivi (deduplica). 25s permette
     *  virate/contro-virate molto rapide ma esclude eco rumorose dell'evento. */
    const MANEUVER_DEDUP_S = 25;
    /** Per classificare tack vs gybe: media |TWA| nelle finestre ±10s
     *  prima/dopo l'evento. Questa soglia decide il confine.
     *  > GYBE_TWA_THRESHOLD = gybe (poppa); altrimenti tack. */

    /** Costanti di conversione */
    const KN_TO_MS = 0.514444;
    const M_TO_NM = 1.0 / 1852.0;
    const NM_TO_M = 1852.0;

    // -------------------------------------------------------------------
    // Geo: distanza ortodromica fra due punti lat/lon (metri)
    // Formula haversine, sufficientemente accurata su scale di regata
    // (errore < 0.5% su distanze fino a centinaia di NM).
    // -------------------------------------------------------------------
    function haversineMeters(lat1, lon1, lat2, lon2) {
        if (lat1 == null || lat2 == null || lon1 == null || lon2 == null) {
            return 0;
        }
        const R = 6371000; // raggio Terra medio in metri
        const toRad = Math.PI / 180;
        const dLat = (lat2 - lat1) * toRad;
        const dLon = (lon2 - lon1) * toRad;
        const a = Math.sin(dLat / 2) ** 2 +
                  Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
                  Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    /** Bearing iniziale (gradi 0-360) da p1 a p2.
     *  Serve per calcolare il TWA "atteso" sulla rotta diretta verso una boa.
     */
    function bearingDeg(lat1, lon1, lat2, lon2) {
        const toRad = Math.PI / 180;
        const phi1 = lat1 * toRad, phi2 = lat2 * toRad;
        const dLon = (lon2 - lon1) * toRad;
        const y = Math.sin(dLon) * Math.cos(phi2);
        const x = Math.cos(phi1) * Math.sin(phi2) -
                  Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
        return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
    }

    // -------------------------------------------------------------------
    // POLARE
    // Il polar.json ha struttura nidificata:
    //   {
    //     boat_name: "...",
    //     polar: {
    //       "6":  { "30": 2.1, "45": 4.3, ..., "180": 3.2 },
    //       "8":  { "30": 2.8, ... },
    //       ...
    //     }
    //   }
    // dove le chiavi esterne sono TWS (nodi) e le chiavi interne sono
    // TWA (gradi, sempre 0-180 perche' la polare e' simmetrica).
    //
    // Costruisco una struttura regolarizzata { tws: [...], twa: [...],
    // mat: [tws][twa] } da cui faccio interpolazione bilineare.
    // -------------------------------------------------------------------
    function makePolarLookup(polar) {
        if (!polar || typeof polar !== 'object') return null;
        const polData = polar.polar;
        if (!polData || typeof polData !== 'object') return null;

        // Estrai e ordina TWS (chiavi esterne)
        const twsKeys = Object.keys(polData).map(k => parseFloat(k))
            .filter(n => isFinite(n)).sort((a, b) => a - b);
        if (twsKeys.length === 0) return null;

        // Verifico che tutti i TWS abbiano lo stesso set di TWA, prendo
        // dal primo (assunzione: il file e' stato validato in upload da
        // validatePolarJson, che impone questa coerenza).
        const firstRow = polData[String(twsKeys[0])] || polData[twsKeys[0].toFixed(1)] ||
                         polData[twsKeys[0].toString()];
        if (!firstRow) return null;
        const twaKeys = Object.keys(firstRow).map(k => parseFloat(k))
            .filter(n => isFinite(n)).sort((a, b) => a - b);
        if (twaKeys.length === 0) return null;

        // Costruisco matrice mat[i][j] = speed a tws[i], twa[j]
        const mat = twsKeys.map((tws, i) => {
            // Cerco la riga: provo formato "6.0", "6", e infine cerco
            // la chiave la cui parseFloat == tws (per robustezza)
            let row = polData[tws.toFixed(1)] || polData[tws.toString()] ||
                      polData[String(tws)];
            if (!row) {
                for (const k of Object.keys(polData)) {
                    if (parseFloat(k) === tws) { row = polData[k]; break; }
                }
            }
            return twaKeys.map(twa => {
                let v = row[twa.toFixed(1)] || row[twa.toString()] || row[String(twa)];
                if (v === undefined) {
                    for (const k of Object.keys(row)) {
                        if (parseFloat(k) === twa) { v = row[k]; break; }
                    }
                }
                return (typeof v === 'number' && isFinite(v)) ? v : 0;
            });
        });

        // Cache di target speed/angolo per ogni TWS
        const targetCache = new Map();

        function speedAt(t_ws, t_wa) {
            // |TWA| perche' polare e' simmetrica
            const aw = Math.abs(t_wa);
            // Bracket TWS
            let i = 0;
            while (i < twsKeys.length - 1 && twsKeys[i + 1] < t_ws) i++;
            const tws0 = twsKeys[i], tws1 = twsKeys[Math.min(i + 1, twsKeys.length - 1)];
            const fTws = (tws1 === tws0) ? 0 :
                         Math.max(0, Math.min(1, (t_ws - tws0) / (tws1 - tws0)));
            // Bracket TWA
            let j = 0;
            while (j < twaKeys.length - 1 && twaKeys[j + 1] < aw) j++;
            const twa0 = twaKeys[j], twa1 = twaKeys[Math.min(j + 1, twaKeys.length - 1)];
            const fTwa = (twa1 === twa0) ? 0 :
                         Math.max(0, Math.min(1, (aw - twa0) / (twa1 - twa0)));
            // Bilineare. mat[i][j] = speed at twsKeys[i], twaKeys[j]
            const i2 = Math.min(i + 1, twsKeys.length - 1);
            const j2 = Math.min(j + 1, twaKeys.length - 1);
            const v00 = mat[i][j],   v01 = mat[i][j2];
            const v10 = mat[i2][j],  v11 = mat[i2][j2];
            const v0 = v00 + (v01 - v00) * fTwa;
            const v1 = v10 + (v11 - v10) * fTwa;
            return v0 + (v1 - v0) * fTws;
        }

        function targetsFor(t_ws) {
            const key = t_ws.toFixed(1);
            if (targetCache.has(key)) return targetCache.get(key);
            const twaMin = Math.max(twaKeys[0], 20);
            const twaMax = Math.min(twaKeys[twaKeys.length - 1], 180);
            let upBest = { twa: 45, spd: 0, vmg: 0 };
            let dnBest = { twa: 150, spd: 0, vmg: 0 };
            for (let a = twaMin; a <= twaMax; a += 1) {
                const s = speedAt(t_ws, a);
                if (!isFinite(s) || s <= 0) continue;
                const vmg = s * Math.cos(a * Math.PI / 180);
                if (a < GYBE_TWA_THRESHOLD) {
                    if (vmg > upBest.vmg) upBest = { twa: a, spd: s, vmg: vmg };
                } else {
                    if (-vmg > dnBest.vmg) dnBest = { twa: a, spd: s, vmg: -vmg };
                }
            }
            const r = {
                upTwa: upBest.twa, upSpd: upBest.spd, upVmg: upBest.vmg,
                dnTwa: dnBest.twa, dnSpd: dnBest.spd, dnVmg: dnBest.vmg,
            };
            targetCache.set(key, r);
            return r;
        }

        // ===================================================================
        // SAIL CROSSOVER (turno sail crossover): se il JSON contiene
        // polar.sails.crossover, espongo lookupSail(tws, twa) -> {key, label, color}.
        // Snappa al TWS e TWA piu' vicino della tabella crossover (che puo'
        // avere risoluzione diversa dalla polare velocita').
        // ===================================================================
        const sailsBlock = polar.sails || null;
        let sailDefs = null;
        let sailCrossover = null;  // [{tws: number, rows: [{twaKey: 'Beat'|'Run'|num, sail: 'Gen+F'}, ...]}]
        let sailCrossoverTws = null;
        if (sailsBlock && sailsBlock.crossover && sailsBlock.definitions) {
            sailDefs = sailsBlock.definitions;
            const crossEntries = [];
            for (const twsK of Object.keys(sailsBlock.crossover)) {
                const tws = parseFloat(twsK);
                if (!isFinite(tws)) continue;
                const row = sailsBlock.crossover[twsK];
                if (!row || typeof row !== 'object') continue;
                // Separo le chiavi numeriche (TWA) da Beat/Run
                const numericRows = [];
                let beatSail = null, runSail = null;
                for (const k of Object.keys(row)) {
                    if (k === 'Beat') beatSail = row[k];
                    else if (k === 'Run') runSail = row[k];
                    else {
                        const a = parseFloat(k);
                        if (isFinite(a)) numericRows.push({ twa: a, sail: row[k] });
                    }
                }
                numericRows.sort((a, b) => a.twa - b.twa);
                crossEntries.push({ tws: tws, beatSail, runSail, numeric: numericRows });
            }
            crossEntries.sort((a, b) => a.tws - b.tws);
            sailCrossover = crossEntries;
            sailCrossoverTws = crossEntries.map(e => e.tws);
        }

        /** Ritorna la vela suggerita per (tws, twa).
         *  twa puo' essere negativo o > 180: lo normalizzo a |twa| in [0,180].
         *  Logica: snappo al TWS piu' vicino, poi cerco riga TWA piu' vicina.
         *  Se TWA <= "Beat angle" del file uso 'Beat'; se TWA >= "Run angle" uso 'Run';
         *  altrimenti il TWA numerico piu' vicino. Ritorna null se non c'e'
         *  sail crossover nel polar.json. */
        function lookupSail(tws, twa) {
            if (!sailCrossover || sailCrossover.length === 0) return null;
            if (tws == null || twa == null || !isFinite(tws) || !isFinite(twa)) return null;
            // Normalizzo TWA: prendo valore assoluto, range [0, 180]
            let aTwa = Math.abs(twa);
            if (aTwa > 180) aTwa = 360 - aTwa;
            // Snappa TWS piu' vicino tra le righe definite
            let bestTwsIdx = 0, bestDelta = Infinity;
            for (let i = 0; i < sailCrossoverTws.length; i++) {
                const d = Math.abs(sailCrossoverTws[i] - tws);
                if (d < bestDelta) { bestDelta = d; bestTwsIdx = i; }
            }
            const entry = sailCrossover[bestTwsIdx];
            // Decido se Beat / numerico / Run.
            // Convenzione: se ho righe numeriche con TWA min e max, considero
            // tutto sotto il min come "bolina stretta" (Beat) e tutto sopra max
            // come "poppa larga" (Run). Coerente con la foto della Soar.
            const numeric = entry.numeric;
            let sailKey = null;
            if (numeric.length === 0) {
                // Solo Beat e Run definiti: assumo zona di trasferimento a 90°
                sailKey = aTwa < 90 ? entry.beatSail : entry.runSail;
            } else {
                const twaMin = numeric[0].twa;
                const twaMax = numeric[numeric.length - 1].twa;
                if (aTwa <= twaMin && entry.beatSail) {
                    sailKey = entry.beatSail;
                } else if (aTwa >= twaMax && entry.runSail) {
                    sailKey = entry.runSail;
                } else {
                    // TWA piu' vicino tra i numerici
                    let best = numeric[0];
                    let bd = Math.abs(numeric[0].twa - aTwa);
                    for (const r of numeric) {
                        const d = Math.abs(r.twa - aTwa);
                        if (d < bd) { bd = d; best = r; }
                    }
                    sailKey = best.sail;
                }
            }
            if (!sailKey) return null;
            const def = sailDefs[sailKey];
            if (!def) return { key: sailKey, label: sailKey, color: '#888888' };
            return {
                key: sailKey,
                label: def.label || sailKey,
                color: def.color || '#888888',
            };
        }

        return {
            speedAt, targetsFor, lookupSail,
            twsList: twsKeys, twaList: twaKeys, matrix: mat,
            // Espongo il blocco sails grezzo per UI (legenda, tabella crossover)
            sailDefinitions: sailDefs,
            sailCrossover: sailCrossover,
            hasSails: sailCrossover != null && sailCrossover.length > 0,
        };
    }

    // -------------------------------------------------------------------
    // ENRICHMENT: aggiungo a ogni punto della traccia i valori derivati
    // (polarSpd, %polar, %targetVmg, leg corrente, distanza percorsa cumulativa).
    // Tutto in-place per evitare di clonare arrays grandi.
    // -------------------------------------------------------------------
    function enrichPoints(points, polarLookup) {
        let cumulative = 0;
        let prev = null;
        for (const p of points) {
            // Distanza dal punto precedente
            if (prev && p.lat != null && p.lon != null && prev.lat != null && prev.lon != null) {
                const d = haversineMeters(prev.lat, prev.lon, p.lat, p.lon);
                cumulative += d;
            }
            p.distFromStart_m = cumulative;
            // % polare = STW / polarSpd(TWS, TWA)  *100
            if (polarLookup && p.tws != null && p.twa != null && p.stw != null && p.stw > 0) {
                const polarSpd = polarLookup.speedAt(p.tws, p.twa);
                p.polarSpd = polarSpd;
                p.polarPct = polarSpd > 0 ? (p.stw / polarSpd) * 100 : null;
            } else {
                p.polarSpd = null;
                p.polarPct = null;
            }
            // % target VMG (separato per up/down).
            // VMG istantaneo = STW * cos(TWA). Target VMG da polare.
            if (polarLookup && p.tws != null && p.twa != null && p.stw != null) {
                const t = polarLookup.targetsFor(p.tws);
                const isUp = Math.abs(p.twa) < GYBE_TWA_THRESHOLD;
                const targetVmg = isUp ? t.upVmg : t.dnVmg;
                p.isUpwind = isUp;
                p.targetTwa = isUp ? t.upTwa : t.dnTwa;
                p.targetSpd = isUp ? t.upSpd : t.dnSpd;
                if (targetVmg > 0) {
                    const myVmg = Math.abs(p.stw * Math.cos(p.twa * Math.PI / 180));
                    p.vmgPct = (myVmg / targetVmg) * 100;
                } else {
                    p.vmgPct = null;
                }
            } else {
                p.isUpwind = null;
                p.targetTwa = null;
                p.targetSpd = null;
                p.vmgPct = null;
            }
            prev = p;
        }
        return cumulative; // distanza totale in metri
    }

    // -------------------------------------------------------------------
    // WIND SHIFT DETECTION
    // Identifica i salti di direzione del vento (TWD) durante la regata.
    // Un "shift" e' un cambio sostenuto >= WIND_SHIFT_MIN_DEG che dura
    // almeno WIND_SHIFT_MIN_DURATION_S secondi (per filtrare oscillazioni).
    //
    // Algoritmo:
    //   1. Smoothing TWD con media vettoriale finestra 60 secondi
    //   2. Per ogni punto, confronto TWD smooth ora vs TWD smooth 5 minuti fa
    //   3. Se delta >= soglia, segno l'evento ma confermo che persista
    //      almeno WIND_SHIFT_MIN_DURATION_S
    //   4. Tipo: 'right' (destra rispetto a chi naviga in upwind) o 'left'
    //
    // Convenzione: shift positivo (TWD aumenta) = "shift a destra"
    //              shift negativo (TWD diminuisce) = "shift a sinistra"
    //              gestendo wrap 0/360.
    // -------------------------------------------------------------------
    const WIND_SHIFT_MIN_DEG = 10;
    const WIND_SHIFT_MIN_DURATION_S = 60;
    const WIND_SHIFT_LOOKBACK_S = 300;  // confronto vento ora vs 5min fa
    const WIND_SHIFT_SMOOTH_S = 60;     // smooth window per togliere noise

    function detectWindShifts(points) {
        const shifts = [];
        if (points.length < 30) return shifts;

        // Smoothing TWD con media vettoriale (sin/cos, gestisce wraparound)
        const twdSmooth = new Array(points.length).fill(null);
        for (let i = 0; i < points.length; i++) {
            const ti = points[i].ts.getTime();
            let sumS = 0, sumC = 0, n = 0;
            for (let j = i; j >= 0; j--) {
                if (points[j].twd == null) continue;
                if (ti - points[j].ts.getTime() > WIND_SHIFT_SMOOTH_S * 1000) break;
                const r = points[j].twd * Math.PI / 180;
                sumS += Math.sin(r); sumC += Math.cos(r); n++;
            }
            if (n >= 3) {
                twdSmooth[i] = ((Math.atan2(sumS, sumC) * 180 / Math.PI) + 360) % 360;
            }
        }

        // Detection: trovo dove TWD differisce di >= WIND_SHIFT_MIN_DEG da 5 min fa
        // e l'evento persiste >= WIND_SHIFT_MIN_DURATION_S.
        // Per evitare di segnare 200 shifts su uno stesso evento, raggruppo
        // shift consecutivi entro 2*lookback.
        let lastShiftIdx = -Infinity;
        for (let i = 0; i < points.length; i++) {
            if (twdSmooth[i] == null) continue;
            const ti = points[i].ts.getTime();
            // Trovo il primo punto >= 5 min fa
            let pastIdx = -1;
            for (let j = i - 1; j >= 0; j--) {
                if (twdSmooth[j] == null) continue;
                if (ti - points[j].ts.getTime() >= WIND_SHIFT_LOOKBACK_S * 1000) {
                    pastIdx = j; break;
                }
            }
            if (pastIdx === -1) continue;
            // Delta circolare [-180, +180]
            let delta = ((twdSmooth[i] - twdSmooth[pastIdx] + 540) % 360) - 180;
            if (Math.abs(delta) < WIND_SHIFT_MIN_DEG) continue;

            // Confermo persistenza: nei prossimi MIN_DURATION_S, il delta
            // resta dello stesso segno con magnitudo >= 0.7 della soglia
            let persists = true;
            for (let k = i + 1; k < points.length; k++) {
                if (twdSmooth[k] == null) continue;
                if (points[k].ts.getTime() - ti > WIND_SHIFT_MIN_DURATION_S * 1000) break;
                let dk = ((twdSmooth[k] - twdSmooth[pastIdx] + 540) % 360) - 180;
                if (Math.sign(dk) !== Math.sign(delta) ||
                    Math.abs(dk) < WIND_SHIFT_MIN_DEG * 0.7) {
                    persists = false; break;
                }
            }
            if (!persists) continue;

            // Cooldown: non segno un nuovo shift entro 2*lookback dal precedente
            if (i - lastShiftIdx < (2 * WIND_SHIFT_LOOKBACK_S * 1000) /
                Math.max(1000, points[1].ts.getTime() - points[0].ts.getTime())) {
                continue;
            }
            lastShiftIdx = i;

            shifts.push({
                idx: i,
                ts: points[i].ts,
                from_twd: twdSmooth[pastIdx],
                to_twd: twdSmooth[i],
                delta_deg: delta,
                direction: delta > 0 ? 'right' : 'left',
            });
        }
        return shifts;
    }

    // -------------------------------------------------------------------
    // SAIL USAGE: REAL vs THEORETICAL
    // Per ogni punto della traccia:
    //   - sail_real = quale vela e' davvero armata (campo "sail" del CSV)
    //   - sail_theory = quale dovrebbe essere armata secondo polar.sails
    // Confronto: percentuale di tempo "in vela giusta" + lista di "miss",
    // cioe' periodi in cui sei stato sulla vela sbagliata > 30s.
    //
    // Richiede:
    //   - Tracker che logga campo "sail" (o "current_sail") nel CSV
    //   - Polare con sezione "sails.crossover"
    //
    // Se manca uno dei due, ritorna null e il render non mostra la sezione.
    // -------------------------------------------------------------------
    const SAIL_MISS_MIN_DURATION_S = 30;

    function computeSailUsage(points, polarLookup) {
        if (!polarLookup || !polarLookup.hasSails || !polarLookup.lookupSail) return null;
        // Almeno un punto deve avere il campo sail (o alias) per giustificare
        // l'analisi. Se nessuno ce l'ha, ritorno null e il render salta.
        const hasSailField = points.some(p => p.sail != null && p.sail !== '');
        if (!hasSailField) return null;

        let totalSeconds = 0;
        let matchSeconds = 0;
        const misses = [];  // {startIdx, endIdx, duration_s, real, theory}

        let currentMissStart = null;
        let currentMissReal = null;
        let currentMissTheory = null;

        for (let i = 1; i < points.length; i++) {
            const p = points[i];
            const dt = (p.ts.getTime() - points[i - 1].ts.getTime()) / 1000;
            if (dt <= 0 || dt > 60) continue;  // ignora gap > 60s
            if (p.tws == null || p.twa == null) continue;
            const theorySail = polarLookup.lookupSail(p.tws, p.twa);
            const realSail = p.sail;
            if (!theorySail || !realSail) continue;

            totalSeconds += dt;
            const theoryKey = theorySail.key;
            // Match: in genere serve match esatto. Tolerante: case-insensitive
            // e spazi tolti.
            const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, '');
            const isMatch = norm(realSail) === norm(theoryKey);
            if (isMatch) {
                matchSeconds += dt;
                // Chiudo eventuale miss in corso
                if (currentMissStart != null) {
                    const missDur = (points[i - 1].ts.getTime() -
                        points[currentMissStart].ts.getTime()) / 1000;
                    if (missDur >= SAIL_MISS_MIN_DURATION_S) {
                        misses.push({
                            startIdx: currentMissStart,
                            endIdx: i - 1,
                            duration_s: missDur,
                            real: currentMissReal,
                            theory: currentMissTheory,
                        });
                    }
                    currentMissStart = null;
                }
            } else {
                if (currentMissStart == null) {
                    currentMissStart = i;
                    currentMissReal = realSail;
                    currentMissTheory = theoryKey;
                }
            }
        }
        // Chiudi miss aperto a fine traccia
        if (currentMissStart != null) {
            const last = points[points.length - 1];
            const missDur = (last.ts.getTime() -
                points[currentMissStart].ts.getTime()) / 1000;
            if (missDur >= SAIL_MISS_MIN_DURATION_S) {
                misses.push({
                    startIdx: currentMissStart,
                    endIdx: points.length - 1,
                    duration_s: missDur,
                    real: currentMissReal,
                    theory: currentMissTheory,
                });
            }
        }

        return {
            totalSeconds: totalSeconds,
            matchSeconds: matchSeconds,
            matchPct: totalSeconds > 0 ? (matchSeconds / totalSeconds) * 100 : null,
            misses: misses,
            missCount: misses.length,
            totalMissSeconds: misses.reduce((s, m) => s + m.duration_s, 0),
        };
    }


    // Per ogni leg upwind, calcolo il tempo speso "sopra layline" cioe' il
    // tempo perso oltre il punto in cui sarebbe stato ottimale virare.
    //
    // Algoritmo:
    //   1. Per ogni leg upwind del percorso, identifico il mark target
    //   2. Calcolo l'angolo TWA optimal upwind dalla polare al TWS medio del leg
    //   3. Per ogni punto del leg, calcolo "bearing al mark - heading"
    //   4. Se la barca e' sopra layline (overshoot) cumulo i secondi
    //
    // Una barca e' "in overstand" quando, dopo aver virato in chiusura, sarebbe
    // sopra il mark con un margine eccessivo. Approssimo cosi':
    //   - Bearing dal punto al prossimo waypoint = brg
    //   - TWA = brg - twd (con segno)
    //   - Se |TWA| > optimalUpTwa + 5°, sei in overstand
    //   (5° di tolleranza per non flaggare ogni piccolo wobble)
    // -------------------------------------------------------------------
    const OVERSTAND_TOLERANCE_DEG = 5;

    function computeOverstandAnalysis(points, legs, polarLookup) {
        const result = {
            totalOverstandSec: 0,
            perLeg: [],
        };
        if (!legs || legs.length === 0) return result;

        legs.forEach((leg, legIdx) => {
            // Considero solo leg upwind (TWA medio < 90 in modulo)
            const isUpwind = Math.abs(leg.avgTwa || 0) < 80;
            if (!isUpwind) return;
            // Target waypoint: il leg ha targetWp con lat/lon
            if (!leg.targetWp || leg.targetWp.lat == null) return;
            const tgt = leg.targetWp;
            // TWA optimal upwind alla TWS media del leg (dalla polare)
            let optimalUpTwa = null;
            if (polarLookup && leg.avgTws != null) {
                const t = polarLookup.targetsFor(leg.avgTws);
                if (t && t.upTwa) optimalUpTwa = t.upTwa;
            }
            if (optimalUpTwa == null) optimalUpTwa = 40;  // fallback ragionevole

            let overstandSec = 0;
            let overstandStart = null;
            const overstandWindows = [];
            for (let i = leg.startIdx; i <= leg.endIdx && i < points.length; i++) {
                const p = points[i];
                if (p.lat == null || p.twd == null) continue;
                const brg = bearingDeg(p.lat, p.lon, tgt.lat, tgt.lon);
                // TWA al mark = brg - twd (segno indica mure)
                let twaToMark = ((brg - p.twd + 540) % 360) - 180;
                // Sopra layline = andresti in upwind con TWA piu' aperto del target
                if (Math.abs(twaToMark) > optimalUpTwa + OVERSTAND_TOLERANCE_DEG) {
                    if (overstandStart == null) overstandStart = i;
                } else {
                    if (overstandStart != null) {
                        const dt = (p.ts.getTime() - points[overstandStart].ts.getTime()) / 1000;
                        if (dt > 5) {  // ignora episodi < 5s
                            overstandSec += dt;
                            overstandWindows.push({
                                startIdx: overstandStart,
                                endIdx: i,
                                duration_s: dt,
                            });
                        }
                        overstandStart = null;
                    }
                }
            }
            // Eventuale overstand aperto a fine leg
            if (overstandStart != null) {
                const last = points[Math.min(leg.endIdx, points.length - 1)];
                const dt = (last.ts.getTime() - points[overstandStart].ts.getTime()) / 1000;
                if (dt > 5) {
                    overstandSec += dt;
                    overstandWindows.push({
                        startIdx: overstandStart,
                        endIdx: leg.endIdx,
                        duration_s: dt,
                    });
                }
            }

            result.perLeg.push({
                legIdx: legIdx,
                legName: leg.name || ('Leg ' + (legIdx + 1)),
                overstand_s: overstandSec,
                episodes: overstandWindows.length,
                episodes_detail: overstandWindows,
                optimalUpTwa: optimalUpTwa,
                avgTws: leg.avgTws,
            });
            result.totalOverstandSec += overstandSec;
        });
        return result;
    }


    // Algoritmo: scorro i punti, cerco eventi "TWA cambia segno" e
    // verifico che il delta totale (TWA al punto T-3s vs TWA al punto T+3s)
    // superi TACK_DELTA_MIN_DEG. Marco l'evento al punto centrale e provo a
    // delimitare l'intervallo [start, end] usando TWA che si stabilizza
    // (variazione < 5 gradi per 3 secondi consecutivi).
    // -------------------------------------------------------------------
    function detectManeuvers(points) {
        const events = [];
        if (points.length < 10) return events;

        // -----------------------------------------------------------------
        // STEP 1: SMOOTHING di HDG e TWA con media vettoriale finestra 5s.
        // La media vettoriale (sin/cos) gestisce correttamente il wraparound
        // a 0/360 (HDG) e -180/+180 (TWA). Senza smoothing, il rumore del
        // sensore di vento o GPS produce salti di segno spuri.
        // -----------------------------------------------------------------
        const smoothCircular = (points, getter, windowS) => {
            const out = new Array(points.length).fill(null);
            for (let i = 0; i < points.length; i++) {
                const ti = points[i].ts.getTime();
                let sumS = 0, sumC = 0, n = 0;
                for (let j = i; j >= 0; j--) {
                    const v = getter(points[j]);
                    if (v == null) continue;
                    if (ti - points[j].ts.getTime() > windowS * 1000) break;
                    const r = v * Math.PI / 180;
                    sumS += Math.sin(r); sumC += Math.cos(r); n++;
                }
                // estendo anche in avanti per centrare la finestra
                for (let j = i + 1; j < points.length; j++) {
                    const v = getter(points[j]);
                    if (v == null) continue;
                    if (points[j].ts.getTime() - ti > windowS * 1000) break;
                    const r = v * Math.PI / 180;
                    sumS += Math.sin(r); sumC += Math.cos(r); n++;
                }
                if (n >= 2) {
                    out[i] = Math.atan2(sumS, sumC) * 180 / Math.PI;
                }
            }
            return out;
        };
        // HDG smooth: 0..360. TWA smooth: -180..+180.
        // La media vettoriale ritorna [-180..180], che e' OK per TWA.
        // Per HDG normalizzo a [0..360).
        const hdgSrc = (p) => p.hdg != null ? p.hdg : p.cog;  // fallback COG
        const hdgRaw = smoothCircular(points, hdgSrc, MANEUVER_SMOOTH_S);
        const hdgSmooth = hdgRaw.map(v => v == null ? null : ((v % 360) + 360) % 360);
        const twaSmooth = smoothCircular(points, p => p.twa, MANEUVER_SMOOTH_S);

        // -----------------------------------------------------------------
        // STEP 2: CANDIDATI da heading change.
        // Per ogni punto, calcolo il delta heading "rolling" su finestra
        // MANEUVER_HDG_WINDOW_S secondi (20s di default). Se delta >=
        // MANEUVER_HDG_DELTA_MIN_DEG (50°), e' candidato manovra.
        // Il delta e' il piu' grande cambio di heading nella finestra.
        // -----------------------------------------------------------------
        const dHdg = new Array(points.length).fill(0);
        for (let i = 0; i < points.length; i++) {
            if (hdgSmooth[i] == null) continue;
            const ti = points[i].ts.getTime();
            // Trova min e max HDG nella finestra ±halfWindow (windowSec totale)
            const halfWindow = MANEUVER_HDG_WINDOW_S * 1000 / 2;
            let referenceHdg = hdgSmooth[i];
            let maxAbsDelta = 0;
            for (let j = Math.max(0, i - 100); j < Math.min(points.length, i + 100); j++) {
                if (hdgSmooth[j] == null) continue;
                const dt = Math.abs(points[j].ts.getTime() - ti);
                if (dt > halfWindow) continue;
                let d = ((hdgSmooth[j] - referenceHdg + 540) % 360) - 180;
                if (Math.abs(d) > maxAbsDelta) maxAbsDelta = Math.abs(d);
            }
            dHdg[i] = maxAbsDelta;
        }

        // -----------------------------------------------------------------
        // STEP 3: PICCHI di dHdg = manovre candidate.
        // Cerco indici dove dHdg supera la soglia ed e' un massimo locale
        // (non un plateau). Tra picchi vicini < MANEUVER_DEDUP_S, tengo
        // quello con dHdg maggiore.
        // -----------------------------------------------------------------
        const candidates = [];
        for (let i = 1; i < points.length - 1; i++) {
            if (dHdg[i] < MANEUVER_HDG_DELTA_MIN_DEG) continue;
            // Picco locale: dHdg[i] >= dHdg[i-1] e dHdg[i] >= dHdg[i+1]
            // Uso disuguaglianza non-stretta per gestire plateau, poi dedup
            if (dHdg[i] >= dHdg[i - 1] && dHdg[i] >= dHdg[i + 1]) {
                candidates.push({ idx: i, dHdg: dHdg[i] });
            }
        }
        // Dedup: tengo solo il candidato con dHdg max in finestre di
        // MANEUVER_DEDUP_S secondi
        const filteredCandidates = [];
        for (const c of candidates) {
            const tc = points[c.idx].ts.getTime();
            const last = filteredCandidates[filteredCandidates.length - 1];
            if (last && (tc - points[last.idx].ts.getTime()) < MANEUVER_DEDUP_S * 1000) {
                // Tieni quello con delta maggiore
                if (c.dHdg > last.dHdg) {
                    filteredCandidates[filteredCandidates.length - 1] = c;
                }
            } else {
                filteredCandidates.push(c);
            }
        }

        // -----------------------------------------------------------------
        // STEP 4: PER OGNI CANDIDATO, costruisco l'evento finale:
        //   - startIdx: dove HDG comincia a cambiare (cerco indietro)
        //   - endIdx: dove HDG si stabilizza (cerco avanti)
        //   - twaBefore/After: media TWA in finestra ±10s prima/dopo
        //   - type: tack se entrambe le medie sono in modulo < GYBE_TWA_THRESHOLD,
        //            gybe se entrambe > GYBE_TWA_THRESHOLD. Se mistura, scelgo
        //            in base alla media in modulo (raro, succede con bear-away
        //            estremi - meglio classificare come gybe).
        //   - durata: endIdx.ts - startIdx.ts
        //   - vmgIn: VMG medio nella finestra (per ranking, gia' presente)
        // -----------------------------------------------------------------
        const RATE_THRESHOLD_DEG_S = 2.5;  // sotto questo, HDG si considera stabile
        for (const cand of filteredCandidates) {
            const i = cand.idx;
            const ti = points[i].ts.getTime();

            // startIdx: torno indietro fino a quando il rate di cambio HDG
            // (deg/s, calcolato su 2 secondi) e' < threshold
            let startIdx = i;
            for (let j = i - 1; j >= Math.max(0, i - 60); j--) {
                if (hdgSmooth[j] == null) continue;
                // rate = abs(deltaHdg) / dt nei 2s precedenti
                let kBack = j;
                while (kBack > 0 &&
                       points[j].ts.getTime() - points[kBack].ts.getTime() < 2000) {
                    kBack--;
                }
                if (hdgSmooth[kBack] == null) { startIdx = j; continue; }
                const dt = (points[j].ts.getTime() - points[kBack].ts.getTime()) / 1000;
                if (dt <= 0) continue;
                const dh = Math.abs(((hdgSmooth[j] - hdgSmooth[kBack] + 540) % 360) - 180);
                const rate = dh / dt;
                if (rate < RATE_THRESHOLD_DEG_S) {
                    startIdx = j;
                    break;
                }
                startIdx = j;
            }

            // endIdx: vado avanti fino a quando rate < threshold
            let endIdx = i;
            for (let j = i + 1; j < Math.min(points.length, i + 60); j++) {
                if (hdgSmooth[j] == null) continue;
                let kFwd = j;
                while (kFwd < points.length - 1 &&
                       points[kFwd].ts.getTime() - points[j].ts.getTime() < 2000) {
                    kFwd++;
                }
                if (hdgSmooth[kFwd] == null) { endIdx = j; continue; }
                const dt = (points[kFwd].ts.getTime() - points[j].ts.getTime()) / 1000;
                if (dt <= 0) continue;
                const dh = Math.abs(((hdgSmooth[kFwd] - hdgSmooth[j] + 540) % 360) - 180);
                const rate = dh / dt;
                if (rate < RATE_THRESHOLD_DEG_S) {
                    endIdx = j;
                    break;
                }
                endIdx = j;
            }

            const durationS = (points[endIdx].ts.getTime() -
                               points[startIdx].ts.getTime()) / 1000;
            if (durationS < MANEUVER_MIN_DURATION_S) continue;

            // -----------------------------------------------------------------
            // CLASSIFICAZIONE TACK vs GYBE: usa MEDIA TWA in finestra prima
            // e dopo (10s rispettivamente), che e' robusta contro outlier
            // del singolo punto. Media vettoriale per gestire wraparound.
            // -----------------------------------------------------------------
            const meanTwaInWindow = (centerIdx, dirSign) => {
                // dirSign: -1 cerca all'indietro, +1 in avanti
                let sumS = 0, sumC = 0, n = 0;
                const center_t = points[centerIdx].ts.getTime();
                const offset = dirSign < 0 ? -10000 : 10000;
                const lo = dirSign < 0 ? center_t + offset : center_t;
                const hi = dirSign < 0 ? center_t : center_t + offset;
                for (let k = 0; k < points.length; k++) {
                    const tk = points[k].ts.getTime();
                    if (tk < lo || tk > hi) continue;
                    if (twaSmooth[k] == null) continue;
                    const r = twaSmooth[k] * Math.PI / 180;
                    sumS += Math.sin(r); sumC += Math.cos(r); n++;
                }
                if (n < 2) return null;
                return Math.atan2(sumS, sumC) * 180 / Math.PI;
            };
            const twaBefore = meanTwaInWindow(startIdx, -1);
            const twaAfter = meanTwaInWindow(endIdx, +1);

            // Senza TWA non posso classificare, ma posso comunque registrare
            // come "manovra generica" (raro, capita se sensore vento e' KO)
            let type;
            if (twaBefore != null && twaAfter != null) {
                const absBefore = Math.abs(twaBefore);
                const absAfter = Math.abs(twaAfter);
                // Gybe: entrambi gli angoli > soglia poppa (vento da poppa),
                // o anche solo uno se l'altro e' molto sopra soglia.
                const meanAbs = (absBefore + absAfter) / 2;
                type = meanAbs > GYBE_TWA_THRESHOLD ? 'gybe' : 'tack';
            } else {
                // Fallback: heuristic basato sull'ampiezza heading.
                // Tack tipicamente cambia heading di 70-90°. Gybe di 130-180°.
                type = cand.dHdg > 110 ? 'gybe' : 'tack';
            }

            // VMG in (per il rank successivo): velocita' efficace verso il vento
            // durante la manovra. Usato dal modulo rankManeuvers a valle.
            let inSum = 0, inCount = 0;
            for (let k = startIdx; k <= endIdx; k++) {
                if (points[k].stw != null && points[k].twa != null) {
                    inSum += Math.abs(points[k].stw *
                              Math.cos(points[k].twa * Math.PI / 180));
                    inCount++;
                }
            }
            const vmgIn = inCount > 0 ? inSum / inCount : 0;

            // TWS medio nella finestra (per stat & ranking)
            let twsAvg = 0, twsCount = 0;
            for (let k = startIdx; k <= endIdx; k++) {
                if (points[k].tws != null) { twsAvg += points[k].tws; twsCount++; }
            }
            twsAvg = twsCount > 0 ? twsAvg / twsCount : null;

            events.push({
                idx: i,
                ts: points[i].ts,
                type: type,
                twaBefore: twaBefore,
                twaAfter: twaAfter,
                durationS: durationS,
                vmgIn: vmgIn,
                twsAvg: twsAvg,
                startIdx: startIdx,
                endIdx: endIdx,
                hdgDelta: cand.dHdg,  // utile per debug/ranking
            });
        }
        return events;
    }

    // -------------------------------------------------------------------
    // MANEUVER RANKING
    // Per ogni manovra calcolo metriche piu' raffinate per ranking:
    //   - speedBefore: velocita' media nei 5s prima
    //   - speedMin: velocita' minima durante la manovra
    //   - speedAfter: velocita' media nei 5s dopo
    //   - recoveryDelta: speedAfter - speedBefore (negativo = recupero non completo)
    //   - speedLossKn = speedBefore - speedMin
    //   - score: combinazione (piu' alto = meglio)
    //
    // Score formula (semplice ma indicativo):
    //   100 - (speedLossKn * 10) - max(0, -recoveryDelta) * 20
    // = parto da 100, tolgo 10 punti per ogni nodo perso al minimo, tolgo
    //   20 punti per ogni nodo non recuperato. Cap a [0, 100].
    //
    // Tornaa un array di maneuver con i campi sopra aggiunti, ORDINATI per
    // score decrescente (i migliori per primi). Mantiene l'idx originale
    // cosi' replay.js puo' linkare al cursor.
    // -------------------------------------------------------------------
    function rankManeuvers(maneuvers, points) {
        return maneuvers.map(m => {
            const startMs = points[m.startIdx].ts.getTime();
            const endMs = points[m.endIdx].ts.getTime();
            // Speed before: 5 secondi prima di startIdx
            let sumB = 0, nB = 0;
            for (let i = m.startIdx; i >= 0; i--) {
                if (startMs - points[i].ts.getTime() > 5000) break;
                if (points[i].sog != null) { sumB += points[i].sog; nB++; }
            }
            const speedBefore = nB > 0 ? sumB / nB : null;

            // Speed min during maneuver
            let speedMin = Infinity;
            for (let i = m.startIdx; i <= m.endIdx && i < points.length; i++) {
                if (points[i].sog != null && points[i].sog < speedMin) {
                    speedMin = points[i].sog;
                }
            }
            if (speedMin === Infinity) speedMin = null;

            // Speed after: 5 secondi dopo endIdx
            let sumA = 0, nA = 0;
            for (let i = m.endIdx; i < points.length; i++) {
                if (points[i].ts.getTime() - endMs > 5000) break;
                if (points[i].sog != null) { sumA += points[i].sog; nA++; }
            }
            const speedAfter = nA > 0 ? sumA / nA : null;

            const speedLossKn = (speedBefore != null && speedMin != null)
                ? speedBefore - speedMin : null;
            const recoveryDelta = (speedAfter != null && speedBefore != null)
                ? speedAfter - speedBefore : null;

            let score = 100;
            if (speedLossKn != null) score -= speedLossKn * 10;
            if (recoveryDelta != null && recoveryDelta < 0) score -= (-recoveryDelta) * 20;
            score = Math.max(0, Math.min(100, score));

            return Object.assign({}, m, {
                speedBefore: speedBefore,
                speedMin: speedMin,
                speedAfter: speedAfter,
                speedLossKn: speedLossKn,
                recoveryDelta: recoveryDelta,
                score: score,
            });
        }).sort((a, b) => b.score - a.score);  // best to worst
    }

    // -------------------------------------------------------------------
    // DETECTION LEG (segmenti tra waypoints).
    // Logica: parto col primo waypoint del file come "destination corrente".
    // Quando la traccia passa entro MARK_ROUNDING_RADIUS_M, considero la boa
    // raggiunta e passo al waypoint successivo. Il leg precedente e' chiuso
    // e marcato con [startIdx, endIdx, fromWp, toWp].
    //
    // Se waypoints non e' fornito o non e' valido, ritorno un singolo "leg"
    // che copre tutta la traccia.
    // -------------------------------------------------------------------
    function detectLegs(points, waypoints) {
        if (!points.length) return [];

        // Parsing waypoints in formato { name, lat, lon } -- delego a
        // SailingCoord.validateWaypointsJson che restituisce gia' un
        // array [{name, lat, lon, ...}] in coordinate decimali.
        let wpts = [];
        if (waypoints && window.SailingCoord && window.SailingCoord.validateWaypointsJson) {
            try {
                wpts = window.SailingCoord.validateWaypointsJson(waypoints);
            } catch (e) {
                wpts = [];
            }
        }

        // Se non ho waypoints, faccio un singolo leg
        if (wpts.length < 1) {
            return [{
                from: { name: '(start)', lat: points[0].lat, lon: points[0].lon },
                to:   { name: '(end)',   lat: points[points.length-1].lat, lon: points[points.length-1].lon },
                startIdx: 0,
                endIdx: points.length - 1,
                fromWpIdx: -1,
                toWpIdx:   -1,
            }];
        }

        const legs = [];
        let curWpIdx = 0; // sto puntando a wpts[0]
        let legStart = 0;
        let legStartWp = { name: '(start)', lat: points[0].lat, lon: points[0].lon };

        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            if (p.lat == null || p.lon == null) continue;
            const wp = wpts[curWpIdx];
            if (!wp) break;
            const d = haversineMeters(p.lat, p.lon, wp.lat, wp.lon);
            if (d <= MARK_ROUNDING_RADIUS_M) {
                // Boa raggiunta -> chiudo leg
                legs.push({
                    from: legStartWp,
                    to:   { name: wp.name, lat: wp.lat, lon: wp.lon },
                    startIdx: legStart,
                    endIdx:   i,
                    fromWpIdx: curWpIdx - 1,
                    toWpIdx:   curWpIdx,
                });
                legStart = i;
                legStartWp = { name: wp.name, lat: wp.lat, lon: wp.lon };
                curWpIdx++;
                if (curWpIdx >= wpts.length) break;
            }
        }
        // Se non ho mai raggiunto l'ultima boa, aggiungo un leg "pendente"
        // dall'ultimo punto raggiunto fino alla fine della traccia.
        if (legStart < points.length - 1) {
            legs.push({
                from: legStartWp,
                to:   { name: '(fine traccia)', lat: points[points.length-1].lat, lon: points[points.length-1].lon },
                startIdx: legStart,
                endIdx:   points.length - 1,
                fromWpIdx: curWpIdx - 1,
                toWpIdx:   -1,
            });
        }

        return legs;
    }

    // -------------------------------------------------------------------
    // Statistiche per leg
    // -------------------------------------------------------------------
    function computeLegStats(leg, points) {
        const pStart = points[leg.startIdx];
        const pEnd   = points[leg.endIdx];

        // Distanza percorsa: cumulative end - cumulative start
        const distSailed_m = (pEnd.distFromStart_m || 0) - (pStart.distFromStart_m || 0);
        // Distanza ortodromica boa-a-boa
        const distOrtho_m = haversineMeters(leg.from.lat, leg.from.lon, leg.to.lat, leg.to.lon);
        const extraPct = distOrtho_m > 0 ? ((distSailed_m / distOrtho_m) - 1) * 100 : null;

        const durationS = (pEnd.ts.getTime() - pStart.ts.getTime()) / 1000;

        // Medie su tutti i punti del leg
        let sogSum = 0, sogN = 0;
        let stwSum = 0, stwN = 0;
        let twsSum = 0, twsN = 0;
        let twdSum = 0, twdN = 0;
        let polarSum = 0, polarN = 0;
        let vmgSum = 0, vmgN = 0;
        for (let i = leg.startIdx; i <= leg.endIdx; i++) {
            const p = points[i];
            if (p.sog != null) { sogSum += p.sog; sogN++; }
            if (p.stw != null) { stwSum += p.stw; stwN++; }
            if (p.tws != null) { twsSum += p.tws; twsN++; }
            if (p.twd != null) { twdSum += p.twd; twdN++; }
            if (p.polarPct != null && isFinite(p.polarPct)) {
                polarSum += p.polarPct; polarN++;
            }
            if (p.vmgPct != null && isFinite(p.vmgPct)) {
                vmgSum += p.vmgPct; vmgN++;
            }
        }
        return {
            distSailed_m: distSailed_m,
            distOrtho_m: distOrtho_m,
            extraPct: extraPct,
            durationS: durationS,
            sogAvg: sogN > 0 ? sogSum / sogN : null,
            stwAvg: stwN > 0 ? stwSum / stwN : null,
            twsAvg: twsN > 0 ? twsSum / twsN : null,
            twdAvg: twdN > 0 ? twdSum / twdN : null,
            polarPctAvg: polarN > 0 ? polarSum / polarN : null,
            vmgPctAvg: vmgN > 0 ? vmgSum / vmgN : null,
        };
    }

    // -------------------------------------------------------------------
    // RIEPILOGO sessione
    // -------------------------------------------------------------------
    function computeSummary(points, maneuvers, totalDist_m) {
        if (points.length < 2) return null;
        const pStart = points[0];
        const pEnd = points[points.length - 1];
        const durationS = (pEnd.ts.getTime() - pStart.ts.getTime()) / 1000;

        let twsMin = Infinity, twsMax = -Infinity, twsSum = 0, twsN = 0;
        let polarSum = 0, polarN = 0;
        let vmgSum = 0, vmgN = 0;
        let upN = 0, dnN = 0;
        // TWD ha il problema del wraparound (media di 350 e 10 e' 0,
        // non 180). Uso media vettoriale: somma sin/cos, poi atan2.
        let twdSinSum = 0, twdCosSum = 0, twdN = 0;
        for (const p of points) {
            if (p.tws != null) {
                twsSum += p.tws; twsN++;
                if (p.tws < twsMin) twsMin = p.tws;
                if (p.tws > twsMax) twsMax = p.tws;
            }
            if (p.twd != null && isFinite(p.twd)) {
                const r = p.twd * Math.PI / 180;
                twdSinSum += Math.sin(r);
                twdCosSum += Math.cos(r);
                twdN++;
            }
            if (p.polarPct != null && isFinite(p.polarPct)) {
                polarSum += p.polarPct; polarN++;
            }
            if (p.vmgPct != null && isFinite(p.vmgPct)) {
                vmgSum += p.vmgPct; vmgN++;
            }
            if (p.isUpwind === true) upN++;
            if (p.isUpwind === false) dnN++;
        }

        const tackCount = maneuvers.filter(m => m.type === 'tack').length;
        const gybeCount = maneuvers.filter(m => m.type === 'gybe').length;
        const twdAvg = twdN > 0 ?
            ((Math.atan2(twdSinSum, twdCosSum) * 180 / Math.PI) + 360) % 360 :
            null;

        return {
            durationS: durationS,
            startTs: pStart.ts,
            endTs: pEnd.ts,
            totalDist_m: totalDist_m,
            twsAvg: twsN > 0 ? twsSum / twsN : null,
            twsMin: twsMin === Infinity ? null : twsMin,
            twsMax: twsMax === -Infinity ? null : twsMax,
            twdAvg: twdAvg,
            polarPctAvg: polarN > 0 ? polarSum / polarN : null,
            vmgPctAvg: vmgN > 0 ? vmgSum / vmgN : null,
            tackCount: tackCount,
            gybeCount: gybeCount,
            upwindFrac: (upN + dnN) > 0 ? upN / (upN + dnN) : null,
            downwindFrac: (upN + dnN) > 0 ? dnN / (upN + dnN) : null,
        };
    }

    // -------------------------------------------------------------------
    // ENTRY POINT pubblico
    // -------------------------------------------------------------------
    function buildAnalysis(points, polar, waypoints) {
        if (!points || points.length < 2) {
            return { ok: false, reason: 'Traccia troppo corta' };
        }

        const polarLookup = makePolarLookup(polar);
        const totalDist_m = enrichPoints(points, polarLookup);
        const maneuvers = detectManeuvers(points);
        const legs = detectLegs(points, waypoints);
        const legStats = legs.map(leg => ({
            leg: leg,
            stats: computeLegStats(leg, points),
        }));
        const summary = computeSummary(points, maneuvers, totalDist_m);

        // === Nuove analisi (turno post-race feature pack) ===
        // Wind shift detection, overstand, ranking manovre, sail usage real
        const windShifts = detectWindShifts(points);
        // Overstand: passo le legs flat per legare al targetWp
        const flatLegsForOverstand = legStats.map(ls => ({
            startIdx: ls.leg.startIdx,
            endIdx: ls.leg.endIdx,
            avgTwa: ls.stats ? ls.stats.avgTwa : null,
            avgTws: ls.stats ? ls.stats.avgTws : null,
            targetWp: ls.leg.toWp || null,
            name: ls.leg.name || null,
        }));
        const overstand = computeOverstandAnalysis(points, flatLegsForOverstand, polarLookup);
        const maneuverRanking = rankManeuvers(maneuvers, points);
        const sailUsage = computeSailUsage(points, polarLookup);

        return {
            ok: true,
            polarLookup: polarLookup,
            totalDist_m: totalDist_m,
            summary: summary,
            legs: legStats,
            maneuvers: maneuvers,
            // Nuove sezioni
            windShifts: windShifts,
            overstand: overstand,
            maneuverRanking: maneuverRanking,
            sailUsage: sailUsage,
        };
    }

    // -------------------------------------------------------------------
    // Helpers di formattazione (usati da replay.js per popolare i tab)
    // -------------------------------------------------------------------
    function formatDuration(seconds) {
        if (seconds == null || !isFinite(seconds)) return '--';
        const s = Math.round(seconds);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        if (h > 0) return `${h}h ${m}m`;
        if (m > 0) return `${m}m ${sec}s`;
        return `${sec}s`;
    }

    function formatNm(meters, decimals) {
        if (meters == null) return '--';
        const d = decimals != null ? decimals : 2;
        return (meters * M_TO_NM).toFixed(d) + ' NM';
    }

    function formatPct(value, decimals) {
        if (value == null || !isFinite(value)) return '--';
        const d = decimals != null ? decimals : 1;
        return value.toFixed(d) + '%';
    }

    function formatDeg(value, decimals) {
        if (value == null || !isFinite(value)) return '--';
        const d = decimals != null ? decimals : 0;
        return value.toFixed(d) + '°';
    }

    function formatKn(value, decimals) {
        if (value == null || !isFinite(value)) return '--';
        const d = decimals != null ? decimals : 1;
        return value.toFixed(d) + ' kn';
    }

    /** "Buono / Medio / Scarso" per %polare e %target VMG.
     *  Soglie: > 95% buono, 85-95 medio, < 85 scarso. */
    function ratingClass(pct) {
        if (pct == null || !isFinite(pct)) return '';
        if (pct >= 95) return 'good';
        if (pct >= 85) return 'warn';
        return 'bad';
    }

    // -------------------------------------------------------------------
    // Espongo come globale
    // -------------------------------------------------------------------
    window.SailingAnalysis = {
        buildAnalysis: buildAnalysis,
        // Factory polar lookup esposta separatamente: serve a polarview.js
        // che vuole disegnare il polar plot SENZA traccia (solo curve teoriche)
        // e quindi non puo' passare per buildAnalysis (richiede points).
        buildPolarLookup: makePolarLookup,
        // Helpers per il render
        formatDuration: formatDuration,
        formatNm: formatNm,
        formatPct: formatPct,
        formatDeg: formatDeg,
        formatKn: formatKn,
        ratingClass: ratingClass,
        // Constanti esposte (utili per turno 2: polar plot, lift/header)
        constants: {
            TACK_DELTA_MIN_DEG: TACK_DELTA_MIN_DEG,
            GYBE_TWA_THRESHOLD: GYBE_TWA_THRESHOLD,
            MARK_ROUNDING_RADIUS_M: MARK_ROUNDING_RADIUS_M,
        },
        // Utility geo riusabili
        haversineMeters: haversineMeters,
        bearingDeg: bearingDeg,
    };
})();
