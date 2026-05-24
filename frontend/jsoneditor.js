/**
 * Sailing Cloud - Editor JSON guidato per polar.json e waypoints.json.
 *
 * Carica il file corrente dal backend, mostra in <textarea> con validazione
 * live (parsing JSON + validatori specifici), e salva con upload POST.
 *
 * NB: usa lo stesso ADMIN_TOKEN gia' salvato in localStorage da boatconfig.js.
 * Quindi va aperto solo dopo che l'utente ha gia' inserito il token.
 */
(function() {
    const API_BASE = window.SAILING_API_BASE ?? 'http://localhost:8000';
    const TOKEN_KEY = 'sailing_admin_token';

    // Stato corrente dell'editor
    let currentKind = null;       // 'polar' o 'waypoints'
    let currentBoatId = null;
    let validationTimer = null;

    // -------------------------------------------------------------------
    // Apertura editor
    // -------------------------------------------------------------------
    async function openEditor(kind, boatIdParam) {
        // Verifica autenticazione (admin token + barca selezionata)
        const token = localStorage.getItem(TOKEN_KEY);
        if (!token) {
            alert('Inserisci prima l\'Admin Token nella sezione Config.');
            return;
        }
        // Se boatId esplicito (chiamata da polarview/wptview), usa quello.
        // Altrimenti fallback al selettore dell'overlay Config (vecchio comportamento).
        const boatId = boatIdParam || document.getElementById('cfg-boat-select').value;
        if (!boatId) {
            alert('Seleziona prima una barca.');
            return;
        }

        currentKind = kind;
        currentBoatId = boatId;

        const title = kind === 'polar' ? '📝 Modifica polar.json' : '📝 Modifica waypoints.json';
        document.getElementById('je-title').textContent = title;
        document.getElementById('je-target-info').textContent =
            `Barca: ${boatId} • File: ${kind === 'polar' ? 'polar.json' : 'waypoints.json'}`;
        document.getElementById('je-textarea').value = 'Caricamento...';
        document.getElementById('je-textarea').disabled = true;
        document.getElementById('je-save').disabled = true;
        setStatus('Caricamento dal server...', 'info');

        document.getElementById('json-editor-overlay').style.display = 'flex';

        // Scarica il file corrente DIRETTAMENTE dal blob storage (no proxy).
        // Step 1: chiedo al backend l'URL del blob.
        // Step 2: fetch diretto al blob (404 = file non ancora caricato).
        try {
            const cfgRes = await SailingAuth.authFetch(API_BASE + '/api/boats/' +
                                       encodeURIComponent(boatId) + '/config-urls');
            if (!cfgRes.ok) throw new Error('config-urls HTTP ' + cfgRes.status);
            const cfg = await cfgRes.json();
            const blobUrl = kind === 'polar' ? cfg.polar_url : cfg.waypoints_url;
            if (!cfg.configured || !blobUrl) {
                throw new Error('Storage non configurato sul server');
            }

            const res = await fetch(blobUrl + '?nocache=' + Date.now());
            if (res.status === 404) {
                // File non ancora caricato: parto da template vuoto
                const template = kind === 'polar' ? defaultPolarTemplate() : defaultWaypointsTemplate();
                document.getElementById('je-textarea').value = JSON.stringify(template, null, 2);
                setStatus('File non ancora caricato. Modifica e salva per crearlo.', 'info');
            } else if (!res.ok) {
                throw new Error('HTTP ' + res.status);
            } else {
                const data = await res.json();
                document.getElementById('je-textarea').value = JSON.stringify(data, null, 2);
                setStatus('File caricato. Modifica e clicca Salva.', 'ok');
            }
            document.getElementById('je-textarea').disabled = false;
            document.getElementById('je-save').disabled = false;
            // Validazione iniziale
            validateContent();
        } catch (e) {
            setStatus('Errore caricamento: ' + e.message, 'err');
            document.getElementById('je-textarea').value = '';
            document.getElementById('je-textarea').disabled = false;
        }
    }

    function closeEditor() {
        document.getElementById('json-editor-overlay').style.display = 'none';
        currentKind = null;
        currentBoatId = null;
    }

    // -------------------------------------------------------------------
    // Template default per file nuovi
    // -------------------------------------------------------------------
    function defaultPolarTemplate() {
        return {
            boat_name: '',
            polar: {
                '6.0': { '30.0': 3.0, '60.0': 5.0, '90.0': 5.5, '120.0': 5.5, '180.0': 5.0 },
                '10.0': { '30.0': 5.0, '60.0': 7.0, '90.0': 8.0, '120.0': 8.5, '180.0': 8.0 },
                '14.0': { '30.0': 6.0, '60.0': 8.5, '90.0': 9.5, '120.0': 10.5, '180.0': 10.0 }
            }
        };
    }

    function defaultWaypointsTemplate() {
        return {
            waypoints: [
                {
                    name: 'Esempio',
                    lat: "45°46.154'N",
                    lon: "13°36.165'E",
                    side: 'port'
                }
            ]
        };
    }

    // -------------------------------------------------------------------
    // Validazione live (debounced)
    // -------------------------------------------------------------------
    function scheduleValidation() {
        if (validationTimer) clearTimeout(validationTimer);
        validationTimer = setTimeout(validateContent, 300);
    }

    function validateContent() {
        const text = document.getElementById('je-textarea').value;
        if (!text.trim()) {
            setStatus('File vuoto', 'err');
            return false;
        }

        // 1. Parsing JSON base
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (e) {
            // Estraggo info da SyntaxError ("Unexpected token X at position Y")
            const m = e.message.match(/position (\d+)/);
            let detail = e.message;
            if (m) {
                const pos = parseInt(m[1], 10);
                const lineCol = posToLineCol(text, pos);
                detail = `${e.message} (riga ${lineCol.line}, col ${lineCol.col})`;
            }
            setStatus('❌ JSON non valido: ' + detail, 'err');
            return false;
        }

        // 2. Validazione specifica
        if (!window.SailingCoord) {
            setStatus('⚠️ Validatori non caricati', 'err');
            return false;
        }
        try {
            if (currentKind === 'polar') {
                const r = window.SailingCoord.validatePolarJson(parsed);
                setStatus(
                    `✅ Polare valida: ${r.twsList.length} TWS × ${r.twaList.length} TWA = ${r.count} celle, vel max ${r.maxSpeed.toFixed(1)} kn`,
                    'ok'
                );
            } else if (currentKind === 'waypoints') {
                const wpts = window.SailingCoord.validateWaypointsJson(parsed);
                setStatus(`✅ ${wpts.length} waypoint validi`, 'ok');
            }
            return true;
        } catch (e) {
            setStatus('❌ ' + e.message, 'err');
            return false;
        }
    }

    function posToLineCol(text, pos) {
        const before = text.substring(0, pos);
        const lines = before.split('\n');
        return { line: lines.length, col: lines[lines.length - 1].length + 1 };
    }

    function setStatus(msg, kind) {
        const el = document.getElementById('je-status');
        el.textContent = msg;
        el.className = 'je-status je-status-' + (kind || 'info');
    }

    // -------------------------------------------------------------------
    // Format JSON (re-indenta)
    // -------------------------------------------------------------------
    function formatJson() {
        const ta = document.getElementById('je-textarea');
        try {
            const parsed = JSON.parse(ta.value);
            ta.value = JSON.stringify(parsed, null, 2);
            setStatus('Formattato. Verifica la sintassi prima di salvare.', 'info');
            validateContent();
        } catch (e) {
            alert('Impossibile formattare: il JSON non è valido.\n\n' + e.message);
        }
    }

    // -------------------------------------------------------------------
    // Save (upload al backend)
    // -------------------------------------------------------------------
    async function saveContent() {
        if (!validateContent()) {
            if (!confirm('Il contenuto non passa la validazione. Vuoi salvare lo stesso?\n(Sconsigliato: il tablet potrebbe non riuscire a leggere il file)')) {
                return;
            }
        }

        const text = document.getElementById('je-textarea').value;
        const token = localStorage.getItem(TOKEN_KEY);
        if (!token) {
            alert('Admin token mancante. Chiudi e riapri dalla sezione Config.');
            return;
        }

        setStatus('Salvataggio in corso...', 'info');
        document.getElementById('je-save').disabled = true;

        try {
            // Pattern SAS upload (3 step):
            //   1. POST /api/admin/boats/{id}/{kind}/upload-url -> SAS URL
            //   2. PUT  <sas_url>  body=text                    -> browser->blob
            //   3. POST /api/admin/boats/{id}/{kind}/notify-uploaded -> timestamp DB
            const sasRes = await SailingAuth.authFetch(API_BASE + `/api/admin/boats/${encodeURIComponent(currentBoatId)}/${currentKind}/upload-url`,
                {
                    method: 'POST',
                    headers: { 'X-Admin-Token': token },
                });
            if (!sasRes.ok) {
                const errText = await sasRes.text();
                setStatus(`❌ Errore SAS (HTTP ${sasRes.status}): ${errText}`, 'err');
                document.getElementById('je-save').disabled = false;
                return;
            }
            const sasData = await sasRes.json();

            // Step 2: PUT diretto al blob.
            const putRes = await fetch(sasData.upload_url, {
                method: 'PUT',
                headers: sasData.headers,
                body: text,
            });
            if (!putRes.ok) {
                const errText = await putRes.text();
                setStatus(`❌ Errore upload blob (HTTP ${putRes.status}): ${errText}`, 'err');
                document.getElementById('je-save').disabled = false;
                return;
            }

            // Step 3: notifico (best-effort)
            try {
                await SailingAuth.authFetch(API_BASE + `/api/admin/boats/${encodeURIComponent(currentBoatId)}/${currentKind}/notify-uploaded`,
                    { method: 'POST', headers: { 'X-Admin-Token': token } });
            } catch (_) { /* ignora */ }

            const sizeKb = (text.length / 1024).toFixed(1);
            setStatus(`✅ Salvato! ${sizeKb} KB caricati sul blob.`, 'ok');

            // Refresh delle viste pubbliche
            if (currentKind === 'polar' && window.SailingPolarView) {
                window.SailingPolarView.refresh();
            }
            if (currentKind === 'waypoints' && window.SailingWptView) {
                window.SailingWptView.refresh();
            }

            // Chiudo dopo 1.2s
            setTimeout(() => {
                closeEditor();
                // Se l'utente aveva la sezione status aperta, ricarico
                if (document.getElementById('config-status-section').style.display !== 'none') {
                    const btn = document.getElementById('cfg-load-status');
                    if (btn) btn.click();
                }
            }, 1200);
        } catch (e) {
            setStatus('❌ Errore: ' + e.message, 'err');
            document.getElementById('je-save').disabled = false;
        }
    }

    function formatBytes(n) {
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / 1024 / 1024).toFixed(2) + ' MB';
    }

    // -------------------------------------------------------------------
    // Tab key handling (per indentare invece che cambiare focus)
    // -------------------------------------------------------------------
    function handleTab(e) {
        if (e.key === 'Tab') {
            e.preventDefault();
            const ta = e.target;
            const start = ta.selectionStart;
            const end = ta.selectionEnd;
            ta.value = ta.value.substring(0, start) + '  ' + ta.value.substring(end);
            ta.selectionStart = ta.selectionEnd = start + 2;
        }
    }

    // -------------------------------------------------------------------
    // Boot
    // -------------------------------------------------------------------
    document.addEventListener('DOMContentLoaded', () => {
        // Pulsanti "Modifica" nell'overlay Config
        const polarBtn = document.getElementById('cfg-polar-edit');
        const wptBtn = document.getElementById('cfg-wpt-edit');
        if (polarBtn) polarBtn.onclick = () => openEditor('polar');
        if (wptBtn) wptBtn.onclick = () => openEditor('waypoints');

        // Toolbar editor
        document.getElementById('je-close').onclick = closeEditor;
        document.getElementById('je-cancel').onclick = closeEditor;
        document.getElementById('je-save').onclick = saveContent;
        document.getElementById('je-format').onclick = formatJson;

        // Validazione mentre digita
        const ta = document.getElementById('je-textarea');
        ta.addEventListener('input', scheduleValidation);
        ta.addEventListener('keydown', handleTab);

        // ESC chiude
        document.addEventListener('keydown', (e) => {
            const overlay = document.getElementById('json-editor-overlay');
            if (e.key === 'Escape' && overlay.style.display === 'flex') {
                if (confirm('Chiudere senza salvare?')) closeEditor();
            }
        });
    });

    // Espongo openEditor come globale per poter aprire l'editor anche
    // da polarview.js / wptview.js (bottone "Modifica" nelle pagine pubbliche).
    window.SailingJsonEditor = {
        open: openEditor,
        close: closeEditor,
    };
})();
