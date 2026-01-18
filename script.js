/**
 * Map to Poster - Web App
 * Generates beautiful, minimalist map posters for any city
 */

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
    NOMINATIM_URL: 'https://nominatim.openstreetmap.org/search',
    // Multiple Overpass servers for fallback (main server can be overloaded)
    OVERPASS_SERVERS: [
        'https://overpass-api.de/api/interpreter',
        'https://overpass.kumi.systems/api/interpreter',
        'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
    ],
    CANVAS_WIDTH: 900,
    CANVAS_HEIGHT: 1200,
    USER_AGENT: 'MapToPosterWebApp/1.0'
};

// Road width multipliers for canvas rendering
const ROAD_WIDTHS = {
    motorway: 3.5,
    motorway_link: 3.0,
    trunk: 3.0,
    trunk_link: 2.5,
    primary: 2.5,
    primary_link: 2.0,
    secondary: 2.0,
    secondary_link: 1.5,
    tertiary: 1.5,
    tertiary_link: 1.2,
    residential: 1.0,
    living_street: 0.8,
    unclassified: 0.8,
    service: 0.5,
    default: 0.8
};

// ============================================================================
// State
// ============================================================================

let currentTheme = null;
let lastGeneratedCity = '';
let lastGeneratedCountry = '';

// ============================================================================
// DOM Elements
// ============================================================================

const elements = {
    form: document.getElementById('poster-form'),
    cityInput: document.getElementById('city'),
    countryInput: document.getElementById('country'),
    themeSelect: document.getElementById('theme'),
    distanceInput: document.getElementById('distance'),
    distanceValue: document.getElementById('distance-value'),
    generateBtn: document.getElementById('generate-btn'),
    downloadBtn: document.getElementById('download-btn'),
    status: document.getElementById('status'),
    canvas: document.getElementById('poster-canvas'),
    loadingOverlay: document.getElementById('loading-overlay'),
    loadingText: document.getElementById('loading-text')
};

const ctx = elements.canvas.getContext('2d');

// ============================================================================
// Theme Loading
// ============================================================================

async function loadTheme(themeName) {
    try {
        const response = await fetch(`themes/${themeName}.json`);
        if (!response.ok) {
            throw new Error(`Theme '${themeName}' not found`);
        }
        currentTheme = await response.json();
        return currentTheme;
    } catch (error) {
        console.error('Error loading theme:', error);
        // Fallback theme
        currentTheme = {
            name: "Default",
            bg: "#FFFFFF",
            text: "#000000",
            gradient_color: "#FFFFFF",
            water: "#C0C0C0",
            parks: "#F0F0F0",
            road_motorway: "#0A0A0A",
            road_primary: "#1A1A1A",
            road_secondary: "#2A2A2A",
            road_tertiary: "#3A3A3A",
            road_residential: "#4A4A4A",
            road_default: "#3A3A3A"
        };
        return currentTheme;
    }
}

// ============================================================================
// Geocoding (Nominatim API)
// ============================================================================

async function geocode(city, country) {
    const query = encodeURIComponent(`${city}, ${country}`);
    const url = `${CONFIG.NOMINATIM_URL}?q=${query}&format=json&limit=1`;
    
    // Browser sends its own User-Agent; custom headers can cause CORS issues
    const response = await fetch(url);
    
    if (!response.ok) {
        throw new Error(`Geocoding request failed (${response.status})`);
    }
    
    const data = await response.json();
    
    if (!data || data.length === 0) {
        throw new Error(`Could not find location: ${city}, ${country}`);
    }
    
    return {
        lat: parseFloat(data[0].lat),
        lon: parseFloat(data[0].lon),
        displayName: data[0].display_name
    };
}

// ============================================================================
// OSM Data Fetching (Overpass API)
// ============================================================================

