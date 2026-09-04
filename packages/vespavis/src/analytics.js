/**
 * Analytics service for Google Analytics 4 with GDPR compliance.
 *
 * Mirrors the approach used in the asteroid-mining game (cursorastroid):
 * analytics is loaded lazily, only after consent where GDPR applies, and the
 * gtag script is injected at runtime rather than hardcoded into index.html.
 */

// GA4 Measurement ID for this property.
export const GA_MEASUREMENT_ID = 'G-MHV7W15WF5'

// GDPR-enforced countries: EU member states, UK, EEA countries
const GDPR_COUNTRIES = [
  'AT', // Austria
  'BE', // Belgium
  'BG', // Bulgaria
  'HR', // Croatia
  'CY', // Cyprus
  'CZ', // Czech Republic
  'DK', // Denmark
  'EE', // Estonia
  'FI', // Finland
  'FR', // France
  'DE', // Germany
  'GR', // Greece
  'HU', // Hungary
  'IE', // Ireland
  'IT', // Italy
  'LV', // Latvia
  'LT', // Lithuania
  'LU', // Luxembourg
  'MT', // Malta
  'NL', // Netherlands
  'PL', // Poland
  'PT', // Portugal
  'RO', // Romania
  'SK', // Slovakia
  'SI', // Slovenia
  'ES', // Spain
  'SE', // Sweden
  'GB', // United Kingdom
  'NO', // Norway (EEA)
  'IS', // Iceland (EEA)
  'LI', // Liechtenstein (EEA)
  'CH', // Switzerland (commonly included in GDPR compliance)
]

const CONSENT_STORAGE_KEY = 'analytics_consent'
const GDPR_REGION_STORAGE_KEY = 'gdpr_region_detected'

/**
 * Detects if the user is in a GDPR-enforced region via IP geolocation.
 * @returns {Promise<boolean>} true if the user is in a GDPR region
 */
export async function detectGDPRRegion() {
  try {
    // Check if we've already detected this before (cache for session)
    const cached = sessionStorage.getItem(GDPR_REGION_STORAGE_KEY)
    if (cached !== null) {
      return cached === 'true'
    }

    // Use free IP geolocation API (ipapi.co)
    const response = await fetch('https://ipapi.co/json/', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    })

    if (!response.ok) {
      throw new Error('Geolocation API request failed')
    }

    const data = await response.json()
    const countryCode = data.country_code

    if (!countryCode) {
      throw new Error('Country code not found in response')
    }

    const isGDPR = GDPR_COUNTRIES.includes(countryCode.toUpperCase())

    // Cache the result for this session
    sessionStorage.setItem(GDPR_REGION_STORAGE_KEY, isGDPR.toString())

    return isGDPR
  } catch (error) {
    console.error('Error detecting GDPR region:', error)
    // Default to showing banner if geolocation fails (safe for GDPR compliance)
    return true
  }
}

/**
 * Checks if the user has already provided consent.
 * @returns {'accepted' | 'declined' | null}
 */
export function hasConsented() {
  try {
    const consent = localStorage.getItem(CONSENT_STORAGE_KEY)
    if (consent === 'accepted' || consent === 'declined') {
      return consent
    }
    return null
  } catch (error) {
    console.error('Error reading consent from localStorage:', error)
    return null
  }
}

/**
 * Stores the user's consent preference.
 * @param {boolean} accepted - true if the user accepted, false if declined
 */
export function setConsent(accepted) {
  try {
    const consentValue = accepted ? 'accepted' : 'declined'
    localStorage.setItem(CONSENT_STORAGE_KEY, consentValue)
  } catch (error) {
    console.error('Error storing consent in localStorage:', error)
  }
}

/**
 * Initializes Google Analytics 4 by loading the gtag script.
 * @param {string} measurementId - GA4 measurement ID (e.g., G-XXXXXXXXXX)
 */
export function initializeGA4(measurementId) {
  // Don't initialize if already loaded
  if (window.gtag || document.querySelector(`script[src*="${measurementId}"]`)) {
    return
  }

  // Add gtag script to document head
  const script1 = document.createElement('script')
  script1.async = true
  script1.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`
  document.head.appendChild(script1)

  // Add inline gtag configuration
  const script2 = document.createElement('script')
  script2.innerHTML = `
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', '${measurementId}');
  `
  document.head.appendChild(script2)
}
