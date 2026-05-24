/**
 * Sailing Cloud - utility per formato coordinate nautiche.
 *
 * Il file waypoints.json del tablet usa il formato:
 *   "lat": "45°46.154'N"
 *   "lon": "13°36.165'E"
 *
 * Queste funzioni convertono da/a decimale per i calcoli interni
 * (es. disegno mappa Leaflet che richiede gradi decimali).
 */

(function() {
    /**
     * Parse "45°46.154'N" -> 45.769233
     *
     * Accetta varianti tolleranti:
     *   "45°46.154'N"      (canonico)
     *   "45 46.154 N"      (spazi)
     *   "45° 46.154' N"    (spazi extra)
     *   "45°46.154N"       (no apostrofo)
     *   "-45.769233"       (decimale plain - per migrazione vecchi file)
     *
     * Restituisce numero (negativo per S/W). Throws se invalid.
     */
    function parseDM(s) {
        if (s == null) throw new Error('Coordinata mancante');
        const str = String(s).trim();
        if (str === '') throw new Error('Coordinata vuota');

        // Caso 1: numero puro (vecchio formato decimale)
        const asNum = parseFloat(str);
        if (!isNaN(asNum) && /^-?[\d.]+$/.test(str)) {
            return asNum;
        }

        // Caso 2: formato DM "45°46.154'N" (e varianti)
        const m = str.toUpperCase().match(
            /^\s*(\d+)\s*[°\s]\s*([\d.]+)\s*['′\s]?\s*([NSEW])\s*$/
        );
        if (!m) {
            throw new Error(
                `Formato non riconosciuto: ${JSON.stringify(s)}\n` +
                `Atteso es. "45°46.154'N" oppure decimale "45.769233"`
            );
        }
        const deg = parseInt(m[1], 10);
        const min = parseFloat(m[2]);
        const hem = m[3];

        if (deg < 0 || min < 0 || min >= 60) {
            throw new Error(`Valori fuori range: ${s}`);
        }

        let val = deg + min / 60.0;
        if (hem === 'S' || hem === 'W') val = -val;
        return val;
    }

    /**
     * Format 45.769233, 'lat' -> "45°46.154'N"
     *
     * axis: 'lat' usa N/S, 'lon' usa E/W. Se omesso, deduce dal segno del valore
     * (default 'lat').
     */
    function formatDM(value, axis) {
        if (typeof value !== 'number' || !isFinite(value)) {
            throw new Error(`Valore non numerico: ${value}`);
        }
        const ax = axis || 'lat';
        let hem;
        if (ax === 'lat') {
            hem = value >= 0 ? 'N' : 'S';
        } else if (ax === 'lon') {
            hem = value >= 0 ? 'E' : 'W';
        } else {
            throw new Error(`axis non valido: ${ax}`);
        }
        const v = Math.abs(value);
        const deg = Math.floor(v);
        const min = (v - deg) * 60.0;
        // Tre decimali sui minuti (precisione ~ 2 metri)
        return `${deg}°${min.toFixed(3)}'${hem}`;
    }

    /**
     * Valida l'intero file waypoints.json.
     * Restituisce { ok: true, waypoints: [...] } se valido, lancia errore altrimenti.
     */
    function validateWaypointsJson(parsed) {
        if (!parsed || typeof parsed !== 'object') {
            throw new Error('Il file deve essere un oggetto JSON');
        }
        if (!Array.isArray(parsed.waypoints)) {
            throw new Error('Manca la chiave "waypoints" (deve essere un array)');
        }
        const out = [];
        parsed.waypoints.forEach((w, i) => {
            const ctx = `waypoint #${i + 1}` + (w.name ? ` (${w.name})` : '');
            if (!w.name) throw new Error(`${ctx}: manca "name"`);
            if (w.lat === undefined) throw new Error(`${ctx}: manca "lat"`);
            if (w.lon === undefined) throw new Error(`${ctx}: manca "lon"`);

            let latNum, lonNum;
            try { latNum = parseDM(w.lat); }
            catch (e) { throw new Error(`${ctx}: lat - ${e.message}`); }
            try { lonNum = parseDM(w.lon); }
            catch (e) { throw new Error(`${ctx}: lon - ${e.message}`); }

            if (latNum < -90 || latNum > 90)
                throw new Error(`${ctx}: latitudine fuori range [-90, +90]: ${latNum}`);
            if (lonNum < -180 || lonNum > 180)
                throw new Error(`${ctx}: longitudine fuori range [-180, +180]: ${lonNum}`);

            out.push({
                name: w.name,
                latRaw: w.lat,        // formato originale (per display)
                lonRaw: w.lon,
                lat: latNum,          // decimale (per Leaflet)
                lon: lonNum,
                side: w.side || null,
            });
        });
        return out;
    }

    /**
     * Valida l'intero file polar.json.
     * Restituisce un riepilogo strutturato:
     *   { ok: true, boat_name, twsList: [6,8,...], twaList: [30,...,180],
     *     maxSpeed, count, sampleRows: [[label, [v1,v2,...]],...] }
     * Lancia errore se invalid.
     */
    function validatePolarJson(parsed) {
        if (!parsed || typeof parsed !== 'object') {
            throw new Error('Il file deve essere un oggetto JSON');
        }
        if (!('polar' in parsed) || typeof parsed.polar !== 'object' || parsed.polar === null) {
            throw new Error('Manca la chiave "polar" (deve essere un oggetto)');
        }
        const boatName = parsed.boat_name === undefined ? '' : String(parsed.boat_name || '');
        const polar = parsed.polar;

        // Estraggo TWS (chiavi esterne) come numeri ordinati
        const twsList = Object.keys(polar).map(k => {
            const n = parseFloat(k);
            if (!isFinite(n)) {
                throw new Error(`Chiave TWS non numerica: "${k}"`);
            }
            if (n < 0 || n > 100) {
                throw new Error(`TWS fuori range [0, 100]: ${n}`);
            }
            return n;
        }).sort((a, b) => a - b);

        if (twsList.length === 0) {
            throw new Error('Nessun valore TWS nella polare');
        }

        // Per ogni TWS verifico TWA + valori
        let twaSet = null;  // set TWA atteso (preso dal primo TWS)
        let maxSpeed = 0;
        let count = 0;

        for (const tws of twsList) {
            const twsKey = String(tws.toFixed(1));
            // Le chiavi originali potrebbero essere "6.0" o "6": cerco entrambe
            let row = polar[twsKey];
            if (row === undefined) {
                row = polar[String(tws)];
            }
            if (row === undefined) {
                // Fallback: cerca tra tutte le chiavi
                for (const k of Object.keys(polar)) {
                    if (parseFloat(k) === tws) { row = polar[k]; break; }
                }
            }
            if (!row || typeof row !== 'object') {
                throw new Error(`TWS ${tws}: valore non e' un oggetto`);
            }

            const twas = Object.keys(row).map(k => {
                const n = parseFloat(k);
                if (!isFinite(n)) {
                    throw new Error(`TWS ${tws}: chiave TWA non numerica "${k}"`);
                }
                if (n < 0 || n > 180) {
                    throw new Error(`TWS ${tws}: TWA fuori range [0, 180]: ${n}`);
                }
                return n;
            }).sort((a, b) => a - b);

            // Verifico che tutti i TWS abbiano lo stesso set di TWA
            if (twaSet === null) {
                twaSet = twas;
            } else {
                if (twas.length !== twaSet.length ||
                    !twas.every((v, i) => v === twaSet[i])) {
                    throw new Error(
                        `TWS ${tws}: i TWA non corrispondono al primo TWS.\n` +
                        `Atteso: [${twaSet.join(', ')}]\nTrovato: [${twas.join(', ')}]`
                    );
                }
            }

            // Verifico valori velocità
            for (const twa of twas) {
                let speed;
                for (const k of Object.keys(row)) {
                    if (parseFloat(k) === twa) { speed = row[k]; break; }
                }
                if (typeof speed !== 'number' || !isFinite(speed)) {
                    throw new Error(
                        `TWS ${tws} TWA ${twa}: velocita' non numerica: ${speed}`
                    );
                }
                if (speed < 0 || speed > 50) {
                    throw new Error(
                        `TWS ${tws} TWA ${twa}: velocita' fuori range [0, 50]: ${speed}`
                    );
                }
                count++;
                if (speed > maxSpeed) maxSpeed = speed;
            }
        }

        // Costruisco una mini-anteprima: prime 4 righe TWA con i valori per ogni TWS
        const sampleTwa = twaSet.filter((_, i) =>
            i === 0 || i === Math.floor(twaSet.length / 3) ||
            i === Math.floor(twaSet.length * 2 / 3) || i === twaSet.length - 1
        );
        const sampleRows = sampleTwa.map(twa => {
            const values = twsList.map(tws => {
                const row = polar[String(tws.toFixed(1))] || polar[String(tws)] ||
                            polar[Object.keys(polar).find(k => parseFloat(k) === tws)];
                const v = row[String(twa.toFixed(1))] || row[String(twa)] ||
                          row[Object.keys(row).find(k => parseFloat(k) === twa)];
                return v;
            });
            return [twa, values];
        });

        // Validazione "soft" del blocco sails (turno sail crossover):
        // se presente e malformato, log warn ma non blocco. La schermata
        // Polari userebbe il bordo neutro, niente di rotto.
        let sailsInfo = null;
        if (parsed.sails && typeof parsed.sails === 'object') {
            const defs = parsed.sails.definitions || {};
            const cross = parsed.sails.crossover || {};
            const defKeys = Object.keys(defs);
            const crossTws = Object.keys(cross);
            const allSailKeysInCrossover = new Set();
            for (const tws of crossTws) {
                const row = cross[tws];
                if (row && typeof row === 'object') {
                    for (const sailKey of Object.values(row)) {
                        allSailKeysInCrossover.add(sailKey);
                    }
                }
            }
            const undef = [...allSailKeysInCrossover].filter(k => !defs[k]);
            if (undef.length > 0) {
                console.warn('[polar] sails.crossover usa chiavi non definite in sails.definitions:', undef);
            }
            sailsInfo = {
                definitions: defs,
                crossover: cross,
                sailKeyCount: defKeys.length,
                crossoverTwsCount: crossTws.length,
            };
        }

        return {
            ok: true,
            boat_name: boatName,
            twsList: twsList,
            twaList: twaSet,
            maxSpeed: maxSpeed,
            count: count,
            sampleRows: sampleRows,
            _raw: polar,  // dati originali per lookup veloce TWS->TWA->speed
            sails: sailsInfo,  // null se il file non ha sail crossover
        };
    }

    // Esporto come globali per usarle in boatconfig.js e ovunque serva
    window.SailingCoord = {
        parseDM, formatDM, validateWaypointsJson, validatePolarJson
    };
})();