async function fetchOSMData(lat, lon, radiusMeters) {
    // Build Overpass query for roads, water, and parks
    const query = `
        [out:json][timeout:90];
        (
            // Roads
            way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|residential|living_street|unclassified|service)$"](around:${radiusMeters},${lat},${lon});
            // Water bodies
            way["natural"="water"](around:${radiusMeters},${lat},${lon});
            relation["natural"="water"](around:${radiusMeters},${lat},${lon});
            way["waterway"~"^(river|riverbank|stream|canal)$"](around:${radiusMeters},${lat},${lon});
            // Parks
            way["leisure"="park"](around:${radiusMeters},${lat},${lon});
            way["landuse"="grass"](around:${radiusMeters},${lat},${lon});
            relation["leisure"="park"](around:${radiusMeters},${lat},${lon});
        );
        out body;
        >;
        out skel qt;
    `;
    
    // Try each Overpass server until one works
    let lastError = null;
    for (const serverUrl of CONFIG.OVERPASS_SERVERS) {
        try {
            setLoadingText(`Fetching map data...`);
            
            const response = await fetch(serverUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: `data=${encodeURIComponent(query)}`
            });
            
            if (!response.ok) {
                throw new Error(`Server returned ${response.status}`);
            }
            
            const data = await response.json();
            return parseOSMData(data);
        } catch (error) {
            console.warn(`Overpass server ${serverUrl} failed:`, error.message);
            lastError = error;
            // Try next server
        }
    }
    
    // All servers failed
    throw new Error(`Failed to fetch map data. Please try again in a moment. (${lastError?.message || 'All servers unavailable'})`);
}

function parseOSMData(data) {
    // Create a lookup for nodes
    const nodes = {};
    data.elements.forEach(el => {
        if (el.type === 'node') {
            nodes[el.id] = { lat: el.lat, lon: el.lon };
        }
    });
    
    const roads = [];
    const waterWays = [];
    const waterPolygons = [];
    const parks = [];
    
    data.elements.forEach(el => {
        if (el.type === 'way' && el.nodes && el.tags) {
            // Get coordinates for this way
            const coords = el.nodes
                .map(nodeId => nodes[nodeId])
                .filter(n => n !== undefined);
            
            if (coords.length < 2) return;
            
            // Categorize by type
            if (el.tags.highway) {
                roads.push({
                    type: el.tags.highway,
                    coords: coords
                });
            } else if (el.tags.natural === 'water' || el.tags.waterway) {
                // Check if it's a closed polygon
                if (el.nodes[0] === el.nodes[el.nodes.length - 1]) {
                    waterPolygons.push({ coords: coords });
                } else {
                    waterWays.push({ coords: coords });
                }
            } else if (el.tags.leisure === 'park' || el.tags.landuse === 'grass') {
                if (el.nodes[0] === el.nodes[el.nodes.length - 1]) {
                    parks.push({ coords: coords });
                }
            }
        }
    });
    
    // Sort roads by importance (draw less important first)
    const roadOrder = ['service', 'living_street', 'unclassified', 'residential', 
                       'tertiary_link', 'tertiary', 'secondary_link', 'secondary',
                       'primary_link', 'primary', 'trunk_link', 'trunk', 
                       'motorway_link', 'motorway'];
    
    roads.sort((a, b) => {
        return roadOrder.indexOf(a.type) - roadOrder.indexOf(b.type);
    });
    
    return { roads, waterWays, waterPolygons, parks, nodes };
}

// ============================================================================
// Coordinate Projection
// ============================================================================

