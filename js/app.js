let state = {
    rawDataset: [],
    filteredDataset: [],
    activeTab: 'tab-map',
    calendarMode: 'daily', // 'daily' | 'monthly'
    currentPage: 1,
    pageSize: 20,
    hasUserUploadedCSV: false
};

let map = null;
let mapMarkersGroup = null;
let aoiCircleLayer = null;

const PRESET_BIOMES = {
    'Southeast Asia': { lat: 13.75, lon: 102.50, radius: 600, zoom: 5 },
    'Amazon Basin': { lat: -3.46, lon: -62.21, radius: 600, zoom: 5 },
    'California / US West': { lat: 37.16, lon: -119.44, radius: 300, zoom: 6 },
    'Australian Outback': { lat: -25.27, lon: 133.77, radius: 600, zoom: 4 },
    'Siberia / Boreal': { lat: 61.52, lon: 105.31, radius: 600, zoom: 4 },
    'Central Africa': { lat: -1.00, lon: 22.00, radius: 600, zoom: 5 }
};

window.onload = async function () {
    initMap();
    setupSidebarToggle();
    updateSchemaCards();
    await loadInitialData();
};

const FALLBACK_DEFAULT_DATA = [
    { id: 1, latitude: 11.55, longitude: 104.92, acquisition_date: "2026-03-01", confidence: 85, frp: 142.5, region: "Southeast Asia", sensor: "VIIRS" },
    { id: 2, latitude: 12.10, longitude: 104.50, acquisition_date: "2026-03-01", confidence: 91, frp: 178.0, region: "Southeast Asia", sensor: "MODIS" },
    { id: 3, latitude: -3.46, longitude: -62.21, acquisition_date: "2026-03-02", confidence: 92, frp: 210.0, region: "Amazon Basin", sensor: "VIIRS" },
    { id: 4, latitude: 37.16, longitude: -119.44, acquisition_date: "2026-03-03", confidence: 78, frp: 65.2, region: "California / US West", sensor: "MODIS" },
    { id: 5, latitude: -25.27, longitude: 133.77, acquisition_date: "2026-04-04", confidence: 95, frp: 180.4, region: "Australian Outback", sensor: "VIIRS" },
    { id: 6, latitude: 61.52, longitude: 105.31, acquisition_date: "2026-05-05", confidence: 60, frp: 35.8, region: "Siberia / Boreal", sensor: "MODIS" },
    { id: 7, latitude: -1.00, longitude: 22.00, acquisition_date: "2026-06-06", confidence: 88, frp: 115.0, region: "Central Africa", sensor: "VIIRS" }
];

async function loadInitialData() {
    if (typeof DATA_CONFIG !== 'undefined' && DATA_CONFIG.sourceType === 'folium_map') {
        showFoliumMap(DATA_CONFIG.foliumMapPath);
        return;
    }

    try {
        const fetchedData = await fetchAndNormalizeProcessedData();
        if (fetchedData && fetchedData.length > 0) {
            state.rawDataset = fetchedData;
        } else {
            throw new Error("Empty dataset returned from configured source.");
        }
    } catch (e) {
        console.warn("Using instant harmonized fallback dataset due to slow or offline API response:", e);
        state.rawDataset = FALLBACK_DEFAULT_DATA;
    }

    state.hasUserUploadedCSV = false;

    if (typeof DATA_CONFIG !== 'undefined') {
        if (DATA_CONFIG.sourceType === 'api_endpoint') {
            updateDataStatusBadge("API Data Active", false);
        } else if (DATA_CONFIG.sourceType === 'csv_file') {
            updateDataStatusBadge("Harmonized Data Active", false);
        } else if (DATA_CONFIG.sourceType === 'parquet_file') {
            updateDataStatusBadge("Parquet Dataset Active", false);
        } else {
            updateDataStatusBadge("Configured Dataset Active", false);
        }
    } else {
        updateDataStatusBadge("Harmonized Dataset Active", false);
    }

    populateRegionDropdown();
    setDefaultDateFilters();
    applyFilters(false);
}

