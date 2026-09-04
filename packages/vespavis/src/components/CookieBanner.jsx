/**
 * Cookie Consent Banner component for GDPR compliance.
 * Only shown to users in GDPR regions (see analytics.js).
 */

export default function CookieBanner({ onAccept, onDecline }) {
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        backgroundColor: '#ffffff',
        color: '#24261d',
        padding: '20px',
        borderTop: '2px solid #b6aed5',
        boxShadow: '0 -2px 12px rgba(60, 54, 96, 0.18)',
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '15px',
        animation: 'cookieFadeInUp 0.3s ease-out',
      }}
    >
      <div style={{ flex: 1, minWidth: '250px' }}>
        <p style={{ margin: 0, lineHeight: 1.6, fontSize: '14px' }}>
          This site uses cookies to analyze usage so we can improve the
          visualizer. By clicking &quot;Accept&quot;, you consent to the use of
          analytics cookies. Feel free to decline &mdash; we just miss out on
          seeing which parts are useful.
        </p>
      </div>
      <div style={{ display: 'flex', gap: '10px', flexShrink: 0 }}>
        <button
          onClick={onDecline}
          style={{
            padding: '10px 20px',
            fontSize: '14px',
            fontWeight: 'bold',
            color: '#24261d',
            backgroundColor: '#ece9f4',
            border: '1px solid #cabfdf',
            borderRadius: '6px',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = '#e0dbef'
            e.currentTarget.style.borderColor = '#b6aed5'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = '#ece9f4'
            e.currentTarget.style.borderColor = '#cabfdf'
          }}
        >
          Decline
        </button>
        <button
          onClick={onAccept}
          style={{
            padding: '10px 20px',
            fontSize: '14px',
            fontWeight: 'bold',
            color: '#12130d',
            backgroundColor: '#5cf699',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
            boxShadow: '0 2px 6px rgba(60, 54, 96, 0.2)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = '#34d8cb'
            e.currentTarget.style.transform = 'scale(1.05)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = '#5cf699'
            e.currentTarget.style.transform = 'scale(1)'
          }}
        >
          Accept
        </button>
      </div>
      <style>{`
        @keyframes cookieFadeInUp {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>
  )
}