function createProjection(centerLat, centerLon, radiusMeters, canvasWidth, canvasHeight) {
    // Calculate bounds using approximate degrees per meter
    const metersPerDegreeLat = 111320;
    const metersPerDegreeLon = 111320 * Math.cos(centerLat * Math.PI / 180);
    
    const latRadius = radiusMeters / metersPerDegreeLat;
    const lonRadius = radiusMeters / metersPerDegreeLon;
    
    const bounds = {
        minLat: centerLat - latRadius,
        maxLat: centerLat + latRadius,
        minLon: centerLon - lonRadius,
        maxLon: centerLon + lonRadius
    };
    
    // Apply Mercator projection
    function latToY(lat) {
        const latRad = lat * Math.PI / 180;
        return Math.log(Math.tan(Math.PI / 4 + latRad / 2));
    }
    
    const minY = latToY(bounds.minLat);
    const maxY = latToY(bounds.maxLat);
    
    return function project(lat, lon) {
        const x = ((lon - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * canvasWidth;
        const y = canvasHeight - ((latToY(lat) - minY) / (maxY - minY)) * canvasHeight;
        return { x, y };
    };
}

// ============================================================================
// Canvas Rendering
// ============================================================================

function clearCanvas() {
    ctx.fillStyle = currentTheme.bg;
    ctx.fillRect(0, 0, CONFIG.CANVAS_WIDTH, CONFIG.CANVAS_HEIGHT);
}

function drawPolygons(polygons, color, project) {
    ctx.fillStyle = color;
    
    polygons.forEach(polygon => {
        if (polygon.coords.length < 3) return;
        
        ctx.beginPath();
        const start = project(polygon.coords[0].lat, polygon.coords[0].lon);
        ctx.moveTo(start.x, start.y);
        
        for (let i = 1; i < polygon.coords.length; i++) {
            const point = project(polygon.coords[i].lat, polygon.coords[i].lon);
            ctx.lineTo(point.x, point.y);
        }
        
        ctx.closePath();
        ctx.fill();
    });
}

function drawWaterways(ways, color, project) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    ways.forEach(way => {
        if (way.coords.length < 2) return;
        
        ctx.beginPath();
        const start = project(way.coords[0].lat, way.coords[0].lon);
        ctx.moveTo(start.x, start.y);
        
        for (let i = 1; i < way.coords.length; i++) {
            const point = project(way.coords[i].lat, way.coords[i].lon);
            ctx.lineTo(point.x, point.y);
        }
        
        ctx.stroke();
    });
}

function getRoadColor(roadType) {
    const colorMap = {
        motorway: currentTheme.road_motorway,
        motorway_link: currentTheme.road_motorway,
        trunk: currentTheme.road_primary,
        trunk_link: currentTheme.road_primary,
        primary: currentTheme.road_primary,
        primary_link: currentTheme.road_primary,
        secondary: currentTheme.road_secondary,
        secondary_link: currentTheme.road_secondary,
        tertiary: currentTheme.road_tertiary,
        tertiary_link: currentTheme.road_tertiary,
        residential: currentTheme.road_residential,
        living_street: currentTheme.road_residential,
        unclassified: currentTheme.road_residential,
        service: currentTheme.road_default
    };
    
    return colorMap[roadType] || currentTheme.road_default;
}

function drawRoads(roads, project) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    roads.forEach(road => {
        if (road.coords.length < 2) return;
        
        ctx.strokeStyle = getRoadColor(road.type);
        ctx.lineWidth = ROAD_WIDTHS[road.type] || ROAD_WIDTHS.default;
        
        ctx.beginPath();
        const start = project(road.coords[0].lat, road.coords[0].lon);
        ctx.moveTo(start.x, start.y);
        
        for (let i = 1; i < road.coords.length; i++) {
            const point = project(road.coords[i].lat, road.coords[i].lon);
            ctx.lineTo(point.x, point.y);
        }
        
        ctx.stroke();
    });
}

function drawGradientFade(location) {
    const gradient = ctx.createLinearGradient(0, 
        location === 'bottom' ? CONFIG.CANVAS_HEIGHT : 0, 
        0, 
        location === 'bottom' ? CONFIG.CANVAS_HEIGHT * 0.75 : CONFIG.CANVAS_HEIGHT * 0.25
    );
    
    gradient.addColorStop(0, currentTheme.gradient_color);
    gradient.addColorStop(1, hexToRGBA(currentTheme.gradient_color, 0));
    
    ctx.fillStyle = gradient;
    
    if (location === 'bottom') {
        ctx.fillRect(0, CONFIG.CANVAS_HEIGHT * 0.75, CONFIG.CANVAS_WIDTH, CONFIG.CANVAS_HEIGHT * 0.25);
    } else {
        ctx.fillRect(0, 0, CONFIG.CANVAS_WIDTH, CONFIG.CANVAS_HEIGHT * 0.25);
    }
}

