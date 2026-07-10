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
        backgroundColor: '#12202b',
        color: '#cfe4f2',
        padding: '20px',
        boxShadow: '0 -2px 10px rgba(0, 0, 0, 0.5)',
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
            color: '#cfe4f2',
            backgroundColor: '#1c2f3d',
            border: '1px solid #2f4c60',
            borderRadius: '6px',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = '#25415290'
            e.currentTarget.style.borderColor = '#3d6280'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = '#1c2f3d'
            e.currentTarget.style.borderColor = '#2f4c60'
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
            color: '#04121b',
            backgroundColor: '#00a3e0',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
            boxShadow: '0 2px 4px rgba(0, 0, 0, 0.3)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = '#2bb8ef'
            e.currentTarget.style.transform = 'scale(1.05)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = '#00a3e0'
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