async function fetchAndNormalizeProcessedData() {
    try {
        if (!DATA_CONFIG || !DATA_CONFIG.sourceType) {
            return [];
        }

        let rawRecords = [];

        if (DATA_CONFIG.sourceType === 'csv_file' && DATA_CONFIG.fileUrl) {
            const response = await fetch(DATA_CONFIG.fileUrl);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const csvText = await response.text();

            if (typeof Papa !== 'undefined') {
                const parsed = Papa.parse(csvText, { header: true, dynamicTyping: true, skipEmptyLines: true });
                rawRecords = parsed.data || [];
            }
        } else if (DATA_CONFIG.sourceType === 'parquet_file' || (DATA_CONFIG.fileUrl && DATA_CONFIG.fileUrl.endsWith('.parquet'))) {
            const response = await fetch(DATA_CONFIG.fileUrl);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const arrayBuffer = await response.arrayBuffer();

            if (typeof hyparquet !== 'undefined') {
                rawRecords = await new Promise((resolve, reject) => {
                    hyparquet.parquetRead({
                        file: arrayBuffer,
                        rowFormat: 'object',
                        complete: (data) => resolve(data),
                        error: (err) => reject(err)
                    });
                });
            } else {
                throw new Error("hyparquet library is required to parse Parquet files in the browser.");
            }
        } else if (DATA_CONFIG.sourceType === 'api_endpoint' && DATA_CONFIG.apiEndpointUrl) {
            const response = await fetch(DATA_CONFIG.apiEndpointUrl, {
                method: 'GET',
                headers: DATA_CONFIG.apiHeaders || {}
            });

            if (!response.ok) {
                throw new Error(`API error! status: ${response.status}`);
            }

            const text = await response.text();
            if (text.trim().startsWith('[') || text.trim().startsWith('{')) {
                const json = JSON.parse(text);
                rawRecords = Array.isArray(json) ? json : (json.data || json.results || []);
            } else if (typeof Papa !== 'undefined') {
                const parsed = Papa.parse(text, { header: true, dynamicTyping: true, skipEmptyLines: true });
                rawRecords = parsed.data || [];
            }
        }

        const mapping = DATA_CONFIG.columnMapping || {};

        return rawRecords.map((row, idx) => {
            const lat = parseFloat(row[mapping.latitude] || row.latitude || row.lat || 0);
            const lon = parseFloat(row[mapping.longitude] || row.longitude || row.lon || 0);
            const dateVal = row[mapping.acquisition_date] || row.acquisition_date || row.date || new Date().toISOString().split('T')[0];
            const dateStr = String(dateVal).split('T')[0];
            const sensorVal = row[mapping.sensor] || row.sensor || row.sensor_type || 'Harmonized';

            return {
                id: idx + 1,
                latitude: lat,
                longitude: lon,
                acquisition_date: dateStr,
                confidence: parseInt(row[mapping.confidence] || row.confidence) || 50,
                frp: parseFloat(row[mapping.frp] || row.frp) || 10.0,
                region: row[mapping.region] || row.region || 'Global / API',
                sensor: sensorVal
            };
        }).filter(r => r.latitude !== 0 && r.longitude !== 0 && !isNaN(r.latitude) && !isNaN(r.longitude));

    } catch (error) {
        console.error("Failed to fetch or normalize dataset:", error);
        return [];
    }
}

let standardMap = null;
let satelliteMap = null;

function initMap() {
    const southWest = L.latLng(-85, -Infinity);
    const northEast = L.latLng(85, Infinity);
    const bounds = L.latLngBounds(southWest, northEast);

    map = L.map('map', {
        center: [20, 0],
        zoom: 3,
        minZoom: 2,
        maxZoom: 15,
        zoomControl: false,
        maxBounds: bounds,
        maxBoundsViscosity: 1.0
    });

    standardMap = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 15,
        noWrap: false,
        attribution: '© OpenStreetMap contributors'
    });

    satelliteMap = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        noWrap: false,
        attribution: 'Tiles © Esri'
    });

    standardMap.addTo(map);
    mapMarkersGroup = L.layerGroup().addTo(map);
}

function calculateDistanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function jumpToPresetBiome() {
    const select = document.getElementById('preset-biome-select');
    const selectedBiome = select.value;
    if (!selectedBiome || !PRESET_BIOMES[selectedBiome]) return;

    const preset = PRESET_BIOMES[selectedBiome];
    document.getElementById('filter-lat').value = preset.lat;
    document.getElementById('filter-lon').value = preset.lon;
    document.getElementById('filter-radius').value = preset.radius;

    applyFilters(true);
}

function toggleLayerMenu() {
    const menu = document.getElementById('layer-menu');
    menu.classList.toggle('hidden');
}

function switchBaseLayer(layerType) {
    const stdBtn = document.getElementById('btn-layer-standard');
    const satBtn = document.getElementById('btn-layer-satellite');

    if (layerType === 'standard') {
        if (map.hasLayer(satelliteMap)) map.removeLayer(satelliteMap);
        standardMap.addTo(map);

        stdBtn.className = "w-full px-3 py-2 rounded-lg text-xs font-medium text-left flex items-center justify-between bg-amber-500/10 text-amber-400 border border-amber-500/30 transition";
        stdBtn.querySelector('.fa-check').classList.remove('hidden');

        satBtn.className = "w-full px-3 py-2 rounded-lg text-xs font-medium text-left flex items-center justify-between text-slate-300 hover:bg-slate-800 hover:text-white transition";
        satBtn.querySelector('.fa-check').classList.add('hidden');
    } else if (layerType === 'satellite') {
        if (map.hasLayer(standardMap)) map.removeLayer(standardMap);
        satelliteMap.addTo(map);

        satBtn.className = "w-full px-3 py-2 rounded-lg text-xs font-medium text-left flex items-center justify-between bg-amber-500/10 text-amber-400 border border-amber-500/30 transition";
        satBtn.querySelector('.fa-check').classList.remove('hidden');

        stdBtn.className = "w-full px-3 py-2 rounded-lg text-xs font-medium text-left flex items-center justify-between text-slate-300 hover:bg-slate-800 hover:text-white transition";
        stdBtn.querySelector('.fa-check').classList.add('hidden');
    }

    toggleLayerMenu();
}

