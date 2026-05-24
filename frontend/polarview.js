/**
 * Sailing Cloud - Schermata Polare (vista pubblica).
 *
 * Lista barche -> select -> scarica polar.json pubblicamente
 * -> render tabella TWS x TWA con heatmap colori.
 */
(function() {
    const API_BASE = window.SAILING_API_BASE ?? 'http://localhost:8000';

    let initDone = false;
    // State del modulo. Tengo qui la reference all'istanza polar plot per
    // poterla ridisegnare al resize/cambio polare.
    const state = { polarPlot: null };

    async function loadBoats() {
        try {
            const res = await SailingAuth.authFetch(API_BASE + '/api/boats');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const boats = await res.json();
            const sel = document.getElementById('polar-boat-select');
            // Conserva selezione corrente se esiste
            const cur = sel.value;
            sel.innerHTML = '<option value="">-- seleziona barca --</option>';
            boats.forEach(b => {
                const opt = document.createElement('option');
                opt.value = b.boat_id;
                opt.textContent = `${b.name} (${b.boat_id})`;
                sel.appendChild(opt);
            });
            if (cur && [...sel.options].some(o => o.value === cur)) {
                sel.value = cur;
            }
        } catch (e) {
            console.error('Errore loadBoats per polar:', e);
        }
    }

    async function loadPolar(boatId) {
        const empty = document.getElementById('polar-empty');
        const content = document.getElementById('polar-content');
        const notUploaded = document.getElementById('polar-not-uploaded');

        if (!boatId) {
            empty.style.display = '';
            content.style.display = 'none';
            notUploaded.style.display = 'none';
            return;
        }

        empty.style.display = 'none';

        try {
            // Step 1: chiedo al backend l'URL del blob storage per questa barca.
            // Endpoint pubblico, nessuna info sensibile (solo URL costruite).
            const cfgRes = await SailingAuth.authFetch(API_BASE + `/api/boats/${encodeURIComponent(boatId)}/config-urls`);
            if (!cfgRes.ok) throw new Error('config-urls HTTP ' + cfgRes.status);
            const cfg = await cfgRes.json();
            if (!cfg.configured || !cfg.polar_url) {
                throw new Error('Storage non configurato sul server');
            }

            // Step 2: scarico DIRETTAMENTE dal blob storage (no proxy).
            // ?nocache forza il browser a non usare la cache HTTP.
            const url = cfg.polar_url + '?nocache=' + Date.now();
            const res = await fetch(url);
            if (res.status === 404) {
                content.style.display = 'none';
                notUploaded.style.display = '';
                return;
            }
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            const r = window.SailingCoord.validatePolarJson(data);
            renderTable(r);
            renderPolarChart(data);
            content.style.display = '';
            notUploaded.style.display = 'none';
        } catch (e) {
            console.error('Errore caricamento polare:', e);
            content.style.display = 'none';
            notUploaded.style.display = '';
            notUploaded.querySelector('p strong').textContent =
                'Errore caricamento polare: ' + e.message;
        }
    }

    function renderTable(r) {
        // Statistiche
        const optimum = computeOptimum(r);
        const stats = document.getElementById('polar-stats');
        stats.innerHTML = `
            <div class="stat-cell">
                <span class="lbl">Barca</span>
                <span class="val">${escapeHtml(r.boat_name || '(senza nome)')}</span>
            </div>
            <div class="stat-cell">
                <span class="lbl">TWS</span>
                <span class="val">${r.twsList.length} valori</span>
                <span class="sub">${r.twsList[0]} - ${r.twsList[r.twsList.length-1]} kn</span>
            </div>
            <div class="stat-cell">
                <span class="lbl">TWA</span>
                <span class="val">${r.twaList.length} angoli</span>
                <span class="sub">${r.twaList[0]}° - ${r.twaList[r.twaList.length-1]}°</span>
            </div>
            <div class="stat-cell">
                <span class="lbl">Vel. max</span>
                <span class="val">${r.maxSpeed.toFixed(1)} kn</span>
            </div>
            <div class="stat-cell">
                <span class="lbl">VMG bolina</span>
                <span class="val">${optimum.upwind ? optimum.upwind.twa + '°' : '--'}</span>
                <span class="sub">${optimum.upwind ? optimum.upwind.bsp.toFixed(1) + ' kn' : ''}</span>
            </div>
            <div class="stat-cell">
                <span class="lbl">VMG poppa</span>
                <span class="val">${optimum.downwind ? optimum.downwind.twa + '°' : '--'}</span>
                <span class="sub">${optimum.downwind ? optimum.downwind.bsp.toFixed(1) + ' kn' : ''}</span>
            </div>
        `;

        // Sail crossover lookup: se il polar.json ha "sails", costruisco un
        // polarLookup secondario solo per chiamare lookupSail su ogni cella.
        // (Riuso la stessa factory di analysis.js esposta come buildPolarLookup,
        // che gia' parsa il blocco sails.)
        let sailLookup = null;
        if (window.SailingAnalysis && window.SailingAnalysis.buildPolarLookup) {
            // Devo passare il polar JSON intero, non l'output di validatePolarJson.
            // Ricostruisco una shape compatibile usando r._raw e r.sails.
            const rebuilt = {
                boat_name: r.boat_name,
                polar: r._raw,
                sails: r.sails ? {
                    definitions: r.sails.definitions,
                    crossover: r.sails.crossover,
                } : undefined,
            };
            const pl = window.SailingAnalysis.buildPolarLookup(rebuilt);
            if (pl && pl.hasSails) sailLookup = pl;
        }

        // Tabella
        const tbl = document.getElementById('polar-table');
        let html = '<thead><tr><th class="corner">TWA \\ TWS</th>';
        r.twsList.forEach(tws => {
            html += `<th>${tws} kn</th>`;
        });
        html += '</tr></thead><tbody>';

        r.twaList.forEach(twa => {
            html += `<tr><th>${twa}°</th>`;
            r.twsList.forEach(tws => {
                const v = lookup(r, tws, twa);
                if (v == null) {
                    html += '<td class="empty">--</td>';
                } else {
                    const intensity = Math.min(1, v / r.maxSpeed);
                    const bg = heatColor(intensity);
                    let style = `background:${bg}`;
                    let title = '';
                    if (sailLookup) {
                        const sail = sailLookup.lookupSail(tws, twa);
                        if (sail) {
                            // Bordo colorato 3px in base alla vela. Sostituisce
                            // il bordo grigio neutro della tabella.
                            style += `;box-shadow: inset 0 0 0 3px ${sail.color}`;
                            title = `vela: ${sail.label}`;
                        }
                    }
                    html += `<td style="${style}" title="${escapeHtml(title)}">${v.toFixed(1)}</td>`;
                }
            });
            html += '</tr>';
        });
        html += '</tbody>';
        tbl.innerHTML = html;

        // Legenda vele sotto la tabella (solo se sail crossover presente)
        renderSailLegend(r, sailLookup);
    }

    /** Disegna sotto la tabella una legenda con i quadratini colorati e i
     *  nomi delle vele. Il container ha id 'polar-sails-legend'. Lo creo
     *  on-the-fly se non esiste, lo nascondo se non c'e' sail crossover. */
    function renderSailLegend(r, sailLookup) {
        let legend = document.getElementById('polar-sails-legend');
        if (!sailLookup || !r.sails || !r.sails.definitions) {
            if (legend) legend.style.display = 'none';
            return;
        }
        if (!legend) {
            legend = document.createElement('div');
            legend.id = 'polar-sails-legend';
            legend.className = 'polar-sails-legend';
            // Inserisco subito dopo la tabella
            const wrap = document.querySelector('.polar-table-wrap');
            if (wrap && wrap.parentNode) {
                wrap.parentNode.insertBefore(legend, wrap.nextSibling);
            }
        }
        legend.style.display = '';
        const defs = r.sails.definitions;
        const items = Object.keys(defs).map(key => {
            const d = defs[key];
            return `<span class="sail-legend-item">
                <span class="sail-legend-swatch" style="background:${d.color}"></span>
                <span class="sail-legend-label">${escapeHtml(d.label || key)}</span>
            </span>`;
        }).join('');
        legend.innerHTML =
            '<div class="sail-legend-title">Vele suggerite (bordo cella):</div>' +
            '<div class="sail-legend-items">' + items + '</div>';
    }

    /** Disegna il diagramma polare (canvas) con le curve teoriche per ogni TWS.
     *  Riusa la factory `SailingPlots.makePolarPlot` passando points=null,
     *  cosi' viene disegnato il diagramma "pulito" senza cloud di punti reali.
     *  Una factory unica garantisce che il rendering sia identico tra
     *  schermata Polari (qui) e tab Polar del Replay. */
    function renderPolarChart(rawPolarJson) {
        const canvas = document.getElementById('polar-chart-canvas');
        if (!canvas) return;
        if (!window.SailingAnalysis || !window.SailingAnalysis.buildPolarLookup ||
            !window.SailingPlots || !window.SailingPlots.makePolarPlot) {
            console.warn('Moduli analysis/analysis-plots non caricati: salto polar chart.');
            return;
        }
        const polarLookup = window.SailingAnalysis.buildPolarLookup(rawPolarJson);
        if (!polarLookup) {
            console.warn('Impossibile costruire polar lookup dalla polare');
            return;
        }
        // makePolarPlot con points=null = solo curve teoriche, niente cloud.
        // size='large' fa il diagramma 2x piu' grande con font/linee scalati.
        // Salvo nello state in caso di redraw futuro.
        state.polarPlot = window.SailingPlots.makePolarPlot(
            canvas, null, polarLookup, { size: 'large' });
        state.polarPlot.redraw();
    }

    function lookup(r, tws, twa) {
        const row = r._raw[String(tws.toFixed(1))] || r._raw[String(tws)] ||
                    r._raw[Object.keys(r._raw).find(k => parseFloat(k) === tws)];
        if (!row) return null;
        const v = row[String(twa.toFixed(1))] || row[String(twa)] ||
                  row[Object.keys(row).find(k => parseFloat(k) === twa)];
        return typeof v === 'number' ? v : null;
    }

    function computeOptimum(r) {
        const targetTws = r.twsList.includes(12) ? 12 :
                          r.twsList[Math.floor(r.twsList.length / 2)];
        let bestUp = null, bestDown = null;
        r.twaList.forEach(twa => {
            const bsp = lookup(r, targetTws, twa);
            if (bsp == null) return;
            if (twa < 90) {
                const vmg = bsp * Math.cos(twa * Math.PI / 180);
                if (!bestUp || vmg > bestUp.vmg) bestUp = { twa, bsp, vmg };
            }
            if (twa > 90) {
                const vmg = bsp * Math.abs(Math.cos(twa * Math.PI / 180));
                if (!bestDown || vmg > bestDown.vmg) bestDown = { twa, bsp, vmg };
            }
        });
        return { upwind: bestUp, downwind: bestDown };
    }

    function heatColor(t) {
        if (t < 0.5) {
            const k = t * 2;
            const r = Math.round(27 + (0 - 27) * k);
            const g = Math.round(58 + (255 - 58) * k);
            const b = Math.round(107 + (136 - 107) * k);
            return `rgba(${r},${g},${b},0.35)`;
        } else {
            const k = (t - 0.5) * 2;
            const r = Math.round(0 + (197 - 0) * k);
            const g = Math.round(255 + (90 - 255) * k);
            const b = Math.round(136 + (17 - 136) * k);
            return `rgba(${r},${g},${b},0.35)`;
        }
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
        }[c]));
    }

    /** Mostra/nascondi il bottone "Modifica" in base a:
     *  - Presenza admin token in localStorage
     *  - Barca selezionata
     *  Se entrambi OK il bottone diventa visibile, altrimenti resta nascosto. */
    function updateEditButton() {
        const btn = document.getElementById('polar-edit-btn');
        if (!btn) return;
        const hasToken = !!localStorage.getItem('sailing_admin_token');
        const sel = document.getElementById('polar-boat-select');
        const hasBoat = sel && !!sel.value;
        btn.style.display = (hasToken && hasBoat) ? '' : 'none';
    }

    function init() {
        if (initDone) return;
        initDone = true;
        const sel = document.getElementById('polar-boat-select');
        sel.addEventListener('change', () => {
            loadPolar(sel.value);
            updateEditButton();
        });
        // Bottone "Modifica" -> apre il JSON editor con la polare della barca corrente
        const editBtn = document.getElementById('polar-edit-btn');
        if (editBtn) {
            editBtn.addEventListener('click', () => {
                if (!sel.value) return;
                if (window.SailingJsonEditor) {
                    window.SailingJsonEditor.open('polar', sel.value);
                } else {
                    alert('Editor non disponibile');
                }
            });
        }
        loadBoats();
        updateEditButton();
    }

    // Lazy-init quando si entra nella schermata
    window.addEventListener('screenChanged', (e) => {
        if (e.detail.name === 'polar') {
            init();
            // Refresh barche ad ogni accesso (potrebbero essere cambiate)
            loadBoats();
            // Aggiorna visibilita' bottone (token potrebbe essere stato salvato
            // nel frattempo dall'overlay Config)
            updateEditButton();
        }
    });

    // Aggiorna bottone quando l'utente salva/rimuove il token in Config
    window.addEventListener('sailingTokenChanged', updateEditButton);

    // Espongo per refresh esterno (es. dopo upload da Config)
    window.SailingPolarView = {
        refresh: () => {
            const sel = document.getElementById('polar-boat-select');
            if (sel && sel.value) loadPolar(sel.value);
        }
    };
})();
