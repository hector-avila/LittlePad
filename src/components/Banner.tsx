import { useStore } from '../store/createStore';
import { bannerStore } from '../store/misc';

export default function Banner() {
  const { message, kind } = useStore(bannerStore);
  if (!message) return null;
  return (
    <div className={`banner banner-${kind}`} role="alert">
      <span>{message}</span>
      <button onClick={() => bannerStore.set({ message: null, kind: 'info' })}>
        ×
      </button>
    </div>
  );
}