document.addEventListener('click', function (event) {
    const menu = document.getElementById('layer-menu');
    const container = menu?.parentElement;
    if (menu && container && !container.contains(event.target)) {
        menu.classList.add('hidden');
    }
});

function toggleMapFullscreen() {
    const mapContainer = document.getElementById('tab-map');
    if (!document.fullscreenElement) {
        mapContainer.requestFullscreen().catch(err => {
            alert(`Error attempting to enable fullscreen: ${err.message}`);
        });
    } else {
        document.exitFullscreen();
    }
}

function locateUser() {
    if ("geolocation" in navigator) {
        navigator.geolocation.getCurrentPosition(position => {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;
            map.setView([lat, lng], 10);
            L.marker([lat, lng]).addTo(map).bindPopup("Emergency Responder Location").openPopup();
        }, () => {
            alert("Unable to retrieve your location.");
        });
    } else {
        alert("Geolocation is not supported by your browser.");
    }
}

function showFoliumMap(path) {
    const iframe = document.getElementById('folium-iframe');
    iframe.src = path;
    iframe.classList.remove('hidden');
    updateDataStatusBadge("Folium Map Embedded", false);
}

function updateDataStatusBadge(text, isSynthetic) {
    const badge = document.getElementById('data-status-badge');
    document.getElementById('data-status-text').textContent = text;
    badge.className = `flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium ${isSynthetic ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'}`;
}

function triggerFileUpload() {
    document.getElementById('csv-file-input').click();
}

function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    Papa.parse(file, {
        header: true,
        dynamicTyping: true,
        skipEmptyLines: true,
        complete: function (results) {
            if (results.data && results.data.length > 0) {
                processUploadedCSV(results.data, file.name);
            }
        }
    });
}

function processUploadedCSV(parsedData, fileName) {
    document.getElementById('folium-iframe').classList.add('hidden');
    const normalized = parsedData.map((row, idx) => ({
        id: idx + 1,
        latitude: parseFloat(row.latitude || row.lat || 0),
        longitude: parseFloat(row.longitude || row.lon || 0),
        acquisition_date: String(row.acquisition_date || row.date || new Date().toISOString().split('T')[0]).split('T')[0],
        confidence: parseInt(row.confidence) || 50,
        frp: parseFloat(row.frp) || 10.0,
        region: row.region || 'Custom Upload',
        sensor: row.sensor || row.sensor_type || 'Harmonized'
    })).filter(r => r.latitude !== 0 && r.longitude !== 0);

    state.rawDataset = normalized;
    state.hasUserUploadedCSV = true;
    updateDataStatusBadge(`Live CSV: ${fileName}`, false);
    populateRegionDropdown();
    setDefaultDateFilters();
    applyFilters(true);
}

async function clearUserCSVData() {
    const fileInput = document.getElementById('csv-file-input');
    if (fileInput) fileInput.value = '';

    const latInput = document.getElementById('filter-lat');
    const lonInput = document.getElementById('filter-lon');
    if (latInput) latInput.value = '';
    if (lonInput) lonInput.value = '';

    const biomeSelect = document.getElementById('preset-biome-select');
    if (biomeSelect) biomeSelect.value = '';

    if (aoiCircleLayer && map) {
        map.removeLayer(aoiCircleLayer);
        aoiCircleLayer = null;
    }

    const iframe = document.getElementById('folium-iframe');
    if (iframe) iframe.classList.add('hidden');

    if (mapMarkersGroup) {
        mapMarkersGroup.clearLayers();
    }

    state.hasUserUploadedCSV = false;
    state.rawDataset = [];
    state.filteredDataset = [];

    await loadInitialData();
}

/**
 * Spatial Radius, Region, Sensor & AOI Filtering with Map Auto-Focus
 */