function hexToRGBA(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function drawTypography(city, country, lat, lon) {
    const textColor = currentTheme.text;
    
    // Spaced city name
    const spacedCity = city.toUpperCase().split('').join('  ');
    
    // City name (large, spaced)
    ctx.fillStyle = textColor;
    ctx.font = '700 48px Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(spacedCity, CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT * 0.86);
    
    // Decorative line
    ctx.strokeStyle = textColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(CONFIG.CANVAS_WIDTH * 0.4, CONFIG.CANVAS_HEIGHT * 0.875);
    ctx.lineTo(CONFIG.CANVAS_WIDTH * 0.6, CONFIG.CANVAS_HEIGHT * 0.875);
    ctx.stroke();
    
    // Country name
    ctx.font = '300 20px Roboto, sans-serif';
    ctx.fillText(country.toUpperCase(), CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT * 0.90);
    
    // Coordinates
    const latDir = lat >= 0 ? 'N' : 'S';
    const lonDir = lon >= 0 ? 'E' : 'W';
    const coordsText = `${Math.abs(lat).toFixed(4)}° ${latDir} / ${Math.abs(lon).toFixed(4)}° ${lonDir}`;
    
    ctx.globalAlpha = 0.7;
    ctx.font = '400 12px Roboto, sans-serif';
    ctx.fillText(coordsText, CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT * 0.93);
    
    // Attribution
    ctx.globalAlpha = 0.5;
    ctx.font = '300 10px Roboto, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('© OpenStreetMap contributors', CONFIG.CANVAS_WIDTH - 20, CONFIG.CANVAS_HEIGHT - 20);
    
    ctx.globalAlpha = 1;
}

async function renderPoster(city, country, lat, lon, radiusMeters) {
    // Create projection function
    const project = createProjection(lat, lon, radiusMeters, CONFIG.CANVAS_WIDTH, CONFIG.CANVAS_HEIGHT);
    
    // Clear and fill background
    clearCanvas();
    
    // Fetch OSM data
    setLoadingText('Fetching map data...');
    const { roads, waterWays, waterPolygons, parks } = await fetchOSMData(lat, lon, radiusMeters);
    
    setLoadingText('Rendering map...');
    
    // Draw layers in order (z-order)
    // 1. Water polygons
    drawPolygons(waterPolygons, currentTheme.water, project);
    
    // 2. Waterways (rivers, streams)
    drawWaterways(waterWays, currentTheme.water, project);
    
    // 3. Parks
    drawPolygons(parks, currentTheme.parks, project);
    
    // 4. Roads
    drawRoads(roads, project);
    
    // 5. Gradient fades
    drawGradientFade('top');
    drawGradientFade('bottom');
    
    // 6. Typography
    drawTypography(city, country, lat, lon);
}

// ============================================================================
// PNG Export
// ============================================================================

function downloadPoster() {
    const link = document.createElement('a');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const citySlug = lastGeneratedCity.toLowerCase().replace(/\s+/g, '_');
    const themeName = elements.themeSelect.value;
    
    link.download = `${citySlug}_${themeName}_${timestamp}.png`;
    link.href = elements.canvas.toDataURL('image/png');
    link.click();
}

// ============================================================================
// UI Helpers
// ============================================================================

function setStatus(message, type = '') {
    elements.status.textContent = message;
    elements.status.className = 'status ' + type;
}

function setLoadingText(text) {
    elements.loadingText.textContent = text;
}

function showLoading(show) {
    if (show) {
        elements.loadingOverlay.classList.remove('hidden');
        elements.generateBtn.disabled = true;
    } else {
        elements.loadingOverlay.classList.add('hidden');
        elements.generateBtn.disabled = false;
    }
}

// ============================================================================
// Event Handlers
// ============================================================================

elements.distanceInput.addEventListener('input', (e) => {
    elements.distanceValue.textContent = e.target.value;
});

elements.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const city = elements.cityInput.value.trim();
    const country = elements.countryInput.value.trim();
    const themeName = elements.themeSelect.value;
    const distanceKm = parseInt(elements.distanceInput.value);
    const radiusMeters = distanceKm * 1000;
    
    if (!city || !country) {
        setStatus('Please enter both city and country', 'error');
        return;
    }
    
    try {
        showLoading(true);
        elements.downloadBtn.disabled = true;
        setStatus('');
        
        // Load theme
        setLoadingText('Loading theme...');
        await loadTheme(themeName);
        
        // Geocode location
        setLoadingText('Finding location...');
        const location = await geocode(city, country);
        
        setStatus(`Found: ${location.displayName}`, 'loading');
        
        // Render poster
        await renderPoster(city, country, location.lat, location.lon, radiusMeters);
        
        // Store for download
        lastGeneratedCity = city;
        lastGeneratedCountry = country;
        
        setStatus(`Poster generated for ${city}, ${country}`, 'success');
        elements.downloadBtn.disabled = false;
        
    } catch (error) {
        console.error('Error generating poster:', error);
        setStatus(`Error: ${error.message}`, 'error');
    } finally {
        showLoading(false);
    }
});

elements.downloadBtn.addEventListener('click', downloadPoster);

// ============================================================================
// Initialization
// ============================================================================

async function init() {
    // Load default theme and render placeholder
    await loadTheme('feature_based');
    clearCanvas();
    
    // Draw placeholder text
    ctx.fillStyle = currentTheme.text;
    ctx.globalAlpha = 0.3;
    ctx.font = '300 24px Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Enter a city to generate your poster', CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2);
    ctx.globalAlpha = 1;
}

init();
