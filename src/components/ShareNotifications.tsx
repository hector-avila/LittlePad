import { useStore } from '../store/createStore';
import { shareNotificationStore, dismissShareNotification, openJoinShareDialog } from '../store/share';

/**
 * Toasts for files other instances on the same Share server just shared —
 * click one to enter its password and open it (see ShareDialog's 'join'
 * mode). Purely informational otherwise: dismissing one doesn't unshare
 * anything, it just stops offering to open it.
 */
export default function ShareNotifications() {
  const { queue } = useStore(shareNotificationStore);
  if (queue.length === 0) return null;

  return (
    <div className="share-notifications">
      {queue.map((entry) => (
        <div className="share-notification" key={entry.shareId}>
          <span className="share-notification-icon">🔗</span>
          <div className="share-notification-body">
            <strong>{entry.filename}</strong>
            <span className="settings-hint">
              Shared by another instance{entry.readOnly ? ' (read-only)' : ''}
            </span>
          </div>
          <button
            className="shortcut-btn"
            onClick={() => {
              dismissShareNotification(entry.shareId);
              openJoinShareDialog(entry);
            }}
          >
            Open
          </button>
          <button
            className="tab-close"
            aria-label="Dismiss"
            onClick={() => dismissShareNotification(entry.shareId)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