function applyFilters(shouldZoomMap = false) {
    const startDate = document.getElementById('filter-start-date').value;
    const endDate = document.getElementById('filter-end-date').value;
    const selectedRegion = document.getElementById('filter-region').value;
    const selectedSensor = document.getElementById('filter-sensor').value;
    const minConf = parseInt(document.getElementById('filter-confidence').value) || 0;
    const minFRP = parseFloat(document.getElementById('filter-frp').value) || 0;

    const latVal = document.getElementById('filter-lat')?.value.trim();
    const lonVal = document.getElementById('filter-lon')?.value.trim();
    const radiusKm = parseFloat(document.getElementById('filter-radius')?.value) || 300;
    const targetLat = latVal !== "" ? parseFloat(latVal) : NaN;
    const targetLon = lonVal !== "" ? parseFloat(lonVal) : NaN;
    const hasCoords = !isNaN(targetLat) && !isNaN(targetLon);

    state.filteredDataset = state.rawDataset.filter(item => {
        const matchDate = (!startDate || item.acquisition_date >= startDate) && (!endDate || item.acquisition_date <= endDate);
        const matchRegion = selectedRegion === 'ALL' || item.region === selectedRegion;
        const matchSensor = selectedSensor === 'ALL' || item.sensor === selectedSensor;
        const matchConf = item.confidence >= minConf;
        const matchFRP = item.frp >= minFRP;

        let matchCoords = true;
        if (hasCoords) {
            const distance = calculateDistanceKm(targetLat, targetLon, item.latitude, item.longitude);
            matchCoords = distance <= radiusKm;
        }

        return matchDate && matchRegion && matchSensor && matchConf && matchFRP && matchCoords;
    });

    if (map) {
        if (aoiCircleLayer) {
            map.removeLayer(aoiCircleLayer);
            aoiCircleLayer = null;
        }
        if (hasCoords) {
            aoiCircleLayer = L.circle([targetLat, targetLon], {
                radius: radiusKm * 1000,
                color: '#f59e0b',
                weight: 1.5,
                dashArray: '5, 5',
                fillColor: '#f59e0b',
                fillOpacity: 0.08
            }).addTo(map);

            if (shouldZoomMap) {
                map.fitBounds(aoiCircleLayer.getBounds(), { padding: [30, 30] });
            }
        } else if (shouldZoomMap && state.filteredDataset.length > 0) {
            resetMapBounds();
        }
    }

    state.currentPage = 1;
    updateMetrics();
    updateEmergencyAnomalyBanner();
    renderActiveTab();
}

function populateRegionDropdown() {
    const select = document.getElementById('filter-region');
    const regions = Array.from(new Set(state.rawDataset.map(d => d.region))).sort();
    select.innerHTML = '<option value="ALL">All Regions (Global)</option>';
    regions.forEach(r => {
        const opt = document.createElement('option');
        opt.value = r;
        opt.textContent = r;
        select.appendChild(opt);
    });
}

function setDefaultDateFilters() {
    if (state.rawDataset.length === 0) return;
    const dates = state.rawDataset.map(d => new Date(d.acquisition_date)).filter(d => !isNaN(d));
    const maxDate = new Date(Math.max(...dates));
    const minDate = new Date(Math.min(...dates));
    document.getElementById('filter-start-date').value = minDate.toISOString().split('T')[0];
    document.getElementById('filter-end-date').value = maxDate.toISOString().split('T')[0];
    document.getElementById('latest-obs-date').textContent = maxDate.toISOString().split('T')[0];
}

function updateRangeLabels() {
    document.getElementById('confidence-val').textContent = document.getElementById('filter-confidence').value + '%';
    document.getElementById('frp-val').textContent = document.getElementById('filter-frp').value + ' MW';
}

function resetFilters() {
    document.getElementById('filter-confidence').value = 0;
    document.getElementById('filter-frp').value = 0;
    document.getElementById('filter-region').value = 'ALL';
    document.getElementById('filter-sensor').value = 'ALL';
    document.getElementById('preset-biome-select').value = '';
    const latInput = document.getElementById('filter-lat');
    const lonInput = document.getElementById('filter-lon');
    if (latInput) latInput.value = '';
    if (lonInput) lonInput.value = '';
    if (aoiCircleLayer && map) {
        map.removeLayer(aoiCircleLayer);
        aoiCircleLayer = null;
    }
    updateRangeLabels();
    setDefaultDateFilters();
    applyFilters(true);
}

function updateMetrics() {
    const data = state.filteredDataset;
    const raw = state.rawDataset;

    document.getElementById('sidebar-total-records').textContent = raw.length;
    document.getElementById('metric-total-hotspots').textContent = data.length.toLocaleString();
    document.getElementById('metric-active-days').textContent = new Set(data.map(d => d.acquisition_date)).size;

    const avgFrp = data.length > 0 ? (data.reduce((acc, curr) => acc + curr.frp, 0) / data.length) : 0;
    document.getElementById('metric-avg-frp').textContent = avgFrp.toFixed(1);

    const rawFrps = raw.map(d => d.frp).sort((a, b) => a - b);
    const medianFrp = rawFrps.length > 0 ? rawFrps[Math.floor(rawFrps.length / 2)] : 0;
    const diffPercent = medianFrp > 0 ? Math.round(((avgFrp - medianFrp) / medianFrp) * 100) : 0;

    const diffEl = document.getElementById('metric-median-diff');
    diffEl.textContent = `${diffPercent >= 0 ? '+' : ''}${diffPercent}%`;
    diffEl.className = `text-xl font-bold font-mono ${diffPercent > 15 ? 'text-red-400' : (diffPercent > 0 ? 'text-amber-400' : 'text-emerald-400')}`;
}

