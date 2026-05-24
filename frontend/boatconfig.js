/**
 * Sailing Cloud - Configurazione admin (overlay).
 *
 * Solo per upload polare/waypoints. Le viste pubbliche di polare e
 * waypoints sono nelle schermate dedicate (polarview.js / wptview.js).
 *
 * Dopo un upload riuscito, chiama window.Sailing*View.refresh() per
 * aggiornare le viste pubbliche se sono attualmente visualizzate.
 */
(function() {
    const API_BASE = window.SAILING_API_BASE ?? 'http://localhost:8000';
    const TOKEN_KEY = 'sailing_admin_token';

    function showConfig() {
        document.getElementById('config-overlay').style.display = 'flex';
        const saved = localStorage.getItem(TOKEN_KEY);
        if (saved) document.getElementById('cfg-admin-token').value = saved;
        loadBoats();
        // Se l'utente ha gia' un token salvato, prova a caricare la blob config
        // cosi' i campi sono pre-popolati subito senza bisogno di "Carica stato"
        if (saved) {
            // Dopo un tick, dato che gli handler DOMContentLoaded girano in
            // ordine e la sezione potrebbe non essere ancora pronta
            setTimeout(() => loadBlobConfig().catch(() => {}), 50);
        } else {
            // Se non c'e' token, mostro almeno i placeholder dei container
            document.getElementById('cfg-blob-container-polars').value    = 'polars';
            document.getElementById('cfg-blob-container-waypoints').value = 'waypoints';
            document.getElementById('cfg-blob-container-tracks').value    = 'tracks';
            // Carico eventuali preferenze locali anche senza token
            const prefs = getBlobPrefs();
            if (prefs.account_name) {
                document.getElementById('cfg-blob-account').value = prefs.account_name;
            }
            if (prefs.container_polars)
                document.getElementById('cfg-blob-container-polars').value = prefs.container_polars;
            if (prefs.container_waypoints)
                document.getElementById('cfg-blob-container-waypoints').value = prefs.container_waypoints;
            if (prefs.container_tracks)
                document.getElementById('cfg-blob-container-tracks').value = prefs.container_tracks;
        }
    }

    function hideConfig() {
        document.getElementById('config-overlay').style.display = 'none';
    }

    async function loadBoats() {
        try {
            const res = await SailingAuth.authFetch(API_BASE + '/api/boats');
            const boats = await res.json();
            const sel = document.getElementById('cfg-boat-select');
            const cur = sel.value;
            sel.innerHTML = '<option value="">-- seleziona --</option>';
            boats.forEach(b => {
                const opt = document.createElement('option');
                opt.value = b.boat_id;
                opt.textContent = `${b.name} (${b.boat_id})`;
                sel.appendChild(opt);
            });
            if (cur) sel.value = cur;
        } catch (e) {
            console.error('loadBoats:', e);
        }
    }

    function saveToken() {
        const t = document.getElementById('cfg-admin-token').value.trim();
        if (t) {
            localStorage.setItem(TOKEN_KEY, t);
            alert('Admin token salvato in questo browser.');
        } else {
            localStorage.removeItem(TOKEN_KEY);
            alert('Admin token rimosso.');
        }
        // Notifico le altre pagine (polarview/wptview) cosi' aggiornano la
        // visibilita' del bottone "Modifica" senza dover ricaricare la pagina.
        window.dispatchEvent(new CustomEvent('sailingTokenChanged'));
    }

    function getToken() {
        const t = document.getElementById('cfg-admin-token').value.trim();
        if (!t) {
            alert('Inserisci prima l\'Admin Token e clicca "Salva".');
            return null;
        }
        return t;
    }

    function getBoatId() {
        const b = document.getElementById('cfg-boat-select').value;
        if (!b) {
            alert('Seleziona prima una barca dal menu.');
            return null;
        }
        return b;
    }

    async function loadStatus() {
        const boat = getBoatId();
        if (!boat) return;
        const tok = getToken();
        if (!tok) return;

        try {
            const res = await SailingAuth.authFetch(API_BASE + `/api/admin/boats/${encodeURIComponent(boat)}/config-status`, {
                headers: { 'X-Admin-Token': tok },
            });
            if (res.status === 401) {
                alert('Admin token non valido.');
                return;
            }
            if (!res.ok) {
                alert(`Errore: HTTP ${res.status}`);
                return;
            }
            const data = await res.json();
            renderStatus(data);
        } catch (e) {
            alert('Errore: ' + e.message);
        }
    }

    function renderStatus(data) {
        document.getElementById('config-status-section').style.display = 'block';

        const polarBox = document.getElementById('cfg-polar-status');
        if (data.polar.uploaded) {
            polarBox.innerHTML = `
                <span class="status-ok">✓ Polare caricata</span>
                <span class="muted">(${formatBytes(data.polar.size_bytes)},
                aggiornata ${formatDate(data.config_updated_at)})</span>
            `;
            // Mostra l'URL diretto del blob (il tablet la usa cosi' com'e').
            // Niente piu' proxy: l'URL non passa per il backend.
            showBlobUrl('cfg-polar-url', 'cfg-polar-url-text', data.polar.blob_url);
        } else {
            polarBox.innerHTML = '<span class="status-empty">Nessuna polare caricata</span>';
            document.getElementById('cfg-polar-url').style.display = 'none';
        }

        const wptBox = document.getElementById('cfg-wpt-status');
        if (data.waypoints.uploaded) {
            wptBox.innerHTML = `
                <span class="status-ok">✓ Waypoints caricati</span>
                <span class="muted">(${formatBytes(data.waypoints.size_bytes)},
                aggiornata ${formatDate(data.config_updated_at)})</span>
            `;
            showBlobUrl('cfg-wpt-url', 'cfg-wpt-url-text', data.waypoints.blob_url);
        } else {
            wptBox.innerHTML = '<span class="status-empty">Nessun waypoints caricato</span>';
            document.getElementById('cfg-wpt-url').style.display = 'none';
        }
    }

    // ========================================================================
    // EVENT HUB per barca (live stream)
    // ========================================================================
    /** Carica la configurazione EH della barca selezionata dal backend.
     *  Popola i campi del form. Mostra anche namespace di default per
     *  aiutare l'utente a capire da dove leggera' di base. */
    async function loadEventHubConfig() {
        const boat = getBoatId();
        if (!boat) return;
        const tok = getToken();
        if (!tok) return;

        try {
            const res = await fetch(
                API_BASE + `/api/admin/boats/${encodeURIComponent(boat)}/eventhub`,
                { headers: { 'X-Admin-Token': tok } });
            if (res.status === 401) {
                alert('Admin token non valido.');
                return;
            }
            if (res.status === 404) {
                alert('Barca non trovata.');
                return;
            }
            if (!res.ok) {
                alert(`Errore: HTTP ${res.status}`);
                return;
            }
            const data = await res.json();
            document.getElementById('cfg-eh-name').value = data.event_hub_name || '';
            // Connection string: il backend non la restituisce per intero;
            // mostriamo solo info: namespace estratto + flag presenza.
            const customNs = document.getElementById('cfg-eh-custom-ns');
            const customInput = document.getElementById('cfg-eh-conn');
            if (data.has_custom_connection_string) {
                customNs.textContent =
                    `In uso una connection string personalizzata (namespace: ${data.custom_connection_string_namespace || 'n/d'}). `
                    + 'Lasciare il campo vuoto per non modificarla; '
                    + 'incollarne una nuova per sostituirla; cancellare e mettere "CLEAR" per rimuoverla.';
                customNs.style.display = 'block';
            } else {
                customNs.textContent = '';
                customNs.style.display = 'none';
            }
            customInput.value = '';
            // Mostra anche il namespace di default in info
            const defaultInfo = document.getElementById('cfg-eh-default-ns');
            if (data.default_namespace) {
                defaultInfo.textContent =
                    `Namespace di default (da env del backend): ${data.default_namespace}`;
                defaultInfo.style.display = 'block';
            } else {
                defaultInfo.textContent = 'Nessun namespace di default configurato sul backend.';
                defaultInfo.style.display = 'block';
            }
        } catch (e) {
            alert('Errore: ' + e.message);
        }
    }

    /** Salva la configurazione EH per la barca corrente.
     *  Logica del campo connection string:
     *  - vuoto e nessuna esistente -> non viene inviato (usa default env)
     *  - vuoto ma una esistente   -> non la tocca (sentiella server-side)
     *  - "CLEAR"                  -> rimuove l'override (torna al default env)
     *  - altro                    -> override (deve iniziare con Endpoint=sb://)
     */
    async function saveEventHubConfig() {
        const boat = getBoatId();
        if (!boat) return;
        const tok = getToken();
        if (!tok) return;

        const ehName = document.getElementById('cfg-eh-name').value.trim();
        const ehConnRaw = document.getElementById('cfg-eh-conn').value.trim();

        // Costruisco il payload. Per la connection string distinguo i 3 casi:
        const payload = { event_hub_name: ehName };
        if (ehConnRaw === 'CLEAR') {
            payload.event_hub_connection_string = '';  // -> server-side diventa NULL
        } else if (ehConnRaw !== '') {
            if (!ehConnRaw.includes('Endpoint=sb://')) {
                alert('Connection string non valida: deve iniziare con "Endpoint=sb://".');
                return;
            }
            payload.event_hub_connection_string = ehConnRaw;
        }
        // Se vuoto e non CLEAR, non includo il campo: backend lascia inalterato.

        try {
            const res = await fetch(
                API_BASE + `/api/admin/boats/${encodeURIComponent(boat)}/eventhub`,
                {
                    method: 'PATCH',
                    headers: {
                        'X-Admin-Token': tok,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(payload),
                });
            if (res.status === 401) { alert('Admin token non valido.'); return; }
            if (res.status === 404) { alert('Barca non trovata.'); return; }
            if (res.status === 400) {
                const err = await res.json().catch(() => ({}));
                alert('Errore: ' + (err.detail || 'richiesta non valida'));
                return;
            }
            if (!res.ok) {
                alert(`Errore: HTTP ${res.status}`);
                return;
            }
            const data = await res.json();
            alert(
                'Salvato.\n\n' +
                `Event Hub: ${data.event_hub_name || '(nessuno - live disabilitato)'}\n` +
                `Connection string personalizzata: ${data.has_custom_connection_string ? 'sì' : 'no (usa default)'}`
            );
            // Ricarico per mostrare lo stato aggiornato (campo conn ripulito + namespace)
            loadEventHubConfig();
        } catch (e) {
            alert('Errore: ' + e.message);
        }
    }

    /** Mostra un URL nel box info. URL e' gia' completo (es. URL blob),
     *  non viene prefissato con API_BASE. */
    function showBlobUrl(boxId, codeId, fullUrl) {
        if (!fullUrl) {
            document.getElementById(boxId).style.display = 'none';
            return;
        }
        document.getElementById(boxId).style.display = 'block';
        document.getElementById(codeId).textContent = fullUrl;
    }

    /** Upload del file selezionato direttamente al blob storage via SAS URL.
     *  Workflow:
     *    1. Validazione locale (parse JSON + schema controls)
     *    2. POST a /api/admin/boats/{boat}/{kind}/upload-url -> riceve SAS URL
     *    3. PUT diretto a SAS URL con il contenuto del file (browser -> Azure)
     *    4. POST a /api/admin/boats/{boat}/{kind}/notify-uploaded per
     *       aggiornare il timestamp ConfigUpdatedAt nel DB
     *
     *  Il backend NON vede mai il contenuto del file: la PUT al blob va
     *  direttamente da browser a Azure Storage. */
    async function uploadFile(kind, fileInputId) {
        const boat = getBoatId();
        if (!boat) return;
        const tok = getToken();
        if (!tok) return;

        const fileInput = document.getElementById(fileInputId);
        const file = fileInput.files[0];
        if (!file) {
            alert('Seleziona prima un file .json');
            return;
        }
        if (!file.name.toLowerCase().endsWith('.json')) {
            alert('Il file deve avere estensione .json');
            return;
        }

        try {
            const text = await file.text();
            let parsed;
            try { parsed = JSON.parse(text); }
            catch (e) {
                alert('Il file non e\' un JSON valido:\n' + e.message);
                return;
            }

            // Validazione waypoints DM
            if (kind === 'waypoints' && window.SailingCoord) {
                try {
                    const wpts = window.SailingCoord.validateWaypointsJson(parsed);
                    const preview = wpts.map(w =>
                        `  • ${w.name}: ${w.latRaw} ${w.lonRaw}` + (w.side ? ` (${w.side})` : '')
                    ).join('\n');
                    if (!confirm(
                        `Trovati ${wpts.length} waypoint nel file:\n\n${preview}\n\nCaricare su blob storage?`
                    )) return;
                } catch (e) {
                    alert('Validazione waypoints fallita:\n\n' + e.message);
                    return;
                }
            }

            // Validazione polare
            if (kind === 'polar' && window.SailingCoord) {
                try {
                    const r = window.SailingCoord.validatePolarJson(parsed);
                    const lines = [
                        `Barca: ${r.boat_name || '(senza nome)'}`,
                        `TWS: ${r.twsList.length} valori (${r.twsList[0]} - ${r.twsList[r.twsList.length-1]} kn)`,
                        `TWA: ${r.twaList.length} angoli (${r.twaList[0]}° - ${r.twaList[r.twaList.length-1]}°)`,
                        `Totale: ${r.count} celle, vel. max ${r.maxSpeed.toFixed(1)} kn`,
                    ];
                    if (!confirm(lines.join('\n') + '\n\nCaricare su blob storage?')) return;
                } catch (e) {
                    alert('Validazione polare fallita:\n\n' + e.message);
                    return;
                }
            }

            // Step 1: chiedo SAS URL al backend
            const sasRes = await SailingAuth.authFetch(API_BASE + `/api/admin/boats/${encodeURIComponent(boat)}/${kind}/upload-url`,
                {
                    method: 'POST',
                    headers: { 'X-Admin-Token': tok },
                });
            if (!sasRes.ok) {
                const err = await sasRes.text();
                alert(`Errore richiesta SAS URL (HTTP ${sasRes.status}):\n${err}`);
                return;
            }
            const sasData = await sasRes.json();

            // Step 2: PUT diretto al blob con la SAS URL.
            // Headers richiesti da Azure: x-ms-blob-type per dire che e' un
            // BlockBlob (l'unico tipo che si puo' creare con PUT diretto).
            const putRes = await fetch(sasData.upload_url, {
                method: 'PUT',
                headers: sasData.headers,
                body: text,
            });
            if (!putRes.ok) {
                const err = await putRes.text();
                alert(`Errore upload al blob (HTTP ${putRes.status}):\n${err}`);
                return;
            }

            // Step 3: notifico al backend cosi' aggiorna ConfigUpdatedAt
            // (best-effort: se fallisce, l'upload del blob e' comunque OK)
            try {
                await SailingAuth.authFetch(API_BASE + `/api/admin/boats/${encodeURIComponent(boat)}/${kind}/notify-uploaded`,
                    { method: 'POST', headers: { 'X-Admin-Token': tok } });
            } catch (_) { /* ignora */ }

            const sizeKb = (text.length / 1024).toFixed(1);
            alert(
                `✓ ${kind === 'polar' ? 'Polare' : 'Waypoints'} caricat${kind === 'polar' ? 'a' : 'i'} ` +
                `(${sizeKb} KB)\n\n` +
                `URL blob: ${sasData.blob_url}`
            );

            fileInput.value = '';
            await loadStatus();

            // Aggiorno le viste pubbliche se erano gia' caricate
            if (kind === 'polar' && window.SailingPolarView) {
                window.SailingPolarView.refresh();
            }
            if (kind === 'waypoints' && window.SailingWptView) {
                window.SailingWptView.refresh();
            }
        } catch (e) {
            alert('Errore upload: ' + e.message);
        }
    }

    function formatBytes(n) {
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / 1024 / 1024).toFixed(2) + ' MB';
    }

    function formatDate(iso) {
        if (!iso) return '--';
        return new Date(iso).toLocaleString('it-IT');
    }

    // ========================================================================
    // BLOB STORAGE CONFIG (sezione 2)
    // ========================================================================
    // I valori di default vengono letti dal backend (GET /api/admin/blob-config)
    // e mostrati nei campi. L'utente puo' sovrascriverli per puntare a uno
    // storage diverso; le sovrascritture sono salvate in localStorage e
    // valgono SOLO per questo browser (non vengono propagate al backend).
    //
    // Il backend resta la fonte di verita': legge la connection string dalle
    // sue Application Settings (AZURE_STORAGE_CONNECTION_STRING). Le modifiche
    // dalla UI servono solo per i pulsanti "Scarica da blob" e per costruire
    // gli URL di download mostrati all'utente.

    const BLOB_PREFS_KEY = 'sailing_blob_prefs';

    function getBlobPrefs() {
        try {
            const raw = localStorage.getItem(BLOB_PREFS_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch (_) {
            return {};
        }
    }

    function setBlobPrefs(prefs) {
        localStorage.setItem(BLOB_PREFS_KEY, JSON.stringify(prefs));
    }

    /** Carica la config blob storage dal server e popola i campi.
     *  Se l'utente ha override locali in localStorage, quelli vincono. */
    async function loadBlobConfig() {
        const tok = getToken();
        if (!tok) return;

        const statusBox = document.getElementById('cfg-blob-status');
        const statusTxt = document.getElementById('cfg-blob-status-text');

        try {
            const res = await SailingAuth.authFetch(API_BASE + '/api/admin/blob-config', {
                headers: { 'X-Admin-Token': tok },
            });
            if (res.status === 401) {
                statusBox.style.display = 'block';
                statusTxt.textContent = 'Admin token non valido.';
                statusTxt.className = 'status-empty';
                return null;
            }
            if (!res.ok) {
                statusBox.style.display = 'block';
                statusTxt.textContent = 'Errore: HTTP ' + res.status;
                statusTxt.className = 'status-empty';
                return null;
            }
            const serverCfg = await res.json();
            const prefs = getBlobPrefs();

            // Default = quello che dice il server, override = localStorage utente
            const merged = {
                account_name:        prefs.account_name        || serverCfg.account_name,
                container_polars:    prefs.container_polars    || serverCfg.containers.polars,
                container_waypoints: prefs.container_waypoints || serverCfg.containers.waypoints,
                container_tracks:    prefs.container_tracks    || serverCfg.containers.tracks,
            };

            document.getElementById('cfg-blob-account').value             = merged.account_name;
            document.getElementById('cfg-blob-container-polars').value    = merged.container_polars;
            document.getElementById('cfg-blob-container-waypoints').value = merged.container_waypoints;
            document.getElementById('cfg-blob-container-tracks').value    = merged.container_tracks;

            statusBox.style.display = 'block';
            if (serverCfg.configured) {
                statusTxt.innerHTML = '<span class="status-ok">✓ Server configurato</span> '
                    + `<span class="muted">account: <code>${serverCfg.account_name}</code></span>`;
            } else {
                statusTxt.innerHTML = '<span class="status-empty">⚠ Server senza AZURE_STORAGE_CONNECTION_STRING</span>'
                    + ' <span class="muted">imposta la variabile su App Service.</span>';
            }
            return merged;
        } catch (e) {
            statusBox.style.display = 'block';
            statusTxt.textContent = 'Errore: ' + e.message;
            return null;
        }
    }

    /** Salva le preferenze inserite nei campi in localStorage. */
    function saveBlobConfig() {
        const prefs = {
            account_name:        document.getElementById('cfg-blob-account').value.trim(),
            container_polars:    document.getElementById('cfg-blob-container-polars').value.trim(),
            container_waypoints: document.getElementById('cfg-blob-container-waypoints').value.trim(),
            container_tracks:    document.getElementById('cfg-blob-container-tracks').value.trim(),
        };
        if (!prefs.account_name || !prefs.container_polars
            || !prefs.container_waypoints || !prefs.container_tracks) {
            alert('Tutti i campi sono obbligatori.');
            return;
        }
        setBlobPrefs(prefs);
        const msg = document.getElementById('cfg-blob-saved-msg');
        msg.textContent = '✓ Salvato in questo browser';
        msg.style.display = 'inline';
        msg.style.color = 'var(--accent-ok, #4caf50)';
        setTimeout(() => { msg.style.display = 'none'; }, 3000);
    }

    /** Reset: cancella le preferenze locali e ricarica i default dal server. */
    async function resetBlobConfig() {
        if (!confirm('Ripristinare i default dal server e cancellare le tue impostazioni locali?')) return;
        localStorage.removeItem(BLOB_PREFS_KEY);
        await loadBlobConfig();
        const msg = document.getElementById('cfg-blob-saved-msg');
        msg.textContent = '✓ Default ripristinati';
        msg.style.display = 'inline';
        msg.style.color = 'var(--accent-ok, #4caf50)';
        setTimeout(() => { msg.style.display = 'none'; }, 3000);
    }

    /** Costruisce l'URL del blob per un certo file della barca corrente. */
    function buildBlobUrl(kind) {
        const account = document.getElementById('cfg-blob-account').value.trim();
        const container = kind === 'polar'
            ? document.getElementById('cfg-blob-container-polars').value.trim()
            : document.getElementById('cfg-blob-container-waypoints').value.trim();
        const filename = kind === 'polar' ? 'polar.json' : 'waypoints.json';
        const boat = getBoatId();
        if (!account || !container || !boat) return null;
        return `https://${account}.blob.core.windows.net/${container}/${boat}/${filename}`;
    }

    // ========================================================================
    // DOWNLOAD DA BLOB (scarica file dal cloud sul PC dell'utente)
    // ========================================================================
    /** Scarica il file dal blob storage e propone il salvataggio sul PC.
     *  Usa l'URL pubblico del blob direttamente (no auth, container deve
     *  essere anonymous-read). Il backend non e' coinvolto: il file va da
     *  Azure Storage al browser senza intermediari. */
    async function downloadFromBlob(kind) {
        const boat = getBoatId();
        if (!boat) return;
        const filename = kind === 'polar' ? 'polar.json' : 'waypoints.json';

        const url = buildBlobUrl(kind);
        if (!url) {
            alert('Configurazione blob storage incompleta. Compila i campi della sezione 2.');
            return;
        }

        try {
            // ?nocache forza il browser a non usare la cache HTTP locale
            const res = await fetch(url + '?nocache=' + Date.now());
            if (!res.ok) {
                if (res.status === 404) {
                    alert(`Nessun ${filename} caricato per la barca "${boat}".`);
                } else if (res.status === 403) {
                    alert(`Accesso negato al blob (HTTP 403).\n` +
                          `Il container deve essere configurato come anonymous-read.\n\n` +
                          `URL tentato: ${url}`);
                } else {
                    alert(`Errore download (HTTP ${res.status})\n\nURL: ${url}`);
                }
                return;
            }
            const text = await res.text();

            // Crea un blob e simula il click su un link di download.
            // Il browser apre la finestra "Salva con nome".
            const blob = new Blob([text], { type: 'application/json' });
            const objUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = objUrl;
            a.download = `${boat}_${filename}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(objUrl);

            const sizeKb = (blob.size / 1024).toFixed(1);
            console.log(`Scaricato ${filename} (${sizeKb} KB) da ${url}`);
        } catch (e) {
            alert('Errore download:\n' + e.message + `\n\nURL: ${url}`);
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        document.getElementById('btn-config').onclick = showConfig;
        document.getElementById('config-close').onclick = hideConfig;
        document.getElementById('cfg-save-token').onclick = saveToken;
        document.getElementById('cfg-load-status').onclick = async () => {
            // Carica sia lo stato barca sia la config blob (se non gia' caricata)
            await loadStatus();
            await loadBlobConfig();
            await loadEventHubConfig();
        };
        document.getElementById('cfg-polar-upload').onclick =
            () => uploadFile('polar', 'cfg-polar-file');
        document.getElementById('cfg-wpt-upload').onclick =
            () => uploadFile('waypoints', 'cfg-wpt-file');

        // Nuovi pulsanti download da blob
        document.getElementById('cfg-polar-download').onclick =
            () => downloadFromBlob('polar');
        document.getElementById('cfg-wpt-download').onclick =
            () => downloadFromBlob('waypoints');

        // Sezione blob storage config
        document.getElementById('cfg-blob-save').onclick = saveBlobConfig;
        document.getElementById('cfg-blob-reset').onclick = resetBlobConfig;

        // Sezione Event Hub per barca (live stream)
        document.getElementById('cfg-eh-save').onclick = saveEventHubConfig;
        document.getElementById('cfg-eh-reload').onclick = loadEventHubConfig;

        // Copy buttons
        document.querySelectorAll('.btn-copy').forEach(btn => {
            btn.onclick = () => {
                const targetId = btn.dataset.target;
                let text;
                if (targetId === 'cfg-coord-dm-input') {
                    text = document.getElementById('cfg-coord-dm').value;
                } else {
                    text = document.getElementById(targetId).textContent;
                }
                navigator.clipboard.writeText(text).then(() => {
                    const orig = btn.textContent;
                    btn.textContent = '✓ Copiato!';
                    btn.classList.add('btn-copied');
                    setTimeout(() => {
                        btn.textContent = orig;
                        btn.classList.remove('btn-copied');
                    }, 1500);
                }).catch(() => alert('Premi Ctrl+C per copiare'));
            };
        });

        // Convertitore decimale -> DM
        const convertBtn = document.getElementById('cfg-coord-convert');
        if (convertBtn) {
            convertBtn.onclick = () => {
                const decStr = document.getElementById('cfg-coord-dec').value.trim();
                const axis = document.getElementById('cfg-coord-axis').value;
                const dmOut = document.getElementById('cfg-coord-dm');
                if (!decStr) { dmOut.value = ''; return; }
                const dec = parseFloat(decStr.replace(',', '.'));
                if (!isFinite(dec)) {
                    alert('Decimale non valido');
                    dmOut.value = '';
                    return;
                }
                try {
                    dmOut.value = window.SailingCoord.formatDM(dec, axis);
                } catch (e) {
                    alert('Errore: ' + e.message);
                    dmOut.value = '';
                }
            };
        }

        document.addEventListener('keydown', (e) => {
            const overlay = document.getElementById('config-overlay');
            if (e.key === 'Escape' && overlay.style.display === 'flex') {
                hideConfig();
            }
        });
    });
})();
