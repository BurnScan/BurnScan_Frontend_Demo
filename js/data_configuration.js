/**
 * FIRE HOTSPOT MONITORING DASHBOARD - ADMIN DATA CONFIGURATION
 * 
 * Supported source types:
 *   - 'synthetic': Uses realistic sample data generated in v1.html
 *   - 'csv_file': Load a local/hosted CSV file via fileUrl
 *   - 'api_endpoint': Connect to a REST API collection returning JSON records
 *   - 'folium_map': Embeds the Python-generated map.html iframe into Tab 1
 */
// require("dotenv").config();
// const KEY = process.env.MAP_KEY;
const DATA_CONFIG = {

    // sourceType: 'cvs_file',
    // fileUrl: './resource/sampleData.csv',

    sourceType: 'parquet_file',
    fileUrl: '/resource/fires_final.parquet',
    
    //apiEndpointUrl: `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${KEY}/VIIRS_NOAA20_NRT/world/1`,
    // apiEndpointUrl: `https://firms.modaps.eosdis.nasa.gov/api/data_availability/csv/${MAP_KEY}/all`,

    columnMapping: {
        latitude: 'latitude',
        longitude: 'longitude',
        acquisition_date: 'acq_date',
        confidence: 'confidence',
        frp: 'frp',
        region: 'region'
    }

    // Active source type: 'synthetic' | 'csv_file' | 'api_endpoint' | 'folium_map'
    //sourceType: 'api_endpoint',
    // File path or API endpoint URL
    //apiEndpointUrl: 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/apikey/VIIRS_NOAA20_NRT/world/1',
    // Include your API key inside request headers or auth parameters
    // apiHeaders: {
    //     'Authorization': 'Bearer YOUR_API_KEY_HERE',
    //     'Content-Type': 'application/json'
    // },
    //foliumMapPath: 'map.html',

    // Column Mapping Adapter
    // columnMapping: {
    //     latitude: 'latitude',
    //     longitude: 'longitude',
    //     acquisition_date: 'acquisition_date',
    //     confidence: 'confidence',
    //     frp: 'frp',
    //     region: 'region'
    // }
};

/**
 * Data Ingestion & Schema Standardization Adapter
 */
async function fetchAndNormalizeProcessedData() {
    let rawRecords = [];

    try {
        if (DATA_CONFIG.sourceType === 'csv_file' && DATA_CONFIG.fileUrl) {
            const response = await fetch(DATA_CONFIG.fileUrl);
            if (!response.ok) throw new Error(`HTTP error ${response.status}`);
            const csvText = await response.text();
            
            if (typeof Papa !== 'undefined') {
                const parsed = Papa.parse(csvText, { header: true, dynamicTyping: true, skipEmptyLines: true });
                rawRecords = parsed.data || [];
            }
        } else if (DATA_CONFIG.sourceType === 'api_endpoint' && DATA_CONFIG.apiEndpoint) {
            const response = await fetch(DATA_CONFIG.apiEndpoint);
            if (!response.ok) throw new Error(`API connection failed: ${response.status}`);
            const json = await response.json();
            rawRecords = Array.isArray(json) ? json : (json.data || json.results || []);
        } else {
            return [];
        }

        const mapping = DATA_CONFIG.columnMapping;
        return rawRecords.map((row, idx) => {
            const lat = parseFloat(row[mapping.latitude]);
            const lon = parseFloat(row[mapping.longitude]);
            const dateVal = row[mapping.acquisition_date] ? String(row[mapping.acquisition_date]).split('T')[0] : null;

            return {
                id: idx + 1,
                latitude: isNaN(lat) ? null : lat,
                longitude: isNaN(lon) ? null : lon,
                acquisition_date: dateVal,
                confidence: parseInt(row[mapping.confidence]) || 50,
                frp: parseFloat(row[mapping.frp]) || 10.0,
                region: row[mapping.region] || 'Unspecified'
            };
        }).filter(item => item.latitude !== null && item.longitude !== null && item.acquisition_date !== null);

    } catch (error) {
        console.error("Error loading configured dataset:", error);
        return [];
    }
}