function updateEmergencyAnomalyBanner() {
    const data = state.filteredDataset;
    const badge = document.getElementById('anomaly-badge');
    const desc = document.getElementById('anomaly-description');
    const peakEl = document.getElementById('metric-peak-period');

    if (data.length === 0) {
        badge.className = "px-2.5 py-0.5 rounded-full font-bold uppercase tracking-wider bg-slate-800 text-slate-400 border border-slate-700 flex items-center gap-1.5";
        badge.innerHTML = `<i class="fa-solid fa-circle-info"></i> No Active Detections`;
        desc.textContent = "No thermal hotspots detected inside current AOI filter parameters.";
        peakEl.textContent = "--";
        return;
    }

    const monthCounts = {};
    data.forEach(d => {
        const ym = d.acquisition_date.slice(0, 7);
        monthCounts[ym] = (monthCounts[ym] || 0) + 1;
    });
    const peakMonth = Object.keys(monthCounts).reduce((a, b) => monthCounts[a] > monthCounts[b] ? a : b);
    peakEl.textContent = `${peakMonth} (${monthCounts[peakMonth]} fires)`;

    const avgFrp = data.reduce((sum, d) => sum + d.frp, 0) / data.length;
    const highIntensityCount = data.filter(d => d.frp > 150).length;

    if (highIntensityCount >= 2 || avgFrp > 140) {
        badge.className = "px-2.5 py-0.5 rounded-full font-bold uppercase tracking-wider bg-red-500/20 text-red-400 border border-red-500/40 flex items-center gap-1.5 animate-pulse";
        badge.innerHTML = `<i class="fa-solid fa-fire-flame-curved"></i> Critical Fire Anomaly`;
        desc.textContent = `Elevated radiative intensity detected (${highIntensityCount} extreme >150 MW hotspots). Immediate land manager review advised.`;
    } else if (avgFrp > 75) {
        badge.className = "px-2.5 py-0.5 rounded-full font-bold uppercase tracking-wider bg-amber-500/20 text-amber-400 border border-amber-500/40 flex items-center gap-1.5";
        badge.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Moderate Burn Activity`;
        desc.textContent = `Sustained burning regime active across ${new Set(data.map(d => d.region)).size} region(s).`;
    } else {
        badge.className = "px-2.5 py-0.5 rounded-full font-bold uppercase tracking-wider bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center gap-1.5";
        badge.innerHTML = `<i class="fa-solid fa-shield-check"></i> Low / Baseline Activity`;
        desc.textContent = "Thermal observations remain within normal seasonal agricultural/low-intensity thresholds.";
    }
}

function switchTab(tabId) {
    state.activeTab = tabId;
    document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.add('hidden'));
    document.getElementById(tabId).classList.remove('hidden');
    document.querySelectorAll('.st-tab').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`btn-${tabId}`).classList.add('active');
    renderActiveTab();
    if (tabId === 'tab-map' && map) setTimeout(() => map.invalidateSize(), 150);
}

function renderActiveTab() {
    if (state.activeTab === 'tab-map') renderMapHotspots();
    else if (state.activeTab === 'tab-calendar') renderActivityCalendar();
    else if (state.activeTab === 'tab-analytics') renderCharts();
    else if (state.activeTab === 'tab-explorer') renderTable();
}

/**
 * Updated renderMapHotspots to display sensor type explicitly in popups
 */
function renderMapHotspots() {
    if (!map) return;
    mapMarkersGroup.clearLayers();
    state.filteredDataset.forEach(item => {
        let color = item.frp > 150 ? '#dc2626' : (item.frp > 50 ? '#f59e0b' : '#facc15');
        const circle = L.circleMarker([item.latitude, item.longitude], {
            radius: item.frp > 150 ? 9 : 6,
            fillColor: color,
            color: '#f8fafc',
            weight: 0.8,
            fillOpacity: 0.85
        });

        const popupContent = `
            <div class="space-y-1 text-xs">
                <div class="font-bold text-amber-400 flex items-center justify-between border-b border-slate-700 pb-1">
                    <span><i class="fa-solid fa-fire mr-1"></i> ${item.region}</span>
                    <span class="text-[10px] text-slate-400">ID #${item.id}</span>
                </div>
                <div class="grid grid-cols-2 gap-x-2 gap-y-1 pt-1 text-slate-200 font-mono">
                    <div>Date: <span class="text-white">${item.acquisition_date}</span></div>
                    <div>Sensor: <span class="text-amber-400 font-bold">${item.sensor}</span></div>
                    <div>FRP: <span class="text-amber-400 font-bold">${item.frp} MW</span></div>
                    <div>Lat/Lon: <span class="text-slate-300">${item.latitude}, ${item.longitude}</span></div>
                    <div class="col-span-2">Confidence: <span class="text-emerald-400 font-bold">${item.confidence}%</span></div>
                </div>
            </div>
        `;
        circle.bindPopup(popupContent);
        mapMarkersGroup.addLayer(circle);
    });
}

function resetMapBounds() {
    if (state.filteredDataset.length > 0) {
        const bounds = L.latLngBounds(state.filteredDataset.map(d => [d.latitude, d.longitude]));
        map.fitBounds(bounds, { padding: [50, 50] });
    } else map.setView([20, 0], 2);
}

function setCalendarViewMode(mode) {
    state.calendarMode = mode;
    const btnDaily = document.getElementById('btn-cal-daily');
    const btnMonthly = document.getElementById('btn-cal-monthly');

    if (mode === 'daily') {
        btnDaily.className = "px-3 py-1.5 rounded-md text-xs font-bold bg-amber-500 text-slate-950 transition";
        btnMonthly.className = "px-3 py-1.5 rounded-md text-xs font-medium text-slate-400 hover:text-white transition";
    } else {
        btnMonthly.className = "px-3 py-1.5 rounded-md text-xs font-bold bg-amber-500 text-slate-950 transition";
        btnDaily.className = "px-3 py-1.5 rounded-md text-xs font-medium text-slate-400 hover:text-white transition";
    }
    renderActivityCalendar();
}

function renderActivityCalendar() {
    const grid = document.getElementById('calendar-grid');
    grid.innerHTML = '';
    const data = state.filteredDataset;
    if (data.length === 0) {
        grid.innerHTML = '<div class="col-span-full text-center text-slate-500 py-6 text-xs">No fire observations found matching current AOI filter criteria.</div>';
        return;
    }

    const countsByKey = {};
    const frpByKey = {};

    data.forEach(d => {
        const key = state.calendarMode === 'monthly' ? d.acquisition_date.slice(0, 7) : d.acquisition_date;
        countsByKey[key] = (countsByKey[key] || 0) + 1;
        frpByKey[key] = (frpByKey[key] || 0) + d.frp;
    });

    const sortedKeys = Object.keys(countsByKey).sort();
    document.getElementById('calendar-date-range').textContent = `Active Regime Span: ${sortedKeys[0]} to ${sortedKeys[sortedKeys.length - 1]}`;

    const maxCount = Math.max(...Object.values(countsByKey));

    sortedKeys.forEach(keyStr => {
        const count = countsByKey[keyStr];
        const avgFrp = Math.round(frpByKey[keyStr] / count);
        const intensity = count / maxCount;

        let bgClass = 'bg-amber-950/50 border-amber-800/50 text-amber-300';
        if (intensity > 0.75) bgClass = 'bg-red-600 border-red-400 text-white font-bold shadow-lg shadow-red-600/30';
        else if (intensity > 0.5) bgClass = 'bg-orange-600 border-orange-400 text-white font-bold';
        else if (intensity > 0.25) bgClass = 'bg-amber-600 border-amber-400 text-slate-950 font-bold';

        const card = document.createElement('div');
        card.className = `p-2.5 rounded-lg border text-center cursor-pointer transition transform hover:scale-105 flex flex-col justify-between h-20 ${bgClass}`;
        const label = state.calendarMode === 'monthly' ? keyStr : keyStr.slice(5);
        card.innerHTML = `
            <span class="text-[10px] opacity-90 font-mono">${label}</span>
            <span class="text-base font-mono font-bold">${count}</span>
            <span class="text-[9px] opacity-80 font-mono">${avgFrp} MW</span>
        `;
        card.onclick = () => showCalendarDayDetails(keyStr, data.filter(d => d.acquisition_date.startsWith(keyStr)));
        grid.appendChild(card);
    });
}

function showCalendarDayDetails(periodStr, records) {
    const drawer = document.getElementById('calendar-day-details');
    const title = document.getElementById('selected-day-title');
    const count = document.getElementById('selected-day-count');
    const list = document.getElementById('selected-day-list');

    drawer.classList.remove('hidden');
    title.textContent = `Satellite Detections for ${periodStr}`;
    count.textContent = `${records.length} Hotspots`;

    list.innerHTML = records.map(r => `
        <div class="p-2.5 bg-slate-950 rounded-lg border border-slate-800 flex justify-between items-center">
            <div>
                <span class="font-bold text-slate-200">${r.region}</span>
                <span class="text-slate-500 ml-2">(${r.latitude}, ${r.longitude})</span>
            </div>
            <div class="flex gap-3 text-slate-300 font-mono text-[11px]">
                <span>Sensor: <strong class="text-amber-400">${r.sensor}</strong></span>
                <span>FRP: <strong class="text-amber-400">${r.frp} MW</strong></span>
                <span>Conf: <strong class="text-emerald-400">${r.confidence}%</strong></span>
            </div>
        </div>
    `).join('');
}

function renderCharts() {
    const data = state.filteredDataset;
    if (data.length === 0) return;

    const layoutTheme = {
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        font: { color: '#94a3b8', family: 'sans-serif', size: 11 },
        margin: { t: 35, r: 45, l: 45, b: 45 },
        xaxis: { gridcolor: '#1e293b', zerolinecolor: '#334155' },
        yaxis: { gridcolor: '#1e293b', zerolinecolor: '#334155' },
        hovermode: 'closest'
    };

    const countsByDay = {};
    data.forEach(d => countsByDay[d.acquisition_date] = (countsByDay[d.acquisition_date] || 0) + 1);
    const dates = Object.keys(countsByDay).sort();

    Plotly.newPlot('chart-timeseries', [{
        x: dates,
        y: dates.map(d => countsByDay[d]),
        type: 'scatter',
        mode: 'lines+markers',
        line: { color: '#f59e0b', width: 3, shape: 'spline' },
        marker: { size: 8, color: '#ef4444' },
        hovertemplate: '<b>Date</b>: %{x}<br><b>Detections</b>: %{y}<extra></extra>'
    }], {
        ...layoutTheme,
        title: { text: 'Daily Detection Trend', font: { size: 12, color: '#f1f5f9' } },
        yaxis: { title: 'Detections Count', gridcolor: '#1e293b' }
    }, { responsive: true, displayModeBar: false });

    const regCounts = {};
    const regTotalFRP = {};
    data.forEach(d => {
        regCounts[d.region] = (regCounts[d.region] || 0) + 1;
        regTotalFRP[d.region] = (regTotalFRP[d.region] || 0) + d.frp;
    });

    const regions = Object.keys(regCounts);
    const hotspotValues = regions.map(r => regCounts[r]);
    const meanFrpValues = regions.map(r => +(regTotalFRP[r] / regCounts[r]).toFixed(1));

    Plotly.newPlot('chart-regional', [
        {
            x: regions,
            y: hotspotValues,
            name: 'Hotspots',
            type: 'bar',
            offsetgroup: 1,
            marker: { color: '#ef4444', opacity: 0.9 },
            hovertemplate: '<b>Region</b>: %{x}<br><b>Hotspots</b>: %{y}<extra></extra>'
        },
        {
            x: regions,
            y: meanFrpValues,
            name: 'Mean FRP (MW)',
            type: 'bar',
            yaxis: 'y2',
            offsetgroup: 2,
            marker: { color: '#f59e0b', opacity: 0.9 },
            hovertemplate: '<b>Region</b>: %{x}<br><b>Mean FRP</b>: %{y} MW<extra></extra>'
        }
    ], {
        ...layoutTheme,
        title: { text: 'Hotspots & Mean FRP by Region (Click bar to filter)', font: { size: 12, color: '#f1f5f9' } },
        barmode: 'group',
        yaxis: {
            title: 'Hotspots',
            titlefont: { color: '#ef4444' },
            tickfont: { color: '#ef4444' },
            gridcolor: '#1e293b'
        },
        yaxis2: {
            title: 'Mean FRP (MW)',
            titlefont: { color: '#f59e0b' },
            tickfont: { color: '#f59e0b' },
            overlaying: 'y',
            side: 'right',
            showgrid: false
        },
        legend: { orientation: 'h', y: -0.25, x: 0.25 }
    }, { responsive: true, displayModeBar: false });

    document.getElementById('chart-regional').on('plotly_click', function (eventData) {
        if (eventData.points && eventData.points[0]) {
            const clickedRegion = eventData.points[0].x;
            document.getElementById('filter-region').value = clickedRegion;
            applyFilters(true);
        }
    });

    Plotly.newPlot('chart-scatter', [{
        x: data.map(d => d.confidence),
        y: data.map(d => d.frp),
        text: data.map(d => `Region: ${d.region}<br>Sensor: ${d.sensor}<br>Date: ${d.acquisition_date}`),
        mode: 'markers',
        type: 'scatter',
        marker: { size: 9, color: data.map(d => d.frp), colorscale: 'YlOrRd', showscale: true, colorbar: { thickness: 10, len: 0.8 } },
        hovertemplate: '<b>Confidence</b>: %{x}%<br><b>FRP</b>: %{y} MW<br>%{text}<extra></extra>'
    }], {
        ...layoutTheme,
        title: { text: 'FRP vs. Detection Confidence', font: { size: 12, color: '#f1f5f9' } },
        xaxis: { title: 'Confidence (%)', gridcolor: '#1e293b' },
        yaxis: { title: 'FRP (MW)', gridcolor: '#1e293b' }
    }, { responsive: true, displayModeBar: false });

    Plotly.newPlot('chart-pie', [{
        labels: regions,
        values: hotspotValues,
        type: 'pie',
        hole: 0.55,
        marker: { colors: ['#f59e0b', '#ef4444', '#3b82f6', '#10b981', '#8b5cf6', '#ec4899'] },
        hovertemplate: '<b>%{label}</b>: %{value} hotspots (%{percent})<extra></extra>'
    }], {
        ...layoutTheme,
        title: { text: 'Regional Proportional Share', font: { size: 12, color: '#f1f5f9' } },
        showlegend: true,
        legend: { orientation: 'h', y: -0.2 }
    }, { responsive: true, displayModeBar: false });
}

function renderTable() {
    const tbody = document.getElementById('data-table-body');
    tbody.innerHTML = '';

    const data = state.filteredDataset;
    const startIdx = (state.currentPage - 1) * state.pageSize;
    const pageData = data.slice(startIdx, startIdx + state.pageSize);

    document.getElementById('table-record-count').textContent = `Showing ${pageData.length} of ${data.length} records`;

    const totalPages = Math.max(1, Math.ceil(data.length / state.pageSize));
    document.getElementById('page-indicator').textContent = `Page ${state.currentPage} of ${totalPages}`;
    document.getElementById('btn-prev-page').disabled = state.currentPage === 1;
    document.getElementById('btn-next-page').disabled = state.currentPage === totalPages;

    if (pageData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="p-8 text-center text-slate-500">No records found.</td></tr>';
        return;
    }

    pageData.forEach(row => {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-slate-900/80 transition';
        tr.innerHTML = `
            <td class="p-3 font-semibold text-slate-200">${row.acquisition_date}</td>
            <td class="p-3 text-slate-400">${row.latitude}</td>
            <td class="p-3 text-slate-400">${row.longitude}</td>
            <td class="p-3"><span class="px-2 py-0.5 rounded bg-slate-800 text-amber-400 border border-slate-700 text-[11px]">${row.region}</span></td>
            <td class="p-3"><span class="text-amber-300 font-mono">${row.sensor}</span></td>
            <td class="p-3"><span class="text-emerald-400 font-bold">${row.confidence}%</span></td>
            <td class="p-3"><span class="text-amber-400 font-bold">${row.frp} MW</span></td>
        `;
        tbody.appendChild(tr);
    });
}

function changePage(delta) {
    state.currentPage += delta;
    renderTable();
}

function filterTable() {
    const query = document.getElementById('table-search').value.toLowerCase();
    if (!query) {
        applyFilters(false);
        return;
    }

    state.filteredDataset = state.rawDataset.filter(item =>
        item.region.toLowerCase().includes(query) ||
        item.acquisition_date.includes(query) ||
        item.sensor.toLowerCase().includes(query)
    );

    state.currentPage = 1;
    renderTable();
}

function exportFilteredCSV() {
    const data = state.filteredDataset;
    if (data.length === 0) {
        alert("No records available to export.");
        return;
    }

    const csv = Papa.unparse(data);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);

    link.setAttribute("href", url);
    link.setAttribute("download", `burnscan_harmonized_hotspots_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function exportIncidentBriefing() {
    const data = state.filteredDataset;
    if (data.length === 0) {
        alert("No active hotspot records in current AOI to summarize.");
        return;
    }

    const avgFrp = (data.reduce((s, d) => s + d.frp, 0) / data.length).toFixed(1);
    const maxFrp = Math.max(...data.map(d => d.frp)).toFixed(1);
    const extremeCount = data.filter(d => d.frp > 150).length;
    const regions = Array.from(new Set(data.map(d => d.region))).join(', ');
    const statusText = document.getElementById('anomaly-badge').innerText.trim();
    const peakPeriod = document.getElementById('metric-peak-period').innerText.trim();

    const reportText = [
        "====================================================================",
        "BURNSCAN - MODIS & VIIRS HARMONIZED FIRE INCIDENT BRIEFING",
        "NASA Space Apps Challenge 2026 | Early Warning & Land Management Tool",
        "====================================================================",
        `Generated Timestamp : ${new Date().toISOString()}`,
        `Alert Status        : ${statusText}`,
        `Affected Region(s)  : ${regions}`,
        `Peak Activity Window: ${peakPeriod}`,
        "--------------------------------------------------------------------",
        "KEY METRICS SUMMARY:",
        `- Total Filtered Hotspots : ${data.length}`,
        `- Active Burning Days     : ${new Set(data.map(d => d.acquisition_date)).size}`,
        `- Mean FRP Intensity      : ${avgFrp} MW`,
        `- Peak FRP Observed       : ${maxFrp} MW`,
        `- Extreme Fires (>150 MW) : ${extremeCount}`,
        "--------------------------------------------------------------------",
        "TOP INTENSITY HOTSPOT DETECTIONS:",
        ...data
            .slice()
            .sort((a, b) => b.frp - a.frp)
            .slice(0, 10)
            .map((r, i) => `${i + 1}. [${r.acquisition_date}] ${r.region} (${r.sensor}) - Lat/Lon: (${r.latitude}, ${r.longitude}) - FRP: ${r.frp} MW | Conf: ${r.confidence}%`),
        "===================================================================="
    ].join("\n");

    const blob = new Blob([reportText], { type: 'text/plain;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `BurnScan_Incident_Briefing_${new Date().toISOString().split('T')[0]}.txt`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function updateSchemaCards() {
    if (typeof DATA_CONFIG === 'undefined' || !DATA_CONFIG.columnMapping) return;
    document.getElementById('schema-mapping-cards').innerHTML = Object.keys(DATA_CONFIG.columnMapping).map(key => `
        <div class="bg-slate-950 p-2.5 rounded-lg border border-slate-800">
            <div class="text-[10px] text-slate-500 uppercase">${key}</div>
            <div class="font-mono text-amber-400 font-semibold truncate">${DATA_CONFIG.columnMapping[key]}</div>
        </div>
    `).join('');
}

function setupSidebarToggle() {
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebar-toggle');
    const closeBtn = document.getElementById('sidebar-close');

    toggleBtn.onclick = () => sidebar.classList.toggle('-translate-x-full');
    if (closeBtn) closeBtn.onclick = () => sidebar.classList.add('-translate-x-full');
}