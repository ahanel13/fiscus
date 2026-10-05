// Development defaults. In the container image, /env.js is generated from API_URL and SOURCE_URL
// at startup (docker/40-fiscus-env.sh).
window.__FISCUS_CONFIG__ = { apiUrl: '', sourceUrl: '' };
