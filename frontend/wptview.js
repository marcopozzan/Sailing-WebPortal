/**
 * Sailing Cloud - Schermata Waypoints (vista pubblica).
 *
 * Lista barche -> select -> scarica waypoints.json pubblicamente
 * -> render tabella + mini-mappa Leaflet.
 */
(function() {
    const API_BASE = window.SAILING_API_BASE ?? 'http://localhost:8000';

    let initDone = false;
    let map = null;
    let markers = [];

    async function loadBoats() {
        try {
            const res = await SailingAuth.authFetch(API_BASE + '/api/boats');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const boats = await res.json();
            const sel = document.getElementById('wpt-boat-select');
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
            console.error('Errore loadBoats per wpt:', e);
        }
    }

    async function loadWaypoints(boatId) {
        const empty = document.getElementById('wpt-empty');
        const content = document.getElementById('wpt-content');
        const notUploaded = document.getElementById('wpt-not-uploaded');

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
            if (!cfg.configured || !cfg.waypoints_url) {
                throw new Error('Storage non configurato sul server');
            }

            // Step 2: scarico DIRETTAMENTE dal blob storage (no proxy).
            // ?nocache forza il browser a non usare la cache HTTP.
            const url = cfg.waypoints_url + '?nocache=' + Date.now();
            const res = await fetch(url);
            if (res.status === 404) {
                content.style.display = 'none';
                notUploaded.style.display = '';
                return;
            }
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            const wpts = window.SailingCoord.validateWaypointsJson(data);
            renderTable(wpts);
            renderMap(wpts);
            content.style.display = '';
            notUploaded.style.display = 'none';
            // Force resize della mappa dopo display
            setTimeout(() => { if (map) map.invalidateSize(); }, 50);
        } catch (e) {
            console.error('Errore caricamento waypoints:', e);
            content.style.display = 'none';
            notUploaded.style.display = '';
            notUploaded.querySelector('p strong').textContent =
                'Errore caricamento waypoints: ' + e.message;
        }
    }

    function renderTable(wpts) {
        const tbl = document.getElementById('wpt-table');
        let html = `
            <thead><tr><th>#</th><th>Nome</th><th>Lat</th><th>Lon</th><th>Side</th></tr></thead>
            <tbody>
        `;
        wpts.forEach((w, i) => {
            const sideBadge = w.side ?
                `<span class="side-badge side-${w.side}">${w.side === 'port' ? '◀ port' : 'stbd ▶'}</span>` :
                '<span class="muted">—</span>';
            html += `
                <tr data-idx="${i}">
                    <td>${i + 1}</td>
                    <td>${escapeHtml(w.name)}</td>
                    <td><code>${escapeHtml(w.latRaw)}</code></td>
                    <td><code>${escapeHtml(w.lonRaw)}</code></td>
                    <td>${sideBadge}</td>
                </tr>
            `;
        });
        html += '</tbody>';
        tbl.innerHTML = html;

        tbl.querySelectorAll('tbody tr').forEach(tr => {
            tr.onclick = () => {
                const idx = parseInt(tr.dataset.idx, 10);
                tbl.querySelectorAll('tr').forEach(t => t.classList.remove('selected'));
                tr.classList.add('selected');
                if (markers[idx] && map) {
                    map.setView(markers[idx].getLatLng(), Math.max(map.getZoom(), 14));
                    markers[idx].openPopup();
                }
            };
        });
    }

    function renderMap(wpts) {
        const mapEl = document.getElementById('wpt-map');

        if (map) {
            map.remove();
            map = null;
            markers = [];
        }

        if (wpts.length === 0) return;

        map = L.map(mapEl, {
            zoomControl: true,
            attributionControl: false,
        });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 18,
        }).addTo(map);

        markers = wpts.map((w, i) => {
            const color = w.side === 'port' ? '#ff4444' :
                          w.side === 'starboard' ? '#00ff88' : '#C55A11';
            const marker = L.circleMarker([w.lat, w.lon], {
                radius: 10,
                color: '#ffffff',
                fillColor: color,
                fillOpacity: 1,
                weight: 2,
            }).addTo(map);
            marker.bindPopup(
                `<strong>${escapeHtml(w.name)}</strong><br>` +
                `${escapeHtml(w.latRaw)}<br>${escapeHtml(w.lonRaw)}` +
                (w.side ? `<br><em>lascia a ${w.side}</em>` : '')
            );
            const label = L.divIcon({
                className: 'wpt-num-label',
                html: `<div class="wpt-num">${i + 1}</div>`,
                iconSize: [22, 22],
                iconAnchor: [11, -10],
            });
            L.marker([w.lat, w.lon], { icon: label }).addTo(map);
            return marker;
        });

        if (wpts.length > 1) {
            const latlngs = wpts.map(w => [w.lat, w.lon]);
            L.polyline(latlngs, {
                color: '#C55A11',
                weight: 2,
                opacity: 0.6,
                dashArray: '5, 5',
            }).addTo(map);
        }

        const bounds = L.latLngBounds(wpts.map(w => [w.lat, w.lon]));
        map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 });
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
        }[c]));
    }

    /** Mostra/nascondi il bottone "Modifica" in base a token + barca. */
    function updateEditButton() {
        const btn = document.getElementById('wpt-edit-btn');
        if (!btn) return;
        const hasToken = !!localStorage.getItem('sailing_admin_token');
        const sel = document.getElementById('wpt-boat-select');
        const hasBoat = sel && !!sel.value;
        btn.style.display = (hasToken && hasBoat) ? '' : 'none';
    }

    function init() {
        if (initDone) return;
        initDone = true;
        const sel = document.getElementById('wpt-boat-select');
        sel.addEventListener('change', () => {
            loadWaypoints(sel.value);
            updateEditButton();
        });
        const editBtn = document.getElementById('wpt-edit-btn');
        if (editBtn) {
            editBtn.addEventListener('click', () => {
                if (!sel.value) return;
                if (window.SailingJsonEditor) {
                    window.SailingJsonEditor.open('waypoints', sel.value);
                } else {
                    alert('Editor non disponibile');
                }
            });
        }
        loadBoats();
        updateEditButton();
    }

    window.addEventListener('screenChanged', (e) => {
        if (e.detail.name === 'waypoints') {
            init();
            loadBoats();
            updateEditButton();
            // Resize mappa se gia' caricata (tile sembrano tagliate altrimenti)
            setTimeout(() => { if (map) map.invalidateSize(); }, 100);
        }
    });

    // Aggiorna bottone quando l'utente salva/rimuove il token in Config
    window.addEventListener('sailingTokenChanged', updateEditButton);

    window.SailingWptView = {
        refresh: () => {
            const sel = document.getElementById('wpt-boat-select');
            if (sel && sel.value) loadWaypoints(sel.value);
        }
    };
})();